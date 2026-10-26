"""书写辅助：把选中文字交给模型改写，并把结果写回原处。

两件事：
  1. `rewrite()` —— 按动作组装指令，强制模型以**工具调用**的形式交回改写结果。
     为什么要强制工具调用、而不是直接读回答：改写结果会被原样写回用户的文档，
     读 content 会把"好的，以下是改写后的文字："这类前言一起写进去。工具调用的
     参数是结构化的，也没有前后缀。
  2. `replace()` —— 把结果写回。焦点先还给目标窗口，再用 UIA 重新定位并选中原范围，
     最后走剪贴板 + Ctrl+V 粘贴（不是逐字模拟：中文输入法状态、键盘布局、时序都会
     影响逐字输入，而粘贴对目标程序而言与用户手动粘贴完全一致，撤销栈也保留）。
"""
import asyncio
import json
import time
from typing import Any, Dict, List, Tuple

import httpx

# ---------- 动作表 ----------
# label 会显示在横框中部（"当前操作名"），也是菜单按钮上的文字，必须与菜单一致。
ACTIONS: Dict[str, Dict[str, str]] = {
    "proofread": {
        "label": "校对",
        "instruction": "校订下面的文字：只修正错别字、标点与明显的语病，"
                       "不得改变原意、语气、结构与信息量，不要润色、不要增减内容。",
    },
    "rewrite": {
        "label": "改写",
        "instruction": "重写下面的文字，使它更通顺、整洁、逻辑条理更清楚；"
                       "保持原意与信息量不变，不添加原文没有的内容。",
    },
    "friendly": {
        "label": "友好",
        "instruction": "把下面的文字改写为更友好、亲切的语气，保持原意与信息量不变。",
    },
    "formal": {
        "label": "正式",
        "instruction": "把下面的文字改写为更正式、专业的书面语气，保持原意与信息量不变。",
    },
    "concise": {
        "label": "简洁",
        "instruction": "把下面的文字改写得更简洁：删去冗词与重复表达，保留全部关键信息。",
    },
    "summary": {
        "label": "摘要",
        "instruction": "把下面的文字概括为一段摘要，保留核心信息，篇幅明显短于原文。",
    },
    "keypoints": {
        "label": "要点",
        "instruction": "把下面的文字提炼为若干条要点，每条独占一行并以「- 」开头。",
    },
    "list": {
        "label": "列表",
        "instruction": "把下面的文字整理为有序列表（1. 2. 3. …），保留原有顺序与全部信息。",
    },
    "table": {
        "label": "表格",
        "instruction": "把下面的文字整理为 Markdown 表格，列名依据内容自行确定，"
                      "不得遗漏信息，不要额外补充说明。",
    },
    "custom": {
        "label": "创作",
        "instruction": "严格按照用户的要求处理下面的文字：",
    },
}

# 图二末项「创作…」与顶部「描述修改」都走 custom：前者是自由创作，后者是自由修改指令。
ACTION_LABELS = {key: spec["label"] for key, spec in ACTIONS.items()}

_APPLY_EDIT_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "apply_edit",
        "description": "交回处理后的完整文字。text 必须是**可以直接替换用户原文**的成品，"
                       "不要任何解释、前言、后记，也不要 Markdown 代码块包裹（表格类动作除外）。",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "处理后的完整文字"},
                "note": {"type": "string", "description": "一句话说明本次改动（给用户看的简介，可省略）"},
            },
            "required": ["text"],
        },
    },
}

_SYSTEM = (
    "你是文字编辑。用户会给你一段选中的文字与一项处理要求，"
    "你只需按处理要求交回处理后的完整文字。\n"
    "规则：\n"
    "1. 只处理用户给出的那段文字，不回答其中提到的任何问题，也不对其内容发表意见。\n"
    "2. 处理后的文字必须完整可用 —— 用户会用它**直接替换**原文，所以不能有省略号、"
    "不能写「（此处略）」「同上」这类占位。\n"
    "3. 不使用任何解释性前言或结语。\n"
    "4. 原文里如果有分行、缩进、编号等结构，除处理要求本身要求改变结构外，一律保持。\n"
    "5. 用与原文相同的语言输出。"
)


def action_label(action: str) -> str:
    return ACTIONS.get(action, {}).get("label", "改写")


