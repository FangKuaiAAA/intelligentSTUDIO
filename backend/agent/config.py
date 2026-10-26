"""Dony Agent 配置加载：环境变量 > .appx_config.json > 默认值。"""
import json
import os
from typing import Any, Dict

_CONFIG_FILE = os.environ.get("APPX_CONFIG_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".appx_config.json")


def _load_config_file() -> dict:
    for path in (
        _CONFIG_FILE,
        os.path.join(os.environ.get("TEMP", os.environ.get("TMP", "/tmp")), "appx_config.json"),
    ):
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return {}


_cfg = _load_config_file()

# 主对话模型（需支持 Function Calling）
# ⚠ 用 `or` 而不是 getenv 的默认值：环境变量被设成空字符串时（CI / 某些启动器很常见），
#   getenv 会返回 ""，于是 Key 与地址被清空、请求必然 401 —— 这里空值一律回落到配置文件。
API_KEY = os.getenv("OPENAI_API_KEY") or _cfg.get("OPENAI_API_KEY") or ""
API_BASE = os.getenv("OPENAI_API_BASE") or _cfg.get("OPENAI_API_BASE") or "https://api.deepseek.com"
MODEL = os.getenv("OPENAI_MODEL") or _cfg.get("OPENAI_MODEL") or "deepseek-v4-flash"

# 视觉理解不再单独配模型：截图直接作为图片塞进主对话，由主模型自己看
# （要求主模型支持 image_url；实测 deepseek-v4-flash 可以）。

# TTS 开关（运行期可被 Dony 应用改写，见 store.py；环境变量优先级最高）
_TTS_ENV = os.getenv("TTS_ENABLED")


def tts_enabled() -> bool:
    """TTS 开关：环境变量 > Dony 应用设置 > 配置文件默认。"""
    if _TTS_ENV is not None:
        return _TTS_ENV.lower() not in ("false", "0", "no")
    from . import store
    return store.tts_enabled()


def tts_voice() -> str:
    """TTS 音色：环境变量 > Dony 应用设置。"""
    env = os.getenv("TTS_VOICE")
    if env:
        return env
    from . import store
    return store.tts_voice()


def tts_always() -> bool:
    """始终朗读回答（打字模式也朗读）。"""
    from . import store
    return store.tts_always()


def tts_voice_only() -> bool:
    """仅在说话使用 Dony 时朗读回答。"""
    from . import store
    return store.tts_voice_only()


# 兼容旧引用（import 时的快照；新增代码请用 tts_enabled()/tts_voice()）
TTS_ENABLED = tts_enabled()
TTS_VOICE = tts_voice()

# 思考强度：DeepSeek 接口只接受 enabled/disabled（实测 thinking.type=low 直接 422，
# budget_tokens 被忽略），所以“调低”这一档实际等价于关掉思考。
#   AGENT_THINKING  主模型（agent 循环）
# 想恢复默认思考行为：把环境变量设为 auto。
THINKING = os.getenv("AGENT_THINKING", "disabled").strip().lower()


def thinking_payload() -> Dict[str, Any]:
    """给请求体加上 thinking 字段；auto 时不加（用服务端默认）。"""
    if THINKING in ("", "auto", "default"):
        return {}
    return {"thinking": {"type": THINKING}}


# 主对话历史里最多保留几张截图：截图现在直接进主对话（很吃 token），
# 超出部分会被替换成一行占位文字，需要时模型会重新截图。
MAX_HISTORY_IMAGES = int(os.getenv("AGENT_MAX_HISTORY_IMAGES", "2"))

# 快速模式最大模型请求数
FAST_MAX_REQUESTS = int(os.getenv("AGENT_FAST_MAX_REQUESTS", _cfg.get("AGENT_FAST_MAX_REQUESTS", 5)))
# 任务模式安全上限
TASK_MAX_REQUESTS = int(os.getenv("AGENT_TASK_MAX_REQUESTS", _cfg.get("AGENT_TASK_MAX_REQUESTS", 40)))
# 快速模式 UIA / 截屏次数限制
FAST_MAX_UIA = 2
FAST_MAX_SCREENSHOT = 1

# 任务模式采用 ReAct（边思考边行动，计划可随时修订，模型的想法会显示在处理药丸上）。
# 设为 0 可退回原来的「先规划、再照计划执行」。环境变量：AGENT_TASK_REACT=0
TASK_REACT = os.getenv("AGENT_TASK_REACT", "1").lower() not in ("0", "false", "no")

# 文件访问范围：Dony 应用可改写（store.py），未设置时用默认规则（用户目录 + 非 C 盘）
USER_HOME = os.path.expanduser("~")
_allowed = _cfg.get("AGENT_ALLOWED_PATHS")
_ENV_ALLOWED = [os.path.normpath(p) for p in _allowed] if _allowed else None


def allowed_paths():
    """自定义允许路径列表；None = 默认规则（用户目录 + 非系统盘）。"""
    if _ENV_ALLOWED is not None:
        return _ENV_ALLOWED
    from . import store
    return store.allowed_paths()


def allowed_drives():
    """允许访问的盘符列表（如 ["C","D"]）；None = 不限制盘符（默认规则内非系统盘全放行）。"""
    from . import store
    return store.allowed_drives()


# 兼容旧引用（import 时的快照；新增代码请用 allowed_paths()）
ALLOWED_PATHS = _ENV_ALLOWED

# Edge 扩展本地 API（由 backend/edge_bridge.py 提供；工具 edge_browser 按此地址调用）
EDGE_API_BASE = os.getenv("EDGE_API_BASE", _cfg.get("EDGE_API_BASE", "http://127.0.0.1:8768"))
# Edge 扩展桥接服务端口（HTTP + WebSocket 同一端口；改这里要保证与 EDGE_API_BASE 一致）
EDGE_BRIDGE_PORT = int(os.getenv("EDGE_BRIDGE_PORT", _cfg.get("EDGE_BRIDGE_PORT", 8768)))

# Edge 扩展浮窗里的视觉智能所用模型（由桥接服务代理请求，扩展不持有密钥）。
# 默认与全局视觉智能的模型名保持一致；若当前 Key 上没有这个模型，桥接服务会自动
# 回退到主对话模型 MODEL 再试一次。
# ⚠ 用 `or` 而不是默认值参数：设置页写过 null / 空串时（键存在但值为空），
#   get(…, 默认值) 会取到 None，请求体里就成了 "model": null，服务端直接 422。
VISION_MODEL = os.getenv("OPENAI_VISION_MODEL") or _cfg.get("OPENAI_VISION_MODEL") or MODEL

# MCP 服务器配置（预留设置接口）
MCP_SERVERS = _cfg.get("MCP_SERVERS", [])
# Skill 安装目录（「STUDIO设置」页可改，写入 AGENT_SKILLS_DIR）
# normpath：默认值由 ".." 拼出来，规范化后设置页与日志里显示的都是干净的绝对路径
SKILLS_DIR = os.path.normpath(os.getenv("AGENT_SKILLS_DIR", _cfg.get("AGENT_SKILLS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills"))))

