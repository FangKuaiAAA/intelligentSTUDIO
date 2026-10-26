"""Dony 应用设置存储：%APPDATA%\\Dony\\settings.json

管理 TTS 开关/音色、AI 可访问的文件路径。读写均为原子写入，
文件修改时间变化时自动重新加载，因此其它进程改动后无需重启即可生效。
"""
import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

APPDATA = os.environ.get("APPDATA") or os.path.expanduser("~")
DONY_DIR = os.path.join(APPDATA, "Dony")
SETTINGS_FILE = os.path.join(DONY_DIR, "settings.json")
HISTORY_DIR = os.path.join(DONY_DIR, "history")

# 可选 TTS 音色（edge-tts 中文音色；2026-10 实测晓辰/晓涵/晓梦/晓墨/晓睿/晓甄已被微软下线，移除）
TTS_VOICES: List[Dict[str, str]] = [
    {"id": "zh-CN-YunxiNeural", "name": "云希 · 男声 · 年轻活泼"},
    {"id": "zh-CN-YunjianNeural", "name": "云健 · 男声 · 沉稳有力"},
    {"id": "zh-CN-YunyangNeural", "name": "云扬 · 男声 · 新闻播报"},
    {"id": "zh-CN-YunxiaNeural", "name": "云夏 · 男声 · 少年感"},
    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓 · 女声 · 温暖"},
    {"id": "zh-CN-XiaoyiNeural", "name": "晓伊 · 女声 · 明朗"},
    {"id": "zh-CN-XiaoxuanNeural", "name": "晓萱 · 女声 · 亲和"},
    {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "晓北 · 女声 · 东北口音"},
    {"id": "zh-CN-shaanxi-XiaoniNeural", "name": "晓妮 · 女声 · 陕西口音"},
]

# 语速（edge-tts rate 参数）：语音服务的真实朗读与设置页的试听朗读共用这一个来源
TTS_RATE = os.getenv("TTS_RATE", "+15%")

# 音色试听朗读的固定测试句（设置页「试听朗读」用，后端给出默认值）
TTS_PREVIEW_TEXT = "天空的色彩随夕阳渐退，夜空如洗，透出繁星点点。"

DEFAULTS: Dict[str, Any] = {
    # tts_enabled 是总闸（voice_server 也读它）：两个开关任一开启即为 True
    "tts_enabled": True,
    # 始终朗读回答：打字模式也朗读（默认关，保持“只在语音模式朗读”的既有行为）
    "tts_always": False,
    # 仅在说话使用 Dony 时朗读回答（默认开 = 现在的行为）
    "tts_voice_only": True,
    "tts_voice": "zh-CN-YunxiNeural",
    # None = 默认范围（用户目录 + 非系统盘）；列表 = 仅这些目录
    "allowed_paths": None,
    # None = 不限制盘符；列表（如 ["C","D"]）= 默认范围内仅这些盘符可访问。
    # 系统盘不写死（用户分区可能变动），运行时动态检测。
    "allowed_drives": None,
    # 闹钟 / 计时器的响铃音频（绝对路径，mp3/wav）。留空 = 用内置默认铃声。
    # 这一项是留给「设置」应用改的：后端只负责读、并在到点时把它带给闹钟窗口。
    "ringtone_alarm": "",
    "ringtone_timer": "",
}

_lock = threading.RLock()
_cache: Optional[Dict[str, Any]] = None
_cache_mtime: float = 0.0


def ensure_dirs() -> None:
    for d in (DONY_DIR, HISTORY_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass


def _read_file() -> Dict[str, Any]:
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load(force: bool = False) -> Dict[str, Any]:
    """读取设置（带 mtime 缓存，外部改动可被察觉）。"""
    global _cache, _cache_mtime
    with _lock:
        try:
            mtime = os.path.getmtime(SETTINGS_FILE)
        except OSError:
            mtime = 0.0
        if force or _cache is None or mtime != _cache_mtime:
            merged = dict(DEFAULTS)
            merged.update(_read_file())
            _cache, _cache_mtime = merged, mtime
        return dict(_cache)


def save(patch: Dict[str, Any]) -> Dict[str, Any]:
    """合并写入设置（原子写入）。"""
    global _cache, _cache_mtime
    ensure_dirs()
    with _lock:
        data = dict(DEFAULTS)
        data.update(_read_file())
        data.update(patch or {})
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_FILE)
        try:
            _cache_mtime = os.path.getmtime(SETTINGS_FILE)
        except OSError:
            _cache_mtime = time.time()
        _cache = data
        return dict(data)


# ---- 便捷读取 ----
def tts_enabled() -> bool:
    return bool(load().get("tts_enabled", True))


def tts_always() -> bool:
    """始终朗读回答（打字模式也朗读）。"""
    return bool(load().get("tts_always", False))


def tts_voice_only() -> bool:
    """仅在说话使用 Dony 时朗读回答。"""
    return bool(load().get("tts_voice_only", True))


def tts_voice() -> str:
    v = str(load().get("tts_voice") or "").strip()
    return v or DEFAULTS["tts_voice"]


def allowed_paths() -> Optional[List[str]]:
    """返回自定义允许路径列表；None 表示使用默认范围（用户目录 + 非系统盘）。"""
    val = load().get("allowed_paths")
    if not val:
        return None
    if isinstance(val, str):
        val = [val]
    paths: List[str] = []
    for p in val:
        try:
            paths.append(os.path.normpath(os.path.expandvars(os.path.expanduser(str(p)))))
        except Exception:
            continue
    return paths or None


def allowed_drives() -> Optional[List[str]]:
    """返回允许访问的盘符列表（如 ["C","D"]）；None 表示不限制盘符。"""
    val = load().get("allowed_drives")
    if not val:
        return None
    if isinstance(val, str):
        val = [val]
    return [str(v).strip().rstrip(":\\/").upper() for v in val
            if str(v).strip().rstrip(":\\/")] or None


def set_allowed_paths(paths: Optional[List[str]]) -> Dict[str, Any]:
    return save({"allowed_paths": list(paths) if paths else None})


# ---- 闹钟/计时器铃声（给「设置」应用用的接口） ----
RINGTONE_KINDS = ("alarm", "timer")
# 内置默认铃声（渲染进程按这个相对路径播）
DEFAULT_RINGTONE = "/MUS.mp3"


def ringtone(kind: str) -> str:
    """到点时该播的音频：设置里的路径，没设就返回内置默认。"""
    if kind not in RINGTONE_KINDS:
        raise ValueError(f"没有这一类铃声：{kind}")
    path = str(load().get(f"ringtone_{kind}") or "").strip()
    return path or DEFAULT_RINGTONE


def set_ringtone(kind: str, path: str) -> Dict[str, Any]:
    """设置闹钟/计时器的铃声路径；空字符串 = 恢复内置默认。

    只接受 mp3/wav（其余格式渲染进程多半播不出来），并且**必须存在**才写入，
    免得设置应用填了个错路径、到点却哑巴。
    """
    if kind not in RINGTONE_KINDS:
        raise ValueError(f"没有这一类铃声：{kind}")
    path = (path or "").strip().strip('"')
    if not path:
        return save({f"ringtone_{kind}": ""})
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".mp3", ".wav", ".m4a", ".ogg"):
        raise ValueError("铃声只支持 mp3 / wav / m4a / ogg")
    if not os.path.isfile(path):
        raise ValueError(f"文件不存在：{path}")
    return save({f"ringtone_{kind}": path})
