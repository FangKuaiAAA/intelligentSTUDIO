"""Windows 系统级直接操作：系统状态、无线开关、音量亮度、剪贴板、窗口、设备、APP管理。"""
import asyncio
import os
import re
import subprocess
from typing import Any, Dict, Optional

from .base import ToolResult, tool


# ---------- 系统状态 ----------
@tool("get_system_status", "读取系统状态",
      "读取电脑运行状态：CPU/内存/硬盘占用等。",
      {})
async def get_system_status(args: Dict[str, Any], ctx) -> ToolResult:
    import psutil
    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("C:\\")
    text = (f"CPU 占用 {cpu:.0f}%；内存 {mem.percent:.0f}%（已用 {mem.used//2**30}GB/{mem.total//2**30}GB）；"
            f"C盘 {disk.percent:.0f}%（剩余 {disk.free//2**30}GB）")
    # 系统状态卡片的标题固定是「系统状态」，指标放副标题（小字）
    return ToolResult(text, card={
        "kind": "status",
        "subtitle": f"CPU {cpu:.0f}% · 内存 {mem.percent:.0f}% · C 盘剩余 {disk.free//2**30}GB"})


# ---------- WiFi / 蓝牙（WinRT Radios，通过 winsdk 直接调用） ----------
def _radio_kind(kind: str):
    """winsdk 里 WiFi 成员名为 WI_FI，这里兼容两种命名。"""
    from winsdk.windows.devices.radios import RadioKind
    members = ("WI_FI", "WIFI") if kind == "wifi" else ("BLUETOOTH",)
    for name in members:
        if hasattr(RadioKind, name):
            return getattr(RadioKind, name)
    raise RuntimeError(f"未知无线类型：{kind}")


async def _find_radios(kind: str):
    """返回指定类型的无线设备列表（WiFi / 蓝牙）。"""
    from winsdk.windows.devices.radios import Radio
    want = _radio_kind(kind)
    return [r for r in await Radio.get_radios_async() if r.kind == want]


async def _radio_state() -> str:
    """读取所有无线设备及其状态（诊断/回读用）。"""
    from winsdk.windows.devices.radios import Radio
    lines = []
    for r in await Radio.get_radios_async():
        try:
            lines.append(f"{r.kind.name}:{r.state.name}")
        except Exception:
            lines.append(f"{r.kind}:{r.state}")
    return "\n".join(lines)


@tool("set_radio", "更改无线开关",
      "打开或关闭 WiFi / 蓝牙。kind: wifi 或 bluetooth；on: true 打开，false 关闭。",
      {"kind": {"type": "string", "enum": ["wifi", "bluetooth"], "required": True},
       "on": {"type": "boolean", "required": True}})
async def set_radio(args: Dict[str, Any], ctx) -> ToolResult:
    kind = args["kind"]
    on = bool(args["on"])
    label = "WiFi" if kind == "wifi" else "蓝牙"
    try:
        from winsdk.windows.devices.radios import RadioAccessStatus, RadioState
        radios = await _find_radios(kind)
        if not radios:
            return ToolResult(f"未找到{label}设备", ok=False)
        want = RadioState.ON if on else RadioState.OFF
        for r in radios:
            status = await r.set_state_async(want)
            if status != RadioAccessStatus.ALLOWED:
                return ToolResult(f"{label}开关被系统拒绝：{status}", ok=False)
        # 回读确认，避免"报告成功但实际没生效"
        actual_on = all(r.state == want for r in await _find_radios(kind))
    except Exception as e:
        return ToolResult(f"更改{label}开关失败：{type(e).__name__}: {e}", ok=False)
    if not actual_on:
        return ToolResult(f"{label}状态未能切换（可能受系统策略或硬件开关限制）。", ok=False)
    # 卡片标题写「对象本身」（WiFi / 蓝牙），状态放副标题；标题不能出现动作词
    return ToolResult(f"{label}已{'打开' if on else '关闭'}。"
                      f"（如要展示卡片：kind={kind}，title 建议「{label}」，"
                      f"subtitle 建议「已{'打开' if on else '关闭'}」，需带开关）",
                      toggle={"key": kind, "on": on})


# ---------- 音量 / 亮度 ----------
def _endpoint_volume():
    """在新线程内初始化 COM 并取到主输出设备的 IAudioEndpointVolume。"""
    import comtypes
    from pycaw.pycaw import AudioUtilities
    comtypes.CoInitialize()
    try:
        return AudioUtilities.GetSpeakers().EndpointVolume
    except Exception:
        comtypes.CoUninitialize()
        raise


def _volume_sync(level: Optional[int] = None) -> int:
    """读取主音量（%）；传入 level 时先设置再回读（0=静音，>0 自动解除静音）。"""
    vol = _endpoint_volume()
    try:
        if level is not None:
            vol.SetMasterVolumeLevelScalar(level / 100.0, None)
            vol.SetMute(level == 0, None)
        return round(vol.GetMasterVolumeLevelScalar() * 100)
    finally:
        import comtypes
        comtypes.CoUninitialize()


def _set_mute_sync(mute: bool) -> None:
    """静音/取消静音（取消静音时若音量为 0，恢复到 30% 以便听见）。"""
    vol = _endpoint_volume()
    try:
        vol.SetMute(mute, None)
        if not mute and vol.GetMasterVolumeLevelScalar() <= 0.0:
            vol.SetMasterVolumeLevelScalar(0.3, None)
    finally:
        import comtypes
        comtypes.CoUninitialize()


@tool("set_volume", "调节音量",
      "设置系统音量。level: 0-100（0 表示静音，大于 0 会自动解除静音）。",
      {"level": {"type": "integer", "description": "音量 0-100", "required": True}})
async def set_volume(args: Dict[str, Any], ctx) -> ToolResult:
    level = max(0, min(100, int(args["level"])))
    try:
        actual = await asyncio.to_thread(_volume_sync, level)
    except Exception as e:
        return ToolResult(f"调节音量失败：{type(e).__name__}: {e}", ok=False)
    if actual != level:
        return ToolResult(f"音量设置未生效（当前 {actual}%）。", ok=False)
    text = f"音量已调至 {actual}%。" if level > 0 else "已静音。"
    # 音量卡片是**滑块**：把当前数值交给卡片（副标题与滑块位置都由它来）
    return ToolResult(text, card={"kind": "volume", "value": actual})