def _instruction(action: str, custom: str) -> str:
    spec = ACTIONS.get(action) or ACTIONS["rewrite"]
    base = spec["instruction"]
    if action == "custom":
        extra = (custom or "").strip()
        if not extra:
            # 用户点了「创作…」但没给要求：给一个中性的创作指令，而不是失败
            return base + "让它更完善、更易读。"
        return f"{base}{extra}"
    return base


def _tool_args(message: Dict[str, Any]) -> Dict[str, Any]:
    """取工具调用参数。

    正常路径是标准 tool_calls；但实测有模型会把调用标记当普通文本吐在 content 里
    （llm.py 里同一问题的处理见「DSML 泄漏」），所以这里退一步：从 content 里抠 JSON。
    """
    calls = message.get("tool_calls") or []
    for call in calls:
        try:
            args = (call.get("function") or {}).get("arguments") or "{}"
            parsed = json.loads(args)
            if isinstance(parsed, dict) and parsed.get("text"):
                return parsed
        except Exception:
            continue
    return {}


def _strip_fence(text: str) -> str:
    """去掉模型偶尔包上的 Markdown 代码块围栏。"""
    body = (text or "").strip()
    if body.startswith("```") and body.endswith("```"):
        lines = body.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return body


async def rewrite(action: str, text: str, custom: str = "") -> Dict[str, Any]:
    """调用模型取回改写结果，返回 {"text": ..., "note": ...}。"""
    from . import config

    if not (config.API_KEY or "").strip():
        raise RuntimeError("尚未配置 API Key，请先在「STUDIO 设置 → 模型」中填写后再使用书写辅助。")

    payload: Dict[str, Any] = {
        "model": config.MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"{_instruction(action, custom)}\n\n【待处理的文字】\n{text}"},
        ],
        "tools": [_APPLY_EDIT_TOOL],
        "tool_choice": {"type": "function", "function": {"name": "apply_edit"}},
        "temperature": config.WRITING_TEMPERATURE,
        **config.thinking_payload(),
    }
    headers = {"Content-Type": "application/json"}
    if config.API_KEY:
        headers["Authorization"] = f"Bearer {config.API_KEY}"
    async with httpx.AsyncClient(
        base_url=config.API_BASE,
        headers=headers,
        timeout=httpx.Timeout(config.WRITING_TIMEOUT, connect=10.0),
    ) as client:
        resp = await client.post("/chat/completions", json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"模型API错误 {resp.status_code}: {resp.text[:300]}")
        data = resp.json()

    message = ((data.get("choices") or [{}])[0].get("message") or {})
    args = _tool_args(message)
    result = _strip_fence(str(args.get("text") or ""))
    if not result:
        # 模型没走工具调用：把 content 当结果用（宁可拿到成品，也好过整轮失败）
        result = _strip_fence(str(message.get("content") or ""))
    if not result:
        raise RuntimeError("模型没有返回可用的文字")
    return {"text": result, "note": str(args.get("note") or "")}


# ---------- 写回 ----------
def _normalize(text: str) -> str:
    """比较用的归一化：忽略空白差异（换行/制表/多空格在 UIA 与屏幕上可能不一致）。"""
    return " ".join((text or "").split())


_EM_SETSEL = 0x00B1
_EM_GETSEL = 0x00B0
_WM_PASTE = 0x0302
_WM_GETTEXTLENGTH = 0x000E
# 这些类名的编辑控件支持 EM_SETSEL（纯整数参数，可跨进程）。
# 记事本（Win11 是 RichEditD2DPT）、老式 Edit、部分 IM 的输入框都在其中。
_EDIT_CLASSES = ("richeditd2dpt", "richedit20w", "richedit50w", "richedit", "edit")


def _find_edit_child(hwnd: int, max_depth: int = 3) -> int:
    """在窗口里找编辑控件（广度优先，限深度，避免遍历整棵大树）。"""
    import win32gui
    level = [hwnd]
    for _ in range(max_depth):
        nxt = []
        for parent in level:
            child = win32gui.FindWindowEx(parent, None, None, None)
            while child:
                try:
                    cls = (win32gui.GetClassName(child) or "").lower()
                except Exception:
                    cls = ""
                if cls in _EDIT_CLASSES:
                    return child
                nxt.append(child)
                child = win32gui.FindWindowEx(parent, child, None, None)
        level = nxt
        if not level:
            break
    return 0


