"""通知分组、滑动窗口、5 秒去重与摘要状态机。

纯内存状态，不依赖模型与 Windows 接口，便于离线自测。
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Optional

from .listener import Incoming

_PUNCT = re.compile(r"[\s\u3000·•,，.。!！?？:：;；\"'“”‘’()（）\[\]【】<>《》/\\|~`@#$%^&*_+=-]+")
MAX_DELTA = 30


def _normalize(text: str, limit: int = 24) -> str:
    cleaned = _PUNCT.sub("", unicodedata.normalize("NFKC", text or ""))
    return cleaned[:limit]


def session_key(item: Incoming) -> str:
    """按应用分组。

    最初按「应用 + 标题（发送者）」分组，但同一应用的不同标题会把 3 条通知拆成
    2+1，永远到不了阈值。现在只按应用分组，标题仍写进摘要输入，既符合用户预期，
    也避免因标题差异导致摘要不触发。
    """
    return item.aumid or _normalize(item.app) or "default"


def dedupe_key(item: Incoming) -> str:
    return f"{item.aumid}|{_normalize(item.title, 60)}|{_normalize(item.body, 120)}"


@dataclass
class Group:
    key: str
    app: str
    aumid: str
    items: list[Incoming] = field(default_factory=list)
    delta: list[Incoming] = field(default_factory=list)
    count: int = 0
    summary: Optional[str] = None
    summarizing: bool = False
    last_event_at: float = 0.0
    last_summary_at: float = 0.0

    @property
    def delta_since_summary(self) -> int:
        return len(self.delta)


@dataclass(frozen=True)
class AddResult:
    key: str
    first: bool
    debounce: bool
    duplicate: bool


class Grouping:
    def __init__(self, threshold: int, window_seconds: float, dedupe_seconds: float):
        self.threshold = threshold
        self.window_seconds = window_seconds
        self.dedupe_seconds = dedupe_seconds
        self.groups: dict[str, Group] = {}
        self._recent: dict[str, float] = {}

    def _prune_window(self, group: Group, now: float) -> None:
        limit = now - self.window_seconds
        group.items = [item for item in group.items if item.created >= limit]

    def add(self, item: Incoming, now: float) -> AddResult:
        key = session_key(item)
        signature = dedupe_key(item)
        last = self._recent.get(signature)
        duplicate = last is not None and (now - last) <= self.dedupe_seconds
        group = self.groups.get(key)
        if group is None:
            group = Group(key=key, app=item.app, aumid=item.aumid)
            self.groups[key] = group

        if duplicate:
            group.count += 1
            group.last_event_at = now
            return AddResult(key=key, first=False, debounce=False, duplicate=True)

        self._recent[signature] = now
        group.items.append(item)
        group.delta.append(item)
        if len(group.delta) > MAX_DELTA:
            del group.delta[:-MAX_DELTA]
        group.count += 1
        group.last_event_at = now
        self._prune_window(group, now)

        if group.summarizing:
            return AddResult(key=key, first=False, debounce=False, duplicate=False)
        if group.summary is None:
            if group.count >= self.threshold:
                group.summarizing = True
                return AddResult(key=key, first=True, debounce=False, duplicate=False)
            return AddResult(key=key, first=False, debounce=False, duplicate=False)

        # 已有摘要：等静默后再增量重生成，期间只累计
        return AddResult(key=key, first=False, debounce=True, duplicate=False)

    def begin(self, key: str, now: float) -> Optional[tuple[Group, Optional[str], list[Incoming]]]:
        group = self.groups.get(key)
        if group is None or not group.delta:
            return None
        group.summarizing = True
        group.last_summary_at = now
        return group, group.summary, list(group.delta)

    def complete(self, key: str, text: Optional[str], ok: bool, now: float,
                 consumed: Optional[list[Incoming]] = None) -> None:
        group = self.groups.get(key)
        if group is None:
            return
        group.summarizing = False
        group.last_summary_at = now
        if not ok or not text:
            return
        group.summary = text
        if consumed:
            used = {item.id for item in consumed}
            group.delta = [item for item in group.delta if item.id not in used]
        else:
            group.delta.clear()
        group.count = 0

    def prune(self, now: float, idle_seconds: float) -> list[str]:
        stale = [
            key for key, group in self.groups.items()
            if not group.summarizing and group.delta_since_summary == 0
            and (now - group.last_event_at) > idle_seconds
        ]
        for key in stale:
            self.groups.pop(key, None)
        if len(self._recent) > 512:
            limit = now - self.dedupe_seconds * 4
            self._recent = {k: v for k, v in self._recent.items() if v >= limit}
        return stale

    def snapshot(self) -> Iterable[dict]:
        for group in self.groups.values():
            yield {
                "key": group.key,
                "app": group.app,
                "count": group.count,
                "summary": group.summary,
                "pending": len(group.delta),
            }
