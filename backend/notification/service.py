"""通知智能服务：编排监听、重要性判断、摘要防抖与事件推送。"""

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import config, summarizer, toast
from .classifier import classifier as importance_classifier
from .engine import QwenEngine
from .events import EventHub, encode
from .focus import FocusMonitor, FocusStatus
from .grouping import Grouping, session_key
from .listener import Incoming, NotificationListener


def _play_notification_sound() -> None:
    try:
        import winsound

        media = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Media")
        for name in ("Windows Notify System Generic.wav", "Windows Notify Messaging.wav"):
            path = os.path.join(media, name)
            if os.path.isfile(path):
                winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
                return
        winsound.MessageBeep(0x40)
    except Exception:
        pass


class NotificationService:
    def __init__(self) -> None:
        self.engine = QwenEngine()
        self.hub = EventHub()
        self.focus = FocusMonitor(config.FOCUS_POLL_SECONDS, self._on_focus_change)
        cfg = config.load(force=True)
        self.grouping = Grouping(cfg.threshold, cfg.window_seconds, config.DEDUPE_SECONDS)
        self.listener = NotificationListener(self._enqueue_batch)
        self.queue: asyncio.Queue[Incoming] = asyncio.Queue()
        self.timers: dict[str, asyncio.Task] = {}
        self.toast_ids: dict[str, int] = {}
        self._worker: Optional[asyncio.Task] = None
        self._housekeeping: Optional[asyncio.Task] = None
        self.started_at = 0.0

    async def start(self) -> None:
        self.started_at = time.time()
        print(f"[notify] service starting (config={config.CONFIG_FILE})", flush=True)
        ok, reason = await asyncio.to_thread(toast.ensure_shortcut)
        if not ok:
            print(f"[notify] toast disabled: {reason}", flush=True)
        cleaned = await asyncio.to_thread(toast.cleanup)
        if cleaned:
            print(f"[notify] removed {cleaned} stale toast(s)", flush=True)
        self.focus.start()
        await self.listener.start()
        self._worker = asyncio.create_task(self._run_worker())
        self._housekeeping = asyncio.create_task(self._run_housekeeping())

    async def stop(self) -> None:
        for task in [self._worker, self._housekeeping, *self.timers.values()]:
            if task is not None:
                task.cancel()
        self._worker = None
        self._housekeeping = None
        self.timers.clear()
        await self.focus.stop()
        await self.listener.stop()

    def _on_focus_change(self, status: FocusStatus) -> None:
        if status.active:
            return
        print("[notify] focus off -> smart dnd idle", flush=True)
        # 专注模式关闭且没有开启摘要时，模型已无用途：立即释放，不等空闲计时
        if not config.load().summary_enabled:
            asyncio.create_task(self.engine.unload())

    async def _enqueue_batch(self, items: list[Incoming]) -> None:
        for item in items:
            # 自己发出的摘要 Toast 也会出现在通知列表里；不过滤会形成「摘要的摘要」
            if item.aumid == config.AUMID:
                continue
            self.queue.put_nowait(item)

    async def _run_worker(self) -> None:
        while True:
            item = await self.queue.get()
            try:
                await self._process(item)
            except Exception as exc:
                print(f"[notify] process failed app={item.app}: {type(exc).__name__}: {exc}", flush=True)
            finally:
                self.queue.task_done()

    async def _process(self, item: Incoming) -> None:
        cfg = config.load()
        if not cfg.any_enabled:
            return
        self.grouping.threshold = cfg.threshold
        self.grouping.window_seconds = cfg.window_seconds
        print(
            f"[notify] new app={item.app} group={session_key(item)} "
            f"title_len={len(item.title)} dnd={cfg.dnd_enabled} summary={cfg.summary_enabled}",
            flush=True,
        )

        if cfg.dnd_enabled and self.focus.status.known and self.focus.status.active:
            started = time.perf_counter()
            important = await importance_classifier.classify(item, cfg.classify_timeout)
            cost = (time.perf_counter() - started) * 1000
            print(f"[notify] classify app={item.app} important={important} {cost:.0f}ms", flush=True)
            if important:
                await self._emit_important(item)

        if cfg.summary_enabled:
            self._note_for_summary(item, cfg)

    async def _emit_important(self, item: Incoming) -> None:
        _play_notification_sound()
        self.hub.publish({
            "type": "important",
            "id": item.id,
            "app": item.app,
            "title": item.title,
            "body": item.body,
            "at": time.time(),
            "aumid": item.aumid,
            "group": session_key(item),
        })

    def _note_for_summary(self, item: Incoming, cfg: config.Settings) -> None:
        result = self.grouping.add(item, time.time())
        if result.first:
            print(f"[notify] group reached threshold, summarizing group={result.key}", flush=True)
            self._schedule(result.key, 0.0)
        elif result.debounce:
            print(f"[notify] summary scheduled in {cfg.debounce_seconds:.0f}s group={result.key}", flush=True)
            self._schedule(result.key, cfg.debounce_seconds)

    def _schedule(self, key: str, delay: float) -> None:
        existing = self.timers.get(key)
        if existing is not None and not existing.done():
            existing.cancel()
        self.timers[key] = asyncio.create_task(self._delayed_summary(key, delay))

    async def _delayed_summary(self, key: str, delay: float) -> None:
        if delay > 0:
            await asyncio.sleep(delay)
        await self._summarize(key)

    async def _summarize(self, key: str) -> None:
        cfg = config.load()
        now = time.time()
        payload = self.grouping.begin(key, now)
        if payload is None:
            self.timers.pop(key, None)
            return
        group, old_summary, items = payload
        text = None
        if cfg.summary_enabled:
            started = time.perf_counter()
            text = await summarizer.summarize(
                self.engine, group.app, items, old_summary, cfg.summary_timeout,
            )
            print(
                f"[notify] summary app={group.app} items={len(items)} "
                f"ok={text is not None} {(time.perf_counter() - started):.2f}s",
                flush=True,
            )
        toast_id: Optional[int] = None
        reason = ""
        if text:
            title = f"{group.app} · 通知摘要"
            toast_id, reason = await asyncio.to_thread(
                toast.send_summary, title, text, key,
            )
            if toast_id:
                await asyncio.to_thread(toast.remove, self.toast_ids.get(key))
                self.toast_ids[key] = toast_id
            else:
                print(f"[notify] toast fallback: {reason}", flush=True)
        self.grouping.complete(key, text, text is not None, time.time(), consumed=items)
        self.timers.pop(key, None)
        print(
            f"[notify] summary done app={group.app} toast_id={toast_id} "
            f"toast_reason={reason or '-'} remaining={len(self.grouping.groups.get(key).delta) if key in self.grouping.groups else 0}",
            flush=True,
        )
        self.hub.publish({
            "type": "summary",
            "app": group.app,
            "group": key,
            "title": text or "",
            "count": len(items),
            "toast_ok": bool(toast_id),
            "reason": reason,
            "at": time.time(),
        })
        group = self.grouping.groups.get(key)
        if group is not None and group.delta:
            self._schedule(key, cfg.debounce_seconds)

    async def _run_housekeeping(self) -> None:
        while True:
            await asyncio.sleep(10)
            cfg = config.load()
            now = time.time()
            if not cfg.any_enabled:
                await self.engine.unload()
                await importance_classifier.unload()
            else:
                await self.engine.maybe_unload(now, cfg.idle_unload, cfg.max_hold)
                if not cfg.dnd_enabled or not self.focus.status.active:
                    await importance_classifier.maybe_unload(now, cfg.idle_unload)
            self.grouping.prune(now, config.GROUP_IDLE_SECONDS)

    def status(self) -> dict:
        cfg = config.load()
        return {
            "ok": True,
            "uptime": round(time.time() - self.started_at, 1),
            "config": {
                "dnd": cfg.dnd_enabled,
                "summary": cfg.summary_enabled,
                "threshold": cfg.threshold,
            },
            "focus": self.focus.status.to_dict(),
            "listener": {
                "running": self.listener.running,
                "baseline": self.listener.baseline_count,
                "error": self.listener.last_error,
            },
            "classifier": importance_classifier.status(),
            "model": self.engine.status(),
            "groups": list(self.grouping.snapshot()),
            "subscribers": self.hub.count,
            "queue": self.queue.qsize(),
        }


