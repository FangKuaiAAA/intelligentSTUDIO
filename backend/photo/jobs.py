"""内存任务表：三维重建这类长任务通过任务号轮询状态与结果。"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class JobRecord:
    id: str
    state: str = "running"          # running | done | failed | cancelled
    stage: str = "准备中"
    progress: float = 0.0
    result: Optional[bytes] = None
    meta: dict = field(default_factory=dict)
    error: Optional[str] = None
    cancelled: bool = False
    created_at: float = field(default_factory=time.time)


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._lock = threading.Lock()

    def submit(self, name: str, work: Callable[[JobRecord], tuple[bytes, dict]]) -> str:
        job_id = uuid.uuid4().hex
        record = JobRecord(id=job_id, stage=name)

        with self._lock:
            self._jobs[job_id] = record
            self._trim()

        def runner() -> None:
            try:
                data, meta = work(record)
                if record.cancelled:
                    record.state = "cancelled"
                    return
                record.result = data
                record.meta = meta
                record.progress = 1.0
                record.stage = "完成"
                record.state = "done"
            except Exception as exc:  # pragma: no cover - 交由界面提示
                record.state = "failed"
                record.error = str(exc)
                record.stage = "失败"
                traceback.print_exc()

        threading.Thread(target=runner, daemon=True).start()
        return job_id

    def get(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.state != "running":
                return False
            record.cancelled = True
            record.state = "cancelled"
            record.stage = "已取消"
            return True

    def _trim(self) -> None:
        if len(self._jobs) <= 24:
            return
        ordered = sorted(self._jobs.values(), key=lambda item: item.created_at)
        for record in ordered[: len(self._jobs) - 24]:
            self._jobs.pop(record.id, None)
