"""书写辅助：全局选区监听。

职责只有一件：用户用鼠标划选之后，把「选中了什么、在屏幕哪里」告诉界面。

为什么不放在 Electron 侧：Chromium **没有**任何跨应用的选区 API（`window.getSelection()`
只对自己窗口的 DOM 有效，`clipboard` 只有文字没有位置），选区几何必须由 Windows 平台层给。
这里用 UIA 的 TextPattern：

    GetFocusedControl() → GetTextPattern() → GetSelection() → TextRange
    TextRange.GetText()                → 选中文本
    TextRange.GetBoundingRectangles()  → 逐行矩形（屏幕物理像素），即系统蓝色高亮的形状

「第一个字」的位置单独取：选区端点的 Start 永远是**逻辑起点**，与拖拽方向无关，
所以把克隆范围的 End 端点移到 Start、再向后扩一个字符，就精确落在第一个字上。
（从右往左划选时鼠标按下点在末尾，靠按下点估起点是错的 —— 这是必须走 UIA 的原因之一。）

触发方式：低层鼠标状态轮询（20ms）判断左键抬起，抬起后延迟若干毫秒再查一次 UIA。
不用 SetWindowsHookEx：轮询同样不吞事件、不阻塞系统输入，而且没有消息循环与钩子
生命周期问题；单次 UIA 调用几十毫秒，只发生在抬起之后，用户无感。
延迟是必需的 —— Chromium 系在鼠标抬起后刷新选区与 UIA 树有 1 帧到 100ms 的延迟，
立刻查会读到上一次的选区。
"""
import asyncio
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

# 左键：VK_LBUTTON
_VK_LBUTTON = 0x01
# 双击 Ctrl：两次 Ctrl 抬起/按下之间的最大间隔（秒）
_DOUBLE_CTRL_SECONDS = 0.45
_VK_CONTROL = 0x11
_VK_LCONTROL = 0xA2
_VK_RCONTROL = 0xA3
_POLL_SECONDS = 0.02
# 读到选区后再等这么久复读，直到两次位置一致（见 _query_with_retry）
_SETTLE_SECONDS = 0.08
# 最多补读几次（0.08 × 4 ≈ 320ms 上限；实际一两轮就稳定）
_SETTLE_MAX_TRIES = 4


def _anchor_xy(rect) -> Optional[Tuple[float, float]]:
    """取矩形左上角。

    ⚠ 锚点在链路里出现过**两种形状**：dict（{"x","y"}）和 [x, y, w, h] 数组。
    这里一律兼容 —— 之前只按 dict 取，真机上是数组，直接抛 AttributeError 把
    查询线程打断，结果是一条选区广播都发不出去（整个书写辅助都不出来了）。
    """
    if isinstance(rect, dict):
        return float(rect.get("x", 0)), float(rect.get("y", 0))
    if isinstance(rect, (list, tuple)) and len(rect) >= 2:
        return float(rect[0]), float(rect[1])
    return None


def _same_anchor(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> bool:
    """两次读到的位置是否已经一样（容差 2px：抗锯齿/亚像素会让同一处抖动 1px）。"""
    if not a or not b:
        return False
    pa, pb = _anchor_xy(a.get("anchor")), _anchor_xy(b.get("anchor"))
    if pa is None or pb is None:
        return False
    return abs(pa[0] - pb[0]) <= 2 and abs(pa[1] - pb[1]) <= 2
# 一次划选的选中文本上限：超过就不触发（否则会把整篇文档经 WS 送进请求体）
_MAX_CHARS = 8000
# 向上寻找 TextPattern 的最大层数（Chromium 的焦点偶尔落在 Document 内部的子元素上）
_MAX_ANCESTORS = 6

# 一次查询的三种结果 —— 必须区分，否则会误收起界面（用户实测：点一下「描述修改」输入框，
# 整个书写辅助界面就自己退出了）：
#   _OK    取到有效选区
#   _EMPTY 焦点在**外部程序**、但没有满足条件的选区 ⇒ 选择确实被取消了，界面该收起
#   _SELF  焦点在 **Dony 自己**身上（用户正点我们的标签/菜单/输入框）⇒ "读不到选区"并不
#          代表外部选区没了，这一轮必须什么都不做
_OK, _EMPTY, _SELF = "ok", "empty", "self"

# 上一次读取的现场描述（焦点在谁身上、有没有文本接口）。
# 只在"读不到选区、最终广播取消"时打印 —— 否则日志里只有一句"选区已取消"，
# 完全分不出是"用户真的取消了"，还是"我们自己的窗口抢了焦点/目标程序接口读不到"。
_LAST_DIAG = "（还没读过）"

# 控制台类窗口：里面的选中内容只是**只读输出**，根本改不了，不该弹书写辅助。
# （用户实测：在 CMD 里选中文字也会冒出标签。）
_CONSOLE_PROCS = {
    "cmd.exe", "conhost.exe", "windowsterminal.exe", "wt.exe",
    "powershell.exe", "pwsh.exe",
}


def _union(rects: List[List[int]]) -> Tuple[int, int, int, int]:
    return (min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects))


