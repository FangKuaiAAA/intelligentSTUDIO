"""SSE 事件总线：把重要通知与摘要结果推给 Electron 主进程。"""

import asyncio
import json
from typing import Any


class EventHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    @property
    def count(self) -> int:
        return len(self._subscribers)

    def publish(self, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass


def encode(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
