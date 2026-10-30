"""UIA 控件操作、截屏理解、GUI 模拟点击、Edge 扩展桥接。"""
import asyncio
import base64
import io
import os
from typing import Any, Dict, List, Tuple

from .. import config
from .base import ToolResult, tool

_FAST = ("fast", "task")
_TASK_ONLY = ("task",)


# ---------- Windows UIA 控件操作 ----------
def _uia_run(fn):
    """UIA 调用的统一入口：在每个工作线程里初始化 COM（MTA）。

    uiautomation 在非 UI 线程里必须显式初始化 COM，否则调用会随机失败
    —— 表现就是「有时控件都读不到」「有时找得到有时找不到」。
    之前这些函数直接跑在 asyncio.to_thread 的工作线程里，没有这层初始化。
    """
    import uiautomation as auto
    with auto.UIAutomationInitializerInThread(debug=False):
        return fn(auto)


def _uia_find_window(auto, title: str, tries: int = 2):
    """按标题关键词找窗口：先子串搜索，失败再遍历顶层窗口做不区分大小写的匹配。

    都找不到时把当前可见窗口标题一并抛出 —— 模型据此能立刻纠正自己写的窗口名，
    而不是反复盲试（原来只说「未找到窗口」，模型就卡在「控件都读不到」）。
    """
    import time as _time
    wanted = (title or "").strip().lower()
    for attempt in range(tries):
        win = auto.WindowControl(searchDepth=1, SubName=title)
        if win.Exists(1.2):
            return win
        if attempt + 1 < tries:
            _time.sleep(0.5)      # 窗口可能正在打开/切换，再等一轮
    candidates: List[str] = []
    for w in auto.GetRootControl().GetChildren():
        try:
            name = (w.Name or "").strip()
        except Exception:
            continue
        if not name:
            continue
        if wanted and wanted in name.lower():
            return auto.WindowControl(searchDepth=1, Name=name)
        if len(candidates) < 20:
            candidates.append(name)
    listing = "、".join(candidates) if candidates else "（未枚举到任何窗口标题）"
    raise RuntimeError(f"未找到标题含「{title}」的窗口。当前可见窗口：{listing}")


def _uia_click_inner(auto, window_title: str, control_name: str,
                     control_type: str, automation_id: str) -> str:
    """在目标窗口范围内定位控件并触发点击。

    优化点：
    - 控件搜索限定在目标窗口子树内（不再从桌面根搜索，避免误命中其它窗口的同名控件）
    - 优先 Invoke 模式（按钮语义，无需移动鼠标、不依赖窗口前台），不支持再回退真实鼠标点击
    - 找不到控件时提示先 uia_list_controls，避免模型反复盲试
    """
    win = _uia_find_window(auto, window_title)
    win.SetActive()
    ct = control_type or "Button"
    ctrl_cls = getattr(auto, f"{ct}Control", None) or auto.ButtonControl
    ctrl = getattr(win, ctrl_cls.__name__)(SubName=control_name, searchDepth=15)
    if not ctrl.Exists(2):
        ctrl = win.Control(SubName=control_name, searchDepth=15)   # 类型不匹配时按名称找
    if not ctrl.Exists(2) and automation_id:
        ctrl = win.Control(AutomationId=automation_id, searchDepth=15)
    if not ctrl.Exists(1):
        raise RuntimeError(f"窗口「{window_title}」中未找到控件「{control_name}」。"
                           f"可先调用 uia_list_controls 查看该窗口实际可用的控件名称")
    try:
        invoke = ctrl.GetPattern(auto.PatternId.InvokePattern)
        if invoke:
            invoke.Invoke()
            return control_name
    except Exception:
        pass
    ctrl.Click(simulateMove=False, waitTime=0)
    return control_name


def _uia_list_inner(auto, window_title: str) -> List[str]:
    win = _uia_find_window(auto, window_title)
    names: List[str] = []
    for ctrl, _ in auto.WalkControl(win, includeTop=False, maxDepth=6):
        if ctrl.Name and ctrl.ControlTypeName in (
                "ButtonControl", "EditControl", "MenuItemControl", "TabItemControl",
                "CheckBoxControl", "ComboBoxControl", "HyperlinkControl", "ListItemControl"):
            # 附带控件中心坐标：需要 GUI 点击时可直接使用
            try:
                rect = ctrl.BoundingRectangle
                coord = f" @({(rect.left + rect.right) // 2},{(rect.top + rect.bottom) // 2})"
            except Exception:
                coord = ""
            entry = f"{ctrl.ControlTypeName.replace('Control', '')}: {ctrl.Name}{coord}"
            if entry not in names:
                names.append(entry)
        if len(names) >= 60:
            break
    return names


def _uia_click(window_title: str, control_name: str, control_type: str, automation_id: str = "") -> str:
    return _uia_run(lambda auto: _uia_click_inner(auto, window_title, control_name,
                                                 control_type, automation_id))


def _uia_list(window_title: str) -> List[str]:
    return _uia_run(lambda auto: _uia_list_inner(auto, window_title))


@tool("uia_click", "点击界面控件",
      "通过 Windows UIA **直接激活**控件（InvokePattern：不移动鼠标、不需要坐标，最快最稳）。"
      "**要点界面时优先用它**。window_title 窗口标题关键词；control_name 控件上显示的文字；"
      "不确定控件名就先 uia_list_controls 看清单；确认该窗口没有控件树时才退到坐标点击。",
      {"window_title": {"type": "string", "description": "窗口标题关键词", "required": True},
       "control_name": {"type": "string", "description": "控件名称/文字", "required": True},
       "control_type": {"type": "string", "description": "控件类型，默认 Button（如 MenuItem/TabItem/CheckBox/ListItem）"},
       "automation_id": {"type": "string", "description": "控件的 AutomationId（可选，名称匹配失败时使用）"}},
      modes=_FAST)
async def uia_click(args: Dict[str, Any], ctx) -> ToolResult:
    ctx.check_uia()
    try:
        name = await asyncio.to_thread(_uia_click, args["window_title"],
                                       args["control_name"], args.get("control_type") or "Button",
                                       args.get("automation_id") or "")
    except Exception as e:
        return ToolResult(str(e), ok=False)
    return ToolResult(f"已点击控件「{name}」。")


