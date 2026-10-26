"""计划任务 / 启动项 / 闹钟 / 计时器工具。"""
import asyncio
import json
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any, Dict


from .base import ToolResult, tool


# ---------- 计划任务（schtasks.exe） ----------
# 不用 win32com：这个 pywin32 版本里任务定义的接口绑定不可用
# （DaysInterval / IExecAction.Path 都设不上，Actions.Item 也拿不到具体接口），
# 会导致创建计划任务必然失败。schtasks 是系统自带命令，稳定且无需接口绑定。
_TASKS_JSON = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")),
                           "Dony", "scheduled_tasks.json")


def _schtasks(args):
    """执行 schtasks 并返回 (退出码, 输出)。

    输出必须按 Windows ANSI 代码页解码：进程环境里设了 PYTHONIOENCODING=utf-8，
    若用 text=True 会拿 UTF-8 去解中文（GBK）输出而报 UnicodeDecodeError，
    导致错误信息丢失。
    """
    import subprocess
    p = subprocess.run(["schtasks", *args], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    raw = (p.stdout or b"") + (p.stderr or b"")
    out = ""
    for enc in ("mbcs", "gbk", "utf-8"):
        try:
            out = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    else:
        out = raw.decode("utf-8", errors="replace")
    return p.returncode, out.strip()


def _load_created_tasks() -> Dict[str, Dict[str, str]]:
    """Dony 自己创建的任务定义（删除后按卡片开关重新启用时需要）。"""
    try:
        with open(_TASKS_JSON, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_created_tasks(data: Dict[str, Dict[str, str]]):
    try:
        os.makedirs(os.path.dirname(_TASKS_JSON), exist_ok=True)
        with open(_TASKS_JSON, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"[agent] 计划任务记录保存失败: {e}", flush=True)


def create_task_sync(name: str, time_str: str, command: str) -> str:
    """创建计划任务，返回首次执行时间（供工具与结果卡片开关复用）。"""
    if time_str.lower().startswith("once:"):
        dt = datetime.strptime(time_str[5:].strip(), "%Y-%m-%d %H:%M")
        args = ["/Create", "/TN", name, "/TR", command, "/SC", "ONCE",
                "/SD", dt.strftime("%Y/%m/%d"), "/ST", dt.strftime("%H:%M"), "/F"]
        start = dt.strftime("%Y-%m-%d %H:%M")
    else:
        dt = datetime.strptime(time_str, "%H:%M")
        args = ["/Create", "/TN", name, "/TR", command, "/SC", "DAILY",
                "/ST", dt.strftime("%H:%M"), "/F"]
        start = datetime.now().replace(hour=dt.hour, minute=dt.minute, second=0,
                                       microsecond=0)
        if start < datetime.now():
            start += timedelta(days=1)
        start = start.strftime("%Y-%m-%d %H:%M")
    code, out = _schtasks(args)
    if code != 0:
        raise RuntimeError(out[:200] or "schtasks 创建失败")
    data = _load_created_tasks()
    data[name] = {"time": time_str, "command": command}
    _save_created_tasks(data)
    return start


def task_spec_sync(name: str):
    """任务的 (time_str, command)：优先取 Dony 自己的记录（用于卡片开关重新启用）。"""
    item = _load_created_tasks().get(name)
    if item:
        return (item.get("time", ""), item.get("command", ""))
    return None


@tool("create_scheduled_task", "制定计划任务",
      "创建 Windows 计划任务。time 格式 HH:MM（每天执行）或 once:YYYY-MM-DD HH:MM（单次）；"
      "command 为要执行的程序或命令。",
      {"name": {"type": "string", "description": "任务名称", "required": True},
       "time": {"type": "string", "description": "HH:MM 或 once:YYYY-MM-DD HH:MM", "required": True},
       "command": {"type": "string", "description": "要执行的程序/命令", "required": True}})
async def create_scheduled_task(args: Dict[str, Any], ctx) -> ToolResult:
    name = args["name"].strip()
    time_str = args["time"].strip()
    command = args["command"]
    try:
        start = await asyncio.to_thread(create_task_sync, name, time_str, command)
    except Exception as e:
        return ToolResult(f"创建计划任务失败：{e}", ok=False)
    # 只声明卡片数据（kind + 状态 + 内容）；是否做成卡片由模型决定（show_card）
    return ToolResult(f"计划任务「{name}」已创建，将于 {start} 执行：{command}",
                      card={"kind": "task", "key": f"task:{name}", "state": True,
                            "subtitle": f"{name} · {start}"})


def delete_scheduled_task_sync(name: str) -> bool:
    code, _out = _schtasks(["/Delete", "/TN", name, "/F"])
    data = _load_created_tasks()
    if name in data:
        data.pop(name, None)
        _save_created_tasks(data)
    return code == 0


@tool("delete_scheduled_task", "删除计划任务",
      "按名称删除计划任务。",
      {"name": {"type": "string", "description": "任务名称", "required": True}})
async def delete_scheduled_task(args: Dict[str, Any], ctx) -> ToolResult:
    name = args["name"].strip()
    ok = await asyncio.to_thread(delete_scheduled_task_sync, name)
    if not ok:
        return ToolResult(f"未找到计划任务「{name}」", ok=False)
    return ToolResult(f"计划任务「{name}」已删除。")


# ---------- 启动项（注册表 Run 键） ----------
_RUN_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run"


def add_startup(name: str, command: str):
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_SZ, command)


def remove_startup(name: str) -> bool:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, name)
        return True
    except OSError:
        return False


