"""通知智能配置：读写 .appx_config.json，按 mtime 热加载。

设置页只负责写文件，本模块每 2 秒检查一次修改时间，因此保存后无需重启服务。
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CONFIG_FILE = os.environ.get("APPX_CONFIG_FILE") or os.path.join(REPO_ROOT, ".appx_config.json")

# 本地模型：Qwen2.5-0.5B-Instruct INT4（onnxruntime-genai 目录结构）
MODEL_DIR = os.getenv(
    "NOTIFY_MODEL_DIR",
    os.path.join(
        REPO_ROOT, "models", "qwen2.5-0.5b-instruct-int4",
        "cpu_and_mobile", "cpu-int4-rtn-block-32",
    ),
)

# 重要性判定模型：bge-small-zh-v1.5 INT8 + 两类质心（约 24 MB）
CLASSIFIER_DIR = os.getenv(
    "NOTIFY_CLASSIFIER_DIR",
    os.path.join(REPO_ROOT, "models", "bge-small-zh-v1.5"),
)

# 摘要通知所属应用（与 Electron appId 一致；需在开始菜单注册同名快捷方式）
AUMID = os.getenv("NOTIFY_AUMID", "com.dony.intelligentstudio")

# 通知服务端口（Electron 与设置页都按这个地址访问）
PORT = int(os.getenv("NOTIFY_SERVICE_PORT", "8770"))

# 时间与阈值默认值（RTF 定义；测试可用环境变量覆盖）
WINDOW_SECONDS = float(os.getenv("NOTIFY_SUMMARY_WINDOW", "60"))
DEDUPE_SECONDS = float(os.getenv("NOTIFY_DEDUPE_SECONDS", "5"))
DEBOUNCE_SECONDS = float(os.getenv("NOTIFY_DEBOUNCE_SECONDS", "30"))
CLASSIFY_TIMEOUT = float(os.getenv("NOTIFY_CLASSIFY_TIMEOUT", "3"))
SUMMARY_TIMEOUT = float(os.getenv("NOTIFY_SUMMARY_TIMEOUT", "7"))
IDLE_UNLOAD_SECONDS = float(os.getenv("NOTIFY_IDLE_UNLOAD", "90"))
MAX_HOLD_SECONDS = float(os.getenv("NOTIFY_MAX_HOLD", "120"))
MAX_NEW_TOKENS = int(os.getenv("NOTIFY_MAX_TOKENS", "32"))
FOCUS_POLL_SECONDS = float(os.getenv("NOTIFY_FOCUS_POLL", "5"))
CONFIG_POLL_SECONDS = float(os.getenv("NOTIFY_CONFIG_POLL", "2"))
GROUP_IDLE_SECONDS = float(os.getenv("NOTIFY_GROUP_IDLE", "600"))


@dataclass(frozen=True)
class Settings:
    dnd_enabled: bool
    summary_enabled: bool
    threshold: int
    window_seconds: float
    debounce_seconds: float
    classify_timeout: float
    summary_timeout: float
    idle_unload: float
    max_hold: float
    aumid: str

    @property
    def any_enabled(self) -> bool:
        return self.dnd_enabled or self.summary_enabled


_cache: Optional[Settings] = None
_cache_mtime: float = -1.0


def _read_file() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _build(raw: dict) -> Settings:
    threshold = raw.get("NOTIFY_SUMMARY_THRESHOLD", 3)
    try:
        threshold = int(threshold)
    except (TypeError, ValueError):
        threshold = 3
    return Settings(
        dnd_enabled=bool(raw.get("SMART_DND_ENABLED", False)),
        summary_enabled=bool(raw.get("NOTIFY_SUMMARY_ENABLED", False)),
        threshold=max(2, min(99, threshold)),
        window_seconds=WINDOW_SECONDS,
        debounce_seconds=DEBOUNCE_SECONDS,
        classify_timeout=CLASSIFY_TIMEOUT,
        summary_timeout=SUMMARY_TIMEOUT,
        idle_unload=IDLE_UNLOAD_SECONDS,
        max_hold=MAX_HOLD_SECONDS,
        aumid=AUMID,
    )


def load(force: bool = False) -> Settings:
    """读取设置；文件未变化时返回缓存，避免每次通知都读盘。"""
    global _cache, _cache_mtime
    try:
        mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        mtime = 0.0
    if force or _cache is None or mtime != _cache_mtime:
        _cache = _build(_read_file())
        _cache_mtime = mtime
    return _cache


def model_files_ready(model_dir: str = MODEL_DIR) -> dict:
    """检查摘要模型目录是否完整；返回每一项的存在情况，供设置页显示原因。"""
    required = ["genai_config.json", "model.onnx", "tokenizer.json"]
    info = {name: os.path.isfile(os.path.join(model_dir, name)) for name in required}
    info["model.onnx.data"] = os.path.isfile(os.path.join(model_dir, "model.onnx.data"))
    info["dir"] = model_dir
    info["ready"] = all(info[name] for name in required)
    return info


def classifier_files_ready(model_dir: str = CLASSIFIER_DIR) -> dict:
    """检查分类模型目录：ONNX 图、外置权重、分词器、质心文件。"""
    required = [
        os.path.join("onnx", "model_quantized.onnx"),
        os.path.join("onnx", "model_quantized.onnx_data"),
        "tokenizer.json",
        "classifier.json",
    ]
    info = {name: os.path.isfile(os.path.join(model_dir, name)) for name in required}
    info["dir"] = model_dir
    info["ready"] = all(info.values())
    return info
