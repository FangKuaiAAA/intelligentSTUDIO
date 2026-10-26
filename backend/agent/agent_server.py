"""Dony Agent 服务入口：WS 8767。会话管理、事件协议、打断确认、闹钟/计时器广播。"""
import asyncio
import json
import os
import time
import uuid
from typing import Any, Dict, Optional

from . import config
from . import writing
from .context import ToolContext
from .llm import AgentLoop
from . import tools  # noqa: F401  注册全部工具
from .alarms import AlarmManager
from .selection import SelectionWatcher


class Session:
    def __init__(self, server: "AgentServer", ws: Any):
        self.server = server
        self.ws = ws
        self.role = "overlay"
        self.loop = AgentLoop(self)
        self.ctx = ToolContext(self)
        self.mode = "fast"
        self.uia_count = 0
        self.screenshot_count = 0
        self.created_files = set()   # 本次会话中 AI 新建的文件/文件夹
        self.history_id: Optional[str] = None   # 本次唤醒会话对应的历史记录 ID
        self._asks: Dict[str, asyncio.Future] = {}
        self._task: Optional[asyncio.Task] = None
        # 书写辅助当前这一轮的改写请求；取消/新请求都要把它掐掉
        self.writing_task: Optional[asyncio.Task] = None

    def reset_counters(self):
        self.uia_count = 0
        self.screenshot_count = 0

    async def emit(self, msg: dict):
        try:
            await self.ws.send(json.dumps(msg, ensure_ascii=False))
        except Exception:
            pass

    async def ask(self, kind: str, text: str, extra: Optional[dict] = None):
        ask_id = uuid.uuid4().hex[:8]
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._asks[ask_id] = fut
        msg = {"type": "ask", "id": ask_id, "kind": kind, "text": text}
        if extra:
            msg["extra"] = extra
        await self.emit(msg)
        answer = await fut
        await self.emit({"type": "ask-resolved", "id": ask_id})
        return answer

    def resolve_ask(self, ask_id: str, payload: Any):
        fut = self._asks.pop(ask_id, None)
        if fut and not fut.done():
            fut.set_result(payload)

    def reset_session(self):
        """一次唤醒会话（唤醒→退出）结束：清空模型上下文与运行状态。"""
        if self._task and not self._task.done():
            self._task.cancel()
        self._cancel_writing()
        for ask_id in list(self._asks):
            self.resolve_ask(ask_id, False)
        self.loop.history.clear()
        self.created_files.clear()
        self.history_id = None   # 下次唤醒开一条新的历史记录
        self.mode = "fast"
        self.reset_counters()

    async def handle(self, msg: dict):
        t = msg.get("type", "")
        if t == "register":
            self.role = msg.get("role", "overlay")
        elif t == "get-settings":
            # 界面每轮开始前拉一次：在 Dony 应用里改了朗读开关可立即生效（不必重连）
            await self.emit({"type": "settings", "tts": config.tts_enabled(),
                             "tts_always": config.tts_always(),
                             "tts_voice_only": config.tts_voice_only()})
        elif t == "reset-context":
            # 界面关闭/重新唤醒：本次会话结束，下一轮从空上下文开始
            self.reset_session()
        elif t == "user-message":
            self.reset_counters()
            text = (msg.get("text") or "").strip()
            if not text:
                return
            # 本次唤醒后的第一句？（给模型用的**可靠信号**）
            # reset_session 每次唤醒都会清空模型上下文 → 模型看不到任何历史 →
            # 它只能"觉得"这是第一句，于是每轮都按第一句的规则去 exit_dony
            #（表现就是"每次打开 APP 都自动退出 Dony"）。所以由这里明确记下来，
            # 再由 llm 写进系统提示，让模型有据可依（不做程序化拦截）。
            self.first_turn = self.history_id is None
            if self.history_id is None:   # 本次唤醒会话的第一条消息 → 新建历史记录
                from . import history as history_store
                self.history_id = history_store.create_session(text)["id"]
            if self._task and not self._task.done():
                self._task.cancel()
            self._task = asyncio.create_task(self.loop.run(text, bool(msg.get("voice"))))
        elif t == "ask-response":
            payload = msg.get("text") if msg.get("text") is not None else bool(msg.get("approved"))
            self.resolve_ask(msg.get("id", ""), payload)
        elif t == "cancel":
            if self._task and not self._task.done():
                self._task.cancel()
            for ask_id in list(self._asks):
                self.resolve_ask(ask_id, False)
            await self.emit({"type": "cancelled"})
        elif t == "writing-rewrite":
            await self._start_writing(msg)
        elif t == "writing-replace":
            await self._do_replace(msg)
        elif t == "writing-cancel":
            self._cancel_writing()
            # 带上请求方给的会话号：这条回包可能晚到（用户已经选了新文字、
            # 新一轮会话已经起来），前端据此丢弃过期回包，不会把新会话打死。
            await self.emit({"type": "writing-cancelled", "sid": int(msg.get("sid") or 0)})
        elif t == "writing-ui":
            # 书写界面显示/收起：决定要不要把"物理点击"派发给前端，以及
            # "这次抬起是不是落在我们界面上"（后者用于跳过重读选区）。
            # 这条路与鼠标接管无关，专治"系统确认点击落在我们窗口、Chromium 却没
            # 把它变成 DOM 事件"那种情况（见 SelectionWatcher.set_ui_active）。
            self.server.selection.set_ui_active(
                bool(msg.get("active")), msg.get("rects") or [])
        elif t == "writing-user-active":
            # 用户开始/结束操作书写辅助界面：期间监听器停止查询选区。
            # 不停的话，我们自己的窗口持有焦点会被误读成"选区消失"（界面自己收掉）。
            if bool(msg.get("active")):
                self.server.selection.suspend(5.0)
            else:
                self.server.selection.resume()
        elif t == "alarm-cmd":
            await self.server.alarms.handle_cmd(msg.get("cmd", ""), msg.get("id", ""))
        elif t == "toggle-card":
            key, on = msg.get("key", ""), bool(msg.get("on"))
            try:
                await self.server.alarms.handle_toggle(key, on)
                await self.emit({"type": "card-control", "ok": True, "key": key, "on": on})
            except Exception as e:
                # 不能把失败吞掉：前端卡片已经本地翻转了，得让它翻回去并说明原因
                print(f"[agent] toggle-card {key} 失败: {type(e).__name__}: {e}", flush=True)
                await self.emit({"type": "card-control", "ok": False, "key": key, "on": not on,
                                 "message": f"{e}"})
        elif t in ("set-ringtone", "get-ringtone"):
            # 铃声接口（留给「设置」应用）：设置/查询闹钟与计时器的响铃音频
            from . import store
            try:
                if t == "set-ringtone":
                    store.set_ringtone(str(msg.get("kind") or ""), str(msg.get("path") or ""))
                await self.emit({"type": "ringtone", "ok": True,
                                 "alarm": store.ringtone("alarm"),
                                 "timer": store.ringtone("timer")})
            except Exception as e:
                await self.emit({"type": "ringtone", "ok": False,
                                 "message": f"{type(e).__name__}: {e}"})
        elif t == "card-value":
            # 卡片上的滑块（音量/亮度，数值）与三段式（电源模式，字符串档位）
            # 注意：**不要**在这里 int()——三段式传的是 "efficiency" 这类字符串，
            # int() 会抛 ValueError 被吞掉，表现就是"点了电源模式没有任何反应"。
            from .tools.system import set_card_value
            key = str(msg.get("key") or "")
            try:
                actual = await set_card_value(key, msg.get("value"))
                await self.emit({"type": "card-control", "ok": True, "key": key,
                                 "value": actual})
            except Exception as e:
                print(f"[agent] card-value {key} 失败: {type(e).__name__}: {e}", flush=True)
                await self.emit({"type": "card-control", "ok": False, "key": key,
                                 "message": f"{e}"})

    # ---------- 书写辅助 ----------
    def _cancel_writing(self):
        if self.writing_task and not self.writing_task.done():
            self.writing_task.cancel()
        self.writing_task = None

    def _selection(self, msg: dict) -> dict:
        """本次改写针对的选区：消息里显式给的优先，否则用监听器记下的最近一次。

        由后端兜底取选区（而不是要求前端回传）是有意的：前端一旦处于"界面还在，
        选区事件却已经过期"的状态，回传的就是错的那一段。
        """
        return {
            "text": str(msg.get("text") or (self.server.last_selection or {}).get("text") or ""),
            "hwnd": int(msg.get("hwnd") or (self.server.last_selection or {}).get("hwnd") or 0),
        }

    async def _start_writing(self, msg: dict):
        action = str(msg.get("action") or "rewrite")
        custom = str(msg.get("custom") or "")
        sid = int(msg.get("sid") or 0)
        # ⚠ 优先用前端带过来的原文：会话起来之后用户只要点过、滚过，后端那份缓存
        #   就会是空的（界面上点击本来就不会重读选区），于是这里会误判成
        #   "没有可用于处理的选中文字" —— 而这段文字在前端一直留在内存里。
        text = str(msg.get("text") or "") or self._selection(msg)["text"]
        # 收到请求先留一行：万一后面"点了没反应"，一眼就能分清是"请求没到后端"
        # 还是"模型没回来"（这条以前没有，出问题时只能靠猜）。
        print(f"[writing] 收到请求 action={action} custom={len(custom)}字 "
              f"text={len(text)}字 sid={sid}", flush=True)
        label = writing.action_label(action)
        if not text.strip():
            await self.emit({"type": "writing-result", "sid": sid, "ok": False, "action": action,
                             "label": label, "message": "没有可用于处理的选中文字"})
            return
        self._cancel_writing()
        await self.emit({"type": "writing-stage", "sid": sid, "action": action, "label": label})
        self.writing_task = asyncio.create_task(self._run_writing(action, custom, text, label, sid))

    async def _run_writing(self, action: str, custom: str, text: str, label: str, sid: int):
        try:
            result = await writing.rewrite(action, text, custom)
        except asyncio.CancelledError:
            print(f"[writing] {action} 已取消", flush=True)
            raise
        except Exception as e:
            print(f"[writing] {action} 失败: {type(e).__name__}: {e}", flush=True)
            await self.emit({"type": "writing-result", "sid": sid, "ok": False, "action": action,
                             "label": label, "message": f"{e}"})
            return
        # 只记长度，不记内容（选中文字属于用户数据，日志里不落）
        print(f"[writing] {action} 完成 {len(text)} → {len(result['text'])} 字", flush=True)
        await self.emit({"type": "writing-result", "sid": sid, "ok": True, "action": action,
                         "label": label, "original": text, "text": result["text"],
                         "note": result["note"]})

    async def _do_replace(self, msg: dict):
        # expected 是"目标程序**当前**选区里的文字"，用来校验与按原文找回；
        # text 是"要写进去的文字"。复原时两者正好对调（expected=改写结果、text=原文），
        # 所以 expected 必须由前端显式给出，不能拿 msg.text 顶替。
        sid = int(msg.get("sid") or 0)
        hwnd = int(msg.get("hwnd") or (self.server.last_selection or {}).get("hwnd") or 0)
        expected = str(msg.get("expected") or (self.server.last_selection or {}).get("text") or "")
        new_text = str(msg.get("text") or "")
        # 位置记录：**后端账本优先**。写回成功后账本会更新成新偏移，而前端那份
        # 还是选区捕获时的旧值 —— 复原/预览时旧偏移指向的已经是别的文字。
        # 前端的值只在"账本没有"（如旧会话）时才用。
        pos = msg.get("pos")
        rec = self.server.writing_pos or {}
        # ⚠ **账本无条件优先**，不再要求 seq 与 sid 相等。
        #   全穿透下用户点「复原」那一下也会落进编辑器、顺手产生一次新选区，
        #   账本的 seq 立刻被换掉 —— 按"序号相等"判就永远用不上账本，
        #   于是复原还是拿着前端那份**旧偏移**，落在完全不同的位置。
        #   偏移越界由 _replace_via_edit 里的 WM_GETTEXTLENGTH 守卫兜住。
        if rec.get("pos"):
            pos = rec["pos"]
        try:
            # 看门狗：写回里有 UIA/COM 调用，目标窗口无响应时会**永久阻塞**，
            # 用户看到的就是"结果回来了、却既不报错也不写"。超时明确报错，不再静默。
            info = await asyncio.wait_for(
                writing.replace_async(hwnd, expected, new_text, pos), timeout=8)
        except asyncio.TimeoutError:
            print("[writing] 替换超时（目标窗口无响应）", flush=True)
            await self.emit({"type": "writing-replaced", "sid": sid, "ok": False,
                             "message": "写回超时：目标窗口没有响应（可能弹出了对话框，或程序正忙）"})
            return
        except Exception as e:
            print(f"[writing] 替换失败: {type(e).__name__}: {e}", flush=True)
            await self.emit({"type": "writing-replaced", "sid": sid, "ok": False, "message": f"{e}"})
            return
        # 写回成功 ⇒ 维护账本：EM_SETSEL 路径给出精确新偏移；其余路径（按文字查找等）
        # 偏移已不可信，作废账本让下一次走查找兜底（文档里正是刚写入的文字，找得到）。
        if info.get("new_pos"):
            self.server.writing_pos = {"seq": rec.get("seq") or sid, "pos": info["new_pos"]}
        else:
            self.server.writing_pos = None
        print(f"[writing] 替换完成（{info['how']}，核对={'是' if info['verified'] else '否'}）", flush=True)
        # 写回后选区/文字都变了：立刻重读一次并广播 ——
        # ① 界面上的选框尺寸跟着更新（否则一直是旧尺寸）；
        # ② 位置账本换成新选区（下一次「复原」按它定位就准）。
        try:
            self.server.selection.wake()
        except Exception:
            pass
        await self.emit({"type": "writing-replaced", "sid": sid, "ok": True,
                         "how": info["how"], "verified": info["verified"]})

    async def close(self):
        if self._task and not self._task.done():
            self._task.cancel()
        self._cancel_writing()
        await self.loop.close()


