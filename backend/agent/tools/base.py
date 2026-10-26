"""Dony 工具基类与注册表：schema 生成、按模式过滤、执行耗时日志。"""
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .. import cards


@dataclass
class ToolResult:
    """工具执行结果。

    text:   回给模型的文字说明。
    card:   可选，本次成果对应的**卡片声明**：{"kind": "wifi", "state": True}、
            {"kind": "timer", "key": "timer:xx", "ends_at": 1730000000.0}；
            内容类卡片则给 title/subtitle（文件名、路径、天气文字…）。
            只有工具知道真实状态与内部标识（alarm:{id}、task:{名称}），所以由工具声明；
            要不要把它做成卡片展示给用户，由模型决定（模型调 show_card(kind=...)）。
            卡片的标题/副标题写法/图标/配色/开关或滑块**全部由 cards.CARD_SPECS 决定**，
            模型改不了——这样就不会再出现"该有开关却没开关"。
    image_b64: 可选，一张 PNG 的 base64。工具消息本身不能带图（OpenAI 协议限制），
            所以 agent 循环会把它在工具消息之后作为一条 user 消息补进对话——
            模型于是“亲眼看到”这张图（截屏理解走的就是这条路）。
    """
    text: str
    card: Optional[dict] = None
    ok: bool = True
    image_b64: Optional[str] = None
    toggle: Optional[dict] = None       # 旧接口（仅开关类），仍可用；会被转成 card

    def to_model_content(self) -> str:
        return self.text if self.ok else f"操作失败：{self.text}"


# 老的卡片提示（「如要展示卡片：kind=…，title 建议…，需带开关」）已经作废：
# 卡片的外观全部由 cards.CARD_SPECS 决定，工具不必也不该再教模型怎么写标题。
# 这里统一把老的提示摘掉，再按工具声明的卡片补一句规范提示。
_CARD_HINT_RE = re.compile(r"（如要展示卡片：[^）]*）")

# toggle key 与卡片 kind 不同名时的对照（带标识的 key 形如 task:名称 / alarm:3f2a）
_TOGGLE_KIND_ALIASES = {"mobile_hotspot": "hotspot"}


def _card_from_toggle(toggle: Optional[dict]) -> Optional[dict]:
    """兼容老接口：工具只给了 toggle 描述时，推出卡片声明。

    滑块的卡片（音量/亮度）推不出来——它们必须由工具给出数值，所以这里直接跳过，
    交给工具自己声明 card（否则卡片会少一个滑块）。
    """
    key = str((toggle or {}).get("key") or "")
    if not key:
        return None
    kind = _TOGGLE_KIND_ALIASES.get(key.split(":", 1)[0], key.split(":", 1)[0])
    spec = cards.spec_for(kind)
    if not spec or spec.get("control") == cards.SLIDER:
        return None
    return {"kind": kind, "key": key, "state": bool(toggle.get("on"))}


def finalize_result(result: ToolResult) -> ToolResult:
    """统一收尾：确定卡片声明 + 规范提示文字。"""
    if not result.ok:
        return result
    card = result.card or _card_from_toggle(result.toggle)
    result.card = card
    text = _CARD_HINT_RE.sub("", result.text).strip()
    if card:
        text = f"{text}（如要展示卡片：kind={card['kind']}）"
    result.text = text
    return result


Handler = Callable[[Dict[str, Any], Any], Awaitable[ToolResult]]


@dataclass
class Tool:
    name: str
    label: str                      # 日常化且正式的中文名称（显示在任务模式药丸上）
    description: str
    parameters: dict                # JSON Schema (object)
    handler: Handler
    modes: tuple = ("fast", "task")  # fast=快速模式可用；task=仅任务模式
    sensitive: bool = False          # 敏感操作（执行前需用户确认，由 handler 内调用 ctx.confirm）


REGISTRY: Dict[str, Tool] = {}


def make_schema(parameters: Optional[dict] = None) -> dict:
    """把简写参数表（{名称: {type, description, required}}）转成标准 JSON Schema。

    模型 API 要求 function.parameters 必须是 type=object 的 JSON Schema，
    因此所有 Tool（含 llm.py 中直接构造的特殊工具）都必须经此转换，
    否则会因 "schema must be a JSON Schema of 'type: \"object\"'" 被 400 拒绝。
    """
    parameters = parameters or {}
    props = {k: {kk: vv for kk, vv in v.items() if kk != "required"}
             for k, v in parameters.items()}
    return {
        "type": "object",
        "properties": props,
        "required": [k for k, v in parameters.items() if v.get("required")],
    }


def tool(name: str, label: str, description: str, parameters: Optional[dict] = None,
         modes: tuple = ("fast", "task"), sensitive: bool = False):
    """注册工具装饰器。parameters 为简写参数表（properties 部分）。"""
    def deco(fn: Handler) -> Handler:
        REGISTRY[name] = Tool(
            name=name, label=label, description=description,
            parameters=make_schema(parameters),
            handler=fn, modes=modes, sensitive=sensitive,
        )
        return fn
    return deco


def get_tool_specs(mode: str, extra: Optional[List[Tool]] = None) -> List[dict]:
    """生成 OpenAI Function Calling tools 数组，按模式过滤。"""
    tools = [t for t in REGISTRY.values() if mode in t.modes]
    if extra:
        tools = tools + list(extra)
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in tools
    ]


async def run_tool(t: Tool, args: Dict[str, Any], ctx: Any) -> ToolResult:
    """执行工具并记录耗时（不记录参数内容，避免泄露敏感数据）。"""
    start = time.time()
    try:
        result = await t.handler(args, ctx)
    except Exception as e:
        result = ToolResult(text=f"{type(e).__name__}: {e}", ok=False)
    if not isinstance(result, ToolResult):
        # 兜底：工具忘了包 ToolResult（返回裸字符串之类）不该让整轮直接崩掉，
        # 之前就是这样报出「'str' object has no attribute 'ok'」把任务打断的。
        result = ToolResult(
            text=f"工具 {t.name} 的返回值异常（{type(result).__name__}）：{str(result)[:200]}",
            ok=False)
    result = finalize_result(result)
    ms = int((time.time() - start) * 1000)
    # 只记录参数名与失败原因（不记录参数内容，避免泄露敏感数据）
    keys = ",".join(sorted(args.keys()))
    print(f"[agent] tool {t.name} {'ok' if result.ok else 'fail'} {ms}ms args=[{keys}]"
          + ("" if result.ok else f" err={result.text[:150]}"), flush=True)
    return result
