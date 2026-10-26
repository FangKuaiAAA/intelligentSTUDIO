"""Dony 历史会话持久化：%APPDATA%\\Dony\\history\\<session_id>.json

一次唤醒会话（唤醒→退出）对应一条历史记录；Dony 应用读取这些记录，
也可以在记录中继续对话（续聊会追加到同一条记录）。
"""
import json
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from .store import HISTORY_DIR, ensure_dirs

_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _path(session_id: str) -> str:
    if not _ID_RE.match(session_id or ""):
        raise ValueError("非法的会话 ID")
    return os.path.join(HISTORY_DIR, f"{session_id}.json")


def new_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]


def _read(session_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_path(session_id), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _write(session: Dict[str, Any]) -> Dict[str, Any]:
    ensure_dirs()
    session["updated_at"] = time.time()
    target = _path(session["id"])
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)
    os.replace(tmp, target)
    return session


def create_session(title: str = "") -> Dict[str, Any]:
    now = time.time()
    session = {
        "id": new_id(),
        "title": (title or "新对话").strip()[:40],
        "created_at": now,
        "updated_at": now,
        "turns": [],
    }
    return _write(session)


def list_sessions(limit: int = 300) -> List[Dict[str, Any]]:
    """列出历史会话概要（按最近更新排序）。"""
    ensure_dirs()
    items: List[Dict[str, Any]] = []
    try:
        names = os.listdir(HISTORY_DIR)
    except OSError:
        return items
    for name in names:
        if not name.endswith(".json"):
            continue
        data = _read(name[:-5])
        if not data:
            continue
        turns = data.get("turns") or []
        preview = ""
        for t in turns:
            if t.get("role") == "assistant" and t.get("content"):
                preview = str(t["content"])[:80]
        items.append({
            "id": data.get("id"),
            "title": data.get("title") or "未命名对话",
            "created_at": data.get("created_at", 0),
            "updated_at": data.get("updated_at", 0),
            "turn_count": len(turns),
            "preview": preview,
        })
    items.sort(key=lambda x: x.get("updated_at") or 0, reverse=True)
    return items[:limit]


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    return _read(session_id)


def append_turn(session_id: str, user_text: str, assistant_text: str,
                cards: Optional[List[dict]] = None,
                operations: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
    """追加一轮问答；会话不存在时自动创建。

    operations：本轮真实执行过的操作（一行一条，如「点击界面控件 · 确定」），
    Dony 应用的历史页会把它们列在回答下面，便于回看 Dony 到底做了什么。
    """
    session = _read(session_id) if session_id else None
    if not session:
        session = create_session(user_text)
        session_id = session["id"]
    now = time.time()
    if user_text:
        session["turns"].append({"role": "user", "content": user_text, "ts": now})
    if assistant_text or operations:
        turn: Dict[str, Any] = {"role": "assistant", "content": assistant_text, "ts": now}
        if cards:
            turn["cards"] = [
                {"title": c.get("title"), "subtitle": c.get("subtitle"), "kind": c.get("kind")}
                for c in cards[:6]
            ]
        if operations:
            # 上限留宽一点：命令类操作在 llm._op_text 里已经截过（80 字符），
            # 这里再截一次会把「运行命令 · …」的前缀也吃掉。
            turn["operations"] = [str(o)[:140] for o in operations[:40]]
        session["turns"].append(turn)
    if not session.get("title") or session["title"] == "新对话":
        session["title"] = (user_text or session["title"]).strip()[:40] or "新对话"
    return _write(session)


def rename_session(session_id: str, title: str) -> bool:
    session = _read(session_id)
    if not session:
        return False
    session["title"] = (title or "").strip()[:40] or session.get("title") or "未命名对话"
    _write(session)
    return True


def delete_session(session_id: str) -> bool:
    try:
        os.remove(_path(session_id))
        return True
    except OSError:
        return False


def delete_all_sessions() -> int:
    """清空全部历史会话，返回删除条数（设置应用的「清空 Dony 对话记录」）。"""
    ensure_dirs()
    removed = 0
    try:
        names = os.listdir(HISTORY_DIR)
    except OSError:
        return 0
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            os.remove(os.path.join(HISTORY_DIR, name))
            removed += 1
        except OSError:
            continue
    return removed


def history_for_model(session_id: str, max_turns: int = 20) -> List[Dict[str, str]]:
    """把历史记录转成模型可用的消息列表（只保留 user/assistant 文本）。"""
    session = _read(session_id)
    if not session:
        return []
    msgs: List[Dict[str, str]] = []
    for t in (session.get("turns") or [])[-max_turns * 2:]:
        role = t.get("role")
        content = t.get("content")
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": str(content)})
    return msgs
