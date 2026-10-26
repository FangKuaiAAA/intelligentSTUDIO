"""Edge 扩展桥接服务（intelligentSTUDIO）

监听 127.0.0.1:8768，单端口同时承载 HTTP 与 WebSocket。四类职责：

1. 履约 Dony 的 edge_browser 契约（backend/agent/tools/uia_screen.py）：
   GET /tabs、GET /bookmarks 读扩展上报的快照缓存（收藏项带 [id=…]，供删除时引用）；
   POST /organize_tabs、POST /organize_bookmarks 下发扩展执行并回传摘要；
   POST /bookmarks/delete 按 ids/urls/titles 删除指定收藏项（dry_run=true 只返回匹配结果，
   供 Dony 工具先向用户确认）。
   ⚠ 读走内存缓存是**必须**的：Agent 的工具会反向 HTTP 调本服务，若这里再去等扩展
   实时响应，就形成「Agent → 8768 → 扩展 → Agent」的请求-响应环，必然死锁。
2. 扩展通道：WS /ext/ws —— 注册（最小 token 握手）、心跳、快照上报、指令下发与回执。
3. 视觉代理：POST /vision/ask（SSE 流式转发模型分片）。API Key 只在服务端，
   扩展内不保存任何密钥。
4. 整理中继：POST /ext/organize（SSE）—— 以独立 WS 会话（role=edge）连 8767 触发
   Dony Agent 执行整理，回流出站事件（mode/plan/tool-start/tool-end/cards/done/error）；
   POST /ext/organize/answer 回填模型的反问答复，使澄清与确认在浮窗内闭环。

鉴权：Dony 侧的四个契约路由沿用「本机无鉴权」的既有约定（工具无法携带 token）；
扩展侧的 /ext/* 与 /vision/ask 需要 token（服务端首次生成后落盘于 %APPDATA%\\Dony），
且 CORS 只放行 chrome-extension:// 来源 —— 避免任意网页读到本机数据。

运行：.venv\\Scripts\\python.exe -m backend.edge_bridge
"""
import asyncio
import json
import os
import secrets
import sys
import time
from typing import Any, AsyncIterator, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import PlainTextResponse, StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from agent import config, store  # noqa: E402

PORT = config.EDGE_BRIDGE_PORT
VERSION = "1.1.0"

# 快照文本上限：Dony 的工具只取 resp.text[:2000]，这里留出富余
SNAPSHOT_TEXT_LIMIT = 1800
# 单次指令下发给扩展的等待上限（关闭重复标签页/重排收藏夹都是一次性操作，很快）
COMMAND_TIMEOUT = 15.0
# 整理前刷新快照的等待上限（等不到就用最近一次的快照，不阻塞流程）
REFRESH_TIMEOUT = 1.2
# 单轮整理会话的整体上限
TURN_TIMEOUT = 240.0
# 已连接实例的心跳容忍时间：超过它就认为那个实例已经不在线，允许别的实例接管
HEARTBEAT_TIMEOUT = 60.0


def log(*args: Any) -> None:
    print("[edge-bridge]", *args, flush=True)


# ================= token（最小握手） =================

def _token_path() -> str:
    return os.path.join(store.DONY_DIR, "edge_bridge_token")


def load_or_create_token() -> str:
    """读取本地 token；不存在则生成并落盘。同一台机器上的扩展据此接入。"""
    path = _token_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            tok = f.read().strip()
            if tok:
                return tok
    except OSError:
        pass
    tok = secrets.token_hex(16)
    try:
        store.ensure_dirs()
        with open(path, "w", encoding="utf-8") as f:
            f.write(tok)
        log("已生成扩展接入 token →", path)
    except OSError as e:
        log("token 落盘失败（本次仅内存有效）:", e)
    return tok


TOKEN = load_or_create_token()


def _token_ok(value: Optional[str]) -> bool:
    return bool(value) and secrets.compare_digest(value, TOKEN)


def _require_token(request: Request) -> None:
    if not _token_ok(request.headers.get("x-dony-token")):
        raise HTTPException(status_code=401, detail="token 无效")


# ================= 快照（扩展上报，只读缓存） =================

def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（内容过长，已截断；共 {len(text)} 字）"