def _wmi_brightness(level: Optional[int] = None) -> int:
    """笔记本内置屏：WMI（系统亮度接口）。"""
    import wmi
    w = wmi.WMI(namespace="wmi")
    monitors = w.WmiMonitorBrightness()
    if not monitors:
        raise RuntimeError("WMI 亮度接口不可用（外接显示器/台式机常见）")
    if level is not None:
        methods = w.WmiMonitorBrightnessMethods()
        if not methods:
            raise RuntimeError("未找到支持亮度写入的显示器")
        methods[0].WmiSetBrightness(level, 0)
        return level
    return int(monitors[0].CurrentBrightness)


def _monitor_handles():
    """枚举所有显示器的 HMONITOR（DDC/CI 用）。"""
    import ctypes
    from ctypes import wintypes
    handles = []
    proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HMONITOR, wintypes.HDC,
                              ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

    def _cb(hmon, _hdc, _rect, _param):
        handles.append(hmon)
        return True

    ctypes.windll.user32.EnumDisplayMonitors(None, None, proc(_cb), 0)
    return handles


def _ddc_brightness(level: Optional[int] = None) -> int:
    """外接显示器亮度：DDC/CI（dxva2）。返回当前亮度（0-100）。"""
    import ctypes
    from ctypes import wintypes

    class _PhysicalMonitor(ctypes.Structure):
        _fields_ = [("hPhysicalMonitor", wintypes.HANDLE),
                    ("szPhysicalMonitorDescription", ctypes.c_wchar * 128)]

    dxva2 = ctypes.windll.dxva2
    dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR.argtypes = [wintypes.HMONITOR,
                                                              ctypes.POINTER(wintypes.DWORD)]
    dxva2.GetPhysicalMonitorsFromHMONITOR.argtypes = [wintypes.HMONITOR, wintypes.DWORD,
                                                      ctypes.POINTER(_PhysicalMonitor)]
    dxva2.GetMonitorBrightness.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD),
                                           ctypes.POINTER(wintypes.DWORD),
                                           ctypes.POINTER(wintypes.DWORD)]
    dxva2.SetMonitorBrightness.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    dxva2.DestroyPhysicalMonitors.argtypes = [wintypes.DWORD,
                                              ctypes.POINTER(_PhysicalMonitor)]

    levels, errors = [], []
    for hmon in _monitor_handles():
        count = wintypes.DWORD(0)
        if not dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, ctypes.byref(count)) or not count.value:
            continue
        arr = (_PhysicalMonitor * count.value)()
        if not dxva2.GetPhysicalMonitorsFromHMONITOR(hmon, count.value, arr):
            continue
        try:
            for mon in arr:
                lo, cur, hi = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
                if not dxva2.GetMonitorBrightness(mon.hPhysicalMonitor, ctypes.byref(lo),
                                                  ctypes.byref(cur), ctypes.byref(hi)):
                    errors.append("这块显示器不支持 DDC/CI")
                    continue
                span = max(1, hi.value - lo.value)
                if level is not None:
                    target = lo.value + int(round(level / 100.0 * span))
                    if not dxva2.SetMonitorBrightness(mon.hPhysicalMonitor, target):
                        errors.append("写入显示器亮度失败")
                        continue
                    cur = wintypes.DWORD(target)
                levels.append(int(round((cur.value - lo.value) * 100.0 / span)))
        finally:
            dxva2.DestroyPhysicalMonitors(count.value, arr)
    if not levels:
        raise RuntimeError("；".join(errors) or "没有找到支持 DDC/CI 的显示器")
    return max(levels)          # 多屏取最亮的那块，符合“屏幕亮不亮”的体感


def _brightness_apply(level: int):
    """先试内置屏（WMI），失败则走外接显示器（DDC/CI）；返回 (回读亮度, 用的通道)。"""
    try:
        _wmi_brightness(level)
        return int(_wmi_brightness()), "内置屏 WMI"
    except Exception:
        pass
    _ddc_brightness(level)
    return int(_ddc_brightness()), "外接显示器 DDC/CI"


def _brightness_read() -> int:
    """只读当前亮度（内置屏 WMI，外接屏 DDC/CI）。"""
    try:
        return int(_wmi_brightness())
    except Exception:
        return int(_ddc_brightness())


# 亮度卡片开关的记忆：关掉前的亮度（开回来时用）
_BRIGHTNESS_PREV: Dict[str, int] = {}


@tool("set_brightness", "调节屏幕亮度",
      "设置屏幕亮度。level: 0-100。内置屏走系统 WMI，外接显示器走 DDC/CI 显示器通道。",
      {"level": {"type": "integer", "description": "亮度 0-100", "required": True}})
async def set_brightness(args: Dict[str, Any], ctx) -> ToolResult:
    level = max(0, min(100, int(args["level"])))
    try:
        actual, how = await asyncio.to_thread(_brightness_apply, level)
    except Exception as e:
        return ToolResult(
            f"调节亮度失败：{type(e).__name__}: {e}。"
            f"若显示器或线材不支持 DDC/CI，软件就调不了亮度，只能用显示器自己的按钮。",
            ok=False)
    if abs(actual - level) > 2:
        return ToolResult(f"亮度设置未完全生效（当前 {actual}%）。", ok=False)
    # 亮度卡片也是滑块：交给卡片当前数值
    return ToolResult(f"屏幕亮度已调至 {actual}%（{how}）。",
                      card={"kind": "brightness", "value": actual})


# ---------- 剪贴板 ----------
@tool("clipboard", "读写剪贴板",
      "读取剪贴板内容（action=read）或写入文本到剪贴板（action=write）。",
      {"action": {"type": "string", "enum": ["read", "write"], "required": True},
       "text": {"type": "string", "description": "action=write 时要写入的文本"}})
async def clipboard_tool(args: Dict[str, Any], ctx) -> ToolResult:
    import win32clipboard

    def _read():
        win32clipboard.OpenClipboard()
        try:
            return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()

    def _write(text: str):
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        finally:
            win32clipboard.CloseClipboard()

    if args["action"] == "read":
        try:
            text = await asyncio.to_thread(_read)
        except Exception:
            return ToolResult("剪贴板中没有文本内容。")
        return ToolResult(f"剪贴板内容：{text[:1000]}")
    text = args.get("text") or ""
    await asyncio.to_thread(_write, text)
    return ToolResult(f"已写入剪贴板（{len(text)} 字符）。"
                      f"（卡片标题只能写名词，若要展示就用「剪贴板」＋内容作副标题）")


