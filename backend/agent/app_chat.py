"""Dony 应用内的对话：读取历史记录并续聊。

与主界面（Alt+Space 唤醒）**完全一致**：同一个 AgentLoop、同一套事件协议、同一个
ToolContext，因此快速/任务模式、任务计划、UIA/截屏、模型反问（ask_user）、敏感操作
确认弹窗、长文本写入等能力全部相同。

两点仅有的差异（由传输方式决定，不改变能力）：
- 事件通过 HTTP SSE 单向推送，确认/反问的答复走 POST .../ask/{id} 回填；
- 对话绑定一条历史会话，逐轮把问答写回历史记录（主界面同样写，只是每次唤醒新建一条）。
"""
import asyncio
import uuid
from typing import Any, Dict, List, Optional

from . import history as history_store
from .context import ToolContext
from .llm import AgentLoop

# 等待用户答复的最长时间（确认/反问），超时按「拒绝 / 未回应」继续，避免永久挂住 SSE
ASK_TIMEOUT = 300.0

# 当前进行中的会话（供 HTTP 回填答复使用）
_ACTIVE: Dict[str, "AppSession"] = {}


def active_session(session_id: str) -> Optional["AppSession"]:
    return _ACTIVE.get(session_id)


class AppSession:
    """应用内会话：实现 AgentLoop 需要的会话接口（与 agent_server.Session 对齐）。"""

    def __init__(self, session_id: str, emit):
        self.history_id = session_id
        self._emit = emit
        self.loop = AgentLoop(self)
        self.ctx = ToolContext(self)
        self.mode = "fast"
        self.uia_count = 0
        self.screenshot_count = 0
        self.created_files = set()
        self._asks: Dict[str, asyncio.Future] = {}

    def reset_counters(self):
        self.uia_count = 0
        self.screenshot_count = 0

    async def emit(self, msg: dict):
        await self._emit(msg)

    async def ask(self, kind: str, text: str, extra: Optional[dict] = None):
        ask_id = uuid.uuid4().hex[:8]
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._asks[ask_id] = fut
        msg: Dict[str, Any] = {"type": "ask", "id": ask_id, "kind": kind, "text": text}
        if extra:
            msg["extra"] = extra
        await self.emit(msg)
        try:
            answer = await asyncio.wait_for(fut, ASK_TIMEOUT)
        except asyncio.TimeoutError:
            answer = False if kind == "confirm" else "（用户未回应，请按此情况继续或结束任务）"
            print(f"[app-chat] 等待用户答复超时（{kind}）", flush=True)
        finally:
            self._asks.pop(ask_id, None)
        await self.emit({"type": "ask-resolved", "id": ask_id})
        return answer

    def resolve_ask(self, ask_id: str, payload: Any):
        fut = self._asks.pop(ask_id, None)
        if fut and not fut.done():
            fut.set_result(payload)

    def cancel_asks(self):
        for ask_id in list(self._asks):
            self.resolve_ask(ask_id, False)


async def run_turn(session_id: str, text: str, emit) -> Dict[str, Any]:
    """在指定历史会话中继续对话；emit 为异步事件回调。

    事件与主界面协议一致：text-chunk / text-reset / mode / plan / tool-start /
    tool-end / cards / ask / ask-resolved / done / error。
    """
    answer = ""
    cards: List[dict] = []

    async def tee(msg: dict):
        """转发事件，同时收集本轮回答与卡片用于返回。"""
        nonlocal answer
        if msg.get("type") == "done":
            answer = msg.get("text") or ""
        elif msg.get("type") == "cards":
            cards.extend(msg.get("cards") or [])
        await emit(msg)

    session = AppSession(session_id, tee)
    # 历史会话的上下文由历史记录恢复（主界面是每次唤醒新建一条记录，此处是续聊同一条）
    prior = history_store.history_for_model(session_id)
    if prior:
        session.loop.history.extend(prior)

    _ACTIVE[session_id] = session
    try:
        await session.loop.run(text, voice=False)
    finally:
        session.cancel_asks()
        _ACTIVE.pop(session_id, None)
    return {"text": answer, "cards": cards}
