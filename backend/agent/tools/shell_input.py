"""后台 shell、键盘模拟（SendInput）、文件搜索。联网搜索/读网页见 web.py。"""
import asyncio
import fnmatch
import os
import subprocess
from typing import Any, Dict, List, Tuple

from .base import ToolResult, tool


# ---------- 后台 shell ----------
def _decode_out(raw: bytes) -> str:
    """命令行输出解码：先按 UTF-8 试（Python/现代工具），失败再按 ANSI(GBK)。"""
    for enc in ("utf-8", "mbcs", "gbk"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")



@tool("run_shell", "执行命令",
      "在后台执行 shell 命令（无窗口）并返回输出内容。适合查询系统信息、网络状态等。timeout 秒，默认 30。",
      {"command": {"type": "string", "description": "要执行的命令", "required": True},
       "timeout": {"type": "integer", "description": "超时秒数，默认30"}})
async def run_shell(args: Dict[str, Any], ctx) -> ToolResult:
    command = args["command"]
    timeout = min(int(args.get("timeout") or 30), 120)

    def _run() -> Tuple[int, str]:
        # 输出按字节取回再自行解码：Windows 命令行工具多数返回 ANSI/GBK 中文，
        # 直接指定 utf-8 + ignore 会把中文整段丢掉（之前就是这样）。
        r = subprocess.run(command, shell=True, capture_output=True,
                           timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode, _decode_out(r.stdout or b"") + _decode_out(r.stderr or b"")

    try:
        code, out = await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
        return ToolResult(f"命令执行超时（{timeout}s）", ok=False)
    out = out.strip()[:3000] or "（无输出）"
    return ToolResult(f"命令执行完成（退出码 {code}）：\n{out}", ok=code == 0)


# ---------- 键盘模拟（SendInput） ----------
VK_MAP = {
    "play_pause": 0xB3, "next_track": 0xB0, "prev_track": 0xB1, "stop_media": 0xB2,
    "volume_up": 0xAF, "volume_down": 0xAE, "mute": 0xAD,
}
MOD_VK = {"win": 0x5B, "ctrl": 0x11, "alt": 0x12, "shift": 0x10}
KEY_VK = {
    "s": 0x53, "c": 0x43, "v": 0x56, "x": 0x58, "z": 0x5A, "a": 0x41, "l": 0x4C,
    "d": 0x44, "e": 0x45, "r": 0x52, "tab": 0x09, "esc": 0x1B, "enter": 0x0D,
    "space": 0x20, "f4": 0x73, "printscreen": 0x2C, "delete": 0x2E, "home": 0x24,
    "end": 0x23, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
}


def _send_vk(vk: int):
    import win32api
    import win32con
    win32api.keybd_event(vk, 0, 0, 0)
    win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)


def _send_combo(keys: List[str]):
    import time as _time
    import win32api
    import win32con
    mods = [MOD_VK[k] for k in keys[:-1] if k in MOD_VK]
    main = KEY_VK.get(keys[-1])
    if main is None:
        raise ValueError(f"不支持的按键：{keys[-1]}")
    for vk in mods:
        win32api.keybd_event(vk, 0, 0, 0)
    _time.sleep(0.03)
    win32api.keybd_event(main, 0, 0, 0)
    win32api.keybd_event(main, 0, win32con.KEYEVENTF_KEYUP, 0)
    for vk in reversed(mods):
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)


@tool("press_keys", "模拟按键",
      "模拟键盘操作。media: 媒体控制（play_pause/next_track/prev_track/stop_media/volume_up/volume_down/mute）；"
      "shortcut: 快捷键（如 'win+shift+s' 截屏、'ctrl+c' 复制、'ctrl+v' 粘贴、'win+l' 锁屏）。",
      {"media": {"type": "string", "enum": list(VK_MAP.keys()), "description": "媒体键"},
       "shortcut": {"type": "string", "description": "快捷键组合，用+连接"}})
async def press_keys(args: Dict[str, Any], ctx) -> ToolResult:
    media = args.get("media")
    shortcut = (args.get("shortcut") or "").lower().replace(" ", "")
    try:
        if media:
            await asyncio.to_thread(_send_vk, VK_MAP[media])
            return ToolResult(f"已执行媒体控制 {media}。")
        if shortcut:
            keys = shortcut.split("+")
            await asyncio.to_thread(_send_combo, keys)
            return ToolResult(f"已按下快捷键 {shortcut}。")
        return ToolResult("未指定按键", ok=False)
    except ValueError as e:
        return ToolResult(str(e), ok=False)


@tool("type_text", "输入文本",
      "在当前焦点窗口模拟键盘输入一段文本（通过剪贴板粘贴，支持中文）。",
      {"text": {"type": "string", "description": "要输入的文本", "required": True}})
async def type_text(args: Dict[str, Any], ctx) -> ToolResult:
    text = args["text"]

    def _paste():
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        finally:
            win32clipboard.CloseClipboard()
        _send_combo(["ctrl", "v"])

    await asyncio.to_thread(_paste)
    return ToolResult(f"已输入 {len(text)} 个字符。")


# ---------- 文件搜索 ----------
@tool("search_files", "搜索文件",
      "在指定目录（默认用户目录）内按名称搜索文件或文件夹。pattern 支持 * ? 通配符。",
      {"pattern": {"type": "string", "description": "文件名模式，如 *.docx、报告*", "required": True},
       "directory": {"type": "string", "description": "搜索起始目录（默认用户目录）"},
       "max_results": {"type": "integer", "description": "最多返回条数，默认30"}})
async def search_files(args: Dict[str, Any], ctx) -> ToolResult:
    pattern = (args["pattern"] or "*").lower()
    root = os.path.expanduser(args.get("directory") or "~")
    max_results = min(int(args.get("max_results") or 30), 200)
    if not os.path.isdir(root):
        return ToolResult(f"目录不存在：{root}", ok=False)

    def _search() -> List[str]:
        found: List[str] = []
        skip = {"appdata", "node_modules", "$recycle.bin", ".git"}
        stack = [root]
        while stack and len(found) < max_results:
            current = stack.pop()
            try:
                with os.scandir(current) as it:
                    for e in it:
                        if len(found) >= max_results:
                            break
                        name = e.name
                        if fnmatch.fnmatch(name.lower(), pattern):
                            found.append(e.path)
                        if e.is_dir(follow_symlinks=False) and name.lower() not in skip:
                            stack.append(e.path)
            except (OSError, PermissionError):
                continue
        return found

    found = await asyncio.to_thread(_search)
    if not found:
        return ToolResult(f"未找到匹配「{pattern}」的文件")
    # 搜索是过程，不是成果：不发卡片（卡片只用来向用户展示成果）
    return ToolResult(f"找到 {len(found)} 个结果：\n" + "\n".join(found))