class ExtChannel:
    """扩展侧连接与快照缓存。

    ⚠ 只允许**一个**浏览器实例接入：快照缓存与写指令都只属于那一个实例，
    两个实例同时连着会让「读到的数据」和「改动的浏览器」不是同一个，
    从而出现「模型按编号删除，却在实际浏览器里匹配不到」这类隐蔽错误。
    已在线实例失去心跳（>HEARTBEAT_TIMEOUT）后才允许新的实例接管。
    """

    def __init__(self) -> None:
        self.ws: Optional[WebSocket] = None
        self.pending: Dict[str, asyncio.Future] = {}
        self.tabs: List[Dict[str, Any]] = []
        self.bookmarks: List[Dict[str, Any]] = []
        self.snapshot_at: float = 0.0
        self.browser: str = ""
        self.version: str = ""
        self.last_seen: float = 0.0
        self._seq = 0

    @property
    def connected(self) -> bool:
        return self.ws is not None

    def healthy(self) -> bool:
        """已连接的实例是否还在正常上报（心跳由扩展每 20 秒发一次）。"""
        if not self.connected:
            return False
        return (time.time() - self.last_seen) < HEARTBEAT_TIMEOUT

    def touch(self) -> None:
        self.last_seen = time.time()

    async def send(self, msg: Dict[str, Any]) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send_text(json.dumps(msg, ensure_ascii=False))
            return True
        except Exception as e:
            log("下发扩展失败:", type(e).__name__, e)
            return False

    async def request(self, action: str, payload: Optional[Dict[str, Any]] = None,
                      timeout: float = COMMAND_TIMEOUT) -> Dict[str, Any]:
        """下发一条指令并等待扩展回执。返回 {ok, detail}。"""
        if not self.connected:
            return {"ok": False, "detail": "Edge 扩展未连接（请在 Edge 中启用扩展并保持浏览器打开）"}
        self._seq += 1
        cid = f"cmd{self._seq}"
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self.pending[cid] = fut
        sent = await self.send({"type": "command", "id": cid, "action": action,
                                "payload": payload or {}})
        if not sent:
            self.pending.pop(cid, None)
            return {"ok": False, "detail": "指令下发失败：扩展连接已断开"}
        try:
            result = await asyncio.wait_for(fut, timeout=timeout)
            return {"ok": bool(result.get("ok")), "detail": str(result.get("detail") or "")}
        except asyncio.TimeoutError:
            return {"ok": False, "detail": f"扩展在 {int(timeout)} 秒内没有回执（可能被浏览器的"
                                           f"确认弹窗阻塞）"}
        finally:
            self.pending.pop(cid, None)

    def resolve(self, cid: str, payload: Dict[str, Any]) -> None:
        fut = self.pending.get(cid)
        if fut and not fut.done():
            fut.set_result(payload)

    async def refresh(self) -> None:
        """请扩展立刻重推一次快照（整理前调用：Agent 马上就会来读）。"""
        before = self.snapshot_at
        if not await self.send({"type": "refresh"}):
            return
        deadline = time.time() + REFRESH_TIMEOUT
        while time.time() < deadline:
            if self.snapshot_at > before:
                return
            await asyncio.sleep(0.08)

    def store_snapshot(self, tabs: Any, bookmarks: Any) -> None:
        if isinstance(tabs, list):
            self.tabs = [t for t in tabs if isinstance(t, dict)]
        if isinstance(bookmarks, list):
            self.bookmarks = [b for b in bookmarks if isinstance(b, dict)]
        self.snapshot_at = time.time()


EXT = ExtChannel()


def explain(result: Dict[str, Any]) -> str:
    """把指令回执翻译成给模型/用户看的话。

    ⚠ 最常见的失败是「Edge 里加载的还是旧构建」：代码已支持某条指令，但浏览器里
    运行的 background.js 还是旧的，于是回执是"未知指令 xxx"。这种时候必须明确告诉
    用户去 edge://extensions 重新加载，否则只会在模型侧表现为"工具调用没生效"。
    """
    detail = str(result.get("detail") or "")
    if not result.get("ok") and "未知指令" in detail:
        return (f"Edge 里的扩展版本过旧（已加载 {EXT.version or '未知'}），不认识该指令："
                "请在 edge://extensions 点一次「重新加载」（或重启 Edge）后重试。")
    return detail


