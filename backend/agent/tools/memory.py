"""长期记忆工具：记住 / 忘记。存于 %APPDATA%\\Dony\\memory.json，见 agent/memory.py。"""
from typing import Any, Dict

from .. import memory
from .base import ToolResult, tool


@tool("remember", "记住信息",
      "把值得长期记住的信息记下来（跨对话保留）：你的地区、称呼、常用偏好、这台电脑的稳定情况等。\n"
      "只在信息稳定、以后还用得上时才记；临时内容、密码、聊天内容、一次性的任务细节不要记。\n"
      "同 key 会覆盖旧值（地区变了就再用同一个 key 记一次）。不确定的信息（比如地区）先问用户再记。",
      {"text": {"type": "string", "description": "要记住的内容，尽量短", "required": True},
       "key": {"type": "string",
               "description": "这条记忆的标签（如「地区」「称呼」「显示器」），便于日后更新或删除"}})
async def remember_tool(args: Dict[str, Any], ctx) -> ToolResult:
    result = memory.remember(str(args.get("text") or ""), str(args.get("key") or ""))
    if not result.get("ok"):
        return ToolResult(f"没能记住：{result.get('reason')}", ok=False)
    action = "更新" if result.get("replaced") else "记下"
    label = f"「{result['key']}」" if result.get("key") else ""
    return ToolResult(f"已{action}{label}：{args.get('text')}"
                      f"（当前共 {result['count']} 条记忆）")


@tool("forget", "忘记信息",
      "删除一条记错或已经过时的记忆。key 与 text 至少给一个：按 key 精确匹配，或按内容包含匹配。",
      {"key": {"type": "string", "description": "要删除的记忆标签"},
       "text": {"type": "string", "description": "要删除的记忆内容（包含即可）"}})
async def forget_tool(args: Dict[str, Any], ctx) -> ToolResult:
    result = memory.forget(str(args.get("key") or ""), str(args.get("text") or ""))
    if not result.get("ok"):
        return ToolResult(f"没能删除：{result.get('reason')}", ok=False)
    return ToolResult("已忘记：" + "；".join(result["removed"][:3])
                      + f"（当前共 {result['count']} 条记忆）")
