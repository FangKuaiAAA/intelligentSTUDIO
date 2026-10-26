"""照片编辑器的本地推理服务（127.0.0.1:8772）。

职责边界：只做 ONNX 推理，不碰界面、不读设置、不直接访问外部生图接口。
图像一律以 base64 PNG 往返，避免临时文件争用。

端口说明：8771 被 Office 加载项本地桥（backend/office_bridge.py，HTTPS）占用，
本服务改用 8772，与 office/manifest.xml 里的固定 URL 解耦。
"""

from __future__ import annotations

import base64
import hashlib
import os
import sys
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

from photo.engines import (  # noqa: E402
    SamEngine,
    SharpEngine,
    available_providers,
    decode_mask,
    decode_png,
    encode_mask_png,
    png_base64,
)
from photo.jobs import JobRegistry  # noqa: E402
from photo.moebius import MoebiusEngine  # noqa: E402

MODEL_DIR = Path(os.getenv("PHOTO_MODEL_DIR", str(ROOT_DIR / "models" / "photo")))
# 8771 归 office_bridge.py（Office 加载项桥）；本服务用 8772。
PORT = 8772

app = FastAPI(title="intelligentSTUDIO 照片编辑器推理服务", docs_url=None, redoc_url=None)

sam = SamEngine(str(MODEL_DIR))
sharp_engine = SharpEngine(str(MODEL_DIR))
moebius_engine = MoebiusEngine(str(MODEL_DIR / "moebius"))
jobs = JobRegistry()

# 点云缓存：图片内容哈希 → (二进制点云, 元数据)
_REFRAME_CACHE: dict[str, tuple[bytes, dict]] = {}


class SessionRequest(BaseModel):
    image: str


class SegmentRequest(BaseModel):
    session: str
    points: list[dict]
    scribble: Optional[str] = None


class MoebiusRequest(BaseModel):
    image: str
    mask: str
    steps: int = 20


class ReframeRequest(BaseModel):
    image: str
    output_path: Optional[str] = None


@app.get("/api/health")
def health() -> dict:
    providers = available_providers()
    return {
        "ok": True,
        "sam": sam.available,
        "sharp": sharp_engine.available,
        "providers": providers,
        "device": sam.provider if sam.available else (providers[0] if providers else "未就绪"),
    }


@app.post("/api/session")
def create_session(request: SessionRequest) -> dict:
    if not sam.available:
        raise HTTPException(status_code=503, detail="分割模型缺失。请先运行 scripts/fetch-photo-models.py。")

    try:
        image = decode_png(base64.b64decode(request.image))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"图像无法解码：{exc}") from exc

    session_id = uuid.uuid4().hex
    try:
        sam.create(session_id, image)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"分割模型载入失败：{exc}") from exc

    return {"id": session_id, "width": int(image.shape[1]), "height": int(image.shape[0])}


@app.post("/api/segment")
def segment(request: SegmentRequest) -> dict:
    points = [(float(item.get("x", 0)), float(item.get("y", 0))) for item in request.points]
    if not points:
        return {"found": False, "mask": "", "width": 0, "height": 0}

    try:
        mask = sam.segment(request.session, points)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"分割失败：{exc}") from exc

    if mask is None:
        return {"found": False, "mask": "", "width": 0, "height": 0}

    return {
        "found": True,
        "mask": base64.b64encode(encode_mask_png(mask)).decode("ascii"),
        "width": int(mask.shape[1]),
        "height": int(mask.shape[0]),
    }


@app.post("/api/moebius/inpaint")
def moebius_inpaint(request: MoebiusRequest) -> dict:
    """Moebius：无文本条件的局部修补，以遮罩为中心裁窗口后整体重绘。"""
    if not moebius_engine.available:
        raise HTTPException(status_code=503, detail="Moebius 模型缺失。请先下载到 models/photo/moebius。")

    try:
        image = decode_png(base64.b64decode(request.image))
        height, width = image.shape[:2]
        mask = decode_mask(base64.b64decode(request.mask), width, height)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"输入无法解析：{exc}") from exc

    try:
        result = moebius_engine.inpaint(
            image,
            (mask > 0).astype(np.uint8) * 255,
            steps=max(4, min(40, int(request.steps))),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Moebius 修复失败：{exc}") from exc

    return {"image": png_base64(result), "engine": "moebius"}


@app.post("/api/reframe/prepare")
def reframe_prepare(request: ReframeRequest) -> dict:
    if not sharp_engine.available:
        raise HTTPException(
            status_code=503,
            detail="三维重建模型缺失。请把 sharp_web_predictor.onnx 放到 models/photo/。",
        )

    try:
        payload = base64.b64decode(request.image)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"图像无法解码：{exc}") from exc

    key = hashlib.sha256(payload).hexdigest()
    if key in _REFRAME_CACHE:
        def cached(record) -> tuple[bytes, dict]:
            record.stage = "读取已有场景"
            record.progress = 0.9
            return _REFRAME_CACHE[key]

        return {"job": jobs.submit("重建场景", cached)}

    def work(record) -> tuple[bytes, dict]:
        record.stage = "准备图像"
        record.progress = 0.08
        image = decode_png(payload)

        record.stage = "估计空间结构"
        record.progress = 0.22
        cloud = sharp_engine.reconstruct(image, request.output_path)

        record.stage = "整理点云"
        record.progress = 0.92
        result = (
            cloud.data,
            {
                "count": cloud.count,
                "width": cloud.width,
                "height": cloud.height,
                "focalPx": cloud.focal_px,
                "fov": cloud.fov,
                "path": request.output_path or "",
            },
        )

        # 同一张图重复进入「重构」时直接复用点云，避免再次等待一分钟
        _REFRAME_CACHE[key] = result
        while len(_REFRAME_CACHE) > 4:
            _REFRAME_CACHE.pop(next(iter(_REFRAME_CACHE)))
        return result

    return {"job": jobs.submit("重建场景", work)}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在。")

    return {
        "state": record.state,
        "stage": record.stage,
        "progress": float(record.progress),
        "result": base64.b64encode(record.result).decode("ascii") if record.result else None,
        "meta": record.meta,
        "error": record.error,
    }


@app.post("/api/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict:
    return {"cancelled": jobs.cancel(job_id)}


if __name__ == "__main__":
    import uvicorn

    print(f"照片编辑器推理服务启动：http://127.0.0.1:{PORT}")
    print(f"模型目录：{MODEL_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