AGENT_WS_PORT = int(os.getenv("AGENT_WS_PORT", _cfg.get("AGENT_WS_PORT", 8767)))

# ================= 书写辅助（选中文字改写） =================
# 三道触发门槛：总开关、最小选中字数、目标控件最小高度。
# 「控件高度」这一条专门用来排除文件名框、地址栏、搜索框这类小文本框：
# 它们是单行小控件（实测高 24~40px），而正文区域（Document / 多行 Edit）通常高于 64px。
WRITING_ENABLED = os.getenv("WRITING_ENABLED", "1").lower() not in ("0", "false", "no")
WRITING_MIN_CHARS = int(os.getenv("WRITING_MIN_CHARS", _cfg.get("WRITING_MIN_CHARS", 20)))
WRITING_MIN_CTRL_HEIGHT = int(os.getenv("WRITING_MIN_CTRL_HEIGHT", _cfg.get("WRITING_MIN_CTRL_HEIGHT", 64)))
# 左键抬起后先等一会儿再查 UIA：Chromium 系刷新选区与 UIA 树有 1 帧到 100ms 的延迟，
# 立刻查会读到上一次的选区（表现就是"标签显示的是上回选的那段"）。
WRITING_QUERY_DELAY_MS = int(os.getenv("WRITING_QUERY_DELAY_MS", _cfg.get("WRITING_QUERY_DELAY_MS", 90)))
# 首次查询没拿到选区时的重试次数（每次间隔同样用上面的延迟）
WRITING_QUERY_RETRIES = int(os.getenv("WRITING_QUERY_RETRIES", _cfg.get("WRITING_QUERY_RETRIES", 2)))
def writing_double_ctrl() -> bool:
    """双击 Ctrl 打开书写工具（可在设置应用中关闭）。

    与其它运行期设置一致：环境变量优先，其次配置文件（.appx_config.json）。
    """
    env = os.getenv("WRITING_DOUBLE_CTRL")
    if env is not None:
        return env.lower() not in ("0", "false", "no")
    return bool(_cfg.get("WRITING_DOUBLE_CTRL", True))


# 改写用的温度：要稳、不要发散，所以比对话低
WRITING_TEMPERATURE = float(os.getenv("WRITING_TEMPERATURE", _cfg.get("WRITING_TEMPERATURE", 0.3)))
# 单次改写的最长等待（秒）
WRITING_TIMEOUT = float(os.getenv("WRITING_TIMEOUT", _cfg.get("WRITING_TIMEOUT", 120)))

# ================= Office 加载项本地桥 =================
# 任务窗格与接口同源（见 backend/office_bridge.py）；清单里的 URL 必须与本端口一致。
# ⚠ 8769 归 dony_app_api.py（Dony 应用本机 API），不能占用；8770 亦被占用，故用 8771。
OFFICE_BRIDGE_PORT = int(os.getenv("OFFICE_BRIDGE_PORT", _cfg.get("OFFICE_BRIDGE_PORT", 8771)))
# 窗格静态资源目录（office 子包构建产物）
OFFICE_STATIC_DIR = os.getenv(
    "OFFICE_STATIC_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "office", "dist"),
)
# 图乐园可执行文件：留空则自动在 playground-app/bin 下按修改时间挑最新的
PLAYGROUND_EXE = os.getenv("PLAYGROUND_EXE", _cfg.get("PLAYGROUND_EXE", ""))
