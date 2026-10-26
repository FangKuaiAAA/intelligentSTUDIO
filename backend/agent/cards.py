"""结果卡片：**每个功能一张独立卡片**，规格在"设计时"就定死。

标准（DonyAG.txt (六)11 + 用户要求）：
  · 一类操作（kind）= 一个功能；禁止"通用"卡片（一张卡同时表示 WiFi 和蓝牙、由模型填参数）；
    未知类型一律不发卡片（回退到"通用卡片"是不允许的）。
  · 标题 / 介绍（副标题怎么来） / 图标 / 配色 / 是否带操控项（开关或滑块）**全部由规格决定**，
    模型改不了；只有含内容的卡片（文件、天气、网站、信息/邮件）才填内容。
  · 主标题在前、小字在后：主标题是「功能/项目名」，副标题是状态与数值——
    「计时器」+「5:00」，不是「5分钟 计时器」。计时器/闹钟的数字在前端按 extra.ends_at 实时走。
  · 工具的 ToolResult.card 只声明"哪张卡 + 什么状态/内容"，卡片本体由 build_card 组装。
    这样开关/滑块**不可能漏**（以前靠模型记得传 toggle=true，时不时就漏）。
"""
import time
import uuid
from typing import Any, Dict, Optional

# 操控项类型
SWITCH = "switch"          # 开关：开/关
SLIDER = "slider"          # 滑块：0-100 的数值
SEGMENTS = "segments"      # 三段式：固定几档里选一个（如电源模式：节能/均衡/高性能）

# 主题渐变：每个功能一种配色，便于区分（允许少量相同）
THEMES = {
    # —— 文件与目录（黑蓝系） ——
    "file":       {"from": "#0B1E3A", "to": "#123F6E", "direction": "vertical"},
    "folder":     {"from": "#123A4D", "to": "#1F6E8C", "direction": "vertical"},
    "delete":     {"from": "#3B0A12", "to": "#7A1526", "direction": "vertical"},
    # —— 系统状态（青灰） ——
    "status":     {"from": "#2C5364", "to": "#203A43", "direction": "vertical"},
    # —— Edge（蓝绿） ——
    "edge":       {"from": "#0F4C81", "to": "#16A085", "direction": "vertical"},
    # —— 联网三件事（蓝 / 靛 / 青绿） ——
    "wifi":       {"from": "#3A7BD5", "to": "#4D8AFF", "direction": "vertical"},
    "bluetooth":  {"from": "#4A3AFF", "to": "#7A5CFF", "direction": "vertical"},
    "hotspot":    {"from": "#0E7C7B", "to": "#17B0A8", "direction": "vertical"},
    # —— 音量亮度（紫 / 橙黄） ——
    "volume":     {"from": "#8E2DE2", "to": "#C44DFF", "direction": "vertical"},
    "brightness": {"from": "#F7971E", "to": "#FFD84D", "direction": "vertical"},
    # —— 计划任务 / 闹钟 / 计时器 / 启动项（深色系，各自区分） ——
    "task":       {"from": "#232526", "to": "#414345", "direction": "vertical"},
    "alarm":      {"from": "#141416", "to": "#000000", "direction": "vertical"},
    "timer":      {"from": "#0D0D12", "to": "#2A2A38", "direction": "vertical"},
    "startup":    {"from": "#1D4350", "to": "#A43931", "direction": "vertical"},
    # —— 设备（蓝灰） ——
    "device":     {"from": "#373B44", "to": "#4286F4", "direction": "vertical"},
    # —— 系统开关：夜间 / 节能 / 就近共享（各自一色） ——
    "night_light":  {"from": "#1B2A6B", "to": "#5A4FCF", "direction": "vertical"},
    "power_mode":   {"from": "#0B6E4F", "to": "#2BC48A", "direction": "vertical"},
    "nearby_share": {"from": "#1D4ED8", "to": "#38BDF8", "direction": "vertical"},
    # —— 辅助功能开关（粘滞键 / 单声道 / 放大镜 / 讲述人 / 屏幕键盘） ——
    "sticky_keys":  {"from": "#4B5563", "to": "#9CA3AF", "direction": "vertical"},
    "mono_audio":   {"from": "#6D28D9", "to": "#A78BFA", "direction": "vertical"},
    "magnifier":    {"from": "#B45309", "to": "#FBBF24", "direction": "vertical"},
    "narrator":     {"from": "#9D174D", "to": "#F472B6", "direction": "vertical"},
    "osk":          {"from": "#1E3A8A", "to": "#60A5FA", "direction": "vertical"},
    # —— 内容类（天气 / 网站） ——
    "weather":    {"from": "#3A7BD5", "to": "#00C9FB", "direction": "vertical"},
    "website":    {"from": "#5B6470", "to": "#2E3440", "direction": "vertical"},
    # ⚠ 这里不再保留 message / mail 的配色：那两类卡片已删除（见 CARD_SPECS 末尾那段说明），
    #   留着配色只会让人误以为还有这两张卡片。
}