def render_tabs() -> str:
    if not EXT.connected:
        return "Edge 扩展尚未连接（请打开 Edge 并启用「Visual intelligence」扩展）；暂时读不到标签页。"
    if not EXT.tabs:
        return "Edge 当前没有打开的标签页。"
    counts: Dict[str, int] = {}
    for t in EXT.tabs:
        url = str(t.get("url") or "")
        if url:
            counts[url] = counts.get(url, 0) + 1
    lines = [f"Edge 共有 {len(EXT.tabs)} 个标签页（窗口 {_window_count()} 个）："]
    for i, t in enumerate(EXT.tabs[:60], 1):
        flags: List[str] = []
        if t.get("active"):
            flags.append("当前")
        if t.get("pinned"):
            flags.append("固定")
        group = str(t.get("groupTitle") or "")
        if group or t.get("groupId") not in (None, -1, "-1"):
            flags.append(f"分组：{group or '未命名'}")
        if t.get("audible"):
            flags.append("有声")
        lines.append(f"{i}. {t.get('title') or '(无标题)'} — {t.get('url') or ''}"
                     + (f"［{'、'.join(flags)}］" if flags else ""))
    if len(EXT.tabs) > 60:
        lines.append(f"……（其余 {len(EXT.tabs) - 60} 个已省略）")
    repeats = [(u, c) for u, c in counts.items() if c > 1]
    if repeats:
        lines.append("重复网址（同一网址被打开了多次）：")
        for url, c in repeats[:20]:
            lines.append(f"· {url} ×{c}")
    return _clip("\n".join(lines), SNAPSHOT_TEXT_LIMIT)


def _window_count() -> int:
    ids = {t.get("windowId") for t in EXT.tabs}
    return len({i for i in ids if i is not None}) or (1 if EXT.tabs else 0)


def _walk_bookmarks(nodes: List[Dict[str, Any]], path: List[str],
                    out: List[str]) -> None:
    for n in nodes:
        if n.get("type") == "folder":
            title = str(n.get("title") or "未命名")
            _walk_bookmarks(list(n.get("children") or []), path + [title], out)
        else:
            url = str(n.get("url") or "")
            if url:
                out.append(f"{'/'.join(path) or '收藏夹'}/{n.get('title') or '(无标题)'} — {url}")


def _collect_bookmarks(nodes: List[Dict[str, Any]], path: List[str],
                       out: List[Dict[str, str]]) -> None:
    """摊平收藏夹：每项带 id/标题/网址/所在路径（id 供模型精确指定删除目标）。"""
    for n in nodes:
        if n.get("type") == "folder":
            title = str(n.get("title") or "未命名")
            _collect_bookmarks(list(n.get("children") or []), path + [title], out)
        else:
            url = str(n.get("url") or "")
            if url:
                out.append({"id": str(n.get("id") or ""), "title": str(n.get("title") or ""),
                            "url": url, "path": "/".join(path) or "收藏夹"})


def render_bookmarks() -> str:
    if not EXT.connected:
        return "Edge 扩展尚未连接（请打开 Edge 并启用「Visual intelligence」扩展）；暂时读不到收藏夹。"
    items: List[Dict[str, str]] = []
    _collect_bookmarks(EXT.bookmarks, [], items)
    if not items:
        return "Edge 收藏夹为空。"
    lines = [f"Edge 收藏夹共 {len(items)} 条（[id=…] 是删除时可直接引用的编号）："]
    for i, it in enumerate(items, 1):
        lines.append(f"{i}. {it['path']}/{it['title'] or '(无标题)'} — {it['url']}"
                     + (f" [id={it['id']}]" if it["id"] else ""))
    return _clip("\n".join(lines), SNAPSHOT_TEXT_LIMIT)


# ================= 整理中继（对接 Dony Agent 8767） =================