# ---------- 窗口管理 ----------
def _win_proc_name(hwnd: int) -> str:
    """窗口所属进程的 exe 名（标题会随内容变的应用，靠它才能稳定找到）。"""
    try:
        import psutil
        import win32process
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return psutil.Process(pid).name()
    except Exception:
        return ""


def _enum_windows():
    import win32gui
    result = []

    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
            result.append((hwnd, win32gui.GetWindowText(hwnd), _win_proc_name(hwnd)))
    win32gui.EnumWindows(cb, None)
    return result


_ACTIVE_WORDS = ("active", "foreground", "前台", "当前窗口", "当前")


@tool("manage_window", "管理窗口",
      "管理屏幕上的窗口。action: list(列出窗口) / focus(置顶激活) / close(关闭) / minimize(最小化)。"
      "title 可以是窗口标题、进程名（如 lx-music、chrome）或 active（前台窗口）——"
      "标题会随内容变的应用（播放器、浏览器）用进程名或 active 更稳。",
      {"action": {"type": "string", "enum": ["list", "focus", "close", "minimize"], "required": True},
       "title": {"type": "string", "description": "窗口标题 / 进程名 / active（list 时可空）"}})
async def manage_window(args: Dict[str, Any], ctx) -> ToolResult:
    import win32gui
    import win32con
    wins = await asyncio.to_thread(_enum_windows)
    if args["action"] == "list":
        lines = [f"{t}（{p}）" if p else t for _, t, p in wins[:50]]
        return ToolResult("当前窗口（标题（进程名））：\n" + "\n".join(lines))
    asked = (args.get("title") or "").strip().lower()
    if asked in _ACTIVE_WORDS or not asked:
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd) or _win_proc_name(hwnd)
    else:
        kw = asked[:-4] if asked.endswith(".exe") else asked
        match = next(((h, t) for h, t, p in wins
                      if kw in t.lower() or kw in (p or "").lower()), None)
        if not match:
            listed = "、".join(f"{t}（{p}）" for _, t, p in wins[:20])
            return ToolResult(f"未找到标题或进程名含「{args.get('title')}」的窗口。"
                              f"当前窗口：{listed}", ok=False)
        hwnd, title = match
    action = args["action"]
    if action == "focus":
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
    elif action == "close":
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    elif action == "minimize":
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
    names = {"focus": "已激活", "close": "已关闭", "minimize": "已最小化"}
    return ToolResult(f"窗口「{title}」{names[action]}。"
                      f"（卡片标题只能写名词，若要展示就用「{title}」，状态写进副标题）")


# ---------- APP 列表 / 启动 / 关闭 ----------
def _installed_apps():
    import winreg
    apps = {}
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for root, sub in roots:
        try:
            with winreg.OpenKey(root, sub) as key:
                for i in range(winreg.QueryInfoKey(key)[0]):
                    try:
                        with winreg.OpenKey(key, winreg.EnumKey(key, i)) as app:
                            name = winreg.QueryValueEx(app, "DisplayName")[0]
                            if name:
                                apps[name] = True
                    except OSError:
                        continue
        except OSError:
            continue
    return sorted(apps.keys())


@tool("list_apps", "读取已安装应用",
      "读取电脑上已安装的 APP 列表。filter 可按名称过滤。",
      {"filter": {"type": "string", "description": "名称过滤关键词（可空）"}})
async def list_apps(args: Dict[str, Any], ctx) -> ToolResult:
    apps = await asyncio.to_thread(_installed_apps)
    kw = (args.get("filter") or "").lower()
    if kw:
        apps = [a for a in apps if kw in a.lower()]
    return ToolResult(f"已安装应用（{len(apps)} 个）：\n" + "\n".join(apps[:80]))


def _start_menu_shortcuts() -> Dict[str, str]:
    """开始菜单快捷方式：{名称(小写，去扩展名): .lnk 完整路径}。"""
    import glob
    roots = [
        os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"),
                     r"Microsoft\Windows\Start Menu\Programs"),
        os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
    ]
    found: Dict[str, str] = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for lnk in glob.glob(os.path.join(root, "**", "*.lnk"), recursive=True):
            found.setdefault(os.path.splitext(os.path.basename(lnk))[0].lower(), lnk)
    return found


def _app_paths() -> Dict[str, str]:
    """注册表 App Paths：{exe 名(小写): 可执行文件路径}。"""
    import winreg
    out: Dict[str, str] = {}
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths") as k:
                for i in range(winreg.QueryInfoKey(k)[0]):
                    name = winreg.EnumKey(k, i)
                    try:
                        with winreg.OpenKey(k, name) as sub:
                            exe = winreg.QueryValueEx(sub, "")[0]
                        if exe and os.path.exists(exe):
                            out[name.lower()] = exe
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def _resolve_from_uninstall(name: str) -> Optional[str]:
    """按已安装应用的 DisplayName 找主程序（DisplayIcon / InstallLocation 内的 exe）。"""
    import glob
    import winreg
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for root, sub in roots:
        try:
            with winreg.OpenKey(root, sub) as key:
                for i in range(winreg.QueryInfoKey(key)[0]):
                    try:
                        with winreg.OpenKey(key, winreg.EnumKey(key, i)) as app:
                            try:
                                display = str(winreg.QueryValueEx(app, "DisplayName")[0]).strip()
                            except OSError:
                                continue
                            if display.lower() != name:
                                continue
                            for field in ("DisplayIcon", "InstallLocation"):
                                try:
                                    val = str(winreg.QueryValueEx(app, field)[0])
                                except OSError:
                                    continue
                                cand = val.split(",")[0].strip().strip('"')
                                if cand.lower().endswith(".exe") and os.path.exists(cand):
                                    return cand
                                if os.path.isdir(cand):
                                    exes = glob.glob(os.path.join(cand, "*.exe"))
                                    if exes:
                                        return exes[0]
                    except OSError:
                        continue
        except OSError:
            continue
    return None


