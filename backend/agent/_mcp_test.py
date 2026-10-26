"""MCP 客户端自测：用一个本地假服务器验证握手 / tools/list / tools/call 全链路。

用法：.venv\\Scripts\\python.exe backend\\agent\\_mcp_test.py
（假服务器 = 子进程里跑的按行 JSON-RPC 回声器，不经网络。）
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAKE_SERVER = r'''
import json, sys
# MCP 规范：stdio 一律 UTF-8（真实服务器即如此；假服务器也照做）
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    msg = json.loads(line)
    mid = msg.get("id")
    if msg.get("method") == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05",
               "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "0"}}}
    elif msg.get("method") == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
            "name": "echo", "description": "原样返回文字",
            "inputSchema": {"type": "object", "properties": {
                "text": {"type": "string"}}, "required": ["text"]}}]}}
    elif msg.get("method") == "tools/call":
        args = msg["params"]["arguments"]
        out = {"jsonrpc": "2.0", "id": mid, "result": {"content": [
            {"type": "text", "text": "回声：" + args.get("text", "")}], "isError": False}}
    else:
        continue
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


async def main():
    import tempfile
    from agent import config, mcp
    from agent.tools.base import REGISTRY

    fd, path = tempfile.mkstemp(suffix=".py")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(FAKE_SERVER)
    try:
        config.MCP_SERVERS = [{"name": "回声", "command": f'"{sys.executable}" "{path}"'}]
        n = await mcp.start_all()
        assert n == 1, f"应连上 1 个服务器，实际 {n}"
        tool = REGISTRY.get("mcp__回声__echo")
        assert tool is not None, "mcp__回声__echo 未注册"
        print("[test] 注册成功:", tool.name, "|", tool.label)
        assert tool.parameters["type"] == "object", "inputSchema 应原样透传"

        result = await tool.handler({"text": "你好"}, None)
        print("[test] 调用结果:", result.text, "| ok =", result.ok)
        assert result.ok and result.text == "回声：你好"

        await mcp.stop_all()
        assert "mcp__回声__echo" not in REGISTRY, "stop_all 后应注销工具"
        print("[test] 注销成功 —— 全链路通过")
    finally:
        os.unlink(path)


if __name__ == "__main__":
    asyncio.run(main())