@tool("uia_list_controls", "读取界面控件",
      "列出指定窗口中可操作的控件（按钮/输入框/菜单等），用于决定下一步操作。",
      {"window_title": {"type": "string", "description": "窗口标题关键词", "required": True}},
      modes=_FAST)
async def uia_list_controls(args: Dict[str, Any], ctx) -> ToolResult:
    ctx.check_uia()
    try:
        names = await asyncio.to_thread(_uia_list, args["window_title"])
    except Exception as e:
        return ToolResult(str(e), ok=False)
    if not names:
        # 这类界面（Chromium/Electron 自绘、游戏、部分 Qt 程序）根本不暴露控件树，
        # 让模型直接换路子，别在 UIA 上反复试
        return ToolResult(
            f"窗口「{args['window_title']}」没有暴露可操作控件（Chromium/自绘界面常见）。"
            f"请改用 screenshot_understand 看清界面，再用 gui_click 点坐标。", ok=False)
    return ToolResult("窗口控件：\n" + "\n".join(names))


# ---------- 截屏理解 ----------
SHOT_LONG_EDGE = 1400          # 整屏截图的长边上限（省 token）
SHOT_WINDOW_LONG_EDGE = 1600   # 窗口截图的长边上限：小窗口保持 1:1，大窗口才缩（省 token、少等待）
#   —— 缩放不会让点击失准：shot_click 会按这里的倍率换算回屏幕坐标
# 最近一次截图的信息（供 shot_click 换算坐标、gui_click 做范围提醒）
_SHOT_META: Dict[str, Any] = {}


def _proc_name(hwnd: int) -> str:
    """窗口所属进程的 exe 名（如 lx-music-desktop.exe）。标题会随内容变，进程名不会。"""
    try:
        import psutil
        import win32process
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return psutil.Process(pid).name()
    except Exception:
        return ""


_ACTIVE_WORDS = ("active", "foreground", "前台", "当前窗口", "当前")


def _window_bounds(hwnd: int):
    """窗口的可见外框（去掉最大化时那圈不可见的调整边框与阴影）。"""
    import ctypes
    from ctypes import wintypes
    try:
        rect = wintypes.RECT()
        # DWMWA_EXTENDED_FRAME_BOUNDS = 9
        ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(hwnd), ctypes.c_uint(9), ctypes.byref(rect), ctypes.sizeof(rect))
        if rect.right > rect.left and rect.bottom > rect.top:
            return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        pass
    import win32gui
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    return left, top, right, bottom