def _force_foreground(hwnd: int) -> bool:
    """把目标窗口重新顶到前台（连同键盘焦点）。

    `SetForegroundWindow` 从**非前台进程**调用常被系统静默拒绝（返回 0），
    这也是"写回时目标窗口失焦、随后什么都失败"的根源。标准解法是先把本线程的
    输入队列挂到目标窗口所在线程上（AttachThreadInput），再调 SetForegroundWindow，
    最后摘下。用户「创作」输入框打完字、或我们拿过焦点之后，都要靠它把焦点还回去。
    """
    import ctypes
    import win32api
    import win32gui
    import win32process
    try:
        if int(win32gui.GetForegroundWindow() or 0) == int(hwnd):
            return True
        user32 = ctypes.windll.user32
        fg = int(win32gui.GetForegroundWindow() or 0)
        cur_tid = win32api.GetCurrentThreadId()
        tids = set()
        for h in (fg, hwnd):
            if not h:
                continue
            try:
                tid, _pid = win32process.GetWindowThreadProcessId(h)
            except Exception:
                tid = 0
            if tid and tid != cur_tid:
                tids.add(tid)
        attached = []
        for tid in tids:
            try:
                user32.AttachThreadInput(cur_tid, tid, True)
                attached.append(tid)
            except Exception:
                pass
        try:
            # ⚠ 这里必须用 ctypes 调 SetForegroundWindow：pywin32 的包装在失败时
            #   **抛异常**（"No error message is available"），一抛就把后面的
            #   SetFocus 全跳过、焦点也就没还回去 —— 日志里那条"恢复焦点异常"
            #   就是这么来的。ctypes 只返回 0/1，不会中断流程。
            win32gui.BringWindowToTop(int(hwnd))
            user32.SetForegroundWindow(int(hwnd))
            user32.SetFocus(int(hwnd))
        finally:
            for tid in attached:
                try:
                    user32.AttachThreadInput(cur_tid, tid, False)
                except Exception:
                    pass
        time.sleep(0.12)
        ok = int(win32gui.GetForegroundWindow() or 0) == int(hwnd)
        print(f"[writing] 恢复目标窗口焦点：{'成功' if ok else '未成功（系统拒绝）'}", flush=True)
        return ok
    except Exception as e:
        print(f"[writing] 恢复焦点异常: {type(e).__name__}: {e}", flush=True)
        return False


def _edit_target(hwnd: int) -> int:
    """定位可 EM_SETSEL 的编辑控件。

    ⚠ 传入的 hwnd 可能是**顶层窗口**（探针/测试脚本），也可能是**编辑控件本身**
      （应用里 `_read_selection_inner` 记的是焦点控件的 NativeWindowHandle ——
      记事本里那就是 RichEditD2DPT 自己）。只按"找子控件"走的话，后者直接空手而归，
      于是原生路径永远不触发、全部落到"按文字查找"上 —— 用户反复遇到的
      "找不到那段文字了"正是这么来的。这里先看自己，再找子控件。
    """
    import win32gui
    try:
        cls = (win32gui.GetClassName(hwnd) or "").lower()
        if cls in _EDIT_CLASSES:
            return hwnd
    except Exception:
        pass
    return _find_edit_child(hwnd)


def _range_text(hwnd: int, pos) -> str:
    """读出 pos 指向的那段文字（用 UIA 的当前选区，不碰文档）。

    用于粘贴前的**落点核对**：读出来不等于原文就绝不粘贴。
    """
    try:
        import uiautomation as auto
        from .selection import _find_text_pattern
        _node, pattern = _find_text_pattern(auto.GetFocusedControl())
        if pattern is None:
            return ""
        sels = pattern.GetSelection() or []
        return (sels[0].GetText(-1) or "") if sels else ""
    except Exception:
        return ""


