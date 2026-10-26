"""MCP 诊断：按当前配置拉起服务器，列出工具，或直接调用一个工具看原始返回。

用法：
  .venv\\Scripts\\python.exe backend\\agent\\_mcp_check.py
  .venv\\Scripts\\python.exe backend\\agent\\_mcp_check.py mcp__everything__get-sum "{\"a\":12,\"b\":30}"
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import mcp  # noqa: E402
from agent.tools.base import REGISTRY  # noqa: E402


async def main():
    n = await mcp.start_all()
    print(f"[check] 已连接 {n} 个服务器")
    names = sorted(k for k in REGISTRY if k.startswith("mcp__"))
    if len(sys.argv) < 2:
        for name in names:
            print("  -", name)
        await mcp.stop_all()
        return
    tool_name = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    if tool_name not in REGISTRY:
        print(f"[check] 没有这个工具：{tool_name}\n可用：{names}")
        await mcp.stop_all()
        return
    result = await REGISTRY[tool_name].handler(args, None)
    print(f"[check] ok={result.ok} args={args}")
    print("[check] 原始返回：", result.text)
    await mcp.stop_all()


if __name__ == "__main__":
    asyncio.run(main())
