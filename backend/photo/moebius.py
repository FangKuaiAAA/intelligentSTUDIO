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
    def _window(width: int, height: int, mask: np.ndarray) -> tuple[int, int, int, int]:
        """取处理窗口（左上角 + 宽高）。

        ⚠ 以前窗口被强制成**正方形**，边长 `min(..., width, height)`：
        「扩展」场景遮罩铺满四条边，bounding box 就是整图，正方形窗口只能取到
        `min(宽, 高)`，于是较长的那个方向有两条边被整个排除在窗口外 ——
        模型没处理它们，`inpaint` 也只把窗口那块贴回去，结果就是
        「上下补好了、左右还是灰的」。所以这里不再强制正方形。
        """
        ys, xs = np.nonzero(mask > 0)
        if xs.size == 0:
            side = min(IMG, width, height)
            return max(0, (width - side) // 2), max(0, (height - side) // 2), side, side

        box_w = int(xs.max() - xs.min() + 1)
        box_h = int(ys.max() - ys.min() + 1)

        # 遮罩外扩 2.5 倍作为上下文（下限 IMG），但不超出画布；宽高各自计算
        win_w = min(width, max(int(math.ceil(box_w * 2.5)), IMG))
        win_h = min(height, max(int(math.ceil(box_h * 2.5)), IMG))

        cx = (xs.min() + xs.max() + 1) / 2.0
        cy = (ys.min() + ys.max() + 1) / 2.0
        sx = int(min(max(round(cx - win_w / 2.0), 0), width - win_w))
        sy = int(min(max(round(cy - win_h / 2.0), 0), height - win_h))
        return sx, sy, win_w, win_h

    def inpaint(self, image: np.ndarray, mask: np.ndarray, steps: int = 20,
                guidance: float = 2.0, seed: int = 0,
                keep_masked: bool = False) -> np.ndarray:
        self._ensure()

        height, width = image.shape[:2]
        binary = (mask > 0).astype(np.uint8) * 255
        sx, sy, win_w, win_h = self._window(width, height, binary)

        crop = image[sy:sy + win_h, sx:sx + win_w]
        crop_mask = binary[sy:sy + win_h, sx:sx + win_w]

        # 等比缩放进 IMG×IMG（不拉伸），空出来的部分补中性灰、并计入 mask：
        # 模型是固定 IMG 的正方形输入，非正方形窗口直接拉伸会变形，补边则不会。
        # 补边区的重绘结果最后会被裁掉，所以填什么都无所谓，但必须标记为「要重绘」。
        scale = IMG / float(max(win_w, win_h))
        fit_w = max(1, int(round(win_w * scale)))
        fit_h = max(1, int(round(win_h * scale)))

        canvas = np.full((IMG, IMG, 3), 128, dtype=np.uint8)
        canvas[:fit_h, :fit_w] = np.asarray(
            Image.fromarray(crop).resize((fit_w, fit_h), Image.LANCZOS))
        mask_canvas = np.full((IMG, IMG), 255, dtype=np.uint8)
        mask_canvas[:fit_h, :fit_w] = np.asarray(
            Image.fromarray(crop_mask).resize((fit_w, fit_h), Image.BOX))
        mask_512 = (mask_canvas >= 128).astype(np.float32)

        chw = (canvas.astype(np.float32) / 255.0 * 2.0 - 1.0).transpose(2, 0, 1)
        mask_3 = mask_512[None, :, :]

        if keep_masked:
            # 扩展：遮罩区填「延展内容 + 噪声」。
            #
            # 这是给"不支持文本条件"的模型下的一条等效指令：把外侧模糊区补全。
            #   · 保留一部分延展内容 → 模型知道该延续什么材质/色调/结构，
            #     不会像纯清零那样在空白处凭空长出主体（实测右侧会冒出一大坨）。
            #   · 叠加较强噪声 → 模型没法直接"抄"这些像素，必须真正重绘；
            #     若只给干净的延展（不叠加噪声），它会当成已有内容原样保留，
            #     结果扩展区只剩拉伸条纹、等于没补。
            rng = np.random.default_rng(seed if seed else 12345)
            noise = rng.normal(0.0, 0.60, chw.shape).astype(np.float32)
            filled = np.clip(chw * 0.45 + noise, -1.0, 1.0)
            masked_chw = chw * (1.0 - mask_3) + filled * mask_3
        else:
            # 擦除 / 重构：遮罩区必须清零，否则被擦掉的物体会被当成已有内容保留
            masked_chw = chw * (1.0 - mask_3)

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

        # 先裁掉补边，再缩放回实际窗口尺寸
        window_image = Image.fromarray(result).crop((0, 0, fit_w, fit_h))
        if (fit_w, fit_h) != (win_w, win_h):
            window_image = window_image.resize((win_w, win_h), Image.LANCZOS)

        # ---- 补颗粒 ----
        # 重绘区是 IMG(512) 生成后放大回来的，高频颗粒被抹平；而原图是全分辨率，
        # 两者并排时接缝会呈现出"一边锐、一边糊"的明显分界。这里从窗口内**未遮罩**的
        # 原图估计高频噪声强度，按同一强度给重绘区加回颗粒，让质地接近。
        try:
            wimg = np.asarray(window_image).astype(np.float32)
            src_arr = crop.astype(np.float32)
            valid = crop_mask < 128
            if int(valid.sum()) > 200:
                pad = np.pad(src_arr, ((1, 1), (1, 1), (0, 0)), mode="edge")
                blur3 = (pad[:-2, 1:-1] + pad[2:, 1:-1]
                         + pad[1:-1, :-2] + pad[1:-1, 2:] + src_arr) / 5.0
                sigma = float(np.std((src_arr - blur3)[valid]))
            else:
                sigma = 3.0
            sigma = float(np.clip(sigma, 1.0, 12.0))

            # 放大过程中噪声会被插值削弱，按 1.6 倍补偿（仅当确实发生了放大）
            gain = 1.6 if (fit_w, fit_h) != (win_w, win_h) else 1.0
            rng = np.random.default_rng(seed if seed else 12345)
            noise = rng.normal(0.0, sigma * gain, wimg.shape)
            alpha = (np.asarray(crop_mask).astype(np.float32)[..., None] / 255.0)
            window_image = Image.fromarray(
                np.clip(wimg + noise * alpha, 0, 255).astype(np.uint8))
        except Exception:
            pass

        source = Image.fromarray(image).convert("RGB")
        # 羽化半径按窗口尺度换算：模型输出是从 IMG 放大回来的，接缝处会有轻微色差，
        # 3.0 的系数太小（1368 宽的画布只有约 5.7px），实测在原图边缘留下一条细线。
        feather = Image.fromarray(crop_mask).filter(
            ImageFilter.GaussianBlur(6.0 * min(win_w, win_h) / IMG))

        base = source.crop((sx, sy, sx + win_w, sy + win_h))
        merged = Image.composite(window_image, base, feather)
        output = source.copy()
        output.paste(merged, (sx, sy))
        return np.asarray(output)