def list_startup() -> Dict[str, str]:
    import winreg
    items = {}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY) as k:
            i = 0
            while True:
                try:
                    n, v, _ = winreg.EnumValue(k, i)
                    items[n] = v
                    i += 1
                except OSError:
                    break
    except OSError:
        pass
    return items


@tool("manage_startup", "管理启动项",
      "管理开机启动项。action: add(添加) / remove(移除) / list(列出)。",
      {"action": {"type": "string", "enum": ["add", "remove", "list"], "required": True},
       "name": {"type": "string", "description": "启动项名称"},
       "command": {"type": "string", "description": "add 时要启动的程序路径/命令"}})
async def manage_startup(args: Dict[str, Any], ctx) -> ToolResult:
    action = args["action"]
    if action == "list":
        items = await asyncio.to_thread(list_startup)
        lines = [f"{n}: {v}" for n, v in items.items()]
        return ToolResult(f"当前启动项（{len(items)} 个）：\n" + "\n".join(lines))
    name = (args.get("name") or "").strip()
    if not name:
        return ToolResult("缺少启动项名称", ok=False)
    if action == "add":
        command = args.get("command") or ""
        await asyncio.to_thread(add_startup, name, command)
        return ToolResult(f"启动项「{name}」已添加：{command}",
                          card={"kind": "startup", "key": f"startup:{name}", "state": True,
                                "subtitle": name})
    ok = await asyncio.to_thread(remove_startup, name)
    if not ok:
        return ToolResult(f"未找到启动项「{name}」", ok=False)
    return ToolResult(f"启动项「{name}」已移除。")


# ---------- 闹钟 / 计时器 ----------
def _parse_time_to_ts(time_str: str) -> float:
    """HH:MM / 相对描述（如 '30分钟后' 已由模型换算为 HH:MM）→ 今天或明天的时间戳。"""
    dt = datetime.strptime(time_str.strip(), "%H:%M")
    target = datetime.now().replace(hour=dt.hour, minute=dt.minute, second=0, microsecond=0)
    if target <= datetime.now():
        target += timedelta(days=1)
    return target.timestamp()


def _parse_duration(text: str) -> int:
    """解析时长描述为秒：'90' / '90秒' / '5分钟' / '1小时30分钟' / '01:30'。"""
    t = text.strip()
    if re.fullmatch(r"\d+", t):
        return int(t)
    m = re.fullmatch(r"(\d+):(\d{1,2})(?::(\d{1,2}))?", t)
    if m:
        h_or_m = int(m.group(1))
        if m.group(3) is not None:
            return h_or_m * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return h_or_m * 60 + int(m.group(2))
    total = 0
    for num, unit in re.findall(r"(\d+)\s*(小时|分钟|分|秒|h|m|s)", t):
        n = int(num)
        if unit in ("小时", "h"):
            total += n * 3600
        elif unit in ("分钟", "分", "m"):
            total += n * 60
        else:
            total += n
    if total == 0:
        raise ValueError(f"无法解析时长：{text}")
    return total


@tool("set_alarm", "设定闹钟",
      "设定闹钟，到点时屏幕顶部弹出提醒。time 格式 HH:MM（24小时制，若时间已过则定为明天）。",
      {"time": {"type": "string", "description": "响铃时间 HH:MM", "required": True},
       "label": {"type": "string", "description": "备注（可空）"}})
async def set_alarm(args: Dict[str, Any], ctx) -> ToolResult:
    try:
        fire_at = _parse_time_to_ts(args["time"])
    except ValueError:
        return ToolResult(f"无法解析时间：{args['time']}，请使用 HH:MM 格式", ok=False)
    label = args.get("label") or ""
    item = await ctx.session.server.alarms.set_alarm(fire_at, label)
    when = datetime.fromtimestamp(fire_at).strftime("%H:%M")
    # 时间由卡片自己显示（主标题「闹钟」，副标题是响铃时间）
    return ToolResult(f"闹钟已设定为 {when}" + (f"（{label}）" if label else "") + "。",
                      card={"kind": "alarm", "key": f"alarm:{item['id']}", "state": True,
                            "when": when})


@tool("set_timer", "设定计时器",
      "设定倒计时。duration 支持 秒数 / '5分钟' / '1小时30分钟' / '05:00'。同时只能运行一个计时器。",
      {"duration": {"type": "string", "description": "时长，如 '5分钟'、'300'、'05:00'", "required": True}})
async def set_timer(args: Dict[str, Any], ctx) -> ToolResult:
    try:
        secs = _parse_duration(args["duration"])
    except ValueError as e:
        return ToolResult(str(e), ok=False)
    if secs <= 0 or secs > 24 * 3600:
        return ToolResult("时长需在 1 秒到 24 小时之间", ok=False)
    item = await ctx.session.server.alarms.set_timer(secs)
    mins, s = divmod(secs, 60)
    text_dur = f"{mins}分{s}秒" if mins else f"{s}秒"
    # ends_at 交给卡片：前端按它实时走秒（副标题是剩余时间，不是标题的一部分）
    return ToolResult(f"计时器已设定：{text_dur}。",
                      card={"kind": "timer", "key": f"timer:{item['id']}", "state": True,
                            "ends_at": item.get("fire_at")})
