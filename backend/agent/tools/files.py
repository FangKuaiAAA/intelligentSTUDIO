"""文件级操作工具：受限路径内的列目录/读/写/创建/删除（删除合并确认）。"""
import asyncio
import os
import re
from typing import Any, Dict, List, Optional

from .. import config
from .base import ToolResult, tool

# 允许创建的文件类型
CREATABLE_EXTS = {".txt", ".py", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"}


def _normalize(path: str) -> str:
    p = os.path.normpath(os.path.abspath(os.path.expandvars(os.path.expanduser(path))))
    # 统一为规范长路径：Windows 的 8.3 短路径（如 C:\Users\FANGJI~1\...）
    # 会让后面的范围校验误判为越界；GetLongPathNameW 同时能规范大小写与实际名称。
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.kernel32.GetLongPathNameW(p, buf, len(buf)):
            p = os.path.normpath(buf.value)
    except Exception:
        pass
    return p


_shell_folder_cache: List[str] = []


def _shell_folder_paths() -> List[str]:
    """用户文件夹实际路径（已规范化大小写/分隔符），进程内缓存。"""
    global _shell_folder_cache
    if not _shell_folder_cache:
        _shell_folder_cache = [os.path.normcase(os.path.normpath(v))
                               for v in known_user_folders().values()]
    return _shell_folder_cache


def system_drive() -> str:
    """当前系统盘（如 "C:"）。用户分区可能变动，绝不写死 C 盘。"""
    drv = os.environ.get("SystemDrive") or os.path.splitdrive(
        os.environ.get("SystemRoot") or os.environ.get("windir") or "C:\\Windows")[0]
    return (drv or "C:").upper()


def list_drives() -> List[Dict[str, Any]]:
    """当前机器实际存在的盘符（供设置页展示；系统盘单独标记）。"""
    import string
    sysdrv = system_drive()
    out: List[Dict[str, Any]] = []
    for letter in string.ascii_uppercase:
        drv = f"{letter}:"
        try:
            if os.path.isdir(drv):
                out.append({"drive": letter, "is_system": drv == sysdrv})
        except OSError:
            continue
    return out


def check_allowed(path: str) -> str:
    """路径范围校验。

    放行规则（三组，**任一命中即放行**）：
      · 自定义文件夹白名单（设置页「只访问指定文件夹」的列表）
      · 用户目录 + 重定向过的用户文件夹（桌面/文档/下载等可能落在系统盘）
      · 盘符：设置了 allowed_drives（如 ["C","D"]）时，这些盘**整盘**放行；
        未设置盘符限制、且**没有**自定义文件夹白名单时，非系统盘全部放行。

    ⚠ 盘符与文件夹白名单是**或**的关系（这是用户实测的坑）：
      原来写成"白名单非空 ⇒ 只认列表、不命中就直接抛错"，于是设置页里勾了磁盘也
      **完全不起作用**：UI 上两个开关看着是叠加的，代码里却是后者永远不生效 ——
      用户勾了盘、保存成功、然后模型照样写不进去，而且没有任何提示。
      现在两者都是"放行条件"，勾哪个都能让对应范围生效。
    """
    p = _normalize(path)
    np = os.path.normcase(p)  # Windows 路径不区分大小写
    allowed = config.allowed_paths()
    if allowed:
        for base in allowed:
            b = os.path.normcase(base)
            if np == b or np.startswith(b + os.sep):
                return p
    else:
        # ⚠ 这两条是**默认范围**的一部分，只在"没有自定义白名单"时适用：
        #   打开「只访问指定文件夹」时它就应当是**严格**的（只认列表），
        #   否则用户设了限制却还能写用户目录，白名单形同虚设。
        home = os.path.normcase(os.path.normpath(config.USER_HOME))
        if np == home or np.startswith(home + os.sep):
            return p
        # 用户重定向过的桌面/文档/下载等可能落在系统盘但不在用户目录下，同样要放行
        for folder in _shell_folder_paths():
            if np == folder or np.startswith(folder + os.sep):
                return p
    drive = os.path.splitdrive(p)[0].upper()[:1]  # "C"
    if drive:
        allowed_drives = config.allowed_drives()
        if allowed_drives is not None:
            if drive in allowed_drives:
                return p
        elif not allowed and drive != system_drive()[:1]:
            # 未设盘符限制、也没有自定义白名单：非系统盘全部放行（原有默认行为）
            return p
    if allowed:
        raise PermissionError(f"路径超出允许范围（仅允许设置里列出的文件夹与盘符）：{p}")
    raise PermissionError(
        f"路径超出允许范围（用户目录、已重定向的用户文件夹与允许的盘符）：{p}")


def _fmt_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


_USER_SHELL_FOLDERS = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
_SHELL_FOLDERS = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"

# 注册表键名 → 中文名。键名可能是旧式名称（Desktop/Personal/My Music…），
# 也可能是 GUID 形式（不同语言/不同 Windows 版本会用），两种都要认。
_FOLDER_LABELS: Dict[str, str] = {
    # —— 用户常说的六个文件夹
    "Desktop": "桌面",
    "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}": "桌面",
    "Personal": "文档",
    "My Documents": "文档",
    "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}": "文档",
    "{A8CDFF1C-4878-43BE-B5FD-F8091C1C60D0}": "文档",
    "{374DE290-123F-4565-9164-39C4925E467B}": "下载",
    "My Pictures": "图片",
    "{33E28130-4E1E-4676-835A-98395C3BC3BB}": "图片",
    "My Music": "音乐",
    "{4BD8D571-6D19-48D3-BE97-422220080E43}": "音乐",
    "My Video": "视频",
    "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}": "视频",
    # —— 其余常用位置（有则一并告知模型；AppData 内的 Recent/SendTo 等属噪声，不列）
    "Favorites": "收藏夹",
    "Start Menu": "开始菜单",
    "Startup": "启动",
    "{56784854-C6CB-462B-8169-88E350ACB882}": "联系人",
    "{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}": "保存的游戏",
    "{BFB9D5E0-C6A9-404C-B2B2-AE6DB6AF4968}": "链接",
}

# 六个常用文件夹的展示顺序（放最前）
_PRIMARY_LABELS = ("桌面", "文档", "下载", "图片", "音乐", "视频")

# 这些键与用户可见的“用户文件夹”无关，不放进提示词（避免噪声）
_SKIP_KEYS = {"AppData", "Local AppData", "Cache", "Cookies", "History", "NetHood",
              "PrintHood", "Fonts", "CD Burning", "Templates", "Programs"}

# 注册表读不到时的兜底子目录名（仅在确实存在时采用）
_DEFAULT_SUBDIR = {"桌面": "Desktop", "文档": "Documents", "下载": "Downloads",
                   "图片": "Pictures", "音乐": "Music", "视频": "Videos"}


def _read_shell_folder_key(subkey: str) -> Dict[str, str]:
    """枚举注册表某个 Shell Folders 键下的全部值（不做名称过滤）。"""
    out: Dict[str, str] = {}
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey) as k:
            for i in range(winreg.QueryInfoKey(k)[1]):
                try:
                    name, val, _type = winreg.EnumValue(k, i)
                except OSError:
                    continue
                if isinstance(val, str) and val.strip():
                    out[name] = val.strip()
    except OSError:
        pass
    return out


