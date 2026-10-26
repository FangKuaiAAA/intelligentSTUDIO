"""Moebius 修补管线（ONNX）。

无文本编码器：UNet 使用固定的 context 向量，CFG 只做两个分支的强度混合。
以遮罩外接框为中心裁剪方形窗口送入 512 画布，结果放大回原图后按遮罩羽化贴回。
算法对应 luweigen/moebius-onnx-android 的 Pipeline.kt / Imaging.kt。
"""

from __future__ import annotations

import math
import os
import threading
from typing import Optional

import numpy as np
from PIL import Image, ImageFilter

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover
    ort = None

IMG = 512
LAT = 64
SCALING_FACTOR = 0.13025
NOISE_OFFSET = 0.0357
NUM_TRAIN_TIMESTEPS = 1000
BETA_START = 0.00085
BETA_END = 0.012
CONTEXT_TOKENS = 10
CONTEXT_DIM = 3072


class _Mulberry32:
    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = (self.state ^ (self.state >> 15)) * (1 | self.state) & 0xFFFFFFFF
        t = ((t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0


def _randn(count: int, seed: int) -> np.ndarray:
    rng = _Mulberry32(seed)
    out = np.empty(count, dtype=np.float32)
    for index in range(count):
        u = 0.0
        v = 0.0
        while u == 0.0:
            u = rng.next()
        while v == 0.0:
            v = rng.next()
        out[index] = math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)
    return out


def _init_latents(seed: int) -> np.ndarray:
    latents = _randn(4 * LAT * LAT, seed)
    offsets = _randn(4, seed ^ 0x9E3779B9)
    plane = LAT * LAT
    for channel in range(4):
        start = channel * plane
        latents[start:start + plane] += NOISE_OFFSET * offsets[channel]
    return latents.reshape(4, LAT, LAT)


class _Ddim:
    def __init__(self, steps: int, strength: float = 0.99) -> None:
        alphas = np.empty(NUM_TRAIN_TIMESTEPS, dtype=np.float64)
        a = math.sqrt(BETA_START)
        b = math.sqrt(BETA_END)
        acc = 1.0
        for index in range(NUM_TRAIN_TIMESTEPS):
            beta = (a + (b - a) * (index / (NUM_TRAIN_TIMESTEPS - 1))) ** 2
            acc *= 1.0 - beta
            alphas[index] = acc

        self.alphas_cumprod = alphas
        ratio = NUM_TRAIN_TIMESTEPS // steps
        all_steps = [(steps - 1 - index) * ratio for index in range(steps)]
        keep = min(int(math.floor(steps * strength)), steps)
        self.timesteps = all_steps[max(steps - keep, 0):]

    def step(self, eps: np.ndarray, sample: np.ndarray, t: int, prev: int) -> np.ndarray:
        alpha_t = self.alphas_cumprod[t]
        alpha_prev = self.alphas_cumprod[prev] if prev >= 0 else 1.0

        predicted = (sample - math.sqrt(1 - alpha_t) * eps) / math.sqrt(alpha_t)
        return (math.sqrt(alpha_prev) * predicted
                + math.sqrt(1 - alpha_prev) * eps).astype(np.float32)


class MoebiusEngine:
    def __init__(self, model_dir: str, prefer_gpu: bool = True) -> None:
        self.model_dir = model_dir
        self.prefer_gpu = prefer_gpu
        self._lock = threading.Lock()
        self._sessions: dict[str, object] = {}
        self._context: Optional[np.ndarray] = None
        self._providers = self._pick_providers()

    @property
    def available(self) -> bool:
        if ort is None:
            return False
        required = ["unet.fp16x.onnx", "vae_encoder.static.onnx", "vae_decoder.static.onnx", "context.bin"]
        return all(os.path.exists(os.path.join(self.model_dir, name)) for name in required)

    def _pick_providers(self) -> list[str]:
        if ort is None:
            return []
        available = ort.get_available_providers()
        ordered: list[str] = []
        if self.prefer_gpu:
            for name in ("DmlExecutionProvider", "CUDAExecutionProvider"):
                if name in available:
                    ordered.append(name)
        ordered.append("CPUExecutionProvider")
        return ordered

    def _session(self, name: str):
        if name not in self._sessions:
            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self._sessions[name] = ort.InferenceSession(
                os.path.join(self.model_dir, name), sess_options=options, providers=self._providers
            )
        return self._sessions[name]

    def _ensure(self) -> None:
        if self._context is None:
            path = os.path.join(self.model_dir, "context.bin")
            # 文件里存的是 CFG 两个分支各自的 context：(2, 10, 3072)
            data = np.fromfile(path, dtype="<f4")
            self._context = data.reshape(2, CONTEXT_TOKENS, CONTEXT_DIM)

    # ---------------- 预处理 ----------------

    @staticmethod
    def _window(width: int, height: int, mask: np.ndarray) -> tuple[int, int, int]:
        ys, xs = np.nonzero(mask > 0)
        if xs.size == 0:
            side = min(IMG, width, height)
            return max(0, (width - side) // 2), max(0, (height - side) // 2), side

        box_w = int(xs.max() - xs.min() + 1)
        box_h = int(ys.max() - ys.min() + 1)
        side = min(max(int(math.ceil(max(box_w, box_h) * 2.5)), IMG), width, height)

        cx = (xs.min() + xs.max() + 1) / 2.0
        cy = (ys.min() + ys.max() + 1) / 2.0
        sx = min(max(int(round(cx - side / 2.0)), 0), width - side)
        sy = min(max(int(round(cy - side / 2.0)), 0), height - side)
        return sx, sy, side

    def inpaint(self, image: np.ndarray, mask: np.ndarray, steps: int = 20,
                guidance: float = 2.0, seed: int = 0) -> np.ndarray:
        self._ensure()

        height, width = image.shape[:2]
        binary = (mask > 0).astype(np.uint8) * 255
        sx, sy, side = self._window(width, height, binary)

        crop = image[sy:sy + side, sx:sx + side]
        crop_mask = binary[sy:sy + side, sx:sx + side]

        canvas = np.asarray(Image.fromarray(crop).resize((IMG, IMG), Image.LANCZOS)) if side != IMG else crop
        mask_canvas = np.asarray(Image.fromarray(crop_mask).resize((IMG, IMG), Image.BOX))
        mask_512 = (mask_canvas >= 128).astype(np.float32)

        chw = (canvas.astype(np.float32) / 255.0 * 2.0 - 1.0).transpose(2, 0, 1)
        masked_chw = chw * (1.0 - mask_512[None, :, :])

        with self._lock:
            encoder = self._session("vae_encoder.static.onnx")
            unet = self._session("unet.fp16x.onnx")
            decoder = self._session("vae_decoder.static.onnx")
            context = self._context

            moments = encoder.run(None, {"image": masked_chw[None].astype(np.float32)})[0]
            masked_latent = moments[0, :4] * SCALING_FACTOR

            # 每个 8×8 块取左上角，与 Pipeline.maskToLatent 一致
            mask_latent = mask_512[::8, ::8].astype(np.float32)

            latent = _init_latents(seed)
            ddim = _Ddim(steps)

            for index, timestep in enumerate(ddim.timesteps):
                nine = np.concatenate([latent, mask_latent[None], masked_latent], axis=0)
                batch = np.stack([nine, nine])
                times = np.array([timestep, timestep], dtype=np.int64)

                noise = unet.run(None, {"latent": batch, "timesteps": times, "context": context})[0]

                uncond, cond = noise[0], noise[1]
                eps = uncond + guidance * (cond - uncond)

                prev = ddim.timesteps[index + 1] if index + 1 < len(ddim.timesteps) else -1
                latent = ddim.step(eps, latent, timestep, prev)

            decoded = decoder.run(None, {"latent": (latent / SCALING_FACTOR)[None].astype(np.float32)})[0]

        result = ((decoded[0].transpose(1, 2, 0) + 1.0) * 127.5)
        result = np.clip(result, 0, 255).astype(np.uint8)

        window_image = Image.fromarray(result)
        if side != IMG:
            window_image = window_image.resize((side, side), Image.LANCZOS)

        source = Image.fromarray(image).convert("RGB")
        feather = Image.fromarray(crop_mask).filter(ImageFilter.GaussianBlur(3.0 * side / IMG))

        base = source.crop((sx, sy, sx + side, sy + side))
        merged = Image.composite(window_image, base, feather)
        output = source.copy()
        output.paste(merged, (sx, sy))
        return np.asarray(output)
