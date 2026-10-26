"""书写辅助端到端点击测试（会真实控制鼠标，运行期间请勿操作鼠标）。

它做的事，就是用户手动做的每一步，只是用脚本代替手：

    1. 拖选记事本里的一段文字            → 等后端广播选区、等标签出现
    2. 把指针移到标签中心并点击           → 等日志出现「标签被点击」
    3. 点菜单里的「校对」                → 等日志出现「选择动作 校对」
    4. 等模型返回、文字被写回            → 点横框右端的「保留」
    5. 立刻再拖选一次、再点标签           → 看这一次还点不点得动（用户报的故障）

每一步都有日志判定，失败时自动截图到 %TEMP%\\wt_e2e_fail.png，
并把最后 40 行日志打出来，便于定位断在哪一环。

用法（先在另一个窗口把应用跑起来，或让本脚本自己拉起）：

    .venv/Scripts/python.exe scripts/writing_e2e.py            # 只跑测试（应用需已在跑）
    .venv/Scripts/python.exe scripts/writing_e2e.py --launch    # 顺便拉起 npm run electron:dev
"""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import win32api  # noqa: E402
import win32con  # noqa: E402
import win32gui  # noqa: E402

# 控制台默认可能是 GBK，而应用日志里带 ➜ 等符号（vite 的输出）会让 print 直接抛异常
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 日志里只看书写辅助相关的那几类行，避免被 vite / 后端噪声淹没
LOG_KEEP = ('[writing]', '[wr]', '[hotkey]', '[vis]', '[tray]', '[agent-server]')
ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')

LOG = os.path.join(os.environ['TEMP'], 'wt_electron.log')
SHOT = os.path.join(os.environ['TEMP'], 'wt_e2e_fail.png')
SAMPLE = os.path.join(os.environ['TEMP'], 'wt_e2e_sample.txt')

SAMPLE_TEXT = (
    '书写辅助的端到端测试文本，用来验证划选、标签、菜单与横框这条链路。'
    '这段文字必须足够长，才能越过二十个字的触发门槛；'
)

VERBOSE = '--quiet' not in sys.argv

_hits = []
_printed = []
# 脚本开始时刻：打印日志时带上相对时间，便于判断"谁比谁晚到"
T0 = time.time()


def say(msg):
    print(msg, flush=True)


def hits_of(key):
    """所有包含 key 的日志文本（按时间顺序）"""
    return [m for (_t, m) in _hits if key in m]


# ---------- 日志 ----------
class LogTail:
    def __init__(self, path):
        self.path = path
        # ⚠ 从**文件末尾**开始读：日志是跨多次运行追加的，从头读会把历史事件
        #   当成"刚刚发生"，时序完全乱掉（排查竞态时最忌讳这个）。
        try:
            self.pos = os.path.getsize(path)
        except OSError:
            self.pos = 0
        self.pending = b''

    def lines(self):
        out = []
        if not os.path.exists(self.path):
            return out
        with open(self.path, 'rb') as f:
            f.seek(self.pos)
            data = f.read()
            self.pos = f.tell()
        buf = self.pending + data
        parts = re.split(rb'\r?\n', buf)
        self.pending = parts.pop()
        for raw in parts:
            text = ANSI_RE.sub('', raw.decode('utf-8', errors='replace')).rstrip()
            if text:
                out.append(text)
        return out

    def drain(self):
        for text in self.lines():
            _hits.append((time.time(), text))
            if not VERBOSE or not any(k in text for k in LOG_KEEP):
                continue
            # 状态快照每 2 秒一条、内容往往一模一样，重复的直接不打印
            if _printed and _printed[-1] == text:
                continue
            _printed.append(text)
            # 带相对时间：定位竞态（"谁比谁晚到"）时，时序就是唯一线索
            say(f'  {time.time() - T0:6.2f} | ' + text)


LOG_TAIL = LogTail(LOG)

# 日志里这些行是关键判定点
KEY_SELECTION = '广播选区'
KEY_RECTS = '接管区域'
KEY_TAG_CLICK = '标签被点击'
KEY_ACTION = '选择动作'
KEY_RESULT = '写作'  # 占位：真实判定用下面 strings
KEY_REWRITE_DONE = '完成'
KEY_REPLACED = '替换完成'
KEY_BAR_KEEP = '保留'