# 前端可渲染的图标名（与 src/components/overlay/cardIcons.tsx 保持一致）
ICONS = ("file", "folder", "link", "mail", "message", "cpu", "wifi", "bluetooth", "volume",
         "sun", "alarm", "timer", "calendar", "rocket", "usb", "clipboard", "window",
         "cloud-sun", "cloud", "rain", "sparkle", "trash", "keyboard", "globe",
         "snow", "thunder", "fog", "wind", "moon")

# ===== 卡片规格表 =====
#   title          : 固定主标题（功能/项目名）。内容类卡片用 title_from="content"
#   subtitle       : "state"（按开关状态/数值生成）或 "content"（工具/模型给）
#   icon           : 固定图标名
#   theme          : 配色键（见 THEMES）
#   control        : SWITCH / SLIDER / None
#   switch         : 操控项回传的 key（前端 card-value / toggle-card 用它）
#   title_from     : "content" 时标题取内容（文件/网站/天气/信息这类没有固定名字的）
CARD_SPECS: Dict[str, Dict[str, Any]] = {
    # ---------- 开关类（单步可取消操作） ----------
    "wifi":       {"title": "WiFi",   "subtitle": "state", "icon": "wifi",      "theme": "wifi",      "control": SWITCH, "switch": "wifi"},
    "bluetooth":  {"title": "蓝牙",    "subtitle": "state", "icon": "bluetooth", "theme": "bluetooth", "control": SWITCH, "switch": "bluetooth"},
    "hotspot":    {"title": "移动热点", "subtitle": "state", "icon": "wifi",      "theme": "hotspot",   "control": SWITCH, "switch": "mobile_hotspot"},
    "power_mode":   {"title": "电源模式", "subtitle": "state", "icon": "cpu",       "theme": "power_mode",
                     "control": SEGMENTS, "switch": "power_mode",
                     "options": [{"value": "efficiency", "label": "节能"},
                                 {"value": "balanced", "label": "均衡"},
                                 {"value": "performance", "label": "高性能"}],
                     "default": "balanced"},
    "sticky_keys":  {"title": "粘滞键",   "subtitle": "state", "icon": "keyboard",  "theme": "sticky_keys",  "control": SWITCH, "switch": "sticky_keys"},
    "mono_audio":   {"title": "单声道音频", "subtitle": "state", "icon": "volume",   "theme": "mono_audio",   "control": SWITCH, "switch": "mono_audio"},
    "magnifier":    {"title": "放大镜",   "subtitle": "state", "icon": "sparkle",   "theme": "magnifier",    "control": SWITCH, "switch": "magnifier"},
    "narrator":     {"title": "讲述人",   "subtitle": "state", "icon": "message",   "theme": "narrator",     "control": SWITCH, "switch": "narrator"},
    "osk":          {"title": "屏幕键盘", "subtitle": "state", "icon": "keyboard",  "theme": "osk",          "control": SWITCH, "switch": "osk"},
    # ---------- 滑块类（数值可调） ----------
    "volume":     {"title": "音量", "subtitle": "state", "icon": "volume", "theme": "volume",     "control": SLIDER, "switch": "volume",     "min": 0, "max": 100, "unit": "%"},
    "brightness": {"title": "亮度", "subtitle": "state", "icon": "sun",    "theme": "brightness", "control": SLIDER, "switch": "brightness", "min": 0, "max": 100, "unit": "%"},
    # ---------- 定时类（开关 + 实时数字） ----------
    "alarm":   {"title": "闹钟",     "subtitle": "time",    "icon": "alarm",    "theme": "alarm",   "control": SWITCH, "switch": "alarm"},
    "timer":   {"title": "计时器",   "subtitle": "time",    "icon": "timer",    "theme": "timer",   "control": SWITCH, "switch": "timer"},
    "task":    {"title": "计划任务", "subtitle": "content", "icon": "calendar", "theme": "task",    "control": SWITCH, "switch": "task"},
    "startup": {"title": "启动项",   "subtitle": "content", "icon": "rocket",   "theme": "startup", "control": SWITCH, "switch": "startup"},
    # ---------- 设备 ----------
    "device":  {"title": "设备", "subtitle": "content", "icon": "usb", "theme": "device", "control": None},
    # ---------- 内容类：标题由工具/模型给（没有固定名字） ----------
    "file":    {"title_from": "content", "subtitle": "content", "icon": "file",   "theme": "file",   "control": None},
    "folder":  {"title_from": "content", "subtitle": "content", "icon": "folder", "theme": "folder", "control": None},
    "delete":  {"title_from": "content", "subtitle": "content", "icon": "trash",  "theme": "delete", "control": None},
    "status":  {"title": "系统状态", "subtitle": "content", "icon": "cpu",   "theme": "status",  "control": None},
    "edge":    {"title": "Edge",    "subtitle": "content", "icon": "globe", "theme": "edge",    "control": None},
    "weather": {"title_from": "content", "subtitle": "content", "icon": "cloud-sun",
                "theme": "weather", "control": None},
    "website": {"title_from": "content", "subtitle": "content", "icon": "link",    "theme": "website", "control": None},
    # ⚠ 曾经有 "message"（信息）与 "mail"（邮件）两类：它们只有"模型自填的标题+副标题"，
    #   等于一张**通用卡片** —— 模型会拿它去汇报"我刚做了什么"（例如改完系统颜色模式后
    #   弹一张绿色的「系统浅色模式已开启」）。已按用户要求删除：
    #   没设计过的类型 spec_for 返回空 → 不发卡片（从根上不存在通用卡片）。
}