ORGANIZE_TABS_TEXT = (
    "这是来自 Edge 扩展浮窗的**浏览器整理请求**（不是用户在 Dony 界面里说话，"
    "用户此刻正看着扩展浮窗）。请按以下要求执行：\n"
    "1. 先调用 edge_browser(action=tabs) 读取当前标签页；\n"
    "2. 判断哪些是重复标签页（同一网址被打开了多次），再调用 "
    "edge_browser(action=organize_tabs) 让扩展执行整理（扩展会自动按域名分组、"
    "关闭重复标签页，并回传执行摘要）；\n"
    "3. 用两到三句话简短汇报结果（关闭了几个重复标签页、按域名建了几个分组），"
    "不要复述全部标签页。\n"
    "约束：不要截屏、不要操作屏幕与鼠标、不要改文件、不要调用 exit_dony、"
    "不要改动与浏览器整理无关的任何内容。"
)

ORGANIZE_BOOKMARKS_TEXT = (
    "这是来自 Edge 扩展浮窗的**收藏夹整理请求**（不是用户在 Dony 界面里说话，"
    "用户此刻正看着扩展浮窗）。请按以下要求执行：\n"
    "1. 先调用 edge_browser(action=bookmarks) 读取收藏夹（列表里每项都带 [id=…]）；\n"
    "2. 规划整理方式（把同一域名的书签收进同名文件夹、合并完全重复的网址），"
    "然后调用 edge_browser(action=organize_bookmarks) 让扩展执行整理并回传摘要；\n"
    "3. 如果用户补充要求里包含删除某些收藏项的意图（例如删除某个网址、某个标题、"
    "某类失效或重复的收藏）：用上一步读到的 [id=…] 或完整网址，调用 "
    "edge_browser(action=delete_bookmarks, ids=[...])（也可用 urls/titles）；"
    "该工具会先给出匹配结果并自动弹出「允许 / 不允许」让用户确认，用户允许后才会真正删除。"
    "删除失败时按工具返回的提示缩小范围重试，不要反复调用同一个必然匹配不到的目标；\n"
    "4. 用两到三句话简短汇报结果（收纳了几条、新建了几个文件夹、删除了几条），"
    "不要复述全部书签。\n"
    "约束：不要截屏、不要操作屏幕与鼠标、不要改文件、不要调用 exit_dony、"
    "不要改动与收藏夹整理无关的任何内容。"
)


class AgentRelay:
    """以独立 WS 会话（role=edge）连 Dony Agent，承载扩展浮窗的整理流程。

    每轮整理新开一条连接：Agent 侧每个连接是独立 Session（独立上下文），
    既不会污染 overlay 会话，也保证「一次整理 = 一次干净对话」。
    """

    def __init__(self) -> None:
        self.ws: Any = None
        self.ask_id: str = ""
        self.active: bool = False

    async def run_turn(self, text: str) -> AsyncIterator[Dict[str, Any]]:
        import websockets

        url = f"ws://127.0.0.1:{config.AGENT_WS_PORT}"
        self.active = True
        self.ask_id = ""
        try:
            async with websockets.connect(url, open_timeout=5) as ws:
                self.ws = ws
                await ws.send(json.dumps({"type": "register", "role": "edge"}))
                await ws.send(json.dumps({"type": "user-message", "text": text,
                                          "voice": False}))
                deadline = time.time() + TURN_TIMEOUT
                while True:
                    left = deadline - time.time()
                    if left <= 0:
                        yield {"type": "error", "message": "整理超时（超过 "
                               f"{int(TURN_TIMEOUT)} 秒没有结果），已中止。"}
                        return
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=left)
                    except asyncio.TimeoutError:
                        yield {"type": "error", "message": "整理超时，已中止。"}
                        return
                    try:
                        evt = json.loads(raw)
                    except Exception:
                        continue
                    if not isinstance(evt, dict):
                        continue
                    if evt.get("type") == "ask":
                        self.ask_id = str(evt.get("id") or "")
                    elif evt.get("type") == "ask-resolved":
                        self.ask_id = ""
                    yield evt
                    if evt.get("type") in ("done", "error", "cancelled"):
                        return
        except Exception as e:
            log("整理中继失败:", type(e).__name__, e)
            yield {"type": "error",
                   "message": f"Dony Agent 服务未就绪（ws://127.0.0.1:{config.AGENT_WS_PORT}）："
                              f"{type(e).__name__}: {e}"}
        finally:
            self.active = False
            self.ask_id = ""
            self.ws = None

    async def answer(self, ask_id: str, text: Optional[str],
                     approved: Optional[bool]) -> bool:
        ws = self.ws
        if ws is None:
            return False
        msg: Dict[str, Any] = {"type": "ask-response", "id": ask_id or self.ask_id}
        if text is not None:
            msg["text"] = text
        if approved is not None:
            msg["approved"] = approved
        try:
            await ws.send(json.dumps(msg))
            return True
        except Exception as e:
            log("回填询问答复失败:", type(e).__name__, e)
            return False

    async def cancel(self) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps({"type": "cancel"}))
            return True
        except Exception:
            return False