def known_user_folders() -> Dict[str, str]:
    """读取用户文件夹（桌面/文档/下载/图片/音乐/视频等）的真实位置。

    这些文件夹可以被用户**分别**重定向到任意盘符、任意名字的目录，彼此也不一定在
    同一个用户目录下（例如桌面在 D:\\fangjiahe\\桌面），所以必须逐项读注册表：
      · User Shell Folders —— 权威设置，值里可能含 %USERPROFILE% 之类环境变量
      · Shell Folders      —— 系统解析后的实际路径，作为逐项兜底
    绝不按 C:\\Users\\<用户名>\\Desktop 之类惯例猜测。
    """
    raw = _read_shell_folder_key(_USER_SHELL_FOLDERS)
    resolved = _read_shell_folder_key(_SHELL_FOLDERS)

    ordered: List[str] = []
    picked: Dict[str, str] = {}
    for key in list(raw) + [k for k in resolved if k not in raw]:
        label = _FOLDER_LABELS.get(key)
        if not label or key in _SKIP_KEYS or label in picked:
            continue
        candidates = []
        if key in raw:
            candidates.append(os.path.normpath(os.path.expandvars(raw[key])))
        if key in resolved:
            candidates.append(os.path.normpath(os.path.expandvars(resolved[key])))
        if not candidates:
            continue
        # 逐项校验：优先选真正存在的路径（用户搬过文件夹时两个键可能不同步）
        path = next((c for c in candidates if os.path.isdir(c)), candidates[0])
        picked[label] = path
        ordered.append(label)

    out: Dict[str, str] = {}
    for label in _PRIMARY_LABELS:          # 六个常用文件夹排最前
        if label in picked:
            out[label] = picked.pop(label)
    for label in ordered:                  # 其余位置保持注册表顺序
        if label in picked:
            out[label] = picked.pop(label)
    for label, sub in _DEFAULT_SUBDIR.items():   # 注册表缺失时的兜底（仅当确实存在）
        if label not in out:
            cand = os.path.join(config.USER_HOME, sub)
            if os.path.isdir(cand):
                out[label] = cand
    return out