# 常见系统应用的中英文别名（值可为 exe 名或系统协议）
_APP_ALIASES = {
    "记事本": "notepad.exe", "notepad": "notepad.exe", "文本编辑器": "notepad.exe",
    "计算器": "calc.exe", "calculator": "calc.exe", "calc": "calc.exe",
    "画图": "mspaint.exe", "paint": "mspaint.exe", "mspaint": "mspaint.exe",
    "任务管理器": "taskmgr.exe", "taskmgr": "taskmgr.exe", "task manager": "taskmgr.exe",
    "资源管理器": "explorer.exe", "文件资源管理器": "explorer.exe", "explorer": "explorer.exe",
    "命令提示符": "cmd.exe", "cmd": "cmd.exe",
    "终端": "wt.exe", "windows terminal": "wt.exe", "terminal": "wt.exe",
    "控制面板": "control.exe", "control panel": "control.exe", "control": "control.exe",
    "设置": "ms-settings:", "windows 设置": "ms-settings:", "windows设置": "ms-settings:",
    "系统设置": "ms-settings:",
    "注册表编辑器": "regedit.exe", "regedit": "regedit.exe", "注册表": "regedit.exe",
    "任务计划程序": "taskschd.msc", "设备管理器": "devmgmt.msc",
    "磁盘管理": "diskmgmt.msc", "服务": "services.msc", "系统配置": "msconfig.exe",
    "远程桌面": "mstsc.exe", "系统信息": "msinfo32.exe",
}


_start_apps_cache: Optional[Dict[str, str]] = None


def _start_apps() -> Dict[str, str]:
    """开始菜单里的全部应用（含商店应用）：{显示名(小写): AppID}。

    Get-StartApps 比扫描快捷方式更全，能覆盖商店应用与中文显示名（如「微信」「剪映专业版」），
    拿到 AppID 后用 explorer 的 shell:appsFolder 启动。必须强制 PowerShell 输出 UTF-8，
    否则中文显示名会因 GBK 解码变成乱码而匹配不上。
    """
    global _start_apps_cache
    if _start_apps_cache is not None:
        return _start_apps_cache
    out: Dict[str, str] = {}
    try:
        cmd = ("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
               "$OutputEncoding=[System.Text.Encoding]::UTF8; "
               "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress")
        p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
                           capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        import json
        data = json.loads((p.stdout or b"").decode("utf-8", errors="replace") or "[]")
        if isinstance(data, dict):
            data = [data]
        for it in data:
            name = str(it.get("Name") or "").strip()
            appid = str(it.get("AppID") or "").strip()
            if name and appid and "卸载" not in name and "Uninstall" not in name:
                out.setdefault(name.lower(), appid)
    except Exception as e:
        print(f"[agent] Get-StartApps 读取失败: {type(e).__name__}: {e}", flush=True)
    _start_apps_cache = out
    return out


def _resolve_app(target: str) -> Optional[str]:
    """把「应用名 / 路径 / 协议」解析成可交给 Shell 启动的目标；解析不到返回 None。"""
    import shutil
    t = target.strip().strip('"').strip("'")
    if not t:
        return None
    # 系统协议 / URL（如 ms-settings:bluetooth、https://…），但排除盘符路径 C:\…
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", t) and not re.match(r"^[a-zA-Z]:[\\/]", t):
        return t
    if os.path.exists(t):
        return t
    name = os.path.basename(t).lower()
    stem = os.path.splitext(name)[0]
    # 0) 常见系统应用别名（中文名/英文名 → exe 或协议）
    alias = _APP_ALIASES.get(stem) or _APP_ALIASES.get(name)
    if alias:
        if ":" in alias and not re.match(r"^[a-zA-Z]:[\\/]", alias):
            return alias
        for cand in (alias, os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "system32", alias)):
            p = cand if os.path.exists(cand) else shutil.which(cand)
            if p:
                return p
    # 1) PATH 中的可执行文件
    for cand in (name, name + ".exe", stem, stem + ".exe"):
        p = shutil.which(cand)
        if p:
            return p
    # 2) 注册表 App Paths
    app_paths = _app_paths()
    for key in (name, name + ".exe", stem + ".exe"):
        if key in app_paths:
            return app_paths[key]
    # 3) 开始菜单快捷方式（覆盖中文应用名，如「微信」）
    shortcuts = _start_menu_shortcuts()
    if stem in shortcuts:
        return shortcuts[stem]
    for k, v in shortcuts.items():
        if stem and (stem in k or k in stem):
            return v
    # 4) 开始菜单应用列表（Get-StartApps：商店应用与中文显示名，返回 appsfolder:<AppID>）
    apps = _start_apps()
    if apps:
        if stem in apps:
            return f"appsfolder:{apps[stem]}"
        if len(stem) >= 2:
            for k, v in apps.items():
                if k.startswith(stem) or stem in k:
                    return f"appsfolder:{v}"
    # 5) 已安装应用显示名（精确匹配）
    return _resolve_from_uninstall(stem)


@tool("open_app", "打开应用",
      "打开一个应用程序。target 可以是可执行文件路径、应用名称（如 notepad、微信）或 shell 协议（如 ms-settings:bluetooth）。",
      {"target": {"type": "string", "description": "应用路径/名称/协议", "required": True}})