RELAY = AgentRelay()


# ================= FastAPI 应用 =================

app = FastAPI(title="intelligentSTUDIO Edge Bridge")
# ⚠ 只放行扩展来源：本机服务一律无鉴权，若 CORS 全开，任意网页都能读到标签页/收藏夹。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|extension)://[a-p]{32}$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _sse(payload: Dict[str, Any]) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive",
               "X-Accel-Buffering": "no"}


# ---------- Dony 契约路由（无 token，语义与 edge_browser 工具一致，勿改） ----------

@app.get("/health")
async def health() -> Dict[str, Any]:
    # extension_version / browser / extension_healthy 供安装按钮判断「已装且版本一致」：
    # 只看 connected 会把刚断开的半开连接当成还在（扩展被删掉后仍报已安装），
    # healthy 以心跳为准，才是"现在真的在用"。
    return {"ok": True, "service": "edge-bridge", "version": VERSION,
            "extension_connected": EXT.connected, "extension_healthy": EXT.healthy(),
            "extension_version": EXT.version, "browser": EXT.browser,
            "agent_port": config.AGENT_WS_PORT}


@app.get("/tabs", response_class=PlainTextResponse)
async def dony_tabs() -> str:
    return render_tabs()


@app.get("/bookmarks", response_class=PlainTextResponse)
async def dony_bookmarks() -> str:
    return render_bookmarks()


@app.post("/organize_tabs", response_class=PlainTextResponse)
async def dony_organize_tabs() -> str:
    await EXT.refresh()
    result = await EXT.request("organize_tabs")
    log("Dony 调用 organize_tabs →", result["detail"][:120])
    return ("标签页整理完成：" if result["ok"] else "标签页整理未执行：") + explain(result)


@app.post("/organize_bookmarks", response_class=PlainTextResponse)
async def dony_organize_bookmarks() -> str:
    await EXT.refresh()
    result = await EXT.request("organize_bookmarks")
    log("Dony 调用 organize_bookmarks →", result["detail"][:120])
    return ("收藏夹整理完成：" if result["ok"] else "收藏夹整理未执行：") + explain(result)


class DeleteBody(BaseModel):
    """删除收藏项的目标集合：ids / urls / titles 取并集，任一命中即删。

    dry_run=true 时只返回匹配结果、不执行删除 —— Dony 工具据此先向用户确认，
    用户点「允许」后再以 dry_run=false 真正下发。
    """
    ids: List[str] = []
    urls: List[str] = []
    titles: List[str] = []
    dry_run: bool = False


@app.post("/bookmarks/delete", response_class=PlainTextResponse)
async def dony_delete_bookmarks(body: DeleteBody) -> str:
    if not (body.ids or body.urls or body.titles):
        return "删除未执行：需要提供 ids、urls 或 titles 之一。"
    # dry_run 只做匹配，不需要等快照刷新；真删前先刷新，保证删完的快照是最新的
    if not body.dry_run:
        await EXT.refresh()
    result = await EXT.request("delete_bookmarks", {
        "ids": body.ids, "urls": body.urls, "titles": body.titles, "dryRun": body.dry_run,
    })
    prefix = ("删除预演：" if body.dry_run else "删除完成：") if result["ok"] else "删除未执行："
    log(f"Dony 调用 delete_bookmarks(dry={body.dry_run}) →", result["detail"][:120])
    return prefix + explain(result)


# ---------- 扩展侧 HTTP（需 token） ----------

class VisionBody(BaseModel):
    messages: List[Dict[str, Any]]
    model: Optional[str] = None


