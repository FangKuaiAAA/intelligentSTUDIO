"""工具包：导入即注册全部工具。"""
import importlib
import traceback

for _mod in ("files", "system", "scheduler", "shell_input", "web", "memory", "uia_screen", "skills"):
    try:
        importlib.import_module(f".{_mod}", __package__)
    except Exception:
        print(f"[agent] tool module {_mod} load failed:", flush=True)
        traceback.print_exc()