def _replace_via_edit(hwnd: int, pos, new_text: str, expected: str = ""):
    """用原生消息按"字符偏移"选中并粘贴。成功返回**新的位置记录**（供下一次写回用），失败返回 None。

    为什么需要这条路：Win11 记事本这类控件的 TextPattern 只实现了读，没实现
    `MoveEndpointByUnit`（实测返回 0），所以"按偏移重建区间"在 UIA 侧走不通。
    但它们的编辑区是 RichEdit，原生 `EM_SETSEL` 直接收整数偏移 —— 位置方案照样成立。
    """
    import win32clipboard
    import win32gui
    try:
        start = int(pos.get("start") or 0)
        length = int(pos.get("length") or 0)
    except Exception:
        return None
    if start < 0 or length <= 0:
        return False
    child = _edit_target(hwnd)
    if not child:
        print("[writing] 没找到可 EM_SETSEL 的编辑控件", flush=True)
        return False
    # ⚠ 先把焦点交还目标窗口，再发消息。
    #   RichEdit 在"控件本身没有焦点"时会**静默忽略 WM_PASTE** —— 不报错、也不改内容，
    #   正是"记事本里改了没反应、也没有错误"。EM_SETSEL 不受焦点影响，粘贴必须有焦点。
    _force_foreground(hwnd)
    # 偏移有效性：文档总长（字符数）必须盖得住 start+length。
    # 这一步挡住"过期偏移"（上次写回改了文档长度后，旧 pos 指到界外/错处）。
    import win32api
    total = win32gui.SendMessage(child, _WM_GETTEXTLENGTH, 0, 0)
    # ⚠ 换行换算：UIA 的 GetText 把换行算 2 个字符（\r\n），RichEdit 内部只算 1 个。
    #   多行选区时两套偏移会越差越多（差 = 前面有几个换行），EM_SETSEL 于是落到错处。
    #   直接读控件自己的文本，数一下前缀里的 \r\n 个数再减掉 —— 单行时这个数就是 0，
    #   自动退化为"不换算"。
    try:
        # origin=edit 的偏移是**控件口径**（捕获时用 EM_GETSEL 读的），与 EM_SETSEL
        # 完全一致 —— 再换算一次反而会错开。只有 UIA 口径才需要换算。
        if total and pos.get("origin") != "edit":
            n = int(total)
            buf = win32gui.PyMakeBuffer((n + 1) * 2)
            win32gui.SendMessage(child, 0x000D, n + 1, buf)   # WM_GETTEXT
            text = bytes(buf)[: n * 2].decode('utf-16-le', 'ignore')
            breaks = text[:start].count('\r\n')
            if breaks:
                start -= breaks
                length -= text[start:start + length].count('\r\n')
                print(f"[writing] 换行换算：偏移前移 {breaks}（多行文本，UIA 与 RichEdit 计数不同）",
                      flush=True)
    except Exception as e:
        print(f"[writing] 换行换算失败（按原偏移继续）: {type(e).__name__}: {e}", flush=True)
    if total and start + length > total:
        print(f"[writing] 偏移越界（start+len={start + length} > 文档长 {total}）→ 偏移过期", flush=True)
        return False
    try:
        if win32gui.GetForegroundWindow() != hwnd:
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.12)
        # ⚠ 一律用 SendMessageTimeout：SendMessage 是**同步阻塞**的，目标窗口一忙
        #   （或弹出模态框）就会永久卡住 —— 表现就是"结果回来了，但既不报错也不写"。
        #   超时就当失败，交给上层兜底，绝不让后端线程被钉死。
        def _send(msg: int, w: int, l: int, timeout_ms: int = 400):
            try:
                win32gui.SendMessageTimeout(child, msg, w, l, 0x0002, timeout_ms)
                return True
            except Exception as e:
                print(f"[writing] SendMessageTimeout(0x{msg:04X}) 失败/超时: {type(e).__name__}", flush=True)
                return False

        if not _send(_EM_SETSEL, start, start + length):
            return None
        time.sleep(0.05)
        # **落点核对**：刚选中的这段文字必须就是原文。OS 会把越界偏移夹到文末，
        # 于是粘贴就变成"在末尾多贴一段、原文没变"（用户实测）。
        # 读不到（有些控件不给选区）就放行，但读到且不符一律不粘。
        if expected:
            got = _range_text(hwnd, pos)
            if got and _normalize(got) != _normalize(expected):
                print(f"[writing] 落点不符（期望 {len(expected)} 字，实际 {len(got)} 字）→ 不粘贴",
                      flush=True)
                return None
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, new_text)
        finally:
            win32clipboard.CloseClipboard()
        if not _send(_WM_PASTE, 0, 0, 600):
            print("[writing] 粘贴消息超时（目标窗口无响应）", flush=True)
            return None
        time.sleep(0.15)
        # 粘贴后立刻核对：内容没变就说明这次粘贴被忽略（焦点/剪贴板问题），
        # 明确失败并让上层走 UIA 兜底 —— 不能再"看起来成功、其实没改"。
        try:
            n2 = win32gui.SendMessage(child, _WM_GETTEXTLENGTH, 0, 0)
            if n2:
                buf2 = win32gui.PyMakeBuffer((n2 + 1) * 2)
                win32gui.SendMessage(child, 0x000D, n2 + 1, buf2)
                now = bytes(buf2)[: n2 * 2].decode('utf-16-le', 'ignore')
                probe = (new_text or "")[:12]
                if probe and probe not in now:
                    print("[writing] 粘贴未生效（控件可能未获得焦点）→ 改用 UIA 兜底", flush=True)
                    return None
        except Exception:
            pass
        # 新偏移**不能**按 len(new_text) 算：多行文本里 RichEdit 的换行是一个字符、
        # UIA 的 GetText 是两个（\r\n），按字符数推会整段偏移。直接问控件：
        # EM_GETSEL 返回粘贴后光标所在位置（低字=起点，高字=终点），那就是新末尾。
        packed = win32gui.SendMessage(child, _EM_GETSEL, 0, 0) or 0
        caret_end = max(packed & 0xFFFF, (packed >> 16) & 0xFFFF)
        length_new = max(1, caret_end - start)
        # 把刚写入的文字**重新选中**：下一次「复原」即使走"当前选区"这条兜底路，
        # 选中的也正好是修改后的文本（用户明确要求"重新选中的应是修改后的文本"）。
        try:
            win32gui.SendMessage(child, _EM_SETSEL, start, caret_end)
        except Exception:
            pass
        # origin=edit：这些偏移是**控件口径**（EM_GETSEL 读的），下一次写回直接用，
        # 不再做换行换算 —— 这是"记事本偏移总飘"的根因所在。
        return {"start": start, "length": length_new, "origin": "edit"}
    except Exception as e:
        print(f"[writing] 原生按偏移写回失败（改用 UIA 兜底）: {type(e).__name__}: {e}", flush=True)
        return None


