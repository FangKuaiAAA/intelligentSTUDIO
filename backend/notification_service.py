"""通知智能服务入口：python backend/notification_service.py

Electron 主进程负责拉起与接管本进程；设置页通过 /api/status 读取状态。
"""

import os
import socket
import sys
import time

from notification import config

# ⚠ 日志不能写在项目/安装目录：装到 Program Files 后那里不可写，等于没有日志。
# 统一落到用户目录 %LOCALAPPDATA%\IntelligentStudio\通知\log.txt（与其他 STUIDO 应用一致）。
LOG_PATH = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "IntelligentStudio", "通知", "log.txt",
)
LOG_LIMIT = 2 * 1024 * 1024


class _Tee:
    """控制台与日志文件同时写：Electron 收 stdout，用户也能直接看用户目录下的 log.txt。"""

    def __init__(self, stream, handle):
        self._stream = stream
        self._handle = handle

    def write(self, data):
        try:
            self._handle.write(data)
            self._handle.flush()
        except Exception:
            pass
        return self._stream.write(data)

    def flush(self):
        try:
            self._handle.flush()
        except Exception:
            pass
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def setup_logging() -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        if os.path.isfile(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_LIMIT:
            backup = LOG_PATH + ".1"
            try:
                os.replace(LOG_PATH, backup)
            except OSError:
                os.remove(LOG_PATH)
        handle = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        sys.stdout = _Tee(sys.stdout, handle)
        sys.stderr = _Tee(sys.stderr, handle)
        print(f"\n===== notification service start {time.strftime('%Y-%m-%d %H:%M:%S')} =====", flush=True)
    except Exception as exc:
        print(f"[notify] log file unavailable: {exc}", flush=True)


def port_in_use(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        return probe.connect_ex(("127.0.0.1", port)) == 0
    finally:
        probe.close()


def main() -> None:
    setup_logging()
    import uvicorn

    from notification.service import app

    if port_in_use(config.PORT):
        print(f"[notify] {config.PORT} 已在运行，本次启动跳过", flush=True)
        return
    print(
        f"[notify] http://127.0.0.1:{config.PORT} model={config.MODEL_DIR}",
        flush=True,
    )
    uvicorn.run(app, host="127.0.0.1", port=config.PORT, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