def _find_window_rect(keyword: str):
    """找窗口 → (标题, (left, top, width, height))，屏幕物理像素。

    匹配规则（很多应用的标题会随内容变，不能只靠标题）：
      · keyword 是 active/前台 之类 → 直接取前台窗口
      · 否则「标题包含」或「进程名包含」任一命中即可（如 lx-music、QQ、explorer）
      · 多个命中取面积最大的那个：主窗口总比它的工具条/浮窗大
    """
    import win32gui

    wanted = (keyword or "").strip().lower()
    if wanted in _ACTIVE_WORDS or not wanted:
        hwnd = win32gui.GetForegroundWindow()
        left, top, right, bottom = _window_bounds(hwnd)
        return (hwnd, win32gui.GetWindowText(hwnd) or _proc_name(hwnd),
                (left, top, right - left, bottom - top))

    asked = wanted[:-4] if wanted.endswith(".exe") else wanted
    hits: List[Any] = []
    seen: List[str] = []

    def visit(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = (win32gui.GetWindowText(hwnd) or "").strip()
        left, top, right, bottom = _window_bounds(hwnd)
        if right - left < 40 or bottom - top < 40:
            return
        proc = _proc_name(hwnd)
        if proc and len(seen) < 25:
            seen.append(f"{title or '（无标题）'}（{proc}）")
        if asked not in title.lower() and asked not in proc.lower():
            return
        hits.append((hwnd, title or proc, (left, top, right - left, bottom - top)))

    win32gui.EnumWindows(visit, None)
    if not hits:
        listing = "、".join(seen) if seen else "（没枚举到可见窗口）"
        raise RuntimeError(f"没找到标题或进程名含「{keyword}」的可见窗口。"
                           f"当前窗口（标题（进程名））：{listing}。"
                           f"也可以用 window=\"active\" 直接截前台窗口")
    hits.sort(key=lambda h: h[2][2] * h[2][3], reverse=True)
    return hits[0]


# 我们自己这条进程链上的程序名（Dony 覆盖层/应用本体）：
# 它们不该被当成“遮挡窗口”——实测 Dony 会回报“Chrome 被 intelligentSTUDIO / electron.exe 完全遮挡”，
# 那就是它自己的窗口。走到 shell/资源管理器就停，避免把终端/桌面也算成自己人。
_SELF_STOP_PROCS = {
    "explorer.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe",
    "conhost.exe", "services.exe", "wininit.exe", "svchost.exe", "python.exe", "pythonw.exe",
}


def _self_process_names() -> set:
    """沿父进程链收集“自己人”的 exe 名。

    注意：起点（本进程）一定要算进来——之前把 python.exe 也放进了停止名单，
    结果第一步就 break，集合恒为空，这道防线等于没有。
    停止判断只对**父进程**生效：走到 shell/资源管理器就不再往上认亲。
    """
    names = set()
    try:
        import psutil
        proc = psutil.Process()
        while proc:
            try:
                name = (proc.name() or "").lower()
            except Exception:
                name = ""
            if name:
                names.add(name)
            parent = proc.parent()
            if parent is None:
                break
            try:
                parent_name = (parent.name() or "").lower()
            except Exception:
                parent_name = ""
            if parent_name in _SELF_STOP_PROCS:
                break
            proc = parent
    except Exception:
        pass
    return names


_SELF_PROCS = _self_process_names()
# ⚠ 实测缺口：用 start.bat 启动时后端的父进程是 cmd.exe，而 cmd.exe 在停止名单里，
# 于是沿父链只收到 python.exe，**electron.exe 被漏掉** —— 结果我们自己那两个覆盖层窗口
# 被当成"外部程序"：点一下标签就被算作一次划过选（后端白白重读一次选区、日志里
# "收到选区"刷屏），"焦点在我们自己身上"这类判断也全部失灵。
# 这个应用本体就是 Electron，直接补进去，不依赖启动方式。
#
# ⚠⚠ 打包版必须补上主程序自己的 exe 名：productName / executableName 是
#   intelligentSTUDIO.exe，而开发态的进程名是 electron.exe。
#   少这一条时的表现（用户实测、且只在安装版出现）：
#     · 覆盖层窗口被当成「外部程序」→ GetFocusedControl 落在我们的网页上（无 TextPattern）
#     · → 判定为「选区被取消」→ 广播空选区 → 书写辅助界面一唤醒就自己收掉
#   带 studio / inteligent 的几种历史拼写都列上，宁多勿漏。
_SELF_PROCS |= {
    "electron.exe",          # 开发态：Electron 主进程
    "appxinteligent.exe",    # 历史可执行名
    "intelligentstudio.exe", # 打包态：productName / executableName（大小写比较前已 lower）
}


def _is_self_process(hwnd: int) -> bool:
    return bool(_SELF_PROCS) and _proc_name(hwnd).lower() in _SELF_PROCS


def _top_window_name(hwnd: int) -> str:
    """窗口的“顶层窗口”名字：子窗口（如 Chrome Legacy Window）要归到它的主窗口。"""
    import win32con
    import win32gui
    try:
        root = win32gui.GetAncestor(hwnd, win32con.GA_ROOT)
        if root:
            hwnd = root
    except Exception:
        pass
    title = (win32gui.GetWindowText(hwnd) or "").strip()
    proc = _proc_name(hwnd)
    return f"{title or '（无标题）'}（{proc}）" if proc else (title or "（无标题）")


def _covering_windows(hwnd: int, rect, samples: int = 6) -> List[str]:
    """采样判断谁真的挡在目标窗口上。

    不用 z 序枚举（窗口列表顺序不可靠），而是在目标矩形上打 6×6 个点，
    逐点问系统“这个位置最上面是谁”——这是地面真相，还自动跳过
    命中测试透明的层（如 Dony 覆盖层执行期放行鼠标时）。
    """
    import win32gui
    import win32process

    x0, y0, w, h = rect
    if w <= 0 or h <= 0:
        return []
    try:
        _, own = win32process.GetWindowThreadProcessId(hwnd)
    except Exception:
        return []

    hits: Dict[str, int] = {}
    total = 0
    for i in range(samples):
        for j in range(samples):
            px = x0 + int((i + 0.5) * w / samples)
            py = y0 + int((j + 0.5) * h / samples)
            total += 1
            try:
                cur = win32gui.WindowFromPoint((px, py))
                if not cur:
                    continue
                _, pid = win32process.GetWindowThreadProcessId(cur)
                if pid == own:                      # 目标自己（含其子窗）
                    continue
                if _is_self_process(cur):            # Dony 自己的覆盖层/应用窗口
                    continue
                name = _top_window_name(cur)
            except Exception:
                continue
            hits[name] = hits.get(name, 0) + 1
    if not total:
        return []
    out = [(n, int(c * 100 / total)) for n, c in hits.items() if c * 100 / total >= 8]
    out.sort(key=lambda kv: -kv[1])
    return [f"{n}（约占 {p}%）" for n, p in out[:3]]


def _capture_screen(window: str = "") -> bytes:
    """截屏 → 按长边等比缩放 → PNG。

    网格/刻度尺那套已经删掉：模型能直接看图估出目标在**图上的像素位置**，
    交给 shot_click 换算即可（比数格子少一层转述、也少一类错）。
    """
    import mss
    from PIL import Image

    title = ""
    hwnd = 0
    if window:
        hwnd, title, rect = _find_window_rect(window)
        region = {"left": rect[0], "top": rect[1], "width": rect[2], "height": rect[3]}
    else:
        with mss.mss() as sct:
            region = dict(sct.monitors[0])          # 0 = 所有显示器的合并虚拟桌面

    # ⚠ mss 抓的是“屏幕上的这块矩形”，不是“窗口自己的内容”：
    # 有别的窗口压在上面时，抓到的会是那个窗口的像素（实测就是这样“内容跳变”的）。
    # 所以这里顺带把遮挡情况算出来告诉模型。
    covering: List[str] = []
    if hwnd:
        try:
            covering = _covering_windows(hwnd, (region["left"], region["top"],
                                                region["width"], region["height"]))
        except Exception:
            covering = []

    with mss.mss() as sct:
        shot = sct.grab(region)

    ox, oy = int(region["left"]), int(region["top"])
    img = Image.frombytes("RGB", shot.size, shot.rgb)
    cap = SHOT_WINDOW_LONG_EDGE if window else SHOT_LONG_EDGE
    scale = max(1.0, max(img.width, img.height) / cap)
    if scale > 1:
        img = img.resize((max(1, round(img.width / scale)),
                          max(1, round(img.height / scale))), Image.LANCZOS)
    _SHOT_META.clear()
    _SHOT_META.update({
        "window": title, "hwnd": int(hwnd or 0), "proc": _proc_name(hwnd) if hwnd else "",
        "scale": round(scale, 3),
        "region": [ox, oy, ox + shot.width, oy + shot.height],
        "image": list(img.size), "covered": covering,
    })
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _shot_hint() -> str:
    """紧贴观测结果的小结：这张图是什么窗口、在什么坐标空间、有没有被遮挡。"""
    m = _SHOT_META
    if not m:
        return "（要点击就用 shot_click 报你在图上的位置，后端换算成屏幕坐标）"
    x0, y0, x1, y1 = m["region"]
    where = (f"窗口「{m['window']}」（进程 {m['proc']}）" if m.get("window") else "整个屏幕")
    space = (f"本图 {m['scale']} 倍缩放，图上像素≠屏幕像素" if m["scale"] != 1.0 else "本图 1:1")
    marks = ("要点击：把你在图上看到的像素位置交给 shot_click（后端按缩放换算成屏幕坐标）；"
             "只有坐标来自 uia_list_controls 的 @(x,y) 时才用 gui_click")
    text = f"（{where}，屏幕区域 ({x0},{y0})-({x1},{y1})；{space}；{marks}）"
    if m.get("covered"):
        text += (f"\n⚠ 这个窗口被压在下面的窗口挡住了部分区域：{'、'.join(m['covered'])}。"
                 f"被挡住的像素不属于这个窗口（截到的会是遮挡者的画面），"
                 f"那里的按钮点不到——先把遮挡窗口移开或最小化，再重新截图定位。")
    return text


def _shot_to_screen(x: int, y: int) -> Tuple[int, int]:
    """把「最近一次截图上的像素坐标」换算成屏幕像素（无留白，只有缩放）。"""
    m = _SHOT_META
    if not m or "region" not in m:
        raise RuntimeError("还没有截过图：先用 screenshot_understand 截一次，再按图上的位置点击")
    x0, y0 = m["region"][0], m["region"][1]
    scale = float(m.get("scale") or 1.0)
    return int(round(x0 + x * scale)), int(round(y0 + y * scale))


@tool("screenshot_understand", "查看屏幕内容",
      "截取屏幕（或指定窗口），截图会**直接作为图片给你看**——你自己看图判断，不需要谁转述。"
      "要点击时用 window 指定目标窗口，然后把你在图上看到的位置交给 shot_click（后端换算）。",
      {"window": {"type": "string",
                  "description": "只截这个窗口：窗口标题、进程名（如 lx-music、QQ），或 active（前台窗口）"}},
      modes=_FAST)
async def screenshot_understand(args: Dict[str, Any], ctx) -> ToolResult:
    ctx.check_screenshot()
    window = (args.get("window") or "").strip()
    try:
        png = await asyncio.to_thread(_capture_screen, window)
    except Exception as e:
        return ToolResult(f"截屏失败：{e}", ok=False)
    # 图由 image_b64 交给主模型（agent 循环会在工具结果之后补一条带图的 user 消息），
    # 不再转述给另一个视觉模型——省一次请求，而且图在上下文里，判断更准。
    return ToolResult(f"截图已附在你下一条消息里，请直接看图判断。\n{_shot_hint()}",
                      image_b64=base64.b64encode(png).decode())


# ---------- GUI 坐标点击（任务模式专用） ----------
def _send_mouse_input(flags: int, data: int = 0) -> int:
    """发一条鼠标 INPUT，返回真正入队的条数（0 = 被系统拦截）。

    ⚠ 不用 win32api.mouse_event：它是旧 API，对**管理员权限窗口**、部分自绘界面/
    游戏会被静默忽略 —— 用户实测正是「指针移过去了，但点不下、工具却报成功」。
    SendInput 是官方推荐路径，且返回值能告诉我们有没有被 UIPI 拦下。
    """
    import ctypes
    from ctypes import wintypes

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", _INPUTUNION)]

    inp = INPUT()
    inp.type = 0  # INPUT_MOUSE
    inp.union.mi.dx = 0
    inp.union.mi.dy = 0
    inp.union.mi.mouseData = data
    inp.union.mi.dwFlags = flags
    inp.union.mi.time = 0
    inp.union.mi.dwExtraInfo = None
    return int(ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)))