@app.get("/ext/token")
async def ext_token(request: Request) -> Dict[str, Any]:
    """token 引导：只认扩展来源（自定义头会触发预检，网页因 CORS 被挡下）。"""
    if request.headers.get("x-dony-extension") != "1":
        raise HTTPException(status_code=403, detail="仅限扩展调用")
    return {"token": TOKEN, "version": VERSION}


@app.get("/ext/status")
async def ext_status(request: Request) -> Dict[str, Any]:
    _require_token(request)
    flat: List[str] = []
    _walk_bookmarks(EXT.bookmarks, [], flat)
    return {
        "ok": True,
        "version": VERSION,
        "extension_version": EXT.version,
        "browser": EXT.browser,
        "tabs": len(EXT.tabs),
        "bookmarks": len(flat),
        "snapshot_age_ms": int((time.time() - EXT.snapshot_at) * 1000) if EXT.snapshot_at else -1,
        "agent_busy": RELAY.active,
        "agent_port": config.AGENT_WS_PORT,
        "vision_model": config.VISION_MODEL,
    }


@app.post("/vision/ask")
async def vision_ask(body: VisionBody, request: Request) -> StreamingResponse:
    _require_token(request)
    log(f"vision/ask messages={len(body.messages)} model={config.VISION_MODEL}")
    return StreamingResponse(_vision_stream(body.messages), media_type="text/event-stream",
                             headers=SSE_HEADERS)


def _chat_url() -> str:
    base = config.API_BASE.rstrip("/")
    return base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"


async def _vision_stream(messages: List[Dict[str, Any]]) -> AsyncIterator[str]:
    """把模型分片转成 SSE：{"delta": "..."} / {"done": true} / {"error": "..."}。

    模型取 config.VISION_MODEL（默认与全局视觉智能同名的模型）；若该模型在当前
    Key 上不可用（部署期最常见的坑），自动回退到主对话模型 MODEL 再试一次。
    请求体与全局视觉智能保持一致（只带 model/messages/stream，不带 thinking）。
    """
    state: Dict[str, str] = {}
    primary = config.VISION_MODEL
    async for item in _try_model(primary, messages, state):
        yield item
    if not state:
        return
    if primary != config.MODEL:
        log(f"视觉模型 {primary} 不可用（{state['error'][:80]}），回退到 {config.MODEL}")
        async for item in _try_model(config.MODEL, messages, None):
            yield item
    else:
        yield _sse({"error": state["error"]})