RECT_RE = re.compile(r'(\d+)x(\d+)@(-?\d+),(-?\d+)')
ANCHOR_RE = re.compile(r'锚点\((-?\d+),(-?\d+)\)')
KEY_ENTER = '进入书写辅助：锚点'
KEY_GOT_SELECTION = '收到选区'
KEY_EXIT = '退出书写辅助模式'


def last_anchor():
    """从最近一条「进入书写辅助：锚点(x,y)」日志里取锚点（选区第一个字的左上角，DIP）"""
    for t in reversed(hits_of(KEY_ENTER)):
        m = ANCHOR_RE.search(t)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def last_rects():
    """从最近一条「接管区域」日志里取出矩形列表 [(x, y, w, h), ...]"""
    lines = hits_of(KEY_RECTS)
    if not lines:
        return []
    tail = lines[-1].split('：', 1)[-1]
    out = []
    for m in RECT_RE.finditer(tail):
        out.append((int(m.group(3)), int(m.group(4)), int(m.group(1)), int(m.group(2))))
    return out


def wait_for(pred, seconds, what):
    """轮询日志直到 pred() 为真；返回 True/False"""
    end = time.time() + seconds
    while time.time() < end:
        LOG_TAIL.drain()
        if pred():
            return True
        time.sleep(0.05)
    LOG_TAIL.drain()
    say(f'  ✗ 超时：等不到「{what}」')
    return False


# ---------- 鼠标 ----------
def click(x, y, settle=0.25, approach=0.3):
    """先把指针移过去、等一下、再按下。

    ⚠ 这一小段等待不是"保险起见"：覆盖层是按 60ms 轮询判定"指针在不在书写元素上"的，
    移过去立刻按下去，这一下 mousedown 可能还落在"尚未接管鼠标"的窗口里，
    于是点击直接穿透 —— 真实用户快速点标签时踩到的就是它。
    """
    win32api.SetCursorPos((int(x), int(y)))
    time.sleep(approach)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(settle)


def focus_notepad(hwnd, x0, y0):
    """把前台交还给记事本。

    ⚠ 必需：本脚本从编辑器/终端里跑，编辑器会在命令输出时把自己的窗口抢到前台，
    于是拖选落在编辑器里、后端读到的是它的控件（日志里会看到"前台=(CodeBuddy CN.exe)"）。
    SetForegroundWindow 有时会被系统拦下，所以这里用"点一下正文"兜底。
    """
    for _ in range(3):
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.2)
    click(x0, y0, settle=0.15)
    time.sleep(0.3)
    return win32gui.GetForegroundWindow() == hwnd


def drag_select(x0, y0, x1, steps=25):
    win32api.SetCursorPos((int(x0), int(y0)))
    time.sleep(0.2)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.12)
    for i in range(1, steps + 1):
        win32api.SetCursorPos((int(x0 + (x1 - x0) * i / steps), int(y0)))
        time.sleep(0.012)
    time.sleep(0.1)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def shot(tag=''):
    try:
        from PIL import ImageGrab
        ImageGrab.grab().save(SHOT)
        say(f'  已截图 → {SHOT} {tag}')
    except Exception as e:
        say(f'  截图失败：{e}')


# ---------- 目标程序 ----------
def find_notepad():
    """按标题里的文件名找记事本窗口。

    ⚠ 不能按完整标题精确匹配：文字被改写（粘贴）之后标题会多出"*"之类的修改标记，
    精确匹配就找不到了。这里只要求标题包含文件名。
    """
    hit = []

    def cb(h, _):
        if win32gui.IsWindowVisible(h):
            title = win32gui.GetWindowText(h)
            if 'wt_e2e_sample' in title and 'Notepad' in title:
                hit.append(h)
        return True

    win32gui.EnumWindows(cb, None)
    return hit[0] if hit else 0