def _span_by_offset(pattern, pos):
    """按「字符偏移 + 长度」重建区间 —— 不看当前选区，也不看内容。

    CompareEndpoints 只给 -1/0/1，拿不到偏移量，所以用 MoveEndpointByUnit 从文档头
    按字符数移动端点：先把 End 移到起点偏移（此时区间 = 文档头..起点），再把它折叠成
    一个光标，最后向后扩出长度。
    """
    import uiautomation as auto
    try:
        start = int(pos.get("start") or 0)
        length = int(pos.get("length") or 0)
        if start < 0 or length <= 0:
            print(f"[writing] 位置记录无效（start={start} length={length}）", flush=True)
            return None
        span = pattern.DocumentRange.Clone()

        def _moved(ret, want: int) -> int:
            """MoveEndpointByUnit 的返回值不统一：有的控件/包装返回 None，有的返回移动量。
            返回 None 时我们没法判断是否走到底，只能信任（后面 Select + 粘贴前会再核对）。"""
            return want if ret is None else int(ret)

        moved = _moved(span.MoveEndpointByUnit(
            auto.TextPatternRangeEndpoint.End, auto.TextUnit.Character, start), start)
        if moved < start:
            # 这个控件不支持按字符移动端点（Win11 记事本就是：返回 0）
            print(f"[writing] 该控件不支持按字符移动端点（moved={moved} want={start}）", flush=True)
            return None
        # ⚠ 这里必须 4 个参数（uiautomation 的包装最后一个 count 不能省）
        span.MoveEndpointByRange(auto.TextPatternRangeEndpoint.Start, span,
                                 auto.TextPatternRangeEndpoint.End, 0)
        moved2 = _moved(span.MoveEndpointByUnit(
            auto.TextPatternRangeEndpoint.End, auto.TextUnit.Character, length), length)
        if moved2 < length:
            # 常见于 Word：第一段能移、第二段只移了一部分。以前这里静默返回 None，
            # 于是悄悄落到"当前选区"那条路，把内容粘到不确定的位置（核对=否）。
            print(f"[writing] 按位置扩长度失败（moved={moved2} want={length}）", flush=True)
            return None
        # 落点核对：重建出来的区间必须**确实**是目标文字，否则宁可不用它。
        # 没有这一步，偏移漂移时会写到别处，而且事后「复原」也找不到原文。
        try:
            got = span.GetText(-1) or ""
        except Exception:
            got = ""
        if _normalize(got) != _normalize(expected):
            print(f"[writing] 位置区间内容不符（期望 {len(expected)} 字，实际 {len(got)} 字）→ 改用兜底",
                  flush=True)
            return None
        return span
    except Exception as e:
        print(f"[writing] 按位置重建区间失败（改用兜底路径）: {type(e).__name__}: {e}", flush=True)
        return None