def _on_primary_screen(rects: List[List[int]]) -> bool:
    """选区是否落在主屏。

    覆盖层只铺主屏（`setBounds(screen.getPrimaryDisplay().bounds)`），落在其它屏上的
    选区算出来了也画不出来，所以直接不触发，免得用户看到"选了却没反应"。
    """
    try:
        import win32api
        w, h = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
    except Exception:
        return True
    left, top, right, bottom = _union(rects)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    return 0 <= cx < w and 0 <= cy < h


def _native_hwnd(control) -> int:
    try:
        return int(control.NativeWindowHandle or 0)
    except Exception:
        return 0


def _find_text_pattern(control) -> Tuple[Any, Any]:
    """从焦点控件向上找第一个支持 TextPattern 的控件。

    只在焦点控件上试一次是不够的：部分程序（含 Chromium 的某些页面）焦点落在内部
    子元素上，真正带文本接口的是它的祖先 Document。
    """
    node = control
    for _ in range(_MAX_ANCESTORS):
        if node is None:
            return None, None
        try:
            pattern = node.GetTextPattern()
        except Exception:
            pattern = None
        if pattern:
            return node, pattern
        try:
            node = node.GetParentControl()
        except Exception:
            return None, None
    return None, None


def _anchor_rect(range_, fallback: List[List[int]]) -> List[int]:
    """第一个字所在的小矩形；取不到时退回选区首行。

    ⚠ 两个 move 调用都必须显式传 waitTime=0：uiautomation 的默认值是 0.5 秒，
    一次 anchor 计算就会平白多出一秒，标签要等一秒才出现。
    """
    try:
        import uiautomation as auto
        first = range_.Clone()
        first.MoveEndpointByRange(auto.TextPatternRangeEndpoint.End, range_,
                                  auto.TextPatternRangeEndpoint.Start, 0)
        first.MoveEndpointByUnit(auto.TextPatternRangeEndpoint.End, auto.TextUnit.Character, 1, 0)
        for rect in first.GetBoundingRectangles():
            if rect.width() > 0 and rect.height() > 0:
                return [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]
    except Exception:
        pass
    return list(fallback[0])


# 可直接用 EM_GETSEL / EM_SETSEL 的编辑控件（与 writing.py 里那份保持一致）
_EDIT_CLASSES = ("richeditd2dpt", "richedit20w", "richedit50w", "richedit", "edit")


def _edit_offsets(hwnd) -> Optional[Dict[str, Any]]:
    """用编辑控件**自己的**坐标读出选区偏移（EM_GETSEL）。

    为什么需要这套坐标：记事本的编辑区是 RichEdit，它内部换行只算 1 个字符，
    而 UIA 的 GetText 把 `\\r\\n` 算 2 个 —— 两套口径在多行文本上必然漂移，
    写回时 `EM_SETSEL` 就会落到错处（"改不了、末尾多一段、复原找不到"）。
    这里直接记控件口径，写回时同一口径使用，**不需要任何换算**。
    """
    try:
        import win32gui
        h = int(hwnd)
        if not h:
            return None
        if (win32gui.GetClassName(h) or "").lower() not in _EDIT_CLASSES:
            return None
        packed = win32gui.SendMessage(h, 0x00B0, 0, 0) or 0   # EM_GETSEL
        start, end = packed & 0xFFFF, (packed >> 16) & 0xFFFF
        if end <= start:
            return None
        return {"start": int(start), "length": int(end - start), "origin": "edit"}
    except Exception:
        return None


