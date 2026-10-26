"""Dony 应用（WinUI3）后端接口：历史会话、续聊（SSE 流式）、TTS 设置、可访问路径。

仅服务本机 Dony 应用，监听 127.0.0.1:8769。
运行：.venv\\Scripts\\python.exe backend\\dony_app_api.py
"""
import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response, StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from agent import config, history, store  # noqa: E402
from agent.app_chat import run_turn  # noqa: E402
from agent.tools.files import known_user_folders, list_drives, system_drive  # noqa: E402

PORT = int(os.getenv("DONY_APP_API_PORT", "8769"))

app = FastAPI(title="Dony App API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


class ChatBody(BaseModel):
    text: str
    voice: bool = False


class AskAnswer(BaseModel):
    """对 ask（敏感操作确认 / 模型反问）的答复：确认用 approved，反问用 text。"""
    text: Optional[str] = None
    approved: Optional[bool] = None


class SettingsPatch(BaseModel):
    tts_enabled: Optional[bool] = None
    tts_always: Optional[bool] = None          # 始终朗读回答（打字模式也朗读）
    tts_voice_only: Optional[bool] = None      # 仅在说话使用 Dony 时朗读回答
    tts_voice: Optional[str] = None
    allowed_paths: Optional[List[str]] = None
    use_default_paths: Optional[bool] = None
    allowed_drives: Optional[List[str]] = None       # None = 不限制；[] 视为 None
    use_default_drives: Optional[bool] = None


class TtsPreviewBody(BaseModel):
    """试听朗读：voice 不传则用当前设置的音色，text 不传则用固定的测试句。"""
    voice: Optional[str] = None
    text: Optional[str] = None


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "model": config.MODEL,
        "tts_enabled": config.tts_enabled(),
        "tts_voice": config.tts_voice(),
    }


# ---------- Skill 与 MCP（「STUDIO设置」页读取；Dony 应用也可用作能力自省） ----------

@app.get("/api/skills")
async def api_skills():
    """列出 SKILLS_DIR 里已发现的技能（每次重扫目录，新放进的不用重启就能看到）。"""
    from agent.tools import skills as skills_mod
    return {"skills_dir": config.SKILLS_DIR, "skills": skills_mod.list_skills()}


@app.get("/api/mcp")
async def api_mcp():
    """当前配置的 MCP 服务器清单（启动时加载；运行态是否连通看 agent-server 日志）。"""
    servers = [s for s in (config.MCP_SERVERS or []) if isinstance(s, dict)]
    return {"servers": [{"name": s.get("name") or "", "command": s.get("command") or ""}
                        for s in servers]}


@app.post("/api/settings/reload")
async def api_settings_reload():
    """设置页保存后调用（SettingsStore.NotifyBackendAsync）。
    TTS/允许路径走 store 热读取、无需重启；MCP 服务器与 Skill 目录在进程启动时加载，
    需重启 Dony 生效 —— 如实告知，不假装已生效。"""
    return {"ok": True,
            "note": "已保存。TTS 与可访问路径即时生效；MCP 服务器与 Skill 目录改动需重启 Dony 生效。"}


# 续聊也走 AgentLoop（同一个工具注册表）：MCP 工具在本进程同样拉起一份，
# 保证「浮层 Dony」与「Dony 应用」能力一致。代价是每个 MCP 服务器会有两个子进程。
@app.on_event("startup")
async def _startup_mcp():
    from agent import mcp
    await mcp.start_all()


@app.on_event("shutdown")
async def _shutdown_mcp():
    from agent import mcp
    await mcp.stop_all()


# ---------- 历史会话 ----------
@app.get("/api/history/sessions")
async def list_sessions(limit: int = 300):
    return {"sessions": history.list_sessions(limit)}


@app.get("/api/history/sessions/{sid}")
async def get_session(sid: str):
    session = history.get_session(sid)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@app.patch("/api/history/sessions/{sid}")
async def rename_session(sid: str, body: Dict[str, Any]):
    title = str((body or {}).get("title") or "")
    if not title.strip():
        raise HTTPException(status_code=400, detail="标题不能为空")
    if not history.rename_session(sid, title):
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"ok": True}


@app.delete("/api/history/sessions")
async def delete_all_sessions():
    """清空全部历史会话（设置应用「清空 Dony 对话记录」）。"""
    return {"ok": True, "removed": history.delete_all_sessions()}


@app.delete("/api/history/sessions/{sid}")
async def delete_session(sid: str):
    if not history.delete_session(sid):
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"ok": True}


@app.post("/api/history/sessions/{sid}/chat")
async def chat(sid: str, body: ChatBody):
    """在历史会话中继续对话，SSE 流式返回。"""
    if not history.get_session(sid):
        raise HTTPException(status_code=404, detail="会话不存在")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="内容为空")

    async def stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(event: dict):
            await queue.put(event)

        async def worker():
            try:
                await run_turn(sid, text, emit)
            except Exception as e:
                await queue.put({"type": "error", "text": f"{type(e).__name__}: {e}"})
            finally:
                await queue.put(None)

        task = asyncio.create_task(worker())
        try:
            yield "retry: 1000\n\n"
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- 对话中的确认/反问答复 ----------
@app.post("/api/history/sessions/{sid}/ask/{ask_id}")
async def answer_ask(sid: str, ask_id: str, body: AskAnswer):
    """回填 ask（确认沿用 approved，反问用 text）。

    SSE 只能单向推送，所以确认结果走这个端点送回正在进行的那一轮对话。
    """
    from agent.app_chat import active_session

    session = active_session(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="该会话当前没有进行中的对话")
    payload = body.text if body.text is not None else bool(body.approved)
    session.resolve_ask(ask_id, payload)
    return {"ok": True}


