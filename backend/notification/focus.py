"""系统专注模式（勿扰）状态读取。

只读，不修改系统设置。三条来源按优先级尝试：
1. WNF_SHEL_QUIETMODE_STATE_CHANGE（Windows 11 勿扰开关）
2. FocusSessionManager.IsFocusActive（专注会话）
3. SHQueryUserNotificationState == QUNS_QUIET_TIME（旧版安静时间）

全部不可用时状态为 unknown，按「关闭」处理。
"""

import asyncio
import ctypes
import time
from dataclasses import dataclass, replace
from typing import Callable, Optional

# Focus Assist / 勿扰的「当前生效配置」：WNF_STATE_NAME{0xA3BF1C75, 0x0D83063E}
# 数据为 DWORD：0=关闭，1=仅优先事项，2=仅闹钟。未文档化，需降级兜底。
WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE = 0x0D83063EA3BF1C75
QUNS_QUIET_TIME = 6


class _WnfStateName(ctypes.Structure):
    _fields_ = [("Data", ctypes.c_ulonglong)]


def _read_wnf() -> Optional[bool]:
    try:
        ntdll = ctypes.WinDLL("ntdll")
        query = ntdll.NtQueryWnfStateData
        query.restype = ctypes.c_long
        query.argtypes = [
            ctypes.POINTER(_WnfStateName),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ulong),
        ]
        name = _WnfStateName(WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE)
        buffer = ctypes.create_string_buffer(8)
        size = ctypes.c_ulong(8)
        stamp = ctypes.c_ulong(0)
        status = query(
            ctypes.byref(name), None, None, ctypes.byref(stamp),
            ctypes.cast(buffer, ctypes.c_void_p), ctypes.byref(size),
        )
        # 有效值为 4 字节 DWORD：0 关闭，1 仅优先事项，2 仅闹钟
        if status == 0 and size.value >= 4:
            profile = int.from_bytes(buffer.raw[:4], "little")
            if profile in (0, 1, 2):
                return profile != 0
    except Exception:
        pass
    return None


def _read_focus_session() -> Optional[bool]:
    try:
        from winsdk.windows.ui.shell import FocusSessionManager

        return bool(FocusSessionManager.get_default().is_focus_active)
    except Exception:
        return None


def _read_shell_state() -> Optional[bool]:
    try:
        state = ctypes.c_int(0)
        ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state))
        if state.value <= 0:
            return None
        return state.value == QUNS_QUIET_TIME
    except Exception:
        return None


def read_focus() -> tuple[Optional[bool], str]:
    """返回 (是否专注, 来源)。值为 None 表示来源不可用。

    SHQueryUserNotificationState 是文档化接口，能明确区分「接受通知」与
    「安静时间」，因此作为主来源；WNF 与专注会话只在它不可用时兜底。
    """
    for reader, source in (
        (_read_wnf, "wnf"),
        (_read_shell_state, "shell_state"),
        (_read_focus_session, "focus_session"),
    ):
        value = reader()
        if value is not None:
            return value, source
    return None, "none"


@dataclass(frozen=True)
class FocusStatus:
    active: bool = False
    known: bool = False
    source: str = "none"
    checked_at: float = 0.0

    def to_dict(self) -> dict:
        return {
            "active": self.active,
            "known": self.known,
            "source": self.source,
            "checked_at": self.checked_at,
        }


class FocusMonitor:
    """每 5 秒轮询一次；变化时回调，避免每个通知都查系统接口。"""

    def __init__(self, interval: float, on_change: Optional[Callable[[FocusStatus], None]] = None):
        self._interval = interval
        self._on_change = on_change
        self._status = FocusStatus()
        self._task: Optional[asyncio.Task] = None

    @property
    def status(self) -> FocusStatus:
        return self._status

    def poll_once(self) -> FocusStatus:
        active, source = read_focus()
        status = FocusStatus(
            active=bool(active), known=active is not None,
            source=source, checked_at=time.time(),
        )
        changed = (status.active, status.known, status.source) != (
            self._status.active, self._status.known, self._status.source,
        )
        self._status = status
        if changed:
            print(
                f"[notify] focus active={status.active} known={status.known} source={status.source}",
                flush=True,
            )
            if self._on_change:
                try:
                    self._on_change(status)
                except Exception as exc:
                    print(f"[notify] focus callback failed: {exc}", flush=True)
        return status

    async def run(self) -> None:
        self.poll_once()
        while True:
            await asyncio.sleep(self._interval)
            self.poll_once()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
