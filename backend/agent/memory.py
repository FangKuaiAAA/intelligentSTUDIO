"""Dony 的长期记忆：%APPDATA%\\Dony\\memory.json

只记少量稳定、以后再对话还用得上的信息（地区、偏好、机器情况），
每轮对话会把它注入系统提示词；同 key 覆盖旧值，条数与长度都有上限。

记忆属于使用者本人，不随程序打包分发：发布前用 npm run clean:memory
（scripts/clear-memory.js）清空，该文件也不在项目目录内。
"""
import json
import os
import threading
from typing import Any, Dict, List, Optional

from . import store

MEMORY_FILE = os.path.join(store.DONY_DIR, "memory.json")
MAX_ITEMS = 30             # 最多记多少条
MAX_ITEM_CHARS = 200       # 单条内容上限
MAX_PROMPT_CHARS = 1200    # 注入提示词的总长度上限

_lock = threading.RLock()
_cache: Optional[List[Dict[str, str]]] = None
_cache_mtime: float = 0.0


def load() -> List[Dict[str, str]]:
    """读取全部记忆；文件被改动后自动重新加载（无需重启）。"""
    global _cache, _cache_mtime
    with _lock:
        try:
            mtime = os.path.getmtime(MEMORY_FILE)
        except OSError:
            _cache, _cache_mtime = [], 0.0
            return []
        if _cache is not None and mtime == _cache_mtime:
            return [dict(i) for i in _cache]
        items: List[Dict[str, str]] = []
        try:
            with open(MEMORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            raw = data.get("items") if isinstance(data, dict) else data
            for it in raw or []:
                if not isinstance(it, dict):
                    continue
                text = str(it.get("text") or "").strip()
                if text:
                    items.append({"key": str(it.get("key") or "").strip(), "text": text})
        except (OSError, ValueError):
            items = []
        _cache, _cache_mtime = items[:MAX_ITEMS], mtime
        return [dict(i) for i in _cache]


def _save(items: List[Dict[str, str]]) -> None:
    store.ensure_dirs()
    tmp = MEMORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MEMORY_FILE)


def remember(text: str, key: str = "") -> Dict[str, Any]:
    """记住一条信息；给了 key 就覆盖同 key 的旧内容。"""
    text = " ".join(str(text or "").split())[:MAX_ITEM_CHARS]
    key = str(key or "").strip()[:30]
    if not text:
        return {"ok": False, "reason": "内容为空"}
    with _lock:
        items = load()
        replaced = False
        if key:
            for it in items:
                if it["key"] == key:
                    it["text"] = text
                    replaced = True
                    break
        if not replaced:
            if len(items) >= MAX_ITEMS:
                return {"ok": False, "reason": f"记忆已满（最多 {MAX_ITEMS} 条），先忘记不用的"}
            items.append({"key": key, "text": text})
        _save(items)
        _forget_cache()
        return {"ok": True, "replaced": replaced, "key": key, "count": len(items)}


def forget(key: str = "", text: str = "") -> Dict[str, Any]:
    """忘记一条：优先按 key 匹配，其次按内容包含关系匹配。"""
    key = str(key or "").strip()
    text = str(text or "").strip()
    if not key and not text:
        return {"ok": False, "reason": "要指定 key 或内容"}
    with _lock:
        items = load()
        kept, removed = [], []
        for it in items:
            hit = (key and it["key"] == key) or (text and text in it["text"])
            (removed if hit else kept).append(it)
        if not removed:
            return {"ok": False, "reason": "没有找到匹配的记忆"}
        _save(kept)
        _forget_cache()
        return {"ok": True, "removed": [i["text"] for i in removed], "count": len(kept)}


def clear() -> int:
    """清空全部记忆，返回清掉的条数。"""
    with _lock:
        count = len(load())
        if os.path.exists(MEMORY_FILE):
            try:
                os.remove(MEMORY_FILE)
            except OSError:
                pass
        _forget_cache()
        return count


def _forget_cache() -> None:
    global _cache, _cache_mtime
    _cache, _cache_mtime = None, 0.0


def as_prompt() -> str:
    """把记忆整理成注入系统提示词的一段话；没有记忆时返回空串。"""
    items = load()
    if not items:
        return ""
    lines: List[str] = []
    used = 0
    for it in items:
        line = f"  · {it['key']}：{it['text']}" if it["key"] else f"  · {it['text']}"
        if used + len(line) > MAX_PROMPT_CHARS:
            break
        used += len(line)
        lines.append(line)
    return ("关于用户与他这台电脑的已知信息（长期记忆，供参考，不要主动复述给用户；"
            "有变化就用 remember 更新，过时了就用 forget 删掉）：\n" + "\n".join(lines))


if __name__ == "__main__":
    import sys
    if "--clear" in sys.argv:
        print(f"已清空 {clear()} 条记忆（{MEMORY_FILE}）")
    else:
        for i in load():
            print(f"[{i['key'] or '-'}] {i['text']}")