service = NotificationService()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await service.start()
    try:
        yield
    finally:
        await service.stop()


app = FastAPI(title="intelligentSTUDIO Notification Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "notification"}


@app.get("/api/status")
async def api_status():
    return service.status()


@app.post("/api/reload")
async def api_reload():
    config.load(force=True)
    return service.status()


@app.get("/api/events")
async def api_events():
    queue = service.hub.subscribe()

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield encode(payload)
        finally:
            service.hub.unsubscribe(queue)

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/api/test/classify")
async def api_test_classify(payload: Optional[dict] = None):
    """调试用：直接跑一次重要性判断，返回模型结论与耗时（不受专注模式限制）。"""
    data = payload or {}
    item = Incoming(
        id=int(time.time() * 1000),
        aumid=str(data.get("aumid", "test")),
        app=str(data.get("app", "测试应用")),
        title=str(data.get("title", "测试标题")),
        body=str(data.get("body", "测试内容")),
        created=time.time(),
    )
    cfg = config.load()
    started = time.perf_counter()
    important = await importance_classifier.classify(item, cfg.classify_timeout)
    return {
        "ok": important is not None,
        "important": important,
        "ms": round((time.perf_counter() - started) * 1000),
    }


@app.post("/api/test/notifications")
async def api_test_notifications(payload: Optional[dict] = None):
    """调试用：向流水线注入若干条假通知，用于验证归纳与摘要链路。"""
    data = payload or {}
    app = str(data.get("app", "测试应用"))
    try:
        count = int(data.get("count", 3))
    except (TypeError, ValueError):
        count = 3
    count = max(1, min(10, count))
    cfg = config.load()
    for index in range(count):
        service.queue.put_nowait(Incoming(
            id=int(time.time() * 1000) + index,
            aumid="test.app",
            app=app,
            title=f"{app} 测试会话",
            body=f"{data.get('body', '这条是用于验证摘要链路的测试通知。')}（第 {index + 1} 条）",
            created=time.time(),
        ))
    return {
        "ok": True, "queued": count,
        "summary_enabled": cfg.summary_enabled,
        "dnd_enabled": cfg.dnd_enabled,
    }


@app.post("/api/test/important")
async def api_test_important(payload: Optional[dict] = None):
    data = payload or {}
    item = Incoming(
        id=int(time.time() * 1000),
        aumid=str(data.get("aumid", config.AUMID)),
        app=str(data.get("app", "测试应用")),
        title=str(data.get("title", "测试通知")),
        body=str(data.get("body", "如果你看到这张卡片，说明弹窗链路正常。")),
        created=time.time(),
    )
    await service._emit_important(item)
    return {"ok": True, "subscribers": service.hub.count}