def _find_span(pattern, expected: str, pos=None):
    """拿到要替换的目标范围。

    优先级：**位置记录**（字符偏移，用户中途怎么点都不影响）→ 当前选区 → 按原文查找。
    后两条是兜底：老版本没有位置记录，或者控件不支持稳定的字符偏移。
    """
    if pos:
        span = _span_by_offset(pattern, pos)
        if span is not None:
            return span, "range"
    try:
        ranges = pattern.GetSelection() or []
    except Exception:
        ranges = []
    if ranges:
        try:
            if _normalize(ranges[0].GetText()) == _normalize(expected):
                return ranges[0], "selection"
        except Exception:
            pass
    try:
        found = pattern.DocumentRange.FindText(expected, False, False)
    except Exception:
        found = None
    if found is not None:
        return found, "search"
    return None, ""


def replace(hwnd: int, expected: str, new_text: str, pos=None) -> Dict[str, Any]:
    """把目标程序里那段文字替换为 new_text（在工作线程里跑）。

    pos = {"start", "length"}：捕获选区时记下的字符偏移。给了它就**只按位置**定位，
    与用户此刻的选区/焦点无关（这正是"中途乱点也不会失败"的关键）。
    """
    import win32clipboard
    import win32gui

    from .selection import _find_text_pattern
    from .tools.shell_input import _send_combo
    from .tools.uia_screen import _is_self_process, _uia_run

    if not hwnd or _is_self_process(hwnd):
        raise RuntimeError("目标窗口无效")
    if not new_text.strip():
        raise RuntimeError("改写结果为空，未做替换")

    def _inner(auto) -> Dict[str, Any]:
        # 0) 原生路径优先：RichEdit/EDIT 支持 EM_SETSEL，按字符偏移直接选中再粘贴。
        #    这条路不依赖 UIA 的 MoveEndpointByUnit，也不看当前选区 —— 记事本这类
        #    "TextPattern 只读"的控件靠它才能做到按位置写回。
        #    成功时带回 new_pos：下一次写回（复原/预览）必须用写后的新偏移。
        if pos:
            new_pos = _replace_via_edit(hwnd, pos, new_text, expected)
            if new_pos:
                verified = False
                try:
                    node, pattern = _find_text_pattern(auto.GetFocusedControl())
                    probe = " ".join(str(new_text).split())[:30]
                    if pattern is not None and probe:
                        verified = bool(pattern.DocumentRange.FindText(probe, False, False))
                except Exception:
                    verified = False
                return {"how": "edit", "verified": verified, "new_pos": new_pos}

        # 1) 焦点还给目标窗口（用户在「描述修改」里打过字时焦点可能在我们这边）。
        #    ⚠ 失败不要中止：从非前台进程调 SetForegroundWindow 经常被系统拒绝，
        #      但这不代表写不了 —— 按位置/按控件取 TextPattern、以及 EM_SETSEL 都
        #      不依赖前台。以前这里直接 raise，于是明明能写也报"找不到文字"。
        # 用 AttachThreadInput 的强化版：用户在输入框里打过字后焦点在我们这边，
        # 直接 SetForegroundWindow 会被静默拒绝（这正是"打完字后什么都失效"的根源）。
        _force_foreground(hwnd)

        # 2) 找文本接口：有位置记录就按**目标窗口**取（不依赖当前焦点控件），
        #    没有才退回"当前聚焦控件"。
        node, pattern = None, None
        if pos:
            try:
                node, pattern = _find_text_pattern(auto.ControlFromHandle(int(hwnd)))
            except Exception:
                node, pattern = None, None
        if pattern is None:
            node, pattern = _find_text_pattern(auto.GetFocusedControl())
        if pattern is None:
            raise RuntimeError("目标控件已不支持文本接口，未做替换")
        span, how = _find_span(pattern, expected, pos)
        if span is None:
            # 三种定位都没命中：位置记录（控件不支持字符偏移时无效）、当前选区（用户点过
            # 别处就没了）、按原文查找（文字被改动过就找不到）。给出可执行的下一步，
            # 而不是只说"已失效"。
            raise RuntimeError(
                "找不到那段文字了：位置记录在这个控件上不可用、"
                "当前选区也不是它。请用鼠标重新选中那段文字，再点「复原」")
        span.Select(0)
        time.sleep(0.06)

        # 3) 剪贴板 + Ctrl+V（与用户手动粘贴一致，保留目标程序的撤销栈）
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, new_text)
        finally:
            win32clipboard.CloseClipboard()
        _send_combo(["ctrl", "v"])
        time.sleep(0.2)

        # 让"刚写入的文字"重新处于选中状态（Word/Chromium 这类控件走的就是这条路）。
        # 做法：粘贴后光标就在新文字末尾，把目标区间的 End 拖到那个光标上再选中。
        # ⚠ 只用 MoveEndpointByRange —— 它在这些控件上都支持；
        #   MoveEndpointByUnit 经常不支持（记事本返回 0），不能指望它。
        return_pos = None
        try:
            after_sel = pattern.GetSelection() or []
            if after_sel:
                span.MoveEndpointByRange(auto.TextPatternRangeEndpoint.End,
                                        after_sel[0], auto.TextPatternRangeEndpoint.Start, 0)
                span.Select(0)
                print("[writing] 已重新选中刚写入的文字", flush=True)
                # 顺手把**新偏移**算出来交给账本。Word 这类控件没有 EM_SETSEL，
                # 「复原」只能靠这条记录；否则只能依赖"当前选区" —— 而点复原那一下
                # 会穿透到下面（把选区点没），之后必然报"找不到那段文字"。
                try:
                    head = pattern.DocumentRange.Clone()
                    head.MoveEndpointByRange(auto.TextPatternRangeEndpoint.End,
                                            span, auto.TextPatternRangeEndpoint.Start, 0)
                    return_pos = {
                        "start": len(head.GetText(-1) or ""),
                        "length": len(span.GetText(-1) or ""),
                    }
                except Exception as e2:
                    print(f"[writing] 计算新偏移失败（复原将依赖选区）: {type(e2).__name__}", flush=True)
        except Exception as e:
            print(f"[writing] 重新选中失败（不影响写入）: {type(e).__name__}: {e}", flush=True)

        # 4) 尽力核对一次（部分程序刷新慢，核对不上不算失败，只是记一笔）
        verified = False
        try:
            reread = auto.GetFocusedControl()
            _node, pattern2 = _find_text_pattern(reread)
            if pattern2 is not None:
                probe = _normalize(new_text)[:30]
                verified = bool(probe) and bool(pattern2.DocumentRange.FindText(probe, False, False))
        except Exception:
            verified = False
        # new_pos：写后的新偏移（UIA 路径也算出来了）。账本据此更新，
        # 「复原」就能按位置定位 —— 不再依赖"当前选区"（点一下就被点没）。
        return {"how": how, "verified": verified, "new_pos": return_pos}

    return _uia_run(_inner)


async def replace_async(hwnd: int, expected: str, new_text: str, pos=None) -> Dict[str, Any]:
    return await asyncio.to_thread(replace, hwnd, expected, new_text, pos)


def labels() -> List[Tuple[str, str]]:
    """菜单用的 (动作, 标题) 列表，顺序即菜单顺序。"""
    order = ["proofread", "rewrite", "friendly", "formal", "concise",
             "summary", "keypoints", "list", "table"]
    return [(key, ACTIONS[key]["label"]) for key in order]


__all__ = ["ACTIONS", "ACTION_LABELS", "action_label", "rewrite",
           "replace", "replace_async", "labels"]
