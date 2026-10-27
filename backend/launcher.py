"""多服务统一入口：intelligentstudio-backend --service <name>

backend 由多个独立进程组成（agent / voice / photo / notification / office /
edge / appapi / main）。PyInstaller 需要单一入口，本脚本按 --service 参数
分发到对应服务，供 Electron 主进程或启动器拉起。
"""
from __future__ import annotations

import os
import sys

# Windows 中文系统的控制台/管道默认编码是 GBK；日志里的 ⚠（\u26a0）、→ 等符号会抛
# UnicodeEncodeError: 'gbk' codec can't encode character ... ，
# 直接把服务启动（如 office_bridge 的「⚠ 未找到证书」）或工具执行打断。
# 入口处强制把标准输出/错误切成 UTF-8，并用 errors=replace 兜底，绝不再因日志字符崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 顶层服务脚本（相对 backend 目录）
SERVICES = {
    "main": "main.py",
    "voice": "voice_server.py",
    "edge": "edge_bridge.py",
    "appapi": "dony_app_api.py",
    "notify": "notification_service.py",
    "office": "office_bridge.py",
    "photo": "photo_service.py",
}


def _backend_dir() -> str:
    if getattr(sys, "frozen", False):
        # PyInstaller：backend 源码随 --add-data 放在 _MEIPASS/backend
        return os.path.join(sys._MEIPASS, "backend")
    # 源码态：本文件位于 backend/ 目录下
    return os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    if "--service" not in sys.argv:
        print("usage: intelligentstudio-backend --service <name>", file=sys.stderr)
        print("services: " + ", ".join(list(SERVICES) + ["agent"]), file=sys.stderr)
        return 2

    name = sys.argv[sys.argv.index("--service") + 1]
    base = _backend_dir()
    # 让 notification / photo / agent 等子包可导入（脚本内多为绝对导入）
    sys.path.insert(0, base)

    # PyInstaller 会把 pywin32 的顶层模块收进 _internal/win32（含 lib、pywin32_system32），
    # 而源码写的是 `import win32gui`，需要把这些子目录显式加入 sys.path，否则运行时报
    # ModuleNotFoundError: No module named 'win32gui'（书写辅助的写回、UIA 等都依赖它）。
    if getattr(sys, "frozen", False):
        for sub in ("win32", os.path.join("win32", "lib"), "pywin32_system32"):
            p = os.path.join(sys._MEIPASS, sub)
            if os.path.isdir(p) and p not in sys.path:
                sys.path.insert(0, p)

    import runpy

    # agent_server 使用包内相对导入（from . import mcp），必须按模块运行
    if name == "agent":
        runpy.run_module("agent.agent_server", run_name="__main__")
        return 0

    if name not in SERVICES:
        print(f"unknown service: {name}", file=sys.stderr)
        return 2

    script = os.path.join(base, SERVICES[name])
    if not os.path.exists(script):
        print(f"missing script: {script}", file=sys.stderr)
        return 2

    runpy.run_path(script, run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