def ensure_notepad():
    if not os.path.exists(SAMPLE):
        with open(SAMPLE, 'w', encoding='utf-8') as f:
            f.write(SAMPLE_TEXT + '\n' + SAMPLE_TEXT + '\n')
    hwnd = find_notepad()
    if not hwnd:
        subprocess.Popen(['notepad.exe', SAMPLE])
        for _ in range(30):
            time.sleep(0.3)
            hwnd = find_notepad()
            if hwnd:
                break
    if not hwnd:
        raise SystemExit('记事本没起来')
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    # ⚠ Windows 会拒绝"非当前前台进程"改前台（SetForegroundWindow 直接抛异常），
    #   而本脚本是从编辑器/终端里跑的 —— 经常正好是这种情形。
    #   兜底：先在记事本窗口里点一下（用户手势能把窗口顶到前台），再设前台。
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        try:
            r = win32gui.GetWindowRect(hwnd)
            win32api.SetCursorPos((r[0] + 40, r[1] + 40))
            win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
            win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
            time.sleep(0.2)
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
    time.sleep(0.5)
    # 文本区矩形：从窗口里深度优先找 DocumentControl
    from backend.agent.tools.uia_screen import _uia_run
    import uiautomation as auto

    def find_doc(_auto):
        def walk(node, depth):
            if depth > 4:
                return None
            for c in node.GetChildren():
                if c.ControlTypeName == 'DocumentControl':
                    return c
                got = walk(c, depth + 1)
                if got is not None:
                    return got
            return None
        return walk(auto.ControlFromHandle(hwnd), 0)

    doc = _uia_run(find_doc)
    if doc is None:
        raise SystemExit('记事本里没找到 DocumentControl')
    box = doc.BoundingRectangle
    say(f'  记事本文本区 = ({box.left},{box.top},{box.right},{box.bottom})')
    return hwnd, box


# ---------- 主流程 ----------
def kill_ports_and_electron():
    """清掉本项目占端口的服务与 electron。

    必须连后端一起清：后端是 electron spawn 的**子进程**，杀掉 electron 不会连带杀掉它们，
    残留的旧后端会占着 8767，新起的 electron 就会"检测到端口已占用、跳过启动"，
    于是你测的是**旧代码**（这一坑真实发生过，排查时浪费了很久）。
    """
    try:
        import psutil
    except ImportError:
        return
    ports = {5173, 8766, 8767, 8768, 8769}
    for c in psutil.net_connections(kind='tcp'):
        if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port in ports:
            try:
                psutil.Process(c.pid).kill()
            except Exception:
                pass
    for p in psutil.process_iter(['name']):
        if (p.info.get('name') or '').lower() == 'electron.exe':
            try:
                p.kill()
            except Exception:
                pass
    time.sleep(2)


class StepFailed(Exception):
    """一轮流程里某一步失败（失败信息即为原因）"""