def _gui_click(x: int, y: int, button: str, double: bool) -> None:
    """win32api 直接移动+点击（比 pyautogui 快：pyautogui 每次动作有 0.1s 固有 PAUSE）。

    ⚠ 之前是「SetCursorPos → 20ms → 按下/抬起之间 0 间隔」，
    实测会出现「光标移过去了，但点不下」：
      · 按下与抬起之间没有间隔，靠轮询按键状态的程序（自绘界面、部分游戏/工具）
        会把整帧丢掉，看不到任何点击；
      · 移动后立刻点，有些控件还没进入悬停态，点击落在“未激活”的控件上。
    所以这里是「移动 → 留悬停时间 → 按下 → 留间隔 → 抬起」。

    不做 SetForegroundWindow 抢焦点：那会让目标窗口在前台/后台之间被强行切换
    （观感上就是“点一下把别的窗口顶到前面来了”），而且 Windows 对后台进程的
    抢焦点本来就会拦。需要时用 AGENT_GUI_ACTIVATE=1 打开。
    """
    import time as _time
    import win32api
    import win32con
    vx, vy = win32api.GetSystemMetrics(76), win32api.GetSystemMetrics(77)
    vw, vh = win32api.GetSystemMetrics(78), win32api.GetSystemMetrics(79)
    if not (vx <= x <= vx + vw and vy <= y <= vy + vh):
        raise ValueError(f"坐标 ({x},{y}) 不在屏幕范围内（可用范围 "
                         f"({vx},{vy})-({vx + vw},{vy + vh})）")

    if os.getenv("AGENT_GUI_ACTIVATE") == "1":
        try:
            import win32gui
            hwnd = win32gui.WindowFromPoint((int(x), int(y)))
            if hwnd and win32gui.GetForegroundWindow() != hwnd:
                win32gui.SetForegroundWindow(hwnd)
                _time.sleep(0.15)
        except Exception:
            pass

    # 移动后留出时间，让目标控件进入悬停态再按下
    win32api.SetCursorPos((int(x), int(y)))
    _time.sleep(0.12)

    if button == "right":
        down, up = win32con.MOUSEEVENTF_RIGHTDOWN, win32con.MOUSEEVENTF_RIGHTUP
    else:
        down, up = win32con.MOUSEEVENTF_LEFTDOWN, win32con.MOUSEEVENTF_LEFTUP
    for i in range(2 if double else 1):
        if _send_mouse_input(down) == 0:
            raise RuntimeError(
                "点击事件被系统拦截（目标窗口权限可能高于本程序）——"
                "请以管理员身份运行 intelligentSTUDIO，或改用 uia_click。")
        _time.sleep(0.06)        # 按下→抬起之间必须有间隔，否则会被整帧丢掉
        if _send_mouse_input(up) == 0:
            raise RuntimeError("鼠标抬起事件被系统拦截，已中止本次点击。")
        if double and i == 0:
            _time.sleep(0.07)    # 双击间隔
    _time.sleep(0.05)
    _mark_shot_stale()           # 点过界面之后，旧截图上的坐标可能就不准了


