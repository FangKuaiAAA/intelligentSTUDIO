"""极简 MCP（Model Context Protocol）stdio 客户端：把外部工具服务器接入 Dony。

不引第三方 MCP SDK：协议是 stdio 上按行分隔的 JSON-RPC 2.0。
启动流程：spawn → initialize 握手 → notifications/initialized → tools/list，
把每个远端工具以 mcp__<服务器名>__<工具名> 注册进 tools.base.REGISTRY ——
复用现有的模式过滤、耗时日志、卡片机制，模型侧无需任何改动。
调用即 tools/call；结果取 content 里的 text 部分（PNG 图片走 ToolResult.image_b64）。

配置来源：.appx_config.json 的 MCP_SERVERS（由「STUDIO设置」页写入）：
  [{"name": "天气", "command": "npx -y xx-server"}]
服务器在 agent_server 启动时拉起、退出时收掉；改配置后需重启 Dony 生效。
"""
import asyncio
import json
from typing import Any, Dict, List, Optional

from . import config
from .tools.base import REGISTRY, Tool, ToolResult

INIT_TIMEOUT = 60.0     # 握手（npx 首次会下载包，给足时间）
CALL_TIMEOUT = 120.0    # 单次工具调用
MAX_TEXT = 12000        # 回给模型的文字上限（防超长输出撑爆上下文）

_servers: List["McpServer"] = []


def _tool_id(server_name: str, tool_name: str) -> str:
    return f"mcp__{server_name}__{tool_name}"


def _content_to_result(res: Dict[str, Any]) -> ToolResult:
    """MCP tools/call 结果 → ToolResult：text 部分拼接，首张 PNG 图走 image_b64。"""
    parts = res.get("content") or []
    texts: List[str] = []
    image_b64: Optional[str] = None
    for p in parts:
        if not isinstance(p, dict):
            continue
        if p.get("type") == "text":
            texts.append(str(p.get("text") or ""))
        elif p.get("type") == "image" and image_b64 is None:
            # ToolResult.image_b64 只接受 PNG（agent 循环按 PNG 补进对话）
            if str(p.get("mimeType") or "") == "image/png" and p.get("data"):
                image_b64 = str(p["data"])
    text = "\n".join(x for x in texts if x).strip()[:MAX_TEXT]
    ok = not bool(res.get("isError"))
    if not text:
        text = "执行成功（见下方图片）" if image_b64 else "（MCP 服务器没有返回文字内容）"
    return ToolResult(text=text, ok=ok, image_b64=image_b64)