def ensure_app():
    """按需清理进程并启动应用"""
    if '--launch' in sys.argv:
        say('清理旧进程并启动应用（npm run electron:dev）…')
        kill_ports_and_electron()
        log = open(LOG, 'wb')   # 截断：本次运行只读自己的日志
        # ⚠ 截断之后必须把已记录的位置归零：LogTail 是在模块加载时按"旧文件长度"
        #   定位的，文件被截短后那个位置在末尾之外，会一直读不到任何东西。
        LOG_TAIL.pos = 0
        LOG_TAIL.pending = b''
        subprocess.Popen('npm run electron:dev', shell=True, stdout=log, stderr=log,
                         cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        if not wait_for(lambda: '选区监听已启动' in '\n'.join(hits_of('选区监听')),
                        90, '后端选区监听启动'):
            shot()
            raise SystemExit('应用没能起来（看 ' + LOG + '）')
        say('  应用已就绪')


def run_cycle(cycle, hwnd, x0, y0, x1):
    """跑一轮完整流程：划选 → 标签 → 菜单 → 改写 → 保留 → 再划选 → 再点标签"""

    def goto_tag():
        """把指针移到锚点旁（标签才会出现并上报），返回标签矩形。

        ⚠ 这一步是**必需的**，不是脚本的偷懒：标签"只有指针靠近才显示"，
        而它是否上报给主进程也受同一个条件门控。真实用户拖选完，指针停在选区
        **末尾**，离锚点几百像素 —— 那正好是最容易点到穿透的位置。
        """
        # ⚠ 锚点那行比"收到选区"晚几十毫秒（要等一次 IPC 取屏幕信息），必须等
        if not wait_for(lambda: last_anchor() is not None, 5, '锚点信息'):
            return None
        anchor = last_anchor()
        win32api.SetCursorPos((anchor[0] - 22, anchor[1] + 24))
        # ⚠ 必须等到"标签尺寸"的那一块：不能拿"最近一条接管区域"顶替 ——
        #   上一轮的横框（420x44）会留在日志里，按它的中心点下去等于点在正文上，
        #   那一下点击会把目标程序里的选区点没，后面的故障就全是自己造出来的
        #   （这一坑真实发生过：一次"复现"其实是脚本点错了地方）。
        tag_rects = lambda: [r for r in last_rects() if r[2] < 80 and r[3] < 80]
        if not wait_for(lambda: bool(tag_rects()), 5, '标签矩形上报（宽度 < 80 的那块）'):
            return None
        return min(tag_rects(), key=lambda r: r[2])

    # ===== 第 1 步：划选 → 标签 =====
    # 拖选允许重试：应用刚起来时渲染层的 WS 可能还没连上，那一次广播前端收不到
    # （广播本身在后端日志里看得到，容易误判成"拖选失败"）。
    say('\n[1] 拖选文字，等标签')
    got = False
    for attempt in range(3):
        before = len(hits_of(KEY_GOT_SELECTION))
        focus_notepad(hwnd, x0, y0)
        drag_select(x0, y0, x1)
        if wait_for(lambda: len(hits_of(KEY_GOT_SELECTION)) > before, 5, '前端收到选区'):
            got = True
            break
        say(f'  第 {attempt + 1} 次拖选前端没收到（界面可能还没连上），重试…')
        time.sleep(2)
    if not got:
        shot()
        raise SystemExit('选区没广播到前端（拖选或 UIA 读取失败）')
    tag = goto_tag()
    if tag is None:
        shot()
        raise SystemExit('标签矩形没上报到主进程')
    say(f'  标签矩形 = {tag}')

    # ===== 第 2 步：点标签 =====
    say('\n[2] 点标签')
    click(tag[0] + tag[2] / 2, tag[1] + tag[3] / 2)
    tag_clicked = wait_for(lambda: hits_of(KEY_TAG_CLICK), 4, '标签被点击')
    say(f'  → {"成功" if tag_clicked else "失败：点击没有到达标签"}')
    if not tag_clicked:
        shot()
        raise SystemExit('第一步就点不动，先修这个')

    # ===== 第 3 步：点菜单里的「校对」 =====
    say('\n[3] 点菜单里的「校对」')
    # 菜单：宽 ~296、高 ~469（不要用"最宽的那块"——横框 420 更宽，会选错）
    menu_rects = lambda: [r for r in last_rects() if 200 < r[2] < 340 and r[3] > 200]
    if not wait_for(lambda: bool(menu_rects()), 4, '菜单矩形'):
        shot()
        raise SystemExit('菜单没出现')
    menu = max(menu_rects(), key=lambda r: r[3])
    # 菜单布局：padding 10 / 输入框 44+10 / 大按钮行 64 高，两列等分
    mx, my = menu[0] + 77, menu[1] + 96
    say(f'  菜单矩形 = {menu}，点 ({mx},{my})')
    click(mx, my)
    if not wait_for(lambda: hits_of(KEY_ACTION), 5, '收到动作（校对）'):
        shot()
        raise SystemExit('菜单按钮没点中')
    say('  动作已触发')

    # ===== 第 4 步：等改写结果 + 横框，点「保留」 =====
    say('\n[4] 等模型返回，点横框的「保留」')
    if not wait_for(lambda: hits_of(KEY_REPLACED), 60, '文字被写回（替换完成）'):
        shot()
        raise SystemExit('替换没完成（看日志）')
    if not wait_for(lambda: any(400 < r[2] < 460 and r[3] < 60 for r in last_rects()),
                    10, '横框矩形'):
        shot()
        raise SystemExit('横框没出现')
    bar = [r for r in last_rects() if 400 < r[2] < 460 and r[3] < 60][-1]
    bx, by = bar[0] + bar[2] - 35, bar[1] + bar[3] / 2
    say(f'  横框矩形 = {bar}，点「保留」({bx},{by})')
    click(bx, by, settle=0.05)

    # ===== 第 5 步：立刻再划选、再点标签（用户报故障的那一步） =====
    say('\n[5] 立刻重新拖选，再点标签（故障复现点）')
    time.sleep(0.15)
    before = len(hits_of(KEY_TAG_CLICK))
    focus_notepad(hwnd, x0, y0)
    drag_select(x0, y0, x1)
    if not wait_for(lambda: len(hits_of(KEY_GOT_SELECTION)) >= 2, 6, '第二次选区广播'):
        shot()
        raise SystemExit('第二次划选没广播（界面可能没收干净）')
    tag2 = goto_tag()
    if tag2 is None:
        shot()
        raise SystemExit('第二次标签矩形没上报')
    say(f'  第二次标签矩形 = {tag2}')
    click(tag2[0] + tag2[2] / 2, tag2[1] + tag2[3] / 2)
    ok = wait_for(lambda: len(hits_of(KEY_TAG_CLICK)) > before, 4, '第二次标签被点击')
    if not ok:
        raise StepFailed('点完横框后，标签又点不动了（复现！）')
    say('  → 成功')

    # ===== 收尾：把这一轮的界面收掉，给下一轮一个干净起点 =====
    # ⚠ 必需：上面点标签会把菜单打开、会话仍在进行中，此时下一轮的划选会被
    #   "不打断当前流程"正确地忽略掉（那是设计行为，不是 bug）。
    #   点一下正文让选区消失，界面就会自己收起（有一条 700ms 的去抖）。
    say('\n[6] 收尾：把选区收成光标（让界面自己收起），为下一轮准备干净状态')
    exited = len(hits_of(KEY_EXIT))

    # 用 UIA 直接把选区折叠成光标：比"点某处正文"确定得多 ——
    # 点哪里都取决于界面此刻的位置与层级，而折叠选区是直接改文档状态。
    def collapse(auto):
        def walk(node, depth):
            if depth > 4:
                return None
            for c in node.GetChildren():
                if c.ControlTypeName == 'DocumentControl':
                    return c
                got = walk(c, depth + 1)
                if got is not None:
                    return got
            return None
        doc = walk(auto.ControlFromHandle(hwnd), 0)
        tp = doc.GetTextPattern()
        rng = tp.DocumentRange
        caret = rng.Clone()
        caret.MoveEndpointByRange(auto.TextPatternRangeEndpoint.Start, rng,
                                  auto.TextPatternRangeEndpoint.Start, 0)
        caret.MoveEndpointByRange(auto.TextPatternRangeEndpoint.End, rng,
                                  auto.TextPatternRangeEndpoint.Start, 0)
        caret.Select(0)

    try:
        _uia_run(collapse)
    except Exception as e:
        say(f'  折叠选区失败（不影响流程）：{e}')
    # 监听器只在"左键抬起"后才查询，所以还要点一下（桌面，不落在任何程序上）
    click(60, 1380, settle=0.3)
    wait_for(lambda: len(hits_of(KEY_EXIT)) > exited, 8, '界面收起（下一轮的前置条件）')


def main():
    ensure_app()
    hwnd, box = ensure_notepad()
    x0, y0 = box.left + 60, box.top + 40
    x1 = box.left + 700

    # 默认跑 3 轮：用户报的是"多次之后失效"，单轮通过不足以说明问题
    cycles = 3
    for a in sys.argv:
        if a.startswith('--cycles='):
            cycles = int(a.split('=', 1)[1])

    passed = 0
    for i in range(1, cycles + 1):
        say(f'\n===== 第 {i}/{cycles} 轮 =====')
        try:
            run_cycle(i, hwnd, x0, y0, x1)
            passed += 1
            say(f'  ✓ 第 {i} 轮通过')
        except StepFailed as e:
            shot(f'（第 {i} 轮故障现场）')
            say(f'  ✗ 第 {i} 轮失败：{e}')
            say('\n最近日志：')
            for line in hits_of('')[-40:]:
                say('  | ' + line)
            break
        except SystemExit as e:   # 步骤里的 raise SystemExit(原因)
            shot(f'（第 {i} 轮故障现场）')
            say(f'  ✗ 第 {i} 轮失败：{e}')
            break
    say(f'\n结果：{passed}/{cycles} 轮通过')
    return 0 if passed == cycles else 1


if __name__ == '__main__':
    try:
        code = main()
    finally:
        say('\n完成')
    sys.exit(code)
