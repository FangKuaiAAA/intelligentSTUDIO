"""Office 加载项本地桥（intelligentSTUDIO）

一个端口同时承担两件事：
  1. 托管任务窗格静态资源（office/dist）—— 与接口**同源**，省掉 CORS 与证书两处常见故障；
  2. 提供窗格用到的接口：书写改写、上下文转提示词、生图、取图、取消、元素清单。

鉴权沿用 edge_bridge 的约定：token 落盘 %APPDATA%\\Dony，页面通过 /api/session 同源取回。
静态资源**不能**带 Cache-Control（Office 需要缓存加载项图标）。

HTTPS：清单要求 https://localhost:8771。若 %APPDATA%\\Dony\\office-bridge 下存在
cert.pem / key.pem 就以 HTTPS 启动；没有则退化为 HTTP 并打印处理办法（证书由
scripts/install-office-addin.ps1 负责生成）。

⚠ 8769 被 backend/dony_app_api.py 独占，8770 亦被占用，因此本服务固定用 8771；
  改端口必须同步改 office/manifest.xml 里所有 URL，否则窗格加载的是空地址。

运行：.venv\\Scripts\\python.exe -m backend.office_bridge
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from agent import config, store  # noqa: E402

# 重定向到文件时 Python 会用系统编码（GBK）写 stdout；统一改成 UTF-8，
# 避免任何非 GBK 字符（生图服务端的报错里很常见）把进程写崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - 老解释器/非文本流时忽略
        pass

VERSION = "1.0.0"
PORT = int(os.getenv("OFFICE_BRIDGE_PORT", str(getattr(config, "OFFICE_BRIDGE_PORT", 8771))))
HOSTNAME = "localhost"

# 画风：与 playground-app/Models/StylePreset.cs 保持同源（改一边就要改另一边）
STYLES: List[Dict[str, str]] = [
    {"key": "any", "name": "任意风格"},
    {"key": "comic", "name": "漫画"},
    {"key": "illustration", "name": "插画"},
    {"key": "emoji", "name": "表情"},
    {"key": "sketch", "name": "素描"},
    {"key": "realistic", "name": "写实"},
]
STYLE_NAMES = {s["key"]: s["name"] for s in STYLES}


def log(*args: Any) -> None:
    """日志永远不能拖垮服务。

    stdout 被重定向到文件时，Python 会退回系统编码（这里是 GBK）；
    生图 CLI 的报错里一旦出现 GBK 之外的字符（实测出现过 U+037C），
    print 会抛 UnicodeEncodeError，进而把整个 uvicorn 进程带下去。
    所以先试 UTF-8，失败再退成纯 ASCII。
    """
    try:
        print("[office-bridge]", *args, flush=True)
    except UnicodeEncodeError:
        safe = " ".join(
            str(a).encode("utf-8", "replace").decode("ascii", "replace") for a in args
        )
        print("[office-bridge]", safe, flush=True)


# ================= token =================
def _token_path() -> str:
    return os.path.join(store.DONY_DIR, "office_bridge_token")


def load_or_create_token() -> str:
    path = _token_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            token = f.read().strip()
        if token:
            return token
    except OSError:
        pass
    token = secrets.token_hex(16)
    try:
        store.ensure_dirs()
        with open(path, "w", encoding="utf-8") as f:
            f.write(token)
        log("已生成窗格接入 token →", path)
    except OSError as e:
        log("token 落盘失败（本次仅内存有效）:", e)
    return token


TOKEN = load_or_create_token()

# 本进程内放开书写超时：本地模型慢，超时会被误判成失败。
# 这是**进程级**赋值，桌面端（另一个进程）的 120s 设置不受影响。
config.WRITING_TIMEOUT = float(os.getenv("OFFICE_WRITING_TIMEOUT", "3600"))


def _token_ok(request: Request) -> bool:
    value = request.headers.get("x-dony-token") or ""
    return bool(value) and secrets.compare_digest(value, TOKEN)


def _require_token(request: Request) -> None:
    if not _token_ok(request):
        raise HTTPException(status_code=401, detail="token 无效")


# ================= 生图进程 =================
JOBS_DIR = os.path.join(store.DONY_DIR, "office-jobs")
RUNNING: Dict[str, asyncio.subprocess.Process] = {}
# 生图串行锁：见 image_generate 里的说明
GEN_LOCK = asyncio.Lock()
_EXE_CACHE: List[str] = []


def _job_path(job_id: str) -> str:
    safe = "".join(c for c in job_id if c.isalnum() or c in "-_")[:64] or "job"
    return os.path.join(JOBS_DIR, f"{safe}.png")


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _resources_root() -> str:
    """打包态：backend 源码在 _internal/backend，静态资源在上一级 resources/；
    源码态：资源就在仓库根。"""
    root = _repo_root()
    if getattr(sys, "frozen", False):
        return os.path.dirname(root)
    return root


def _playground_dir() -> str:
    """图乐园子应用目录：打包态 resources/playground，源码态 playground-app。"""
    name = "playground" if getattr(sys, "frozen", False) else "playground-app"
    return os.path.join(_resources_root(), name)


def find_playground_exe() -> Optional[str]:
    """找图乐园可执行文件：环境变量优先，其次在 playground-app/bin 下按修改时间取最新。"""
    if _EXE_CACHE:
        return _EXE_CACHE[0]
    explicit = os.getenv("PLAYGROUND_EXE", "") or getattr(config, "PLAYGROUND_EXE", "")
    if explicit and os.path.exists(explicit):
        _EXE_CACHE.append(explicit)
        return explicit

    if getattr(sys, "frozen", False):
        direct = os.path.join(_playground_dir(), "ImagePlayground.exe")
        if os.path.exists(direct):
            _EXE_CACHE.append(direct)
            return direct
        return None

    root = os.path.join(_repo_root(), "playground-app", "bin")
    newest: Optional[str] = None
    newest_at = 0.0
    for base, _dirs, files in os.walk(root):
        if "ImagePlayground.exe" in files:
            path = os.path.join(base, "ImagePlayground.exe")
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if mtime > newest_at:
                newest, newest_at = path, mtime
    if newest:
        _EXE_CACHE.append(newest)
        log("图乐园可执行文件：", newest)
    return newest


# 窗格只展示 12 个元素（3 列 × 4 行）。60 个全铺在窄窗格里既挤又难选，
# 这 12 个覆盖场景/主题/表情/角色/配饰五类，足以拼出常见文档插图。
# 桌面端图乐园仍用完整 60 个，互不影响。
CURATED_ELEMENT_IDS = (
    "p1_01",  # 城市
    "p1_03",  # 森林
    "p1_07",  # 太空
    "p2_12",  # 日落
    "p2_07",  # 繁星之夜
    "p3_02",  # 开心
    "p3_07",  # 思考
    "p4_02",  # 宇航员
    "p4_09",  # 科学家
    "p4_07",  # 机器人
    "p5_09",  # 太阳镜
    "p5_08",  # 盆栽
)


def _elements_manifest() -> List[Dict[str, str]]:
    path = os.path.join(_repo_root(), "playground-app", "Assets", "Elements", "manifest.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        log("元素清单读取失败:", e)
        return []

    by_id: Dict[str, Dict[str, str]] = {}
    for page in data.get("pages", []):
        for item in page.get("items", []):
            file = item.get("file")
            if not file or not item.get("id"):
                continue
            by_id[item["id"]] = {
                "id": item["id"],
                "name": item.get("name") or item["id"],
                "prompt": item.get("prompt") or item.get("name") or "",
                "file": f"/elements/{file}",
            }

    # 按上面写死的顺序输出，避免 manifest 调整顺序后卡片位置乱跳
    return [by_id[i] for i in CURATED_ELEMENT_IDS if i in by_id]


# ================= 应用 =================
app = FastAPI(title="intelligentSTUDIO Office Bridge")


class WritingBody(BaseModel):
    action: str
    text: str
    custom: str = ""


class ContextBody(BaseModel):
    text: str
    style: str = "illustration"
    elements: List[str] = []


class GenerateBody(BaseModel):
    jobId: str
    prompt: str
    style: str = "illustration"
    size: int = 1024


class CancelBody(BaseModel):
    jobId: str


@app.get("/api/session")
async def session(request: Request):
    """同源下发 token：Origin 不匹配就拒绝，避免任意网页读到本机 token。"""
    origin = request.headers.get("origin") or ""
    allowed = {f"https://{HOSTNAME}:{PORT}", f"http://{HOSTNAME}:{PORT}", f"http://127.0.0.1:{PORT}"}
    if origin and origin not in allowed:
        raise HTTPException(status_code=403, detail="来源不被允许")
    return {"token": TOKEN, "version": VERSION}


@app.get("/api/health")
async def health(request: Request):
    _require_token(request)
    writing_ok = bool(config.API_KEY and config.API_BASE)
    image_ok = bool(find_playground_exe())
    message = ""
    if not image_ok:
        message = "未找到 ImagePlayground.exe，请先构建图乐园应用"
    elif not writing_ok:
        message = "对话模型未配置，书写辅助暂不可用"
    return {"ok": True, "version": VERSION, "writing": writing_ok, "image": image_ok, "message": message}


@app.post("/api/writing/run")
async def writing_run(body: WritingBody, request: Request):
    _require_token(request)
    from agent.writing import ACTION_LABELS, rewrite

    text = body.text
    custom = body.custom

    if not text.strip():
        # 对话式改写：没有选中文字不再是错误，改为"在光标处创作"。
        # 给模型一句占位素材 + 明确指令，避免它回一句"请提供文字"。
        if body.action != "custom":
            raise HTTPException(status_code=400, detail="没有可处理的文字")
        text = "（此处没有选中文字）"
        custom = f"{custom}；当前没有选中文字，请直接在光标处创作内容，不要解释，不要复述要求。".strip("；")

    try:
        result = await rewrite(body.action, text, custom)
    except Exception as e:  # noqa: BLE001 - 模型侧错误统一转成一句可读的话
        log("改写失败:", type(e).__name__, str(e)[:200])
        return JSONResponse(status_code=502, content={"detail": f"模型请求失败：{str(e)[:160]}"})

    return {
        "text": result["text"],
        "note": result.get("note", ""),
        "label": ACTION_LABELS.get(body.action, "改写"),
    }


@app.post("/api/image/context")
async def image_context(body: ContextBody, request: Request):
    _require_token(request)
    import httpx

    if not body.text.strip():
        raise HTTPException(status_code=400, detail="上下文为空")

    style_name = STYLE_NAMES.get(body.style, "插画")
    elements = "、".join(body.elements) if body.elements else "（未指定）"
    system = (
        "你是插画提示词撰写者。根据用户给出的文档片段，写一段**可直接用于生图**的画面描述。\n"
        "要求：\n"
        "1. 只写画面内容，40 到 80 字；\n"
        "2. 不解释、不加引号、不用 Markdown、不写“以下是”；\n"
        "3. 画面里不要出现文字、字幕、水印、界面元素；\n"
        "4. 贴合指定画风，主体明确、构图完整；\n"
        "5. 文档片段里可能有与画面无关的内容（标题、编号、页眉、无关公式等），"
        "要按语境判断光标处最合适的插图，不要照抄原文，也不要试图把整段文意画出来。"
    )
    user = f"【文档片段】\n{body.text[:1200]}\n\n画风：{style_name}\n希望出现的元素：{elements}"

    payload = {
        "model": config.MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.7,
        **config.thinking_payload(),
    }
    try:
        async with httpx.AsyncClient(
            base_url=config.API_BASE,
            headers={"Authorization": f"Bearer {config.API_KEY}"},
            # 同样不设超时：提示词这一步也是本地模型，慢不代表失败
            timeout=None,
        ) as client:
            resp = await client.post("/chat/completions", json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"模型返回 {resp.status_code}")
            data = resp.json()
        prompt = (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
    except Exception as e:  # noqa: BLE001
        log("上下文提示词失败:", type(e).__name__, str(e)[:200])
        raise HTTPException(status_code=502, detail=f"模型请求失败：{str(e)[:120]}")

    cleaned = prompt.strip().strip('“”"\'`').replace("\n", " ").strip()
    if not cleaned:
        raise HTTPException(status_code=502, detail="模型没有给出画面描述")
    return {"prompt": cleaned}


@app.post("/api/image/generate")
async def image_generate(body: GenerateBody, request: Request):
    _require_token(request)
    # SD WebUI 一次只推理一张：并发请求会让后来者拿到空 images（"生图服务没有返回图片数据"）。
    # 这里串行化，第二个请求排队等待，而不是和第一个抢服务端。
    async with GEN_LOCK:
        return await _image_generate_locked(body)


async def _image_generate_locked(body: GenerateBody):
    exe = find_playground_exe()
    if not exe:
        raise HTTPException(status_code=503, detail="未找到 ImagePlayground.exe，请先构建图乐园应用")

    os.makedirs(JOBS_DIR, exist_ok=True)
    out = _job_path(body.jobId)
    err_file = out + ".err.txt"
    size = max(256, min(1536, int(body.size or 1024)))
    args = [
        exe,
        "--office",
        "--prompt",
        body.prompt,
        "--style",
        body.style or "illustration",
        "--size",
        str(size),
        "--out",
        out,
        # CLI 自带错误落盘：进程异常退出时 stderr 可能是空的，
        # 有了这个文件才能知道它到底因为什么失败
        "--error-out",
        err_file,
    ]

    log("开始生图", body.jobId, "画风:", body.style)
    started = time.time()
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    RUNNING[body.jobId] = proc
    try:
        # 不设超时：本地模型慢是常态，超时会把"还在算"误判成失败
        # （实测：图已经生成完并落盘，却因为跨过等待上限被判"生成未完成"）。
        # 中止只走 /api/image/cancel（kill 子进程），不靠计时器。
        stdout, stderr = await proc.communicate()
    finally:
        RUNNING.pop(body.jobId, None)

    if proc.returncode != 0:
        message = (stderr.decode("utf-8", "ignore") or stdout.decode("utf-8", "ignore")).strip()
        if not message and os.path.exists(err_file):
            try:
                with open(err_file, "r", encoding="utf-8", errors="ignore") as f:
                    message = f.read().strip()
            except OSError:
                message = ""
        log("生图失败", proc.returncode, (message or "(无输出)")[:200])
        return {"ok": False, "error": message[:300] or f"生成进程退出码 {proc.returncode}"}

    log("生图完成", body.jobId, f"{time.time() - started:.1f}s")
    return {"ok": True, "file": out}


@app.get("/api/image/raw")
async def image_raw(request: Request, job: str):
    _require_token(request)
    path = _job_path(job)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="图片不存在或已过期")
    return FileResponse(path, media_type="image/png")


@app.post("/api/image/cancel")
async def image_cancel(body: CancelBody, request: Request):
    _require_token(request)
    proc = RUNNING.get(body.jobId)
    if proc and proc.returncode is None:
        # taskkill /T 连子进程一起结束：生图进程可能自己再拉起 python 之类
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
        log("已取消生图", body.jobId)
        return {"ok": True}
    return {"ok": False}


@app.get("/api/image/elements")
async def image_elements(request: Request):
    _require_token(request)
    return {"elements": _elements_manifest(), "styles": STYLES}


# ---- 静态资源：必须最后挂载，否则 "/" 会吞掉 /api/* ----
STATIC_DIR = (os.getenv("OFFICE_STATIC_DIR")
              or getattr(config, "OFFICE_STATIC_DIR", "")
              or os.path.join(_resources_root(), "office", "dist"))
ELEMENTS_DIR = (os.getenv("PLAYGROUND_ELEMENTS_DIR")
                or os.path.join(_playground_dir(), "Assets", "Elements"))

if os.path.isdir(ELEMENTS_DIR):
    app.mount("/elements", StaticFiles(directory=ELEMENTS_DIR), name="elements")
else:
    log("元素图片目录不存在：", ELEMENTS_DIR)

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="pane")
else:
    log("窗格静态目录不存在（先 npm run office:build）：", STATIC_DIR)


def main() -> None:
    import uvicorn

    cert_dir = os.path.join(store.DONY_DIR, "office-bridge")
    cert = os.path.join(cert_dir, "cert.pem")
    key = os.path.join(cert_dir, "key.pem")
    use_https = os.path.exists(cert) and os.path.exists(key)

    log(f"v{VERSION} 启动：{'https' if use_https else 'http'}://{HOSTNAME}:{PORT}")
    if not use_https:
        log("⚠ 未找到自签名证书，已退化为 HTTP。清单要求 HTTPS，请运行：")
        log("   powershell -ExecutionPolicy Bypass -File scripts/install-office-addin.ps1")

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=PORT,
        log_level="info",
        ssl_certfile=cert if use_https else None,
        ssl_keyfile=key if use_https else None,
    )


if __name__ == "__main__":
    main()