KINDS = tuple(CARD_SPECS.keys())


def spec_for(kind: str) -> dict:
    """取某类卡片的规格；未设计的类型返回空（= 不发卡片）。"""
    return CARD_SPECS.get(kind) or {}


def bound_switch_key(kind: str, key: str = "") -> str:
    """卡片上操控项该回传的 key。

    多数情况就是规格里写死的那个（volume/brightness/wifi…）；但闹钟/计时器/计划任务/
    启动项是**带标识的实例**（alarm:3f2a、task:每日备份），工具必须把自己的标识带上，
    否则前端不知道要关哪一个。
    """
    spec = CARD_SPECS.get(kind) or {}
    base = spec.get("switch") or ""
    if not key:
        return base
    if not base:
        return key
    return key if (key == base or key.startswith(f"{base}:")) else base


def _hhmm(ts: float) -> str:
    return time.strftime("%H:%M", time.localtime(ts))


def _mmss(seconds: float) -> str:
    seconds = max(0, int(seconds))
    m, s = divmod(seconds, 60)
    if m >= 60:
        h, m = divmod(m, 60)
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _state_subtitle(spec: dict, pending: dict, control_state) -> str:
    """开关/滑块/三段式卡片的副标题：小字是状态或数值，不是主标题的一部分。"""
    if spec.get("control") == SEGMENTS:
        value = pending.get("value", control_state) or spec.get("default")
        for opt in spec.get("options") or []:
            if opt.get("value") == value:
                return str(opt.get("label"))
        return ""
    if spec.get("control") == SLIDER:
        value = pending.get("value", control_state)
        unit = spec.get("unit", "")
        if value is None:
            return ""
        value = int(value)
        return "已静音" if (spec["switch"] == "volume" and value <= 0) else f"{value}{unit}"
    if spec.get("subtitle") == "time":
        # 时间类：优先用工具给的时刻/剩余秒数；计时器由前端按 extra.ends_at 实时刷新
        if pending.get("ends_at"):
            return _mmss(float(pending["ends_at"]) - time.time())
        if pending.get("when"):
            return str(pending["when"])
        return ""
    on = pending.get("state", control_state)
    if on is None:
        return ""
    return "已打开" if on else "已关闭"


def make_card(kind: str, title: str, subtitle: str = "", icon: str = "sparkle",
              theme: Optional[str] = None, image: Optional[str] = None,
              control: Optional[str] = None, toggle: Optional[dict] = None,
              slider: Optional[dict] = None, segments: Optional[dict] = None,
              extra: Optional[dict] = None) -> dict:
    """组装卡片数据（前端渲染用的最终形态）。"""
    spec = CARD_SPECS.get(kind) or {}
    card = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "theme": THEMES.get(theme or spec.get("theme") or kind),
        "title": title,
        "subtitle": subtitle,
        "icon": icon,
        "control": control,
    }
    if image:
        card["image"] = image
    if toggle:
        card["toggle"] = toggle
    if slider:
        card["slider"] = slider
    if segments:
        card["segments"] = segments
    if extra:
        card["extra"] = extra
    return card


def _clean_details(details: Optional[list]) -> Optional[list]:
    """明细项：[{label, value}]，最多 6 条（天气卡用）。"""
    if not details:
        return None
    out = []
    for item in details:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()[:8]
        value = str(item.get("value") or "").strip()[:32]
        if label and value:
            out.append({"label": label, "value": value})
    return out[:6] or None