def _range_position(auto, pattern, span) -> Optional[Dict[str, int]]:
    """把选区换算成「相对文档开头的字符偏移 + 长度」。

    这是"只依赖位置、不依赖内容"的关键一步：把区间记成两个数字，写回时按它重建，
    与用户此刻的选区/焦点/内容是否变化都无关（同一份文档、同一个控件即可）。
    做法：克隆文档范围，把它的 End 端点移到选区起点，这段前缀的字符数就是起点偏移。
    """
    try:
        doc = pattern.DocumentRange
        head = doc.Clone()
        head.MoveEndpointByRange(auto.TextPatternRangeEndpoint.End, span,
                                 auto.TextPatternRangeEndpoint.Start)
        start = len(head.GetText(-1) or "")
        length = len(span.GetText(-1) or "")
        if length <= 0:
            return None
        return {"start": int(start), "length": int(length)}
    except Exception:
        return None


def _read_selection_inner(auto) -> Tuple[str, Optional[Dict[str, Any]]]:
    """在读选区的那个工作线程里取一次当前选区。

    返回 (状态, 选区)，状态取值见模块顶部的 _OK / _EMPTY / _SELF。
    """
    from . import config
    from .tools.uia_screen import _is_self_process, _proc_name

    # 前台是我们自己的窗口：用户正在操作书写辅助界面（点标签/菜单/输入框）。
    # ⚠ 必须放在**所有**读取之前：我们网页里的控件几乎不暴露 TextPattern，
    #   如果先找 pattern 再判"是不是自己"，会先落进 _EMPTY 分支 —— 被当成
    #   "选区消失"广播出去、界面自己收掉。用户实测的"点一下输入框界面就退出"、
    #   以及上一轮修复无效，根因都是这个判断顺序。
    global _LAST_DIAG
    try:
        fg = int(auto.GetForegroundWindow() or 0)
    except Exception:
        fg = 0
    _LAST_DIAG = f"前台=({_proc_name(fg) if fg else '?'}) 自己={bool(fg and _is_self_process(fg))}"
    if fg and _is_self_process(fg):
        return _SELF, None

    focused = auto.GetFocusedControl()
    if not focused:
        _LAST_DIAG += " 焦点=无"
        return _EMPTY, None
    try:
        _LAST_DIAG += f" 焦点=({focused.ControlTypeName} {focused.Name[:20]!r} 进程={_proc_name(_native_hwnd(focused))})"
    except Exception:
        pass

    node, pattern = _find_text_pattern(focused)
    if pattern is None:
        _LAST_DIAG += " 无文本接口"
        return _EMPTY, None

    owner = node or focused
    hwnd = _native_hwnd(owner)
    if not hwnd:
        try:
            hwnd = int(auto.GetForegroundWindow() or 0)
        except Exception:
            hwnd = 0
    # 焦点在 Dony 自己身上（用户正在点标签/菜单/输入框）：这不是"外部选区"，
    # 但也**不能**当成"选区消失了" —— 那种误判会让界面在用户点输入框时自己退出。
    if hwnd and _is_self_process(hwnd):
        return _SELF, None

    # 控制台类窗口（CMD / PowerShell / Windows Terminal）：选中的只是只读输出，改不了
    from .tools.uia_screen import _proc_name
    try:
        if _proc_name(hwnd).lower() in _CONSOLE_PROCS:
            _LAST_DIAG += " 控制台窗口"
            return _EMPTY, None
    except Exception:
        pass

    # 明确报"只读"的控件同样排除（PDF 阅读器、日志查看器这类）
    try:
        value_pattern = owner.GetValuePattern()
    except Exception:
        value_pattern = None
    if value_pattern is not None:
        try:
            if bool(value_pattern.IsReadOnly):
                _LAST_DIAG += " 控件自报只读(ValuePattern.IsReadOnly)"
                return _EMPTY, None
        except Exception:
            pass

    ranges = pattern.GetSelection() or []
    if not ranges:
        _LAST_DIAG += " 无选区(GetSelection 为空)"
        return _EMPTY, None
    span = ranges[0]

    try:
        text = span.GetText() or ""
    except Exception as e:
        _LAST_DIAG += f" 读文字失败({type(e).__name__})"
        return _EMPTY, None
    if len(text.strip()) < config.WRITING_MIN_CHARS:
        _LAST_DIAG += f" 选区太短({len(text.strip())}字)"
        return _EMPTY, None
    if len(text) > _MAX_CHARS:
        _LAST_DIAG += f" 选区太长({len(text)}字)"
        return _EMPTY, None

    rects: List[List[int]] = []
    for rect in span.GetBoundingRectangles():
        if rect.width() > 0 and rect.height() > 0:
            rects.append([int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)])
    if not rects:
        _LAST_DIAG += " 无有效矩形"
        return _EMPTY, None
    if not _on_primary_screen(rects):
        _LAST_DIAG += " 选区不在主屏"
        return _EMPTY, None

    # 控件外框高度：用来排除文件名框、地址栏、搜索框这类单行小文本框。
    # 只有拿到高度且明显偏小时才否决 —— 某些自绘控件报 0，那种情况下靠字数门槛兜底。
    try:
        box = owner.BoundingRectangle
        ctrl_height = int(box.bottom - box.top)
    except Exception:
        ctrl_height = 0
    if ctrl_height and ctrl_height < config.WRITING_MIN_CTRL_HEIGHT:
        _LAST_DIAG += f" 控件太矮({ctrl_height}px)"
        return _EMPTY, None

    try:
        ctrl_name = str(owner.ControlTypeName or "").replace("Control", "")
    except Exception:
        ctrl_name = ""

    return _OK, {
        "text": text,
        "rects": rects,
        "anchor": _anchor_rect(span, rects),
        "hwnd": hwnd,
        "ctrl": ctrl_name,
        "multiLine": len(rects) > 1,
        # 位置记录（相对文档开头的字符偏移 + 长度）：写回时按它重建区间，
        # 不看当前选区、不看内容 —— 见 writing._span_by_offset
        # 位置记录：优先用**控件口径**（EM_GETSEL，写回时同一口径直接用，无需换算）；
        # 拿不到（Word/浏览器这类没有 EM_SETSEL 的控件）才退回 UIA 字符偏移。
        "pos": _edit_offsets(hwnd) or _range_position(auto, pattern, span),
    }