async def open_app(args: Dict[str, Any], ctx) -> ToolResult:
    target = (args.get("target") or "").strip()
    if not target:
        return ToolResult("未指定要打开的应用", ok=False)
    resolved = await asyncio.to_thread(_resolve_app, target)
    if not resolved:
        return ToolResult(
            f"未找到应用「{target}」。请确认它已安装，或改用可执行文件完整路径 / 系统协议"
            f"（如 ms-settings:bluetooth、ms-settings:wifi）。", ok=False)
    try:
        if resolved.startswith("appsfolder:"):
            # 开始菜单应用（含商店应用）：用 explorer 的 shell:appsFolder 启动
            appid = resolved.split(":", 1)[1]
            await asyncio.to_thread(
                subprocess.Popen, ["explorer.exe", f"shell:appsFolder\\{appid}"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            await asyncio.to_thread(os.startfile, resolved)   # ShellExecute：失败会抛 OSError
    except OSError as e:
        try:      # 兜底：交给 shell 启动（对某些协议 / 商店应用更宽容）
            await asyncio.to_thread(
                subprocess.Popen, f'start "" "{target}"', shell=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e2:
            return ToolResult(f"启动「{target}」失败：{e}；{e2}", ok=False)
    # 给模型一条提示（**不做任何程序化判定**，是否收起界面完全由模型自己决定）
    hint = ("（如果用户**只**要求打开这一个程序、此外没有任何别的事，"
            "就在收尾时调用 exit_dony 把 Dony 界面收起来；还有别的操作就不要调用。）")
    return ToolResult(f"已打开 {target}。{hint}")


@tool("close_app", "关闭应用",
      "按进程名关闭应用程序（如 notepad.exe）。",
      {"process": {"type": "string", "description": "进程名", "required": True}})
async def close_app(args: Dict[str, Any], ctx) -> ToolResult:
    proc = args["process"]
    killed = 0
    import psutil
    for p in psutil.process_iter(["name"]):
        try:
            if p.info["name"] and p.info["name"].lower() == proc.lower():
                p.terminate()
                killed += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if not killed:
        return ToolResult(f"未找到运行中的进程 {proc}", ok=False)
    return ToolResult(f"已关闭 {proc}（{killed} 个进程）。")


# ---------- 设备管理（弹出U盘） ----------
@tool("eject_device", "弹出设备",
      "安全弹出U盘等可移动设备。drive 为盘符（如 E）。",
      {"drive": {"type": "string", "description": "盘符字母，如 E", "required": True}})
async def eject_device(args: Dict[str, Any], ctx) -> ToolResult:
    drive = args["drive"].strip().rstrip(":").upper()

    def _eject():
        import win32file
        import win32con
        import winioctlcon
        handle = win32file.CreateFile(
            f"\\\\.\\{drive}:", win32con.GENERIC_READ | win32con.GENERIC_WRITE,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE, None,
            win32con.OPEN_EXISTING, 0, None)
        try:
            win32file.DeviceIoControl(handle, winioctlcon.IOCTL_STORAGE_EJECT_MEDIA, None, None)
        finally:
            handle.Close()

    try:
        await asyncio.to_thread(_eject)
    except Exception as e:
        return ToolResult(f"弹出 {drive}: 失败：{e}", ok=False)
    return ToolResult(f"设备 {drive}: 已安全弹出。",
                      card={"kind": "device", "subtitle": f"{drive}: 盘 · 已安全弹出"})


# ---------- 系统开关（原生接口） ----------
# 全部直接调系统接口：注册表 / SystemParametersInfo / WinRT / powercfg / 系统自带程序，
# 不模拟按键、不依赖界面。key 同时也是结果卡片上开关的标识（见文件末尾 toggle_system_switch）。
_TOGGLE_LABELS: Dict[str, str] = {
    # 飞行模式已移除：系统的飞行模式总开关是私有接口（第三方改不动），
    # 只关无线电会在设置页显示不一致 —— 按"做不到就不留接口"处理。
    # 夜间模式 / 就近共享 也已移除，原因同上但更彻底：改完**拿不到系统自己的说法**
    # （设置页里那两项读不到状态），也就是永远无法确认有没有真的生效——宁可没有接口，
    # 也不留一个"报了成功却不知道真假"的开关。要恢复的话得改成驱动设置页控件。
    # 电源模式不在这里：它是三档（节能/均衡/高性能），走单独的 set_power_mode 工具。
    "mobile_hotspot": "移动热点",
    "sticky_keys": "粘滞键",
    "mono_audio": "单声道音频",
    "magnifier": "放大镜",
    "narrator": "讲述人",
    "osk": "屏幕键盘",
    # 虚拟触摸板已移除：系统没有可调用的程序/接口（它只存在于任务栏弹出菜单）
}


def _notify_setting_change() -> None:
    """改完通知外壳一次（不通知也会生效，只是让已打开的设置界面尽早刷新）。"""
    try:
        import ctypes
        ctypes.windll.user32.SendMessageTimeoutW(
            0xFFFF, 0x001A, 0, ctypes.c_wchar_p("Software\\Microsoft\\Windows\\CurrentVersion"),
            0x0002, 300, None)
    except Exception:
        pass


def _reg_read(path: str, name: str = ""):
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
        return winreg.QueryValueEx(key, name)[0]


def _reg_write(path: str, value, name: str = "", binary: bool = False) -> None:
    import winreg
    kind = winreg.REG_BINARY if binary else winreg.REG_DWORD
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, name, 0, kind, value)
    _notify_setting_change()


# ---- 夜间模式：没有公开 API，只能改 CloudStore 里那段未公开的二进制值 ----
# 结论：**这条路不可靠**，接口已删除。曾经做到的是——
#   · 按"byte[18]=0x15/0x13，打开时在 0x22 插一对 0x10 0x00"改写（索引是拿本机
#     原始值逐字节比对出来的，不是猜的），写入成功且不会被系统回退；
#   · 但**屏幕不会变暖**，回读只等于读自己写进去的字节（假成功）；
#   · 用 UIA 去问系统自己：设置页里只读得到"按计划开启"那个开关（状态 0），
#     主开关根本读不到状态 —— 也就是**拿不到任何独立信号**。
# 没有独立信号就无法判断真假；按"做不到就不留接口"处理，整体删掉。
# 要恢复的话：改成驱动设置页控件（UIA），状态从控件回读，那才是可确认的。


# ---- 单声道音频：注册表开关 ----
# （就近共享同理删除：写进去之后同样拿不到系统自己的说法，无法确认是否生效。）
_MONO_PATH = r"Software\Microsoft\Multimedia\Audio"
_MONO_NAME = "AccessibilityMonoMixState"          # 1=开


def _mono_get() -> bool:
    return int(_reg_read(_MONO_PATH, _MONO_NAME) or 0) == 1


def _mono_set(on: bool) -> None:
    _reg_write(_MONO_PATH, 1 if on else 0, _MONO_NAME)


# ---- 粘滞键：SystemParametersInfo（原生辅助功能接口） ----
_SPI_GETSTICKYKEYS, _SPI_SETSTICKYKEYS = 0x003A, 0x003B
_SKF_STICKYKEYSON, _SKF_HOTKEYACTIVE = 0x00000001, 0x00000004
_SKF_CONFIRMHOTKEY, _SKF_HOTKEYSOUND, _SKF_INDICATOR = 0x00000008, 0x00000010, 0x00000020
_SPIF_UPDATEINIFILE, _SPIF_SENDCHANGE = 0x0001, 0x0002


def _sticky_keys_sync(on: Optional[bool] = None) -> bool:
    import ctypes

    class _StickyKeys(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwFlags", ctypes.c_uint)]

    sk = _StickyKeys(ctypes.sizeof(_StickyKeys), 0)
    user32 = ctypes.windll.user32
    if not user32.SystemParametersInfoW(_SPI_GETSTICKYKEYS, sk.cbSize, ctypes.byref(sk), 0):
        raise RuntimeError("读取粘滞键状态失败")
    if on is None:
        return bool(sk.dwFlags & _SKF_STICKYKEYSON)
    if on:
        sk.dwFlags |= _SKF_STICKYKEYSON | _SKF_HOTKEYACTIVE | _SKF_CONFIRMHOTKEY | _SKF_INDICATOR
        sk.dwFlags &= ~_SKF_HOTKEYSOUND       # 打开时不要那声提示音
    else:
        sk.dwFlags &= ~_SKF_STICKYKEYSON
    if not user32.SystemParametersInfoW(_SPI_SETSTICKYKEYS, sk.cbSize, ctypes.byref(sk),
                                        _SPIF_UPDATEINIFILE | _SPIF_SENDCHANGE):
        raise RuntimeError("写入粘滞键状态失败")
    return bool(sk.dwFlags & _SKF_STICKYKEYSON)


# ---- 程序型开关：放大镜 / 讲述人 / 屏幕键盘（系统自带程序，起停即开关） ----
_EXE_TOGGLES = {"magnifier": "magnify.exe", "narrator": "narrator.exe", "osk": "osk.exe"}


def _system32(exe: str) -> str:
    return os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", exe)


def _proc_running(exe: str) -> bool:
    import psutil
    want = exe.lower()
    return any((p.info.get("name") or "").lower() == want for p in psutil.process_iter(["name"]))


def _exe_set(exe: str, on: bool) -> None:
    """起停系统辅助程序（放大镜/讲述人/屏幕键盘）。

    两个实测坑：
      · 直接 Popen 会被拦下（WinError 740 需要提升）——这几个程序带 uiAccess 清单，
        交给外壳（explorer.exe）启动就正常；
      · taskkill 对它们必定失败（实测返回码 1，进程还在），psutil 强杀可以。
    """
    import time
    if on:
        if _proc_running(exe):
            return
        subprocess.run(["explorer.exe", _system32(exe)], capture_output=True, timeout=20)
        for _ in range(16):
            if _proc_running(exe):
                return
            time.sleep(0.5)
        raise RuntimeError(f"{exe} 没能启动（可能被系统策略拦住了）")
    import psutil
    want = exe.lower()
    for p in psutil.process_iter(["name"]):
        if (p.info.get("name") or "").lower() == want:
            try:
                p.kill()
            except Exception:
                pass
    for _ in range(10):
        if not _proc_running(exe):
            return
        time.sleep(0.4)


# ---- 电源模式：powrprof 的 overlay 接口——能写、也能回读（三档） ----
# 三个 GUID 是系统的电源模式 overlay；设置页与操作中心里看到的就是它。
# 之前那版是切 powercfg 电源方案（等于改了另一个东西），用户在设置里看不到变化。
_POWER_MODE_GUIDS = {
    "efficiency":  "ded574b5-45a0-4f42-8737-46345c09c238",   # 节能（最佳能效）
    "balanced":    "00000000-0000-0000-0000-000000000000",   # 均衡（系统默认）
    "performance": "e9a42b02-d5df-448d-aa00-03f14749eb61",   # 高性能（最佳性能）
}
_POWER_MODE_LABELS = {"efficiency": "节能", "balanced": "均衡", "performance": "高性能"}
_POWER_MODE_DEFAULT = "balanced"
# 三档各对应一个电源方案（实测「高性能」这一档 overlay 会被系统拒绝——方案是可靠的那条路）
_POWER_PLAN_GUIDS = {
    "efficiency":  "a1841308-3541-4fab-bc81-f71556f20b4a",   # 节能
    "balanced":    "381b4222-f694-41f0-9685-ff5bb260df2e",   # 平衡
    "performance": "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",   # 高性能
}


def _power_prev_file() -> str:
    import tempfile
    return os.path.join(tempfile.gettempdir(), "dony_prev_power_scheme.txt")


def _power_scheme() -> str:
    out = subprocess.run(["powercfg", "/getactivescheme"], capture_output=True,
                         text=True, timeout=20).stdout
    m = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", out)
    return m.group(0).lower() if m else ""


def _power_mode_guid() -> str:
    """当前电源模式的 overlay GUID（系统自己的说法）。"""
    import ctypes
    import uuid
    buf = ctypes.create_string_buffer(16)
    if ctypes.windll.powrprof.PowerGetActualOverlayScheme(ctypes.byref(buf)) != 0:
        raise RuntimeError("读取电源模式失败（这台机器可能不支持电源模式）")
    return str(uuid.UUID(bytes_le=bytes(buf.raw))).lower()


def _power_mode_set_overlay(mode: str) -> None:
    """写 overlay（设置页里"电源模式"就是它）。"""
    import ctypes
    import uuid

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                    ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

    guid = GUID()
    ctypes.memmove(ctypes.byref(guid), uuid.UUID(_POWER_MODE_GUIDS[mode]).bytes_le, 16)
    if ctypes.windll.powrprof.PowerSetActiveOverlayScheme(guid) != 0:
        raise RuntimeError("系统拒绝了这次电源模式写入")


def _power_mode_get_mode() -> str:
    """当前是哪一档：efficiency / balanced / performance。

    两处一起看（它们都是系统自己维护的）：
      · 电源方案（powercfg）：实测**高性能方案**会让"电源模式"选项变灰，
        所以「高性能」这一档只能靠方案；节能方案同理。
      · overlay（powrprof）：设置页"电源模式"选的正是它，能细则更精确。
    """
    plan = _power_scheme()
    if plan == _POWER_PLAN_GUIDS["performance"]:
        return "performance"
    if plan == _POWER_PLAN_GUIDS["efficiency"]:
        return "efficiency"
    try:
        overlay = _power_mode_guid()
    except Exception:
        overlay = ""
    if overlay == _POWER_MODE_GUIDS["efficiency"]:
        return "efficiency"
    if overlay == _POWER_MODE_GUIDS["performance"]:
        return "performance"
    return "balanced"


def _power_mode_set_mode(mode: str) -> None:
    """切到某一档：先换电源方案（三档各一个方案），再尽力同步 overlay。"""
    if mode not in _POWER_PLAN_GUIDS:
        raise RuntimeError(f"没有这一档电源模式：{mode}")
    subprocess.run(["powercfg", "/setactive", _POWER_PLAN_GUIDS[mode]],
                   capture_output=True, text=True, timeout=30)
    try:
        _power_mode_set_overlay(mode)        # 变灰/被拒不算失败：方案已经切过去了
    except Exception:
        pass


# ---- 移动热点：WinRT ----
def _hotspot_manager():
    """取热点管理器（按已配置的 WiFi 连接）。读状态与开关都走它。"""
    from winsdk.windows.networking.connectivity import NetworkInformation
    from winsdk.windows.networking.networkoperators import NetworkOperatorTetheringManager
    profiles = NetworkInformation.get_connection_profiles()
    wifi = next((p for p in profiles if p.is_wlan_connection_profile), None)
    if wifi is None:
        raise RuntimeError("本机没有可用的 WiFi 连接配置（需要先连过一次 WiFi）")
    return NetworkOperatorTetheringManager.create_from_connection_profile(wifi)


async def _hotspot_state() -> bool:
    """热点现在开着吗（只读；卡片自己取状态时用）。"""
    from winsdk.windows.networking.networkoperators import TetheringOperationalState
    return int(_hotspot_manager().tethering_operational_state) == int(TetheringOperationalState.ON)


async def _hotspot_set(on: bool) -> bool:
    """移动热点：WinRT TetheringManager（按已配置的 WiFi 连接取管理器）。"""
    from winsdk.windows.networking.networkoperators import TetheringOperationalState
    mgr = _hotspot_manager()
    want = int(TetheringOperationalState.ON if on else TetheringOperationalState.OFF)
    if int(mgr.tethering_operational_state) != want:
        if on:
            await mgr.start_tethering_async()
        else:
            await mgr.stop_tethering_async()
    for _ in range(20):                       # 状态切换有过渡期，回读几次
        if int(mgr.tethering_operational_state) == want:
            return True
        await asyncio.sleep(0.5)
    return False


_SYNC_TOGGLES = {
    "mono_audio": (_mono_get, _mono_set),
    "sticky_keys": (lambda: _sticky_keys_sync(), lambda on: _sticky_keys_sync(on)),
    "magnifier": (lambda: _proc_running("magnify.exe"), lambda on: _exe_set("magnify.exe", on)),
    "narrator": (lambda: _proc_running("narrator.exe"), lambda on: _exe_set("narrator.exe", on)),
    "osk": (lambda: _proc_running("osk.exe"), lambda on: _exe_set("osk.exe", on)),
}


def _read_toggle_state(key: str) -> Optional[bool]:
    """按开关 key 读真实状态（卡片上开关的位置靠它；工具没给状态时用）。"""
    pair = _SYNC_TOGGLES.get(key)
    return bool(pair[0]()) if pair else None


def _brightness_read() -> int:
    """当前屏幕亮度（%）：内置屏走 WMI，不行就外接显示器 DDC/CI。"""
    try:
        return int(_wmi_brightness())
    except Exception:
        return int(_ddc_brightness())


async def _apply_toggle(key: str, on: bool) -> bool:
    """执行开关并回读真实状态；返回“当前是不是开”。"""
    if key == "mobile_hotspot":
        return await _hotspot_set(on)
    pair = _SYNC_TOGGLES.get(key)
    if pair is None:
        raise RuntimeError(f"这个系统开关（{key}）没有可用的原生接口")
    read, write = pair
    await asyncio.to_thread(write, on)
    return await asyncio.to_thread(read)


def _toggle_card_kind(key: str) -> str:
    """系统开关用哪类卡片承载开关。

    每个开关在 cards.CARD_SPECS 里**各自就是一个带 switch 的 kind**
    （power_mode / sticky_keys / mono_audio …）；热点沿用 hotspot
    （它的 switch 是 mobile_hotspot）。以前这里返回 "status"，
    而 status 的 switch 是 None → 卡片永远挂不上开关。
    """
    return "hotspot" if key == "mobile_hotspot" else key


@tool("set_system_toggle", "更改系统开关",
      "打开或关闭这些系统开关（都走原生接口，不模拟按键）：电源模式（最佳能效/平衡）、移动热点、"
      "粘滞键、单声道音频、放大镜、讲述人、屏幕键盘。"
      "key 用英文标识（power_mode / mobile_hotspot / sticky_keys / mono_audio / magnifier / "
      "narrator / osk），on=true 打开、false 关闭。"
      "注意：移动热点需要本机连过 WiFi。"
      "（夜间模式、就近共享、飞行模式、虚拟触摸板没有可靠的原生接口，已按"
      "「做不到就不留接口」移除——用户问到就照实说明，请他在系统设置里手动开关。）",
      {"key": {"type": "string", "enum": list(_TOGGLE_LABELS.keys()), "required": True},
       "on": {"type": "boolean", "required": True}})
async def set_system_toggle(args: Dict[str, Any], ctx) -> ToolResult:
    key = str(args.get("key") or "").strip()
    on = bool(args["on"])
    label = _TOGGLE_LABELS.get(key)
    if not label:
        return ToolResult(f"未知开关「{key}」（可选：{'、'.join(_TOGGLE_LABELS.keys())}）", ok=False)
    try:
        actual = await _apply_toggle(key, on)
    except Exception as e:
        return ToolResult(f"更改{label}失败：{type(e).__name__}: {e}", ok=False)
    if actual != on:
        # 回读的是系统自己的状态（不是我们刚写进去的字节）：不一致就是真的没切成
        return ToolResult(f"{label}未能切换：系统没有接受这次修改（当前仍是"
                          f"{'开' if actual else '关'}）。请让用户在系统设置里手动改一次。", ok=False)
    kind = _toggle_card_kind(key)
    return ToolResult(f"{label}已{'打开' if on else '关闭'}（已回读系统状态确认）。"
                      f"（如要展示卡片：kind={kind}）",
                      card={"kind": kind, "state": on})


@tool("exit_dony", "关掉 Dony 界面",
      "把 Dony 的界面收起来（隐藏覆盖层；宿主程序仍在后台运行，不是退出整个程序）。"
      "**是否调用由你自己判断，没有任何程序化拦截**：当用户只要求打开某个程序"
      "（或只打开一个网址）、本次对话里没有别的事时，打开完成后调用它收尾；"
      "已经聊过别的内容、或还有别的操作时不要调用。",
      {}, modes=("fast", "task"))
async def exit_dony(args: Dict[str, Any], ctx) -> ToolResult:
    """关掉 Dony 界面（隐藏覆盖层），**不是**退出宿主程序（intelligentSTUDIO）。

    退出事件**广播给所有窗口**，而不是只发给当前这条会话：经「应用内对话」触发时，
    事件会发给应用内那一路，主界面（覆盖层）收不到 → 表现就是"说了要退却没退"。
    """
    server = getattr(getattr(ctx, "session", None), "server", None)
    if server is None or not hasattr(server, "broadcast"):
        return ToolResult("关闭失败：拿不到会话，无法通知界面关闭", ok=False)
    try:
        await server.broadcast({"type": "dismiss-dony"})
    except Exception as e:
        return ToolResult(f"关闭失败：{type(e).__name__}: {e}", ok=False)
    return ToolResult("Dony 界面已收起（宿主程序仍在运行）。")


async def set_card_value(key: str, value):
    """卡片上的**滑块/三段式**被拖动（或点选）后回传的值。

    volume / brightness → 0-100 的整数；
    power_mode          → efficiency / balanced / performance。
    """
    if key == "power_mode":
        mode = str(value or "").strip().lower()
        if mode not in _POWER_MODE_GUIDS:
            raise RuntimeError(f"没有这一档电源模式：{mode}")
        await asyncio.to_thread(_power_mode_set_mode, mode)
        actual = await asyncio.to_thread(_power_mode_get_mode)
        if actual != mode:
            raise RuntimeError(f"系统没有接受电源模式修改（当前是"
                               f"{_POWER_MODE_LABELS.get(actual, actual)}）")
        return mode
    level = max(0, min(100, int(value)))
    if key == "volume":
        return int(await asyncio.to_thread(_volume_sync, level))    # 回读真实音量
    if key == "brightness":
        actual, _how = await asyncio.to_thread(_brightness_apply, level)
        return int(actual)                                          # 回读真实亮度
    raise RuntimeError(f"没有名为 {key} 的滑块/三段式")


@tool("set_power_mode", "更改电源模式",
      "切换系统电源模式（三档）：efficiency = 节能（最佳能效）、balanced = 均衡（标准）、"
      "performance = 高性能。用户说「节能模式 / 省电」就用 efficiency，「高性能」用 performance，"
      "「均衡 / 标准」用 balanced。切换后会回读系统状态确认，没生效会如实报失败。",
      {"mode": {"type": "string", "enum": ["efficiency", "balanced", "performance"],
                "required": True}})
async def set_power_mode(args: Dict[str, Any], ctx) -> ToolResult:
    mode = str(args.get("mode") or "").strip().lower()
    if mode not in _POWER_MODE_GUIDS:
        return ToolResult(f"没有这一档电源模式：{mode}（可选 efficiency / balanced / performance）",
                          ok=False)
    label = _POWER_MODE_LABELS[mode]
    try:
        await asyncio.to_thread(_power_mode_set_mode, mode)
    except Exception as e:
        return ToolResult(f"更改电源模式失败：{type(e).__name__}: {e}", ok=False)
    # 回读的是**系统自己的说法**（powrprof），不是"我刚写进去的值"
    actual = await asyncio.to_thread(_power_mode_get_mode)
    if actual != mode:
        return ToolResult(f"电源模式未能切成{label}：系统现在仍是"
                          f"{_POWER_MODE_LABELS.get(actual, actual)}。", ok=False)
    return ToolResult(f"电源模式已切到{label}（已回读系统状态确认）。",
                      card={"kind": "power_mode", "value": mode})


# ---------- 结果卡片开关转发 ----------
# 关闭后要能重新打开：记下被关掉时的定义（进程内缓存）
_STARTUP_CACHE: Dict[str, str] = {}
_TASK_CACHE: Dict[str, tuple] = {}


async def toggle_system_switch(key: str, on: bool):
    """结果卡片上的开关由前端 toggle-card 触发。

    支持：wifi/bluetooth/volume/startup:*/task:*/闹钟计时器（在 alarms 里处理），
    以及 set_system_toggle 的那批系统开关。

    **失败一律抛出去**（以前只 print 吞掉）：上层会把真实状态回给卡片，
    让开关翻回去并说明原因——"点了没反应、开关状态还是错的"就是这么来的。
    返回：切换后回读到的真实值。
    """
    if key == "power_mode":
        want = "efficiency" if on else "balanced"
        await asyncio.to_thread(_power_mode_set_mode, want)
        actual = await asyncio.to_thread(_power_mode_get_mode)
        if actual != want:
            raise RuntimeError(f"系统没有接受电源模式修改（当前是"
                               f"{_POWER_MODE_LABELS.get(actual, actual)}）")
        return True
    if key in _TOGGLE_LABELS:
        actual = await _apply_toggle(key, on)        # 内部已回读系统状态
        if bool(actual) != bool(on):
            raise RuntimeError(f"{_TOGGLE_LABELS[key]}没有切成{'开' if on else '关'}")
        return bool(actual)
    if key in ("wifi", "bluetooth"):
        res = await set_radio({"kind": key, "on": on}, None)
        if not res.ok:
            raise RuntimeError(res.text)
        return bool(on)
    elif key == "volume":
        try:
            await asyncio.to_thread(_set_mute_sync, not on)   # on=true → 恢复声音
        except Exception as e:
            print(f"[agent] toggle volume failed: {type(e).__name__}: {e}", flush=True)
    elif key == "brightness":
        # 亮度卡片的开关：关 → 降到 20%（仍看得清，不至于全黑后找不到开关），
        # 开 → 回到关之前那个亮度。
        try:
            if not on:
                _BRIGHTNESS_PREV["cur"] = await asyncio.to_thread(_brightness_read)
                await asyncio.to_thread(_brightness_apply, 20)
            else:
                prev = int(_BRIGHTNESS_PREV.get("cur") or 70)
                await asyncio.to_thread(_brightness_apply, max(20, min(100, prev)))
        except Exception as e:
            print(f"[agent] toggle brightness failed: {type(e).__name__}: {e}", flush=True)
    elif key.startswith("startup:"):
        from . import scheduler
        name = key.split(":", 1)[1]
        if not on:
            cmd = scheduler.list_startup().get(name)
            if cmd:
                _STARTUP_CACHE[name] = cmd
            scheduler.remove_startup(name)
        elif name in _STARTUP_CACHE:
            scheduler.add_startup(name, _STARTUP_CACHE[name])
        else:
            print(f"[agent] 启动项 {name} 的原始命令未知，无法重新启用", flush=True)
    elif key.startswith("task:"):
        from . import scheduler
        name = key.split(":", 1)[1]
        if not on:
            spec = await asyncio.to_thread(scheduler.task_spec_sync, name)
            if spec:
                _TASK_CACHE[name] = spec
            await asyncio.to_thread(scheduler.delete_scheduled_task_sync, name)
        elif name in _TASK_CACHE:
            time_str, command = _TASK_CACHE[name]
            await asyncio.to_thread(scheduler.create_task_sync, name, time_str, command)
        else:
            print(f"[agent] 计划任务 {name} 的原始定义未知，无法重新启用", flush=True)