# ⚠ 注意：这里曾经把 @tool("gui_click", ...) 挂在下面这个辅助函数上，
# 于是注册表里 gui_click 的处理器成了 _looks_like_shot_coords（返回 bool）——
# 任何点击都会回「工具 gui_click 的返回值异常（bool）：False」，
# 模型就把它回报成「点击工具失效」（用户实测反馈的正是这个）。
# 装饰器必须**紧贴**真正的 async def gui_click（见下方）。
def _looks_like_shot_coords(x: int, y: int) -> bool:
    """判断 (x,y) 是不是「截图上的像素」被误当成屏幕坐标。

    三层判据（越靠前越确定）：
      1. 落在图幅内、却不在截图覆盖的屏幕区域里 → 图坐标（窗口截图）；
      2. 落在图幅内、**也**在屏幕区域里（两者重叠区）：
         · 有缩放 → 图坐标（缩放后的图幅必然小于屏幕区域）；
         · 无缩放但截图带偏移（region 左上不是 0,0）→ **同样判为图坐标**。
           这是之前的缺口：窗口截图 scale=1 时重叠区约占图幅 40%，
           模型把图坐标传给 gui_click 会被放行，点击整体偏移 (region.left, region.top)
           —— 用户实测「lx-music 每次点击都偏移，其他窗口正常」就是这条。
      3. 落在图幅外 → 一定是屏幕坐标，放行。

    ⚠ 代价：窗口带偏移时，落在图幅内的**屏幕坐标**也会被拒。这类坐标主要来自
    uia_list_controls 的 @(x,y)，而现行规则是「能用 uia_click 直接激活就别用坐标」，
    所以误伤面很小；被拒时提示里会同时给出「用 shot_click」和「移开窗口再点」两条路。
    """
    m = _SHOT_META
    if not m or "region" not in m or "image" not in m:
        return False
    x0, y0, x1, y1 = m["region"]
    iw, ih = m["image"]
    scale = float(m.get("scale") or 1.0)

    if not (0 <= x < iw and 0 <= y < ih):
        return False                        # 图幅之外 → 不可能是图坐标
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return True                         # 图幅内、却不在截图覆盖的屏幕区域
    if scale > 1.0:
        return True                         # 缩放过 → 重叠区必然是图坐标
    return x0 != 0 or y0 != 0               # 无缩放但有偏移 → 同样高度可疑


def _occluder(x: int, y: int) -> str:
    """(x,y) 处最上面的窗口若不是最近截图的那个、且属于别的进程 → 返回它的名字。

    实测场景：聊天窗口压在音乐播放器中下部，播放控制栏整块被挡，
    那里的坐标点下去只会点到聊天窗口——所以这种点击直接拒绝并说清原因。
    """
    m = _SHOT_META
    if not m or not m.get("hwnd"):
        return ""
    try:
        import win32gui
        import win32process
        hwnd = win32gui.WindowFromPoint((int(x), int(y)))
        if not hwnd:
            return ""
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        _, own = win32process.GetWindowThreadProcessId(int(m["hwnd"]))
        if pid == own:
            return ""                     # 同一进程（含它的菜单/子窗）不算被挡
        if _is_self_process(hwnd):
            return ""                     # Dony 自己的覆盖层不算遮挡（见 _self_process_names）
        return _top_window_name(hwnd)
    except Exception:
        return ""


def _mark_shot_stale() -> None:
    """任何点击/拖拽/滚动之后都调用：最近那张截图就不再可信了。

    实测症状（用户/模型反馈）：要「起于第 02 行、落于第 05 行」，实际是第 07-10 行——
    **起点和终点各自稳定偏移同一个常量**。这正是“拿旧截图量行号”的指纹：
    中间滚过/点过界面，内容移动了固定几行，而图上坐标没跟着变。
    """
    if _SHOT_META:
        _SHOT_META["stale"] = True


def _stale_note() -> str:
    if not _SHOT_META or not _SHOT_META.get("stale"):
        return ""
    return (" ⚠ 这张截图之后界面已经被操作过（点击/拖拽/滚动），图上坐标可能整体错位——"
            "尤其是滚动过的窗口，请重新截图再量坐标。")


def _click_note(x: int, y: int) -> Tuple[bool, str]:
    """点击后的附加说明，**同时**给出这次点击该不该算失败。返回 (ok, note)。

    ⚠ 以前调用方写的是 `ok = not note`：只要 note 非空就判成失败。而坐标落在
    截图范围内时 note 是 `_stale_note()`（"截图之后界面被操作过"的提醒），
    于是**第一次点击之后，后面每一次点击都返回 ok=False**。模型据此认为没点中，
    反复点同一处（用户实测：「模型反复点同一处，但对话里也不说点击失败」）。
    点击其实已经执行了，stale 只是提醒，不能否决成败。

    只有「坐标根本不在最近一次截图范围内」才真的可疑 —— 那种情况才判失败，
    并提示改用 shot_click / 重新截图。
    """
    m = _SHOT_META
    if not m or "region" not in m:
        return True, ""
    x0, y0, x1, y1 = m["region"]
    if x0 <= x <= x1 and y0 <= y <= y1:
        return True, _stale_note()
    where = f"窗口「{m['window']}」" if m.get("window") else "整屏"
    return False, (f" ⚠ 这个坐标不在最近一次截图（{where}，屏幕区域 "
                   f"({x0},{y0})-({x1},{y1})）的范围内。"
                   f"如果你量的是**图上像素**，请改用 shot_click（它会自动换算）；"
                   f"不要把窗口内坐标直接当成屏幕坐标传给 gui_click。")


@tool("gui_click", "光标点击",
      "在屏幕指定坐标模拟鼠标点击（仅当 UIA 与直接操作都不可用时使用）。"
      "坐标是**屏幕像素**：优先取 uia_list_controls 返回的控件中心坐标（自带 @(x,y)）；"
      "看图定位请用 shot_click（它会按截图缩放自动换算），别把图上的像素直接当屏幕像素传进来。"
      "button: left/right。double: 是否双击。点完若无反应，先重新截屏确认，不要连续盲点。",
      {"x": {"type": "integer", "required": True},
       "y": {"type": "integer", "required": True},
       "button": {"type": "string", "enum": ["left", "right"]},
       "double": {"type": "boolean"}},
      modes=_TASK_ONLY)