async def _try_model(model: str, messages: List[Dict[str, Any]],
                     state: Optional[Dict[str, str]]) -> AsyncIterator[str]:
    import httpx

    url = _chat_url()
    headers = {"Authorization": f"Bearer {config.API_KEY}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "stream": True}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "ignore")
                    message = f"模型返回 HTTP {resp.status_code}：{detail[:300]}"
                    # 模型名不可用（Key 上没有这个模型）→ 交给上层回退；其余错误直接报给浮窗
                    if state is not None and resp.status_code in (400, 403, 404) \
                            and "model" in detail.lower():
                        state["error"] = message
                    else:
                        yield _sse({"error": message})
                    return
                async for line in resp.aiter_lines():
                    line = (line or "").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except Exception:
                        continue
                    delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content")
                    if delta:
                        yield _sse({"delta": delta})
        yield _sse({"done": True, "model": model})
    except Exception as e:
        yield _sse({"error": f"请求模型失败：{type(e).__name__}: {e}"})


class OrganizeBody(BaseModel):
    kind: str                      # tabs | bookmarks
    request: str = ""              # 用户自定义要求（可空）


@app.post("/ext/organize")
async def ext_organize(body: OrganizeBody, request: Request) -> StreamingResponse:
    _require_token(request)
    kind = body.kind if body.kind in ("tabs", "bookmarks") else "tabs"
    await EXT.refresh()            # 先把最新数据推上来：Agent 紧接着就会来读
    text = (ORGANIZE_TABS_TEXT if kind == "tabs" else ORGANIZE_BOOKMARKS_TEXT)
    extra = (body.request or "").strip()
    if extra:
        text += f"\n用户补充的要求（优先遵守）：{extra}"
    log(f"整理请求 kind={kind} 扩展在线={EXT.connected} 补充要求={bool(extra)}")
    return StreamingResponse(_organize_stream(text), media_type="text/event-stream",
                             headers=SSE_HEADERS)


async def _organize_stream(text: str) -> AsyncIterator[str]:
    if RELAY.active:
        yield _sse({"type": "error", "message": "上一次整理还在进行中，请稍候或先取消。"})
        return
    async for evt in RELAY.run_turn(text):
        yield _sse(evt)


class AnswerBody(BaseModel):
    id: str = ""
    text: Optional[str] = None
    approved: Optional[bool] = None


@app.post("/ext/organize/answer")
async def ext_organize_answer(body: AnswerBody, request: Request) -> Dict[str, Any]:
    _require_token(request)
    ok = await RELAY.answer(body.id, body.text, body.approved)
    return {"ok": ok}


@app.post("/ext/organize/cancel")
async def ext_organize_cancel(request: Request) -> Dict[str, Any]:
    _require_token(request)
    return {"ok": await RELAY.cancel()}


class EventBody(BaseModel):
    action: str                    # tabs | bookmarks | organize_tabs | organize_bookmarks
    payload: Dict[str, Any] = {}


@app.post("/ext/run")
async def ext_run(body: EventBody, request: Request) -> Dict[str, Any]:
    """供浮窗/调试直接下发一次扩展指令（与 Dony 走同一条通道）。"""
    _require_token(request)
    action = body.action if body.action in (
        "tabs", "bookmarks", "organize_tabs", "organize_bookmarks",
        "delete_bookmarks", "refresh") else ""
    if not action:
        raise HTTPException(status_code=400, detail="未知 action")
    if action == "refresh":
        await EXT.refresh()
        return {"ok": True, "detail": "已请求扩展重新上报"}
    result = await EXT.request(action, body.payload)
    # 与对外契约路由一致：旧扩展的"未知指令"要翻译成可执行的提示，便于诊断
    return {"ok": result["ok"], "detail": explain(result)}


# ---------- 扩展侧 WebSocket ----------

@app.websocket("/ext/ws")
async def ext_ws(ws: WebSocket) -> None:
    await ws.accept()
    first = await ws.receive_text()
    try:
        hello = json.loads(first)
    except Exception:
        hello = {}
    if not _token_ok(hello.get("token")):
        log("扩展注册被拒绝：token 不匹配")
        await ws.send_text(json.dumps({"type": "registered", "ok": False,
                                       "message": "token 不匹配：请重装扩展或在状态面板重新配对"}))
        await ws.close(code=1008)
        return
    if EXT.healthy():
        log(f"拒绝第二个扩展连接（已在线的实例：{EXT.browser} {EXT.version}）")
        await ws.send_text(json.dumps({
            "type": "registered", "ok": False,
            "message": "另一浏览器实例已接入 · 关闭其一后重试",
        }, ensure_ascii=False))
        await ws.close(code=4000)
        return
    EXT.ws = ws
    EXT.browser = str(hello.get("browser") or "Edge")
    EXT.version = str(hello.get("version") or "")
    EXT.touch()
    log(f"扩展已连接（{EXT.browser} {EXT.version}）")
    await ws.send_text(json.dumps({"type": "registered", "ok": True, "version": VERSION}))
    try:
        while True:
            raw = await ws.receive_text()
            EXT.touch()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get("type", "")
            if t == "heartbeat":
                continue
            if t == "snapshot":
                EXT.store_snapshot(msg.get("tabs"), msg.get("bookmarks"))
                log(f"快照已更新：标签页 {len(EXT.tabs)} 个，收藏夹 {len(EXT.bookmarks)} 个根节点")
            elif t == "command-result":
                EXT.resolve(str(msg.get("id") or ""), msg)
            elif t == "log":
                log("扩展:", str(msg.get("message"))[:200])
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log("扩展通道异常:", type(e).__name__, e)
    finally:
        if EXT.ws is ws:
            EXT.ws = None
        log("扩展已断开")


# ================= 入口 =================

def port_in_use(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> None:
    if port_in_use(PORT):
        log(f"{PORT} 已在运行，本次启动跳过")
        return
    import uvicorn
    log(f"listening http://127.0.0.1:{PORT} （Dony 契约 + 扩展通道 + 视觉代理 + 整理中继）")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