class AgentServer:
    def __init__(self):
        self.sessions = set()
        self.alarms = AlarmManager(self)
        # 书写辅助：全局选区监听 + 最近一次选区（改写/替换都由后端兜底取它）
        self.selection = SelectionWatcher()
        self.last_selection: Optional[Dict[str, Any]] = None
        # 位置账本：{"seq": 选区号, "pos": {start,length}}。
        # ⚠ 独立于 last_selection：空选区广播会把后者清掉，而写回恰恰常发生在
        #   "选区已被点掉"之后。账本只在两个时机变化 —— 新选区进来（覆盖）、
        #   写回成功（更新成新偏移，或按文字路径写入时作废），因此它始终是最新的。
        self.writing_pos: Optional[Dict[str, Any]] = None
        self._selection_task: Optional[asyncio.Task] = None

    async def start_selection(self):
        self.selection.attach(asyncio.get_event_loop())
        self.selection.start()
        self._selection_task = asyncio.create_task(self._pump_selection())

    async def _pump_selection(self):
        """把工作线程推来的选区事件广播给所有会话。

        选区一变就广播（含"变成没有选区"），界面据此显示/收起标签。
        监听器本身已去重，这里不再叠加节流。
        """
        try:
            async for event in self.selection.events():
                self.last_selection = event if event.get("text") else None
                if event.get("text") and event.get("pos"):
                    # 新选区 ⇒ 位置账本换新页（旧的偏移已经没有意义）
                    self.writing_pos = {"seq": event.get("seq"), "pos": event["pos"]}
                await self.broadcast(event)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[writing] 选区事件循环异常: {type(e).__name__}: {e}", flush=True)

    async def broadcast(self, msg: dict):
        for s in list(self.sessions):
            await s.emit(msg)

    async def handler(self, ws):
        session = Session(self, ws)
        self.sessions.add(session)
        print(f"[agent] client connected role pending ({len(self.sessions)})", flush=True)
        try:
            await session.emit({"type": "init", "tts": config.tts_enabled(),
                                "tts_always": config.tts_always(),
                                "tts_voice_only": config.tts_voice_only(),
                                "model": config.MODEL})
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                await session.handle(msg)
        except Exception:
            pass
        finally:
            self.sessions.discard(session)
            await session.close()
            print(f"[agent] client disconnected ({len(self.sessions)})", flush=True)


async def main():
    server = AgentServer()
    import websockets
    from . import mcp
    print(f"[agent-server] ws://127.0.0.1:{config.AGENT_WS_PORT} model={config.MODEL}", flush=True)
    await server.start_selection()
    try:
        # MCP 服务器随主服务常驻（配置见 .appx_config.json 的 MCP_SERVERS，
        # 由「STUDIO设置」页维护；改动后需重启 Dony 生效）
        await mcp.start_all()
        async with websockets.serve(server.handler, "127.0.0.1", config.AGENT_WS_PORT):
            await asyncio.Future()
    finally:
        # 退出时务必停掉轮询线程，否则进程会拖着两个 daemon 线程不放
        server.selection.stop()
        await mcp.stop_all()


def port_in_use(port: int) -> bool:
    """端口是否已被监听（重复启动时友好退出，而不是抛 bind 10048 错误）。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    if port_in_use(config.AGENT_WS_PORT):
        print(f"[agent-server] {config.AGENT_WS_PORT} 已在运行，本次启动跳过", flush=True)
        raise SystemExit(0)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