async def gui_click(args: Dict[str, Any], ctx) -> ToolResult:
    x, y = int(args["x"]), int(args["y"])
    button = args.get("button") or "left"
    double = bool(args.get("double"))
    if _looks_like_shot_coords(x, y):
        m = _SHOT_META
        scale = float(m.get("scale") or 1.0)
        rx0, ry0, rx1, ry1 = m["region"]
        iw, ih = m["image"]
        sx, sy = int(round(rx0 + x * scale)), int(round(ry0 + y * scale))
        if scale > 1.0:
            why = (f"最近那张截图是 {scale} 倍缩小后的图（图幅 {iw}×{ih}），"
                   f"({x},{y}) 落在图幅内")
        else:
            why = (f"({x},{y}) 落在最近那张截图的图幅内（{iw}×{ih}，1:1），"
                   f"而这张截图是窗口「{m.get('window') or '整屏'}」、"
                   f"屏幕区域 ({rx0},{ry0})-({rx1},{ry1})")
        return ToolResult(
            f"没有点击：{why}，看起来是**图上的像素**。\n"
            f"· 若这就是你在图上量的位置 → 用 shot_click(x={x}, y={y})，会点到屏幕 ({sx},{sy})；\n"
            f"· 若要的就是屏幕坐标 ({x},{y}) → 先把该窗口移开，"
            f"或改用 uia_click 直接激活控件（不需要坐标）。",
            ok=False)
    blocked = _occluder(x, y)
    if blocked:
        return ToolResult(
            f"没有点击：({x},{y}) 处是「{blocked}」的窗口，不是最近截图的那个窗口——"
            f"目标被它挡住了，点下去只会点到它。请先移开或最小化「{blocked}」，"
            f"再重新截图定位。", ok=False)
    try:
        await asyncio.to_thread(_gui_click, x, y, button, double)
    except Exception as e:
        return ToolResult(f"点击失败：{e}", ok=False)
    ok, note = _click_note(x, y)
    # ok 只取决于「坐标是否落在截图范围内」：成功后已执行，stale 提醒不否决成败
    return ToolResult(f"已在坐标 ({x},{y}) {'双击' if double else '点击'}（{button}）。{note}",
                      ok=ok)


@tool("shot_click", "按图点击",
      "坐标填**最近一次 screenshot_understand 那张图上的像素位置**（你看到目标在图上哪里就填哪里，"
      "后端会按缩放换算成屏幕坐标，你不用做任何计算），适合“看图点目标”。"
      "如果坐标是 uia_list_controls 返回的 @(x,y)（那些本身已是屏幕像素），请改用 gui_click。"
      "button: left/right。double: 是否双击。",
      {"x": {"type": "integer", "required": True},
       "y": {"type": "integer", "required": True},
       "button": {"type": "string", "enum": ["left", "right"]},
       "double": {"type": "boolean"}},
      modes=_TASK_ONLY)
async def shot_click(args: Dict[str, Any], ctx) -> ToolResult:
    x, y = int(args["x"]), int(args["y"])
    button = args.get("button") or "left"
    double = bool(args.get("double"))
    try:
        sx, sy = await asyncio.to_thread(_shot_to_screen, x, y)
    except Exception as e:
        return ToolResult(f"点击失败：{e}", ok=False)
    blocked = _occluder(sx, sy)
    if blocked:
        return ToolResult(
            f"没有点击：换算后的屏幕位置 ({sx},{sy}) 处是「{blocked}」的窗口，"
            f"不是最近截图的那个窗口——目标被它挡住了。请先移开或最小化「{blocked}」，"
            f"再重新截图定位。", ok=False)
    try:
        await asyncio.to_thread(_gui_click, sx, sy, button, double)
    except Exception as e:
        return ToolResult(f"点击失败：{e}", ok=False)
    ok, note = _click_note(sx, sy)
    return ToolResult(f"已在截图上 ({x},{y}) 处 {'双击' if double else '点击'}"
                      f"（屏幕坐标 ({sx},{sy})）。{note}", ok=ok)


# ---------- GUI 拖拽 / 滚轮（任务模式专用） ----------
def _ensure_on_screen(x: int, y: int) -> None:
    """坐标必须在屏幕可用范围内（虚拟桌面可能带负原点）。"""
    import win32api
    vx, vy = win32api.GetSystemMetrics(76), win32api.GetSystemMetrics(77)
    vw, vh = win32api.GetSystemMetrics(78), win32api.GetSystemMetrics(79)
    if not (vx <= x <= vx + vw and vy <= y <= vy + vh):
        raise ValueError(f"坐标 ({x},{y}) 不在屏幕范围内（可用范围 "
                         f"({vx},{vy})-({vx + vw},{vy + vh})）")