@tool("list_directory", "读取文件夹内容",
      "读取指定文件夹内的文件和子文件夹列表（名称/类型/大小）。",
      {"path": {"type": "string", "description": "文件夹路径", "required": True}})
async def list_directory(args: Dict[str, Any], ctx) -> ToolResult:
    path = check_allowed(args["path"])
    if not os.path.isdir(path):
        return ToolResult(f"文件夹不存在：{path}", ok=False)

    def _scan():
        entries = []
        with os.scandir(path) as it:
            for e in it:
                try:
                    size = 0 if e.is_dir() else e.stat().st_size
                    entries.append((e.name, e.is_dir(), size))
                except OSError:
                    entries.append((e.name, e.is_dir(), 0))
        return entries

    entries = await asyncio.to_thread(_scan)
    lines = [f"{'[文件夹]' if d else '[文件]'} {n}" + ("" if d else f" ({_fmt_size(s)})")
             for n, d, s in entries[:200]]
    text = f"{path} 共 {len(entries)} 项：\n" + ("\n".join(lines) if lines else "（空）")
    return ToolResult(text)


@tool("read_file", "读取文件",
      "读取文件内容。文本类文件直接读；Word（docx）会提取段落与表格、"
      "Excel（xlsx）会提取各工作表、PowerPoint（pptx）会提取各页文字。",
      {"path": {"type": "string", "description": "文件路径", "required": True},
       "max_chars": {"type": "integer", "description": "最多读取字符数，默认4000"}})
async def read_file_tool(args: Dict[str, Any], ctx) -> ToolResult:
    path = check_allowed(args["path"])
    if not os.path.isfile(path):
        return ToolResult(f"文件不存在：{path}", ok=False)
    max_chars = int(args.get("max_chars") or 4000)
    name = os.path.basename(path)
    doc_text = await asyncio.to_thread(_read_office, path)
    if doc_text is not None:
        body = doc_text[:max_chars]
        more = "（内容较长，已截断）" if len(doc_text) > max_chars else ""
        return ToolResult(f"文件 {name} 内容{more}：\n{body}")
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = await asyncio.to_thread(f.read, max_chars)
    except OSError as e:
        return ToolResult(str(e), ok=False)
    return ToolResult(f"文件 {name} 内容：\n{content}")