class McpServer:
    """一个 MCP stdio 服务器子进程。"""

    def __init__(self, name: str, command: str):
        self.name = name
        self.command = command
        self.proc: Optional[asyncio.subprocess.Process] = None
        self._id = 0
        self._lock = asyncio.Lock()      # 串行化请求：读 stdout 是按行应答式，并发会串包
        self.tools: List[dict] = []

    # ---- JSON-RPC 基础 ----

    def _write(self, msg: dict) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n")

    async def _request(self, method: str, params: dict, timeout: float) -> Dict[str, Any]:
        self._id += 1
        rid = self._id
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        assert self.proc and self.proc.stdin and self.proc.stdout
        await self.proc.stdin.drain()
        while True:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
            if not raw:
                raise ConnectionError("MCP 服务器已退出")
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue    # 服务器偶尔打印的非 JSON 行
            if msg.get("id") == rid:
                if "error" in msg:
                    err = msg["error"] or {}
                    raise RuntimeError(str(err.get("message") or err))
                return msg.get("result") or {}
            # 服务器主动发来的请求（ping 等）：回 method-not-found，不让它干等
            if msg.get("method") and msg.get("id") is not None:
                self._write({"jsonrpc": "2.0", "id": msg["id"],
                             "error": {"code": -32601, "message": "Method not found"}})

    def _notify(self, method: str) -> None:
        self._write({"jsonrpc": "2.0", "method": method})

    # ---- 生命周期 ----

    async def start(self) -> bool:
        try:
            # Windows 上 npx/node 等命令需要 shell 解析（命令是用户在设置页填的整串）
            self.proc = await asyncio.create_subprocess_shell(
                self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
        except Exception as e:
            print(f"[mcp] {self.name}: 启动失败（{type(e).__name__}: {e}）", flush=True)
            return False
        try:
            await self._request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "dony-agent", "version": "1.0"},
            }, INIT_TIMEOUT)
            self._notify("notifications/initialized")
            res = await self._request("tools/list", {}, INIT_TIMEOUT)
            self.tools = [t for t in (res.get("tools") or []) if isinstance(t, dict)]
            return True
        except Exception as e:
            print(f"[mcp] {self.name}: 握手失败（{type(e).__name__}: {e}）", flush=True)
            await self.stop()
            return False

    async def call(self, tool_name: str, args: Dict[str, Any]) -> ToolResult:
        async with self._lock:
            if not self.proc or self.proc.returncode is not None:
                return ToolResult(f"MCP 服务器「{self.name}」已退出，请重启 Dony 后重试。", ok=False)
            try:
                res = await self._request(
                    "tools/call", {"name": tool_name, "arguments": args}, CALL_TIMEOUT)
            except Exception as e:
                return ToolResult(f"MCP 调用失败：{type(e).__name__}: {e}", ok=False)
        return _content_to_result(res)

    async def stop(self) -> None:
        proc, self.proc = self.proc, None
        if not proc:
            return
        # 先关 stdin 让服务器自己退；不退再 kill。最后必须 wait()，
        # 否则 asyncio 在事件循环关闭时才回收管道，退出日志里会刷一屏
        # "Event loop is closed / unclosed transport" 的无害噪音。
        try:
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), 2)
            return
        except Exception:
            pass
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except Exception:
            pass


def _make_handler(server: McpServer, tool_name: str):
    async def handler(args: Dict[str, Any], ctx) -> ToolResult:
        return await server.call(tool_name, dict(args or {}))
    return handler


def _register(server: McpServer) -> int:
    """把该服务器的工具注册进 REGISTRY；返回注册数。"""
    count = 0
    for t in server.tools:
        tname = str(t.get("name") or "").strip()
        if not tname:
            continue
        full = _tool_id(server.name, tname)
        desc = str(t.get("description") or "").strip() or "（服务器未提供描述）"
        schema = t.get("inputSchema")
        if not isinstance(schema, dict) or schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        REGISTRY[full] = Tool(
            name=full,
            label=f"{server.name}·{tname}",
            description=f"[MCP:{server.name}] {desc}",
            parameters=schema,
            handler=_make_handler(server, tname),
            modes=("fast", "task"),
        )
        count += 1
    return count


async def start_all() -> int:
    """按配置拉起全部 MCP 服务器并注册工具。单个失败只记日志，不影响其它服务器与主服务。"""
    entries = config.MCP_SERVERS or []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        command = str(entry.get("command") or "").strip()
        args = entry.get("args")   # 前向兼容：{"command": "npx", "args": ["-y", "xx"]}
        if isinstance(args, (list, tuple)):
            command = " ".join([command] + [str(a) for a in args]).strip()
        if not name or not command:
            print(f"[mcp] 跳过无效配置项（name/command 为空）：{entry}", flush=True)
            continue
        if any(s.name == name for s in _servers):
            continue
        server = McpServer(name, command)
        if await server.start():
            n = _register(server)
            _servers.append(server)
            print(f"[mcp] {name}: 已连接，注册 {n} 个工具", flush=True)
    return len(_servers)


async def stop_all() -> None:
    global _servers
    for s in _servers:
        for t in s.tools:
            REGISTRY.pop(_tool_id(s.name, str(t.get("name") or "")), None)
        await s.stop()
    _servers = []