def _gui_drag(x1: int, y1: int, x2: int, y2: int, button: str = "left",
              duration_ms: int = 600) -> None:
    """按住从 (x1,y1) 拖到 (x2,y2)。

    三个要点（拖拽失败基本都是这里出的问题）：
      · 不能“按下后一步跳到终点”：目标程序按帧轮询鼠标位置，一步到位常被识别成
        “点了一下”或干脆没反应，所以要按距离分成多步、每步之间给 10-30ms；
      · 按下后要稍停一下：不少程序需要“按住”一小会才进入拖拽状态；
      · 到终点后再停一下才松手：让最后一次移动被吃到，否则松手仍在半路。
    """
    import time as _time
    import win32api
    import win32con
    _ensure_on_screen(x1, y1)
    _ensure_on_screen(x2, y2)
    if button == "right":
        down, up = win32con.MOUSEEVENTF_RIGHTDOWN, win32con.MOUSEEVENTF_RIGHTUP
    else:
        down, up = win32con.MOUSEEVENTF_LEFTDOWN, win32con.MOUSEEVENTF_LEFTUP
    dist = max(abs(x2 - x1), abs(y2 - y1))
    steps = max(12, min(40, dist // 12))
    delay = max(0.008, (duration_ms / 1000.0) / steps)

    win32api.SetCursorPos((int(x1), int(y1)))
    _time.sleep(0.12)                  # 起点先进入悬停态
    if _send_mouse_input(down) == 0:
        raise RuntimeError("拖拽按下事件被系统拦截（目标窗口权限可能高于本程序）。")
    _time.sleep(0.08)                  # 按住一小会再动
    for i in range(1, steps + 1):
        win32api.SetCursorPos((int(round(x1 + (x2 - x1) * i / steps)),
                               int(round(y1 + (y2 - y1) * i / steps))))
        _time.sleep(delay)
    _time.sleep(0.1)                   # 到终点后顿一下再松手
    _send_mouse_input(up)
    _time.sleep(0.06)
    _mark_shot_stale()                 # 拖动可能改变界面（滚动/选中），旧截图不再可信


def _gui_scroll(x: int, y: int, lines: int) -> int:
    """在 (x,y) 处滚动滚轮，返回实际滚的格数。

    一格滚轮 = WHEEL_DELTA(120)，Windows 默认一格 = 3 行，所以 lines 按
    「3 行 = 一格」换算；并且**一格一格发**（间隔 12ms）——一次发很大的
    delta 会被部分程序忽略或只滚一点点。

    符号按系统约定：dwData **正数 = 滚轮向前 = 页面向上**，负数向下。
    所以「向下滚」要发 -120（这条一开始接反了，实测向下滚完全没反应）。
    """
    import time as _time
    import win32api
    import win32con
    _ensure_on_screen(x, y)
    if not lines:
        raise ValueError("lines 不能为 0")
    notches = min(40, int(round(abs(lines) / 3.0)) or 1)
    step = -win32con.WHEEL_DELTA if lines > 0 else win32con.WHEEL_DELTA
    win32api.SetCursorPos((int(x), int(y)))
    _time.sleep(0.06)
    for _ in range(notches):
        _send_mouse_input(win32con.MOUSEEVENTF_WHEEL, step)
        _time.sleep(0.012)
    _time.sleep(0.05)
    _mark_shot_stale()                 # 滚过之后，之前量好的行号全部错位
    return notches


@tool("gui_drag", "光标拖拽",
      "按住鼠标从起点拖到终点：拖动滑块、移动窗口、拉选内容、拖放文件等。"
      "坐标是**屏幕像素**（起点可取自 uia_list_controls 的 @(x,y)）；看图定位请用 shot_drag。"
      "button: left/right。duration_ms: 整个拖动时长（默认 600；拖窗口这类可以给 800-1200，更稳）。",
      {"x1": {"type": "integer", "description": "起点 x（屏幕像素）", "required": True},
       "y1": {"type": "integer", "description": "起点 y（屏幕像素）", "required": True},
       "x2": {"type": "integer", "description": "终点 x（屏幕像素）", "required": True},
       "y2": {"type": "integer", "description": "终点 y（屏幕像素）", "required": True},
       "button": {"type": "string", "enum": ["left", "right"]},
       "duration_ms": {"type": "integer", "description": "拖动时长（毫秒），默认 600"}},
      modes=_TASK_ONLY)
async def gui_drag(args: Dict[str, Any], ctx) -> ToolResult:
    x1, y1, x2, y2 = (int(args[k]) for k in ("x1", "y1", "x2", "y2"))
    button = args.get("button") or "left"
    duration = max(120, min(4000, int(args.get("duration_ms") or 600)))
    if _looks_like_shot_coords(x1, y1) or _looks_like_shot_coords(x2, y2):
        m = _SHOT_META
        return ToolResult(
            f"没有拖动：坐标看起来是**截图上的像素**（截图范围 "
            f"({m['region'][0]},{m['region'][1]})-({m['region'][2]},{m['region'][3]})）。"
            f"请改用 shot_drag（会自动换算），或改传屏幕坐标。", ok=False)
    for label, (px, py) in (("起点", (x1, y1)), ("终点", (x2, y2))):
        blocked = _occluder(px, py)
        if blocked:
            return ToolResult(f"没有拖动：{label} ({px},{py}) 处是「{blocked}」的窗口，"
                              f"不是最近截图的那个窗口——目标被它挡住了，先移开再试。", ok=False)
    try:
        await asyncio.to_thread(_gui_drag, x1, y1, x2, y2, button, duration)
    except Exception as e:
        return ToolResult(f"拖动失败：{e}", ok=False)
    return ToolResult(f"已从 ({x1},{y1}) 拖到 ({x2},{y2})（{button}，{duration}ms）。"
                      f"拖完请重新截一张图确认结果，没到位就调整坐标重来。"
                      + _stale_note())


@tool("shot_drag", "按图拖拽",
      "拖拽的起点/终点填**最近一次 screenshot_understand 那张图上的像素位置**，"
      "后端会按缩放换算成屏幕坐标（你不用做任何计算），适合“看图拖东西”。"
      "button: left/right。duration_ms: 拖动时长（默认 600）。",
      {"x1": {"type": "integer", "description": "起点 x（截图上的像素）", "required": True},
       "y1": {"type": "integer", "description": "起点 y（截图上的像素）", "required": True},
       "x2": {"type": "integer", "description": "终点 x（截图上的像素）", "required": True},
       "y2": {"type": "integer", "description": "终点 y（截图上的像素）", "required": True},
       "button": {"type": "string", "enum": ["left", "right"]},
       "duration_ms": {"type": "integer", "description": "拖动时长（毫秒），默认 600"}},
      modes=_TASK_ONLY)
async def shot_drag(args: Dict[str, Any], ctx) -> ToolResult:
    x1, y1, x2, y2 = (int(args[k]) for k in ("x1", "y1", "x2", "y2"))
    button = args.get("button") or "left"
    duration = max(120, min(4000, int(args.get("duration_ms") or 600)))
    try:
        sx1, sy1 = await asyncio.to_thread(_shot_to_screen, x1, y1)
        sx2, sy2 = await asyncio.to_thread(_shot_to_screen, x2, y2)
    except Exception as e:
        return ToolResult(f"拖动失败：{e}", ok=False)
    for label, (px, py) in (("起点", (sx1, sy1)), ("终点", (sx2, sy2))):
        blocked = _occluder(px, py)
        if blocked:
            return ToolResult(f"没有拖动：{label}换算到屏幕 ({px},{py}) 处是「{blocked}」的窗口，"
                              f"不是最近截图的那个窗口——目标被它挡住了，先移开再试。", ok=False)
    try:
        await asyncio.to_thread(_gui_drag, sx1, sy1, sx2, sy2, button, duration)
    except Exception as e:
        return ToolResult(f"拖动失败：{e}", ok=False)
    return ToolResult(f"已从图上 ({x1},{y1}) 拖到 ({x2},{y2})"
                      f"（屏幕 ({sx1},{sy1})→({sx2},{sy2})，{duration}ms）。"
                      f"拖完请重新截图确认结果。")


@tool("gui_scroll", "滚动界面",
      "在指定位置滚动鼠标滚轮（滚动页面/列表/文档）。lines 正数向下滚、负数向上滚，"
      "一格滚轮≈3 行（按此换算，实际按整格发，一次最多 40 格≈120 行，要滚更多就多调几次）。"
      "位置二选一：给屏幕坐标 x/y，或给 window（窗口标题/进程名/active，自动取窗口中心）。",
      {"lines": {"type": "integer", "description": "滚动行数：正数向下、负数向上", "required": True},
       "x": {"type": "integer", "description": "滚动位置 x（屏幕像素）"},
       "y": {"type": "integer", "description": "滚动位置 y（屏幕像素）"},
       "window": {"type": "string",
                  "description": "窗口标题/进程名/active；不给 x/y 时用它取窗口中心"}},
      modes=_TASK_ONLY)
async def gui_scroll(args: Dict[str, Any], ctx) -> ToolResult:
    lines = int(args["lines"])
    if not lines:
        return ToolResult("lines 不能为 0（正数向下、负数向上）。", ok=False)
    x, y, where = args.get("x"), args.get("y"), ""
    if x is None or y is None:
        win = (args.get("window") or "").strip()
        if not win:
            return ToolResult("需要位置：给屏幕坐标 x/y，或给 window 取窗口中心。", ok=False)
        try:
            _, title, rect = await asyncio.to_thread(_find_window_rect, win)
        except Exception as e:
            return ToolResult(f"没找到窗口：{e}", ok=False)
        x, y = rect[0] + rect[2] // 2, rect[1] + rect[3] // 2
        where = f"窗口「{title}」中心"
    blocked = _occluder(int(x), int(y))
    if blocked:
        return ToolResult(f"没有滚动：({int(x)},{int(y)}) 处是「{blocked}」的窗口，"
                          f"不是最近截图的那个窗口——先移开再试。", ok=False)
    try:
        notches = await asyncio.to_thread(_gui_scroll, int(x), int(y), lines)
    except Exception as e:
        return ToolResult(f"滚动失败：{e}", ok=False)
    return ToolResult(f"已在{where}({int(x)},{int(y)}) "
                      f"{'向下' if lines > 0 else '向上'}滚动约 {abs(lines)} 行（{notches} 格）。"
                      f"滚完请重新截一张图确认位置（之前那张图上的行号已经全部错位）。")


# ---------- Edge 扩展 API ----------
@tool("edge_browser", "读取、整理或清理浏览器",
      "通过 Edge 扩展提供的 API 读取/整理/删除浏览器信息。action: "
      "tabs(读取标签页) / bookmarks(读取收藏夹，列表里的 [id=…] 可直接用于删除) / "
      "organize_tabs(整理标签页：按域名分组 + 关闭重复标签页) / "
      "organize_bookmarks(整理收藏夹：按域名收纳 + 合并完全重复的网址) / "
      "delete_bookmarks(删除指定收藏项：给出 ids 或 urls 或 titles，执行前会向用户确认)。"
      "需要 Edge 扩展已安装并运行。",
      {"action": {"type": "string",
                  "enum": ["tabs", "bookmarks", "organize_tabs", "organize_bookmarks",
                           "delete_bookmarks"],
                  "required": True},
       "ids": {"type": "array", "items": {"type": "string"},
               "description": "delete_bookmarks：要删除的收藏项 id（读取收藏夹时 [id=…] 里的值）"},
       "urls": {"type": "array", "items": {"type": "string"},
                "description": "delete_bookmarks：要删除的收藏项完整网址"},
       "titles": {"type": "array", "items": {"type": "string"},
                  "description": "delete_bookmarks：要删除的收藏项标题（完全匹配）"}},
      modes=_FAST)
async def edge_browser(args: Dict[str, Any], ctx) -> ToolResult:
    import httpx
    action = args["action"]
    try:
        async with httpx.AsyncClient(base_url=config.EDGE_API_BASE, timeout=8.0) as client:
            if action in ("tabs", "bookmarks"):
                resp = await client.get(f"/{action}")
            elif action == "delete_bookmarks":
                return await _edge_delete_bookmarks(client, args, ctx)
            else:
                resp = await client.post(f"/{action}")
        return ToolResult(f"Edge {action} 结果：\n{resp.text[:2000]}",
                          card={"kind": "edge", "subtitle": f"{action}"})
    except Exception:
        return ToolResult("Edge 扩展 API 未连接（请确认 Edge 已安装「Visual intelligence」扩展且浏览器正在运行）。",
                          ok=False)


async def _edge_delete_bookmarks(client, args: Dict[str, Any], ctx) -> ToolResult:
    """删除收藏项：先预演匹配结果，再由用户确认，最后真正删除。

    删除不可逆，所以确认放在**工具内部**（ctx.confirm）而不是指望模型自觉：
    无论从主界面还是扩展浮窗发起，都会弹出「允许 / 不允许」。
    """
    def _list(key: str) -> List[str]:
        value = args.get(key)
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [str(v) for v in value if str(v).strip()]
        return []

    body = {"ids": _list("ids"), "urls": _list("urls"), "titles": _list("titles")}
    if not any(body.values()):
        return ToolResult("删除收藏项需要给出 ids、urls 或 titles 之一。"
                          "可先用 action=bookmarks 读取（列表里的 [id=…] 就是可删除的编号）。", ok=False)
    preview = await client.post("/bookmarks/delete", json={**body, "dry_run": True}, timeout=15.0)
    text = preview.text.strip()
    if not text.startswith("删除预演："):
        return ToolResult(text, ok=False)
    approved = await ctx.confirm(f"是否删除收藏夹里的这些条目？\n{text[len('删除预演：'):]}")
    if not approved:
        return ToolResult("用户不允许删除，已取消（收藏夹未改动）。", ok=False)
    resp = await client.post("/bookmarks/delete", json=body, timeout=20.0)
    detail = resp.text[:2000]
    return ToolResult(detail, ok=detail.startswith("删除完成："),
                      card={"kind": "edge", "subtitle": "delete_bookmarks"})


# ---------- MCP / Skill ----------
# 原先这里有两个「预留接口」桩工具 mcp_call / use_skill，恒返回
# 「调用通道尚未启用（等待设置APP对接）」「Skill 运行时尚未启用」。
# 它们会与真实实现并存（真实实现见 agent/mcp.py 的 mcp__<服务>__<工具>，
# 以及 agent/tools/skills.py 的 load_skill），模型时常优先挑中这两个桩，
# 于是明明能调用，却回报「已安装/已配置，但未启用」——已删除，避免误导。