def _write_office(path: str, content: str):
    """按扩展名写出真实格式的文稿：docx/xlsx/pptx/csv 用对应库，其余按纯文本。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".doc", ".docx"):
        _write_docx(path, content)
    elif ext in (".xls", ".xlsx"):
        _write_xlsx(path, content)
    elif ext in (".ppt", ".pptx"):
        _write_pptx(path, content)
    elif ext == ".csv":
        _write_csv(path, content)
    else:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)


# ---------- 文稿读写：轻量标记 → 真实 Office 格式 ----------
# 模型只需输出带下列标记的纯文本，就能得到结构正确的文稿：
#   # 一级标题   ## 二级标题   ### 三级标题   - 项目符号   1. 编号    **行内加粗**
#   （pptx 里每个「# 标题」开一页；表格用「|」分列，其次制表符，最后逗号）

_BULLET_RE = re.compile(r"^[-*·•]\s+(.*)$")
_NUMBER_RE = re.compile(r"^\d+[.)]\s+(.*)$")


def _plain(text: str) -> str:
    """去掉行内标记，用于标题等不支持富文本的位置。"""
    return text.replace("**", "").strip()


def _add_runs(paragraph, text: str) -> None:
    """把 **粗体** 写成真正的加粗，其余按普通文本。"""
    for i, piece in enumerate(text.split("**")):
        if piece:
            paragraph.add_run(piece).bold = bool(i % 2)


def _split_row(line: str) -> List[str]:
    """拆一行的单元格：优先「|」分列，其次制表符，最后按 CSV 规则解析逗号。"""
    if "|" in line:
        parts = [p.strip() for p in line.split("|")]
    elif "\t" in line:
        parts = [p.strip() for p in line.split("\t")]
    else:
        import csv
        try:
            parts = [p.strip() for p in next(csv.reader([line]))]
        except Exception:
            parts = [p.strip() for p in line.split(",")]
    while parts and not parts[0]:
        parts.pop(0)
    while parts and not parts[-1]:
        parts.pop()
    return parts


def _as_number(cell: str):
    """像数字的单元格转成数值，Excel 里才能参与计算。"""
    t = cell.strip()
    if re.fullmatch(r"[+-]?\d+", t):
        return int(t)
    if re.fullmatch(r"[+-]?\d*\.\d+", t):
        return float(t)
    return cell


def _write_docx(path: str, content: str) -> None:
    from docx import Document
    doc = Document()
    for raw in content.split("\n"):
        line = raw.strip()
        if not line:
            doc.add_paragraph("")
            continue
        heading = next(((prefix, level)
                        for prefix, level in (("### ", 3), ("## ", 2), ("# ", 1))
                        if line.startswith(prefix)), None)
        if heading:
            prefix, level = heading
            doc.add_heading(_plain(line[len(prefix):]), level=level)
            continue
        bullet = _BULLET_RE.match(line)
        number = _NUMBER_RE.match(line)
        if bullet:
            _add_runs(doc.add_paragraph(style="List Bullet"), bullet.group(1))
        elif number:
            _add_runs(doc.add_paragraph(style="List Number"), number.group(1))
        else:
            _add_runs(doc.add_paragraph(), line)
    doc.save(path)


def _fill_body(text_frame, lines: List[str]) -> None:
    """把要点填进幻灯片的正文框；缩进两格及以上算下级要点。"""
    text_frame.clear()
    for i, raw in enumerate(lines):
        text = raw.strip()
        indent = len(raw) - len(raw.lstrip())
        bullet = _BULLET_RE.match(text)
        if bullet:
            text = bullet.group(1)
        para = text_frame.paragraphs[0] if i == 0 else text_frame.add_paragraph()
        para.text = _plain(text)
        para.level = min(indent // 2, 4)


def _write_pptx(path: str, content: str) -> None:
    from pptx import Presentation
    prs = Presentation()
    lines = content.split("\n")

    if not any(l.strip().startswith("# ") for l in lines):
        # 没有分页标记：首行当标题、其余当正文
        body = [l for l in lines if l.strip()]
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = _plain(body[0]) if body else ""
        _fill_body(slide.placeholders[1].text_frame, body[1:])
        prs.save(path)
        return

    blocks: List[Dict[str, Any]] = []
    for raw in lines:
        s = raw.strip()
        if s.startswith("# "):
            blocks.append({"title": _plain(s[2:]), "body": [], "cover": False})
        elif s == "---":
            blocks.append({"title": "", "body": [], "cover": False})
        else:
            if not blocks:
                blocks.append({"title": "", "body": [], "cover": True})
            blocks[-1]["body"].append(raw)

    for block in blocks:
        body = [l for l in block["body"] if l.strip()]
        if block["cover"]:
            # 第一个「# 」之前的内容做封面页：首行主标题、次行副标题
            slide = prs.slides.add_slide(prs.slide_layouts[0])
            slide.shapes.title.text = _plain(body[0]) if body else ""
            if len(body) > 1:
                slide.placeholders[1].text = _plain(body[1])
            continue
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = block["title"]
        _fill_body(slide.placeholders[1].text_frame, body)
    prs.save(path)


def _write_xlsx(path: str, content: str) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook()
    ws = wb.active
    first_row = True
    for raw in content.split("\n"):
        if not raw.strip():
            continue
        cells = [_as_number(c) for c in _split_row(raw)]
        ws.append(cells)
        if first_row:
            # 首行不含数字时当作表头加粗（纯数据表就不动它）
            if not any(isinstance(c, (int, float)) for c in cells):
                for cell in ws[ws.max_row]:
                    if cell.value is not None:
                        cell.font = Font(bold=True)
            first_row = False
    wb.save(path)


def _write_csv(path: str, content: str) -> None:
    """写成标准 CSV：UTF-8 带 BOM + 规范引号，Excel 双击打开不乱码。"""
    import csv
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        for raw in content.split("\n"):
            if raw.strip():
                writer.writerow(_split_row(raw))


def _read_office(path: str) -> Optional[str]:
    """读取 Office 文稿里的文字；不是这几类格式时返回 None。"""
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".docx":
            from docx import Document
            doc = Document(path)
            parts = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)
        if ext == ".xlsx":
            from openpyxl import load_workbook
            wb = load_workbook(path, read_only=True, data_only=True)
            parts = []
            for ws in wb.worksheets:
                parts.append(f"[工作表] {ws.title}")
                for row in ws.iter_rows(values_only=True):
                    if any(c is not None and str(c).strip() for c in row):
                        parts.append(" | ".join("" if c is None else str(c) for c in row))
            wb.close()
            return "\n".join(parts)
        if ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(path)
            parts = []
            for i, slide in enumerate(prs.slides, 1):
                texts = [sh.text_frame.text for sh in slide.shapes
                         if sh.has_text_frame and sh.text_frame.text.strip()]
                parts.append(f"[第 {i} 页]\n" + "\n".join(texts))
            return "\n".join(parts)
    except Exception:
        return None
    return None


@tool("write_file", "写入文件",
      "创建或写入文件，会按扩展名写出真实格式。用户文稿默认用：文字稿 .docx、纯文本 .txt、"
      "表格 .xlsx、演示 .pptx（不要默认用 .md/.csv/.py/.json，除非用户指定）。\n"
      "content 就是带轻量标记的纯文本，标记会被转成真正的文稿结构：\n"
      "  # 一级标题   ## 二级标题   ### 三级标题   - 项目符号   1. 编号条目   **行内加粗**\n"
      "  演示文稿（pptx）：每个「# 标题」开一页，页内用「- 要点」写正文，缩进两格为下级要点。\n"
      "  表格（xlsx/csv）：每行一条记录，优先用「|」分列（如「姓名|部门|工时」），"
      "也可用制表符或逗号；数字会自动存成数值。\n"
      "其它扩展名按纯文本写入；也可创建文件夹（is_folder=true）。",
      {"path": {"type": "string", "description": "目标路径", "required": True},
       "content": {"type": "string", "description": "写入内容（创建文件夹时留空）"},
       "is_folder": {"type": "boolean", "description": "true 表示创建文件夹"}})
async def write_file(args: Dict[str, Any], ctx) -> ToolResult:
    path = check_allowed(args["path"])
    name = os.path.basename(path)
    if args.get("is_folder"):
        existed = os.path.isdir(path)
        await asyncio.to_thread(os.makedirs, path, exist_ok=True)
        if not existed:
            ctx.mark_created(path)
        # 卡片标题只写「项」（名词），不写动作：不要「创建 报告.docx」这类动词标题
        return ToolResult(f"已{'打开' if existed else '创建'}文件夹 {path}",
                          card={"kind": "folder", "title": name, "subtitle": path})
    ext = os.path.splitext(path)[1].lower()
    if ext and ext not in CREATABLE_EXTS and ext not in (".md", ".json", ".csv", ".log", ".html"):
        return ToolResult(f"不支持创建 {ext} 类型文件", ok=False)
    parent = os.path.dirname(path)
    if parent:
        await asyncio.to_thread(os.makedirs, parent, exist_ok=True)
    existed = os.path.exists(path)
    content = args.get("content") or ""
    await asyncio.to_thread(_write_office, path, content)
    if not existed:
        ctx.mark_created(path)   # AI 新建的文件：删除时无需再次确认
    action = "修改" if existed else "创建"
    return ToolResult(f"已{action}文件 {path}（{len(content)} 字符）",
                      card={"kind": "file", "title": name, "subtitle": path})


@tool("delete_files", "删除文件",
      "删除一个或多个文件/文件夹。用户原有的文件执行前会打断请求确认（多个合并为一次）；"
      "AI 在本次会话中自己新建的文件/文件夹直接删除，无需确认。",
      {"paths": {"type": "array", "items": {"type": "string"}, "description": "要删除的路径列表", "required": True}},
      sensitive=True)
async def delete_files(args: Dict[str, Any], ctx) -> ToolResult:
    paths: List[str] = [check_allowed(p) for p in (args.get("paths") or [])]
    if not paths:
        return ToolResult("未指定要删除的路径", ok=False)
    # AI 自己在本次会话中创建的文件无需确认，只对其它文件请求确认（多个合并为一次）
    need_confirm = [p for p in paths if not ctx.is_created(p)]
    if need_confirm:
        names = [os.path.basename(p) for p in need_confirm]
        if len(need_confirm) == 1:
            prompt = f"确定要删除 {names[0]} 吗？此操作不可恢复。"
        else:
            prompt = (f"确定要删除以下 {len(need_confirm)} 个项目吗？此操作不可恢复。\n"
                      + "\n".join(names[:20]))
        approved = await ctx.confirm(prompt, {"files": names})
        if not approved:
            return ToolResult("用户取消了删除操作。")
    deleted, failed = [], []
    for p in paths:
        try:
            if os.path.isdir(p):
                await asyncio.to_thread(__import__("shutil").rmtree, p)
            else:
                await asyncio.to_thread(os.remove, p)
            deleted.append(p)
        except OSError as e:
            failed.append(f"{os.path.basename(p)}: {e}")
        else:
            ctx.unmark_created(p)
    # 删除是用户提出的成果：交由模型决定用 delete 卡片展示（删除多个时展示第一个）
    text = f"已删除 {len(deleted)} 个项目：" + "、".join(os.path.basename(p) for p in deleted)
    if failed:
        text += "；失败：" + "；".join(failed)
    card = None
    if deleted:
        first = deleted[0]
        more = f"（另 {len(deleted) - 1} 个）" if len(deleted) > 1 else ""
        card = {"kind": "delete", "title": f"{os.path.basename(first)}{more}",
                "subtitle": os.path.dirname(first)}
    return ToolResult(text, card=card, ok=not failed)