class SelectionWatcher:
    """选区监听器：轮询线程 → 查询线程 → (事件循环队列) → agent_server 广播。

    线程分工刻意分开：轮询必须保持 20ms 的节奏（否则会漏掉一次快速的按下-抬起），
    而 UIA 查询要几十毫秒且要 sleep 等目标程序刷新，两者放在一起必然互相拖累。
    """

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._queue: Optional[asyncio.Queue] = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads: List[threading.Thread] = []
        self._seq = 0
        # 每次"左键抬起"一个编号。同一次抬键可能被读两次（查询重试、停查结束后补查），
        # 前端据此区分"同一次动作的重复广播"与"用户又划了一次"——
        # 没有这个号，重复广播会被当成新划选，把刚打开的菜单当场拆掉。
        self._gesture = 0
        # 当前这次查询是由哪一次抬键触发的（见 _poll_loop 里的说明）
        self._wake_gesture = 0
        # 这一次查询是不是"双击 Ctrl"手动触发的（是的话前端直接打开改写面板）
        self._manual = False
        self._had_selection = False
        self._started = False
        # 用户正在操作书写辅助界面时的"停查"截止时刻（见 suspend）
        self._resume_at = 0.0
        # 书写界面是否正在显示（见 set_ui_active：决定要不要派发物理点击）
        self._ui_active = False
        # 界面各块的屏幕矩形（见 set_ui_active / _in_ui）
        self._ui_rects: List[Dict[str, Any]] = []

    # ---------- 用户操作期间的停查 ----------
    def suspend(self, seconds: float = 5.0) -> None:
        """用户正在操作书写辅助界面：这段时间一律不查询选区。

        为什么必须停：用户点我们的标签/菜单/输入框时，焦点落在**我们自己**的窗口上，
        此时 UIA 读不到外部选区。若照常"查不到就广播空选区"，界面就会自己收掉 ——
        用户实测的现象正是"点一下「描述修改」输入框，整个界面退出"。

        有超时兜底（默认 5 秒）：万一界面忘了回报"操作结束"，也不会永久停摆。
        """
        self._resume_at = time.monotonic() + max(0.5, seconds)

    def resume(self) -> None:
        self._resume_at = 0.0

    def _suspended(self) -> bool:
        return time.monotonic() < self._resume_at

    # ---------- 生命周期 ----------
    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        """在主事件循环里绑定：事件从这里交回 asyncio 侧。"""
        self._loop = loop
        self._queue = asyncio.Queue()

    def start(self) -> None:
        if self._started:
            return
        if self._loop is None or self._queue is None:
            raise RuntimeError("SelectionWatcher.attach(loop) 必须先于 start()")
        from . import config
        if not config.WRITING_ENABLED:
            print("[writing] 选区监听已由 WRITING_ENABLED 关闭", flush=True)
            return
        self._started = True
        for name, target in (("writing-mouse", self._poll_loop), ("writing-uia", self._query_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
        # 双击 Ctrl：可在设置应用中关闭（WRITING_DOUBLE_CTRL）
        if config.writing_double_ctrl():
            t = threading.Thread(target=self._kbd_loop, name="writing-keys", daemon=True)
            t.start()
            self._threads.append(t)
        print(f"[writing] 选区监听已启动（最小 {config.WRITING_MIN_CHARS} 字，"
              f"控件高 ≥ {config.WRITING_MIN_CTRL_HEIGHT}px，"
              f"双击 Ctrl {'开' if config.writing_double_ctrl() else '关'}）", flush=True)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    async def events(self):
        """异步生成器：把工作线程推来的事件交给调用方（agent_server 负责广播）。"""
        if self._queue is None:
            return
        while True:
            event = await self._queue.get()
            yield event

    # ---------- 物理点击派发 ----------
    def wake(self) -> None:
        """立刻重读一次选区。

        写回之后文档变了（内容与长度都变），界面上的选框尺寸和位置账本都需要同步 ——
        否则用户会看到"框还是旧大小"，而下一次「复原」也会按旧偏移定位。
        """
        try:
            self._wake_gesture = self._gesture
            self._wake.set()
        except Exception:
            pass

    def set_ui_active(self, active: bool, rects=None) -> None:
        """书写界面是否正在显示（决定要不要把物理点击派发给前端）。

        为什么需要这条链路：覆盖层是 WS_EX_LAYERED 的透明窗，真实环境里出现过
        "系统层面确认点击落在我们窗口上、Chromium 却没有把它变成 DOM 事件"的情况
        （日志里连点十几次，渲染层一次 mousedown 都没有）。这条链路绕开 Chromium 的
        输入分发：后端直接看物理按键与指针位置，把点发给前端，由前端自己做命中派发。
        """
        self._ui_active = bool(active)
        # 界面各块的屏幕矩形（标签/菜单/横框）。窗口始终点击穿透，所以点我们界面时
        # 那一下**同时**会落到下面的编辑器里；用这份矩形就能认出"这次抬起是打在我们
        # 自己界面上的"，从而跳过重读选区（不跳过就会被读空、会话当场结束）。
        if rects is not None:
            self._ui_rects = [r for r in rects
                              if isinstance(r, dict) and "x" in r and "y" in r]

    # ---------- 线程：键盘（双击 Ctrl） ----------
    def _trigger_manual(self) -> None:
        """双击 Ctrl：按"一次新的动作"读当前选区，结果带上 manual 标记。

        读不到选区（没有选中文字、选区太短、焦点在我们自己身上）时**什么都不发** ——
        手动触发不应该凭空显示界面，也不该把已有会话收掉。
        """
        self._manual = True
        self._gesture += 1
        self._wake_gesture = self._gesture
        self._wake.set()

    def _kbd_loop(self) -> None:
        """低层键盘钩子：只识别"双击 Ctrl"这一种手势。

        为什么用钩子而不是轮询：双击 Ctrl 需要区分"单独按两下 Ctrl"与
        "Ctrl+C 按了两遍" —— 后者两次按下之间夹着别的键，必须作废。轮询拿不到
        "这期间有没有其它键"，钩子拿得到。钩子只读不吞：一律 CallNextHookEx，
        不改变任何按键行为。
        """
        import ctypes
        from ctypes import wintypes

        WH_KEYBOARD_LL = 13
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x100, 0x101, 0x104, 0x105

        class KBDLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [
                ("vkCode", wintypes.DWORD),
                ("scanCode", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_void_p),
            ]

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        state = {"down": False, "last_up": 0.0}

        # 显式声明原型：LRESULT / LPARAM 是指针宽度，缺省 c_int 会在 x64 上截断
        # （实测报错：OverflowError: int too long to convert）
        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int,
                                      wintypes.WPARAM, wintypes.LPARAM)
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC,
                                             ctypes.c_void_p, wintypes.DWORD]
        user32.SetWindowsHookExW.restype = ctypes.c_void_p
        user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                          wintypes.WPARAM, wintypes.LPARAM]
        user32.CallNextHookEx.restype = ctypes.c_ssize_t
        user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
        user32.UnhookWindowsHookEx.restype = wintypes.BOOL
        user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), ctypes.c_void_p,
                                        wintypes.UINT, wintypes.UINT, wintypes.UINT]
        user32.PeekMessageW.restype = wintypes.BOOL

        def proc(nCode, wParam, lParam):
            if nCode == 0:
                try:
                    kb = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                    vk = int(kb.vkCode)
                    is_down = wParam in (WM_KEYDOWN, WM_SYSKEYDOWN)
                    is_up = wParam in (WM_KEYUP, WM_SYSKEYUP)
                    is_ctrl = vk in (_VK_CONTROL, _VK_LCONTROL, _VK_RCONTROL)
                    if is_ctrl and is_down and not state["down"]:
                        state["down"] = True
                        now = time.monotonic()
                        if state["last_up"] and now - state["last_up"] <= _DOUBLE_CTRL_SECONDS:
                            state["last_up"] = 0.0
                            self._trigger_manual()
                    elif is_ctrl and is_up:
                        state["down"] = False
                        state["last_up"] = time.monotonic()
                    elif is_down and not is_ctrl:
                        # 两次 Ctrl 之间夹了别的键：这是一组快捷键，不是双击 Ctrl
                        state["last_up"] = 0.0
                except Exception:
                    pass
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        callback = HOOKPROC(proc)
        hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, callback, None, 0)
        if not hook:
            print("[writing] 双击 Ctrl 监听注册失败（键盘钩子不可用）", flush=True)
            return
        print("[writing] 双击 Ctrl 监听已启动", flush=True)
        msg = wintypes.MSG()
        try:
            while not self._stop.is_set():
                # PeekMessage + 小睡：GetMessage 会一直阻塞，stop 时无法退出线程
                if user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                else:
                    time.sleep(0.01)
        finally:
            user32.UnhookWindowsHookEx(hook)
            print("[writing] 双击 Ctrl 监听已停止", flush=True)

    # ---------- 线程：鼠标轮询 ----------
    def _poll_loop(self) -> None:
        import win32api
        pressed_before = False
        while not self._stop.is_set():
            try:
                pressed = bool(win32api.GetKeyState(_VK_LBUTTON) & 0x8000)
                if pressed and not pressed_before:
                    pressed_before = True
                    # 按下就派发（不像"单击"那样等抬起）：界面按钮的反应必须是按下的那一刻。
                    # 是否落在可点元素上由前端判定（它手上才有 DOM 布局）。
                    if self._ui_active:
                        try:
                            x, y = win32api.GetCursorPos()
                            self._enqueue({"type": "writing-click", "x": int(x), "y": int(y)})
                        except Exception:
                            pass
                elif not pressed and pressed_before:
                    pressed_before = False
                    # ⚠ 号只给"真的会触发查询"的抬键（在目标程序里的抬键）：
                    #   点我们自己的标签/菜单同样会产生一次抬起，那一下就加号的话，
                    #   随后那次"补查"会带上新号，前端就认不出它其实是上一次划选。
                    # ⚠ 号还必须**在抬键这一刻固定**到 _wake_gesture：查询可能被推迟
                    #   几百毫秒才跑，那时计着数的已经不是这一次了。
                    pos = win32api.GetCursorPos()
                    # 抬起也要通知前端：横框上有些按钮是"按住时临时改变文档、松开恢复"
                    # （预览原文）。窗口是点击穿透的，真实 mouseup 到不了 DOM，
                    # 所以这条也必须由后端读物理按键补上，否则预览只能进去、出不来。
                    if self._ui_active:
                        try:
                            self._enqueue({"type": "writing-pointer-up",
                                           "x": int(pos[0]), "y": int(pos[1])})
                        except Exception:
                            pass
                    # 落在我们自己界面上（标签/菜单/横框）→ 这不算"用户重新划选"。
                    # 窗口始终点击穿透时，点界面的那一下**同时**落到了下面的编辑器里
                    # （光标被挪走、UIA 会读出空选区），照常查询就会把当前会话读没。
                    if not self._in_ui(pos) and not self._is_own_window(pos):
                        self._gesture += 1
                        self._wake_gesture = self._gesture
                        self._wake.set()
            except Exception:
                pass
            self._stop.wait(_POLL_SECONDS)

    def _in_ui(self, pos) -> bool:
        """这个屏幕坐标是否落在书写界面（标签/菜单/横框）上。外扩 6px 抗边缘抖动。"""
        try:
            x, y = pos
        except Exception:
            return False
        for r in self._ui_rects:
            pad = 6
            if (r["x"] - pad <= x <= r["x"] + r.get("width", 0) + pad
                    and r["y"] - pad <= y <= r["y"] + r.get("height", 0) + pad):
                return True
        return False

    def _foreground_is_self(self) -> bool:
        """前台窗口是不是我们自己的。

        用来判断"停查窗口"里这一次抬键值不值得查：前台已经回到目标程序，
        说明用户正在那边的编辑器里重新划选，这次广播是真的。
        """
        try:
            import win32gui
            from .tools.uia_screen import _is_self_process
            hwnd = win32gui.GetForegroundWindow()
            return bool(hwnd) and _is_self_process(hwnd)
        except Exception:
            return False

    def _is_own_window(self, pos) -> bool:
        """抬起的位置是否落在 Dony 自己的窗口上。

        这一条是必需的：用户点我们的小标签、菜单按钮时同样会产生"抬起"，若照常查询，
        得到的还是目标程序里那份旧选区，界面会在用户操作菜单的同时被重放一次。
        """
        try:
            import win32gui
            from .tools.uia_screen import _is_self_process
            hwnd = win32gui.WindowFromPoint(pos)
            return bool(hwnd) and _is_self_process(hwnd)
        except Exception:
            return False

    # ---------- 线程：UIA 查询 ----------
    def _query_loop(self) -> None:
        while not self._stop.is_set():
            if not self._wake.wait(0.2):
                continue
            self._wake.clear()
            if self._stop.is_set():
                break
            self._query_with_retry()

    def _query_with_retry(self) -> None:
        # 这一次查询是不是双击 Ctrl 触发的：是的话结果带 manual 标记，
        # 读不到选区时**什么都不发**（不能把界面凭空弹出来，也不能把已有会话收掉）
        manual = self._manual
        self._manual = False
        # 用户正压在我们的界面上操作（指针在标签/菜单/输入框上）时不能立刻查 ——
        # 那会把"我们自己持有焦点"误读成"选区消失"而收起界面。
        #
        # ⚠ 但**绝不能直接把这次抬键丢掉**。抬键是一次真实的用户动作，丢掉之后不会
        #   有第二次广播，界面就永远停在上一个会话 —— 用户描述的正是这个时序：
        #   "面板（改写结果）还没退出，我就重新划选了，然后怎么点都没反应"。
        #   那个会话还在、新选区没进来，标签自然不会出现，点原来的位置等于点空气。
        # 正确处理是**推迟**：等停查窗口过去（有上限）再查；期间只要前台回到目标程序，
        # 说明用户已经在别处重新划选了，那就不必再等，立刻查。
        if self._suspended():
            deadline = time.monotonic() + 6.0
            while self._suspended() and not self._stop.is_set():
                if not self._foreground_is_self():
                    break
                if time.monotonic() > deadline:
                    return
                if self._stop.wait(0.12):
                    return
        from . import config
        from .tools.uia_screen import _uia_run
        attempts = max(1, config.WRITING_QUERY_RETRIES + 1)
        for _ in range(attempts):
            if self._stop.is_set():
                return
            # 等目标程序把选区与 UIA 树刷新完（见模块开头）
            if self._stop.wait(config.WRITING_QUERY_DELAY_MS / 1000.0):
                return
            try:
                status, info = _uia_run(_read_selection_inner)
            except Exception as e:
                print(f"[writing] 读取选区失败: {type(e).__name__}: {e}", flush=True)
                status, info = _EMPTY, None
            if status == _OK and info is not None:
                # ⚠ 松手后**第一次**读到的位置常常还是旧的：目标程序（记事本/浏览器）
                #   还没把新选区画完，UIA 里读到的仍是上一段的位置。用户实测的现象正是
                #   "鼠标本来就在标签范围内（松手即自动显示）时，标签先出现在偏右下的
                #   旧位置、再跳到正确位置"；而"选完再把鼠标移过去"就不会 —— 那时树早稳了。
                #
                # 固定的"隔一会再读一次"不够可靠（不同程序刷新快慢差很多，实测 90ms
                # 仍可能读到旧位置），所以改成**连读到位置稳定为止**：两次读数一致才算数，
                # 最多补读 _SETTLE_MAX_TRIES 次。代价是几十到一百多毫秒，但标签只出现一次、
                # 直接落在最终位置。
                try:
                    for _ in range(_SETTLE_MAX_TRIES):
                        if self._stop.wait(_SETTLE_SECONDS):
                            return
                        try:
                            status2, info2 = _uia_run(_read_selection_inner)
                        except Exception:
                            status2, info2 = _EMPTY, None
                        if status2 != _OK or info2 is None:
                            break      # 第二次读不到（选区没了/焦点到我们这）：保留第一次的结果
                        if _same_anchor(info, info2):
                            info = info2
                            break
                        info = info2
                except Exception as e:
                    # 稳定化只是"让标签别跳"，它自己出任何问题都**不能**拖垮广播：
                    # 一次 AttributeError 就曾把这条线程整个打断，表现为"选了字什么都不出来"。
                    print(f"[writing] 位置稳定化失败（忽略，按首次读数广播）: {e}", flush=True)
                if manual:
                    info["manual"] = True
                self._publish(info)
                return
            # 焦点落在我们自己身上（用户正在点标签/菜单/输入框）：这一轮什么都别做。
            # 尤其**不能**当作"选区消失"去收起界面 —— 那正是"点一下输入框界面就退出"的原因。
            if status == _SELF:
                return
        # 重试用尽、焦点一直在外部程序却没有有效选区 ⇒ 判断为"选择被取消"。
        # 把当时的现场一并打出来：分不清"用户取消"和"我们自己的原因"时，
        # 这一行是唯一的判据（用户报的"点一下界面就没了"就是靠它定位的）。
        print(f"[writing] 选区读取失败，按取消处理｜{_LAST_DIAG}", flush=True)
        if manual:
            # 双击 Ctrl 时没有选中文字：什么都不显示
            print("[writing] 双击 Ctrl 未读到选区 → 不显示界面", flush=True)
            return
        self._publish(None)

    # ---------- 事件 ----------
    def _publish(self, info: Optional[Dict[str, Any]]) -> None:
        """广播一次选区状态。

        ⚠ 这里**不做"跨抬起的去重"**。曾经按 (text, rects, hwnd) 去重，是个实打实的坑：
        用户反复选同一段文字非常常见（测试时更是如此），第二次起会因为 key 相同而
        完全不广播 —— 表现就是"只有第一次能唤醒界面"。
        同一次抬起内部本来就不会重复广播（_query_with_retry 一旦读到有效选区就 return），
        所以不需要靠去重来防刷屏。
        """
        # "一直没选区"不值得每次抬键都广播一条空的；只有曾经有、现在没了才通知界面收起
        if info is None and not self._had_selection:
            return
        self._had_selection = info is not None
        self._seq += 1
        payload: Dict[str, Any] = {
            "type": "writing-selection", "seq": self._seq, "gesture": self._wake_gesture,
            "text": "", "rects": [], "anchor": None,
            "hwnd": 0, "ctrl": "", "multiLine": False,
        }
        if info:
            payload.update(info)
            # 只记行数与字数，**不记内容**（选中文字属于用户数据）
            # 锚点也打出来：下次若还出现"跳一下"，对比两条广播的锚点就能立刻判断是
            # "读到了旧位置"还是"前端又重开了一轮"。
            _p = _anchor_xy(info.get("anchor")) or (0, 0)
            print(f"[writing] 广播选区：{len(info['rects'])} 行 / {len(info['text'])} 字"
                  f"（{info.get('ctrl') or '未知控件'}） seq={self._seq}"
                  f" gesture={self._wake_gesture} 锚点=({_p[0]:.0f},{_p[1]:.0f})", flush=True)
        else:
            print("[writing] 广播：选区已取消 → 收起界面", flush=True)
        self._enqueue(payload)

    def broadcast_local(self, payload: Dict[str, Any]) -> None:
        """给外部（替换完成后需要通知界面刷新选区）留的出队入口。"""
        self._enqueue(payload)

    def _enqueue(self, payload: Dict[str, Any]) -> None:
        loop, queue = self._loop, self._queue
        if loop is None or queue is None:
            return
        try:
            loop.call_soon_threadsafe(queue.put_nowait, payload)
        except RuntimeError:
            pass   # 事件循环已关闭（正在退出）