# 标题只能是「项目本身」，不能带动作：模型偶尔写成「创建 报告.docx」，这里兜底去掉
_ACTION_PREFIXES = (
    "创建", "新建", "删除", "移除", "打开", "关闭", "移动", "复制", "重命名", "改名",
    "保存", "写入", "修改", "编辑", "设置", "调节", "切换", "添加", "发送", "下载",
    "上传", "安装", "卸载", "启动", "停用", "查询", "查找", "搜索", "整理", "清理",
)


def strip_action_prefix(title: str) -> str:
    """去掉标题开头的动词（如「创建 报告.docx」→「报告.docx」）。"""
    text = (title or "").strip()
    for verb in _ACTION_PREFIXES:
        if text.startswith(verb):
            rest = text[len(verb):]
            if rest[:1] in (" ", "·", "：", ":"):
                cleaned = rest[1:].strip()
                if cleaned:
                    return cleaned
            break
    return text


def clean_subject(title: str) -> str:
    """标题只留「项目本身」：去路径前缀、去「……的状态」这类后缀。"""
    text = (title or "").strip()
    slash = max(text.rfind("\\"), text.rfind("/"))
    if slash >= 0:
        tail = text[slash + 1:].strip()
        if tail:
            text = tail
    for _ in range(3):
        before = text
        for suf in ("的状态", "的情况"):
            if text.endswith(suf) and len(text) > len(suf):
                text = text[: -len(suf)].strip(" 的：:·")
                break
        if text == before:
            break
    return text.strip()


def build_card(kind: str, pending: Optional[dict] = None, content: Optional[dict] = None,
               control_state: Any = None, details: Optional[list] = None,
               icon_override: str = "") -> Optional[dict]:
    """按规格组装卡片：标题/图标/配色/操控项来自规格，内容与状态来自工具或模型。

    pending: 刚才那个工具声明的卡片数据（ToolResult.card），形如
             {"kind": "wifi", "state": True} / {"kind": "timer", "key": "timer:xx", "ends_at": ...}
    content: 模型填的内容（仅内容类卡片用得上：文件名、天气文字、网址…）
    control_state: 后端自己读到的状态（工具没给时用它补上，保证开关一定在）
    """
    spec = CARD_SPECS.get(kind)
    if not spec:
        return None                      # 没设计过的类型：不发卡片（不存在"通用卡片"）
    pending = pending or {}
    content = content or {}

    if spec.get("title_from") == "content":
        # 内容以**工具**为准（文件名/路径是它亲眼看到的），模型填的只在工具没给时兜底
        title = clean_subject(str(pending.get("title") or content.get("title") or ""))
    else:
        title = spec["title"]
    title = strip_action_prefix(title)[:60]
    if not title:
        return None

    if spec.get("subtitle") == "content":
        subtitle = str(pending.get("subtitle") or content.get("subtitle") or "").strip()[:120]
    else:
        subtitle = _state_subtitle(spec, pending, control_state)

    toggle = slider = segments = None
    control = spec.get("control")
    extra: Dict[str, Any] = {}
    if control == SWITCH:
        state = pending.get("state", control_state)
        if state is not None:
            toggle = {"key": bound_switch_key(kind, str(pending.get("key") or "")),
                      "on": bool(state)}
    elif control == SLIDER:
        value = pending.get("value", control_state)
        if value is not None:
            slider = {"key": bound_switch_key(kind, str(pending.get("key") or "")),
                      "value": int(value), "min": int(spec.get("min", 0)),
                      "max": int(spec.get("max", 100)), "unit": spec.get("unit", "")}
    elif control == SEGMENTS:
        value = pending.get("value", control_state) or spec.get("default")
        if value:
            segments = {"key": bound_switch_key(kind, str(pending.get("key") or "")),
                        "value": str(value), "options": list(spec.get("options") or [])}

    # 计时器要能实时走：把截止时刻给前端（extra.ends_at，秒）
    if kind == "timer" and pending.get("ends_at"):
        extra["ends_at"] = float(pending["ends_at"])
    if kind == "alarm" and pending.get("when"):
        extra["when"] = str(pending["when"])

    icon = icon_override if (icon_override and icon_override in ICONS
                             and spec.get("title_from") == "content") else spec["icon"]
    if kind == "weather" and icon_override in ICONS:
        icon = icon_override            # 天气图标由模型在天气图标集里挑（见 DonyAG.txt）

    cleaned = _clean_details(details or content.get("details"))
    if cleaned:
        extra["details"] = cleaned

    return make_card(kind, title, subtitle, icon, spec.get("theme"),
                     image=content.get("image"), control=control,
                     toggle=toggle, slider=slider, segments=segments,
                     extra=extra or None)
