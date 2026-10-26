"""系统通知监听：启动基线、事件触发 + 3 秒兜底轮询、文本提取。

winsdk 的 IAsyncOperation 不能直接 await，需轮询 status 后取结果；
事件回调发生在 WinRT 线程，统一经 call_soon_threadsafe 投递回事件循环。
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

POLL_SECONDS = 1.5


@dataclass(frozen=True)
class Incoming:
    id: int
    aumid: str
    app: str
    title: str
    body: str
    created: float

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.body}".strip()


def _wait_operation(operation, timeout: float = 6.0):
    deadline = time.time() + timeout
    while operation.status == 0 and time.time() < deadline:
        time.sleep(0.01)
    if operation.status != 1:
        raise RuntimeError(f"async operation failed: status={operation.status}")
    return operation.get_results()


def _binding_texts(notification) -> list[str]:
    visual = notification.notification.visual
    if visual is None:
        return []
    bindings = visual.bindings
    if not bindings:
        return []
    texts: list[str] = []
    for element in bindings[0].get_text_elements():
        value = (element.text or "").strip()
        if value:
            texts.append(value)
    return texts


def extract(notification) -> Incoming:
    app = "未知应用"
    aumid = ""
    try:
        info = notification.app_info
        if info is not None:
            aumid = info.app_user_model_id or ""
            if info.display_info is not None:
                app = info.display_info.display_name or app
    except Exception:
        pass
    texts = _binding_texts(notification)
    title = texts[0] if texts else app
    body = "\n".join(texts[1:]) if len(texts) > 1 else ""
    try:
        created = notification.creation_time.timestamp()
    except Exception:
        created = time.time()
    return Incoming(
        id=int(notification.id), aumid=aumid, app=app,
        title=title, body=body, created=created,
    )


def _snapshot_sync() -> list[Incoming]:
    from winsdk.windows.ui.notifications import NotificationKinds
    from winsdk.windows.ui.notifications.management import UserNotificationListener

    listener = UserNotificationListener.current
    operation = listener.get_notifications_async(NotificationKinds.TOAST)
    items = _wait_operation(operation)
    result: list[Incoming] = []
    for item in items:
        try:
            incoming = extract(item)
            if not incoming.aumid:
                # 新注册 AUMID 的首条通知，app_info 可能还没就绪：按 ID 重取几次。
                for _ in range(4):
                    time.sleep(0.15)
                    fresh = listener.get_notification(int(item.id))
                    if fresh is None:
                        continue
                    incoming = extract(fresh)
                    if incoming.aumid:
                        break
            result.append(incoming)
        except Exception as exc:
            print(f"[notify] extract failed: {type(exc).__name__}", flush=True)
    return result


class NotificationListener:
    """只负责「有新通知」这件事；分组、推理与弹窗在 service 里编排。"""

    def __init__(self, on_batch: Callable[[list[Incoming]], Awaitable[None]]):
        self._on_batch = on_batch
        self._seen: set[int] = set()
        self._wake = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._token = None
        self._listener = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.baseline_count = 0
        self.running = False
        self.last_error = ""

    def _kick(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._wake.set)

    def _on_changed(self, _sender, _args) -> None:
        self._kick()

    async def start(self) -> None:
        from winsdk.windows.ui.notifications.management import UserNotificationListener

        self._loop = asyncio.get_running_loop()
        self._listener = UserNotificationListener.current
        try:
            baseline = await asyncio.to_thread(_snapshot_sync)
            self._seen = {item.id for item in baseline}
            self.baseline_count = len(self._seen)
            print(f"[notify] baseline={self.baseline_count} (历史通知不参与归纳)", flush=True)
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            print(f"[notify] baseline failed: {self.last_error}", flush=True)
        try:
            self._token = self._listener.add_notification_changed(self._on_changed)
        except Exception as exc:
            # 未打包应用订阅变更事件常返回 ELEMENT_NOT_FOUND；轮询仍可完整覆盖，
            # 因此不计为错误，只记录一次降级原因。
            print(
                f"[notify] 事件订阅不可用，改用 {POLL_SECONDS:g}s 轮询：{type(exc).__name__}",
                flush=True,
            )
        self.running = True
        self._task = asyncio.create_task(self._loop_poll())

    async def _loop_poll(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()
            try:
                items = await asyncio.to_thread(_snapshot_sync)
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                continue
            current = {item.id for item in items}
            fresh = [item for item in items if item.id not in self._seen]
            self._seen = current
            self.last_error = ""
            if fresh:
                fresh.sort(key=lambda n: n.created)
                try:
                    await self._on_batch(fresh)
                except Exception as exc:
                    print(f"[notify] batch handler failed: {type(exc).__name__}: {exc}", flush=True)

    async def stop(self) -> None:
        self.running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._listener is not None and self._token is not None:
            try:
                self._listener.remove_notification_changed(self._token)
            except Exception:
                pass
        self._token = None
        self._listener = None
