from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx
import json
import os
from typing import List, Optional

app = FastAPI(title="APPXInteligent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration - supports OpenAI-compatible APIs
# Priority: env vars > config file > defaults
_config_file = os.environ.get("APPX_CONFIG_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".appx_config.json")

def _load_config():
    if os.path.exists(_config_file):
        try:
            with open(_config_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg
        except Exception:
            pass

    # Try temp config file
    temp_file = os.path.join(os.environ.get("TEMP", os.environ.get("TMP", "/tmp")), "appx_config.json")
    if os.path.exists(temp_file):
        try:
            with open(temp_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg
        except Exception:
            pass
    return {}

_config = _load_config()

API_KEY = os.getenv("OPENAI_API_KEY", _config.get("OPENAI_API_KEY", "your-api-key-here"))
API_BASE = os.getenv("OPENAI_API_BASE", _config.get("OPENAI_API_BASE", "https://api.openai.com/v1"))
MODEL = os.getenv("OPENAI_MODEL", _config.get("OPENAI_MODEL", "gpt-4o-mini"))


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    model: Optional[str] = None


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


@app.post("/chat")
async def chat(request: ChatRequest):
    try:
        async def generate():
            async with httpx.AsyncClient(timeout=120.0) as client:
                payload = {
                    "model": request.model or MODEL,
                    "messages": [m.model_dump() for m in request.messages],
                    "stream": True,
                }
                headers = {
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                }
                async with client.stream(
                    "POST",
                    f"{API_BASE}/chat/completions",
                    json=payload,
                    headers=headers,
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        yield f"data: {json.dumps({'error': f'API error: {response.status_code} - {error_text.decode()}'})}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            yield f"{line}\n\n"

                yield "data: [DONE]\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