# ---------- 设置：TTS ----------
@app.get("/api/settings")
async def get_settings():
    data = store.load()
    paths = store.allowed_paths()
    return {
        "tts_enabled": config.tts_enabled(),
        "tts_always": config.tts_always(),
        "tts_voice_only": config.tts_voice_only(),
        "tts_voice": config.tts_voice(),
        "tts_voices": store.TTS_VOICES,
        "tts_preview_text": store.TTS_PREVIEW_TEXT,
        "allowed_paths": paths or [],
        "use_default_paths": paths is None,
        "allowed_drives": config.allowed_drives() or [],
        "use_default_drives": config.allowed_drives() is None,
        "drives": list_drives(),
        "system_drive": system_drive()[:1],
        "user_home": config.USER_HOME,
        "user_folders": known_user_folders(),
        "settings_file": store.SETTINGS_FILE,
    }


@app.put("/api/settings")
async def update_settings(patch: SettingsPatch):
    update: Dict[str, Any] = {}
    if patch.tts_enabled is not None:
        update["tts_enabled"] = bool(patch.tts_enabled)
    if patch.tts_always is not None or patch.tts_voice_only is not None:
        # 两个朗读开关：任一开启即“有朗读”，据此同步总闸（voice_server 读的就是它）
        always = bool(patch.tts_always) if patch.tts_always is not None else config.tts_always()
        voice_only = (bool(patch.tts_voice_only) if patch.tts_voice_only is not None
                      else config.tts_voice_only())
        if patch.tts_always is not None:
            update["tts_always"] = always
        if patch.tts_voice_only is not None:
            update["tts_voice_only"] = voice_only
        update["tts_enabled"] = bool(always or voice_only)
    if patch.tts_voice is not None:
        voice = patch.tts_voice.strip()
        if not voice:
            raise HTTPException(status_code=400, detail="音色不能为空")
        update["tts_voice"] = voice
    if patch.use_default_paths:
        update["allowed_paths"] = None
    elif patch.allowed_paths is not None:
        cleaned: List[str] = []
        for p in patch.allowed_paths:
            p = str(p or "").strip()
            if not p:
                continue
            cleaned.append(os.path.normpath(os.path.expandvars(os.path.expanduser(p))))
        update["allowed_paths"] = cleaned or None
    if patch.use_default_drives:
        update["allowed_drives"] = None
    elif patch.allowed_drives is not None:
        drives = [str(d or "").strip().rstrip(":\\/").upper()
                  for d in patch.allowed_drives]
        drives = [d for d in drives if d] or None
        # 限制为不存在的盘符没有意义，仍接受（用户可能马上要插移动硬盘），只做去重
        update["allowed_drives"] = list(dict.fromkeys(drives)) if drives else None
    if update:
        store.save(update)
    return await get_settings()


# ---------- 试听朗读（音色调节） ----------
@app.post("/api/tts/preview")
async def tts_preview(body: TtsPreviewBody = TtsPreviewBody()):
    """用指定音色合成一段试听音频，直接把 mp3 字节返回给应用播放。

    只合成、不播放：播放设备在 Dony 应用侧（与全局唤醒的朗读同一思路），
    这样设置页能自己控制播放/停止，也不会和后端进程抢音频设备。
    语速取自 store.TTS_RATE，与真实朗读完全一致（听感即所得）。
    """
    voice = (body.voice or "").strip() or config.tts_voice()
    text = (body.text or "").strip() or store.TTS_PREVIEW_TEXT
    try:
        import edge_tts
    except ImportError:
        raise HTTPException(status_code=500, detail="edge-tts 未安装，无法合成朗读音频")

    audio = bytearray()
    try:
        communicate = edge_tts.Communicate(text, voice, rate=store.TTS_RATE)
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                audio.extend(chunk["data"])
    except Exception as e:
        detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        raise HTTPException(status_code=502,
                            detail=f"朗读合成失败（{detail}）：音色 ID 可能无效，或网络不可用")
    if not audio:
        raise HTTPException(status_code=502,
                            detail=f"朗读合成失败：音色「{voice}」没有返回音频，请检查音色 ID")
    return Response(content=bytes(audio), media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store"})


def port_in_use(port: int) -> bool:
    """端口是否已被监听（重复启动时友好退出，而不是抛 bind 10048 错误）。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    import uvicorn
    if port_in_use(PORT):
        print(f"[dony-app-api] {PORT} 已在运行，本次启动跳过（无需重复启动）", flush=True)
        raise SystemExit(0)
    print(f"[dony-app-api] http://127.0.0.1:{PORT} settings={store.SETTINGS_FILE}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
