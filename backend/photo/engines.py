"""ONNX 推理引擎：SAM 分割、SHARP 单图三维重建。

设计要点：
- 模型懒加载并常驻，避免每次请求重建会话。
- 执行提供程序按 DirectML → CUDA → CPU 顺序尝试，失败自动回退。
- 输入输出名称按实际模型签名读取，兼容不同的 ONNX 导出。
"""

from __future__ import annotations

import base64
import io
import math
import os
import struct
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - 缺少依赖时由服务层给出中文提示
    ort = None


SHARP_INPUT_SIZE = 1536
DEFAULT_FOCAL_MM = 30.0
FILM_35MM_DIAGONAL_MM = 43.266615305567875
# 与原项目 full 预设一致：SHARP 全量高斯（1536×1536 网格的一半），避免稀疏空洞
MAX_POINTS = 1_179_648
DEFAULT_FOV = 75.0


def available_providers() -> list[str]:
    if ort is None:
        return []
    try:
        return list(ort.get_available_providers())
    except Exception:
        return []


def pick_providers(prefer_gpu: bool = True) -> list[str]:
    """DirectML 覆盖核显 / AMD / NVIDIA；不可用时退回 CPU。"""
    providers = available_providers()
    ordered: list[str] = []
    if prefer_gpu:
        for name in ("DmlExecutionProvider", "CUDAExecutionProvider"):
            if name in providers:
                ordered.append(name)
    ordered.append("CPUExecutionProvider")
    return ordered


# ---- GPU 能力标记：DirectML 对个别算子（FFT 等）不支持，失败一次后固定 CPU ----

def _cpu_marker(model_dir: str, name: str) -> Path:
    return Path(model_dir) / f".{name}_cpu"


def _cpu_locked(model_dir: str, name: str) -> bool:
    return _cpu_marker(model_dir, name).exists()


def _lock_cpu(model_dir: str, name: str) -> None:
    try:
        _cpu_marker(model_dir, name).write_text("dml-unsupported", encoding="utf-8")
    except Exception:
        pass


def _session(path: str, providers: list[str]):
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = max(1, min(8, (os.cpu_count() or 4) - 1))
    # DirectML 在 1536 输入下容易顶到显存峰值（E_OUTOFMEMORY），
    # 关掉内存池复用可以压低峰值，代价是略慢。
    options.enable_mem_pattern = False
    options.enable_cpu_mem_arena = False
    return ort.InferenceSession(path, sess_options=options, providers=providers)


def decode_png(data: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    return np.asarray(image)


def decode_mask(data: bytes, width: int, height: int) -> np.ndarray:
    mask = Image.open(io.BytesIO(data)).convert("L")
    if mask.size != (width, height):
        mask = mask.resize((width, height), Image.BILINEAR)
    return (np.asarray(mask) > 127).astype(np.uint8)


def encode_png(array: np.ndarray) -> bytes:
    image = Image.fromarray(array)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def keep_main_component(mask: np.ndarray, seeds: Iterable[tuple[float, float]]) -> np.ndarray:
    """只保留与提示点相连的前景分量，丢弃远处被一起识别出的孤立区域。"""
    from collections import deque

    height, width = mask.shape
    result = np.zeros_like(mask)

    for sx, sy in seeds:
        sx = int(min(width - 1, max(0, sx)))
        sy = int(min(height - 1, max(0, sy)))
        if not mask[sy, sx] or result[sy, sx]:
            continue

        queue = deque([(sx, sy)])
        result[sy, sx] = 1
        while queue:
            x, y = queue.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and not result[ny, nx]:
                    result[ny, nx] = 1
                    queue.append((nx, ny))

    return result


def encode_mask_png(mask: np.ndarray) -> bytes:
    image = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


# --------------------------------------------------------------------------- SAM


class SamEngine:
    """MobileSAM / SlimSAM：编码器生成图像 embedding，解码器按提示点出掩码。"""

    def __init__(self, model_dir: str, prefer_gpu: bool = True) -> None:
        self.model_dir = model_dir
        # 优先 SAM ViT-B（sam_encoder/sam_decoder），旧安装回退 SlimSAM 命名
        encoder = os.path.join(model_dir, "sam_encoder.onnx")
        decoder = os.path.join(model_dir, "sam_decoder.onnx")
        self.encoder_path = encoder if os.path.exists(encoder) else os.path.join(model_dir, "mobile_sam_encoder.onnx")
        self.decoder_path = decoder if os.path.exists(decoder) else os.path.join(model_dir, "mobile_sam_decoder.onnx")
        self._encoder = None
        self._decoder = None
        self._lock = threading.Lock()
        self._providers = pick_providers(prefer_gpu)
        self._use_cpu = _cpu_locked(model_dir, "sam")
        self._embeddings: dict[str, np.ndarray] = {}
        self._sizes: dict[str, tuple[int, int]] = {}

    def _active_providers(self) -> list[str]:
        return ["CPUExecutionProvider"] if self._use_cpu else self._providers

    def _fallback(self) -> None:
        _lock_cpu(self.model_dir, "sam")
        self._use_cpu = True
        self._encoder = None
        self._decoder = None

    @property
    def available(self) -> bool:
        return ort is not None and os.path.exists(self.encoder_path) and os.path.exists(self.decoder_path)

    @property
    def provider(self) -> str:
        if self._use_cpu:
            return "CPUExecutionProvider"
        return self._providers[0] if self._providers else "未就绪"

    def _ensure(self) -> None:
        if self._encoder is not None and self._decoder is not None:
            return
        if not self.available:
            raise RuntimeError("分割模型文件缺失。请运行 scripts/fetch-photo-models.py。")
        self._encoder = _session(self.encoder_path, self._active_providers())
        self._decoder = _session(self.decoder_path, self._active_providers())

    def create(self, session_id: str, image: np.ndarray) -> None:
        self._ensure()
        with self._lock:
            tensor, resized = self._encoder_input(image)
            feeds = {self._encoder.get_inputs()[0].name: tensor}

            try:
                outputs = self._encoder.run(None, feeds)
            except Exception:
                if self._use_cpu:
                    raise
                print("分割编码器在 GPU 上不可用，改为 CPU。", file=sys.stderr)
                self._fallback()
                self._ensure()
                outputs = self._encoder.run(None, feeds)

            # 编码器可能输出 image_embeddings 与 image_positional_embeddings 两组，
            # 解码器两个都要；只传第一个会导致掩码完全失真
            names = [o.name for o in self._encoder.get_outputs()]
            self._embeddings[session_id] = {
                name: np.asarray(value) for name, value in zip(names, outputs)
            }
            self._sizes[session_id] = (image.shape[1], image.shape[0])

    def drop(self, session_id: str) -> None:
        self._embeddings.pop(session_id, None)
        self._sizes.pop(session_id, None)

    def segment(self, session_id: str, points: Iterable[tuple[float, float]]) -> Optional[np.ndarray]:
        embedding = self._embeddings.get(session_id)
        if embedding is None:
            return None

        width, height = self._sizes[session_id]
        points = list(points)
        coords = np.array([[x, y] for x, y in points], dtype=np.float32)
        if coords.size == 0:
            return None

        # 编码器把整图等比缩放到 1024 方图的左上角（见 _encoder_input），
        # 横纵必须用同一个缩放系数，否则非方图上提示点会整体偏移，命中相邻色块。
        scale = 1024.0 / max(width, height)
        coords *= scale

        # 两种导出签名：MobileSAM 用 [1,N,2]，transformers.js 的多点版本用 [1,1,N,2]
        coords3 = coords[None, :, :]
        coords4 = coords[None, None, :, :]
        labels3 = np.ones((1, coords.shape[0]), dtype=np.int64)
        labels4 = np.ones((1, 1, coords.shape[0]), dtype=np.int64)

        feeds: dict[str, np.ndarray] = {}
        for item in self._decoder.get_inputs():
            name = item.name
            if name in embedding:
                feeds[name] = embedding[name]
            elif "embedding" in name:
                feeds[name] = next(iter(embedding.values()))
            elif "input_points" in name:
                feeds[name] = coords4
            elif "point_coords" in name:
                feeds[name] = coords3
            elif "input_labels" in name:
                feeds[name] = labels4
            elif "point_labels" in name:
                feeds[name] = labels3
            elif "mask_input" in name:
                feeds[name] = np.zeros((1, 1, 256, 256), dtype=np.float32)
            elif "has_mask" in name:
                feeds[name] = np.zeros((1,), dtype=np.float32)
            elif "orig_im_size" in name:
                feeds[name] = np.array([height, width], dtype=np.float32)

        try:
            outputs = self._decoder.run(None, feeds)
        except Exception:
            if self._use_cpu:
                raise
            print("分割解码器在 GPU 上不可用，改为 CPU。", file=sys.stderr)
            self._fallback()
            self._ensure()
            outputs = self._decoder.run(None, feeds)

        # 输出为 iou_scores 与 pred_masks：按得分挑出最贴合提示的那一个候选，
        # 避免固定取第一个导致多个物体被连成一片
        names = [item.name for item in self._decoder.get_outputs()]
        mask_index = next((i for i, name in enumerate(names) if "mask" in name), 0)
        iou_index = next((i for i, name in enumerate(names) if "iou" in name), None)

        masks = np.asarray(outputs[mask_index])

        # 三种导出布局： (B,P,N,3,H,W) / (B,3,H,W) / (3,H,W)，统一先压到 (3,H,W)
        if masks.ndim == 6:
            masks = masks[0, 0]
        elif masks.ndim == 5:
            masks = masks[0, 0]
        elif masks.ndim == 4:
            masks = masks[0]

        candidates = masks
        if candidates.ndim == 3 and candidates.shape[0] > 1:
            count = candidates.shape[0]
            scores = np.asarray(outputs[iou_index]).reshape(-1) if iou_index is not None else None

            if scores is not None and scores.size >= count:
                order = np.argsort(-scores[:count])
            else:
                order = np.arange(count)

            # 候选必须真的覆盖点击位置：只按 iou 排序会选中一张不含种子点的大区域
            candidate_height, candidate_width = candidates.shape[-2], candidates.shape[-1]
            seeds = [
                (
                    int(min(candidate_width - 1, max(0, x * candidate_width / max(width, height)))),
                    int(min(candidate_height - 1, max(0, y * candidate_height / max(width, height)))),
                )
                for x, y in points
            ]

            def covers(index: int) -> bool:
                candidate = candidates[index]
                for sx, sy in seeds:
                    patch = candidate[max(0, sy - 2): sy + 3, max(0, sx - 2): sx + 3]
                    if patch.size and bool((patch > 0.0).any()):
                        return True
                return False

            chosen = next((int(i) for i in order if covers(int(i))), int(order[0]))
            candidates = candidates[chosen]

        masks = candidates
        while masks.ndim > 2:
            masks = masks[0]

        # logits 覆盖的是 1024 方图（右下为补零边），必须先裁掉补边再等比缩放，
        # 否则纵向会被压缩，掩码整体上移。
        if masks.shape != (height, width):
            encoder_scale = 1024.0 / max(width, height)
            content_width = max(1, int(round(width * encoder_scale)))
            content_height = max(1, int(round(height * encoder_scale)))

            source_height, source_width = masks.shape[-2], masks.shape[-1]
            crop_width = max(1, int(round(source_width * content_width / 1024.0)))
            crop_height = max(1, int(round(source_height * content_height / 1024.0)))
            masks = masks[:crop_height, :crop_width]

            upsampled = Image.fromarray(masks.astype(np.float32), mode="F").resize(
                (width, height), Image.BILINEAR
            )
            masks = np.asarray(upsampled)

        mask = (masks > 0.0).astype(np.uint8)

        # 只保留包含提示点的连通分量，避免相邻但语义不同的区域被一起选中
        filtered = keep_main_component(mask, [(float(x), float(y)) for x, y in points])
        if filtered.any() and filtered.mean() > 0.001:
            mask = filtered

        ratio = float(mask.mean())
        if ratio < 0.0005 or ratio > 0.96:
            return None
        return mask

    def _encoder_input(self, image: np.ndarray):
        size = 1024
        height, width = image.shape[:2]
        scale = size / max(width, height)
        resized = np.asarray(
            Image.fromarray(image).resize((max(1, int(width * scale)), max(1, int(height * scale))))
        )

        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[: resized.shape[0], : resized.shape[1]] = resized

        # transformers.js 的 SAM 导出：rescale 到 0-1，归一化在图内完成
        tensor = canvas.astype(np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
        return tensor, resized


# ----------------------------------------------------------------------- SHARP


@dataclass
class PointCloud:
    data: bytes
    count: int
    width: int
    height: int
    focal_px: float
    fov: float


SH_COEFF_DEG0 = math.sqrt(1.0 / (4.0 * math.pi))


def _quaternions_from_matrices(matrices: np.ndarray) -> np.ndarray:
    """(N,3,3) 旋转矩阵转 (N,4) 四元数，顺序为 w,x,y,z，与原项目导出一致。"""
    count = matrices.shape[0]
    quats = np.zeros((count, 4), dtype=np.float64)
    trace = matrices[:, 0, 0] + matrices[:, 1, 1] + matrices[:, 2, 2]

    positive = trace > 0
    if positive.any():
        s = 2.0 * np.sqrt(np.maximum(trace[positive] + 1.0, 1e-12))
        quats[positive, 0] = 0.25 * s
        quats[positive, 1] = (matrices[positive, 2, 1] - matrices[positive, 1, 2]) / s
        quats[positive, 2] = (matrices[positive, 0, 2] - matrices[positive, 2, 0]) / s
        quats[positive, 3] = (matrices[positive, 1, 0] - matrices[positive, 0, 1]) / s

    rest = ~positive
    branch_x = rest & (matrices[:, 0, 0] > matrices[:, 1, 1]) & (matrices[:, 0, 0] > matrices[:, 2, 2])
    if branch_x.any():
        s = 2.0 * np.sqrt(np.maximum(
            1.0 + matrices[branch_x, 0, 0] - matrices[branch_x, 1, 1] - matrices[branch_x, 2, 2], 1e-12))
        quats[branch_x, 0] = (matrices[branch_x, 2, 1] - matrices[branch_x, 1, 2]) / s
        quats[branch_x, 1] = 0.25 * s
        quats[branch_x, 2] = (matrices[branch_x, 0, 1] + matrices[branch_x, 1, 0]) / s
        quats[branch_x, 3] = (matrices[branch_x, 0, 2] + matrices[branch_x, 2, 0]) / s

    branch_y = rest & ~branch_x & (matrices[:, 1, 1] > matrices[:, 2, 2])
    if branch_y.any():
        s = 2.0 * np.sqrt(np.maximum(
            1.0 + matrices[branch_y, 1, 1] - matrices[branch_y, 0, 0] - matrices[branch_y, 2, 2], 1e-12))
        quats[branch_y, 0] = (matrices[branch_y, 0, 2] - matrices[branch_y, 2, 0]) / s
        quats[branch_y, 1] = (matrices[branch_y, 0, 1] + matrices[branch_y, 1, 0]) / s
        quats[branch_y, 2] = 0.25 * s
        quats[branch_y, 3] = (matrices[branch_y, 1, 2] + matrices[branch_y, 2, 1]) / s

    branch_z = rest & ~branch_x & ~branch_y
    if branch_z.any():
        s = 2.0 * np.sqrt(np.maximum(
            1.0 + matrices[branch_z, 2, 2] - matrices[branch_z, 0, 0] - matrices[branch_z, 1, 1], 1e-12))
        quats[branch_z, 0] = (matrices[branch_z, 1, 0] - matrices[branch_z, 0, 1]) / s
        quats[branch_z, 1] = (matrices[branch_z, 0, 2] + matrices[branch_z, 2, 0]) / s
        quats[branch_z, 2] = (matrices[branch_z, 1, 2] + matrices[branch_z, 2, 1]) / s
        quats[branch_z, 3] = 0.25 * s

    norm = np.linalg.norm(quats, axis=1, keepdims=True)
    norm[norm < 1e-12] = 1.0
    return quats / norm


def _build_gaussian_ply(
    means: np.ndarray,
    scales: np.ndarray,
    quaternions: np.ndarray,
    colors: np.ndarray,
    opacities: np.ndarray,
    scale_x: float,
    scale_y: float,
) -> bytes:
    """按原项目的字段顺序输出二进制 PLY，供 Spark 高斯泼溅渲染。"""
    count = len(means)

    norm = np.linalg.norm(quaternions, axis=1, keepdims=True)
    norm[norm < 1e-12] = 1.0
    q = quaternions / norm
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]

    rotation = np.empty((count, 3, 3), dtype=np.float64)
    rotation[:, 0, 0] = 1.0 - 2.0 * (y * y + z * z)
    rotation[:, 0, 1] = 2.0 * (x * y - w * z)
    rotation[:, 0, 2] = 2.0 * (x * z + w * y)
    rotation[:, 1, 0] = 2.0 * (x * y + w * z)
    rotation[:, 1, 1] = 1.0 - 2.0 * (x * x + z * z)
    rotation[:, 1, 2] = 2.0 * (y * z - w * x)
    rotation[:, 2, 0] = 2.0 * (x * z - w * y)
    rotation[:, 2, 1] = 2.0 * (y * z + w * x)
    rotation[:, 2, 2] = 1.0 - 2.0 * (x * x + y * y)

    variance = np.maximum(scales, 1e-8) ** 2
    covariance = np.einsum("nij,nj,nkj->nik", rotation, variance, rotation)

    # 透视缩放各向异性，按 S·C·S 重算后再做特征分解，得到新的旋转与尺度
    transform = np.array([scale_x, scale_y, 1.0], dtype=np.float64)
    matrix = covariance * transform[:, None] * transform[None, :]

    eigenvalues, eigenvectors = np.linalg.eigh(matrix)
    order = np.argsort(-eigenvalues, axis=1)
    eigenvalues = np.take_along_axis(eigenvalues, order, axis=1)
    eigenvectors = np.take_along_axis(eigenvectors, order[:, None, :], axis=2)

    flip = np.linalg.det(eigenvectors) < 0
    if flip.any():
        eigenvectors[flip, :, 2] *= -1.0

    new_scales = np.sqrt(np.maximum(eigenvalues, 1e-12))
    new_quaternions = _quaternions_from_matrices(eigenvectors)

    srgb = np.clip(colors, 0.0, 1.0)
    srgb = np.where(srgb <= 0.0031308, 12.92 * srgb, 1.055 * np.power(srgb, 1.0 / 2.4) - 0.055)
    sh0 = (srgb - 0.5) / SH_COEFF_DEG0

    clamped = np.clip(opacities, 1e-6, 1.0 - 1e-6)
    opacity_logit = np.log(clamped / (1.0 - clamped))
    log_scale = np.log(np.maximum(new_scales, 1e-8))

    vertex = np.column_stack([means, sh0, opacity_logit, log_scale, new_quaternions]).astype("<f4")

    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment generated by photo-editor\n"
        f"element vertex {count}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property float f_dc_0\n"
        "property float f_dc_1\n"
        "property float f_dc_2\n"
        "property float opacity\n"
        "property float scale_0\n"
        "property float scale_1\n"
        "property float scale_2\n"
        "property float rot_0\n"
        "property float rot_1\n"
        "property float rot_2\n"
        "property float rot_3\n"
        "end_header\n"
    )
    return header.encode("ascii") + vertex.tobytes()


class SharpEngine:
    """SHARP 单图三维重建：输出点云（位置 + 颜色 + 尺度）与相机参数。"""

    def __init__(self, model_dir: str, prefer_gpu: bool = True) -> None:
        self.model_dir = model_dir
        self.model_path = os.path.join(model_dir, "sharp_web_predictor.onnx")
        self._session = None
        self._lock = threading.Lock()
        self._providers = pick_providers(prefer_gpu)
        self._use_cpu = _cpu_locked(model_dir, "sharp")

    @property
    def available(self) -> bool:
        return ort is not None and os.path.exists(self.model_path)

    @property
    def provider(self) -> str:
        if self._use_cpu:
            return "CPUExecutionProvider"
        return self._providers[0] if self._providers else "未就绪"

    def _active_providers(self) -> list[str]:
        return ["CPUExecutionProvider"] if self._use_cpu else self._providers

    def _ensure(self) -> None:
        if self._session is None:
            if not self.available:
                raise RuntimeError("三维重建模型缺失。请把 SHARP 模型放到 models/photo/。")
            self._session = _session(self.model_path, self._active_providers())

    def reconstruct(self, image: np.ndarray, output_path: Optional[str] = None) -> PointCloud:
        self._ensure()
        height, width = image.shape[:2]

        focal_px = DEFAULT_FOCAL_MM * math.hypot(width, height) / FILM_35MM_DIAGONAL_MM

        resized = np.asarray(
            Image.fromarray(image).resize((SHARP_INPUT_SIZE, SHARP_INPUT_SIZE), Image.BILINEAR)
        )
        tensor = resized.astype(np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]

        feeds: dict[str, np.ndarray] = {}
        for item in self._session.get_inputs():
            name = item.name
            if "disparity" in name:
                feeds[name] = np.array([focal_px / width], dtype=np.float32)
            else:
                feeds[name] = tensor

        with self._lock:
            try:
                outputs = self._session.run(None, feeds)
            except Exception:
                if self._use_cpu:
                    raise
                print("重建模型在 GPU 上不可用，改为 CPU。", file=sys.stderr)
                _lock_cpu(self.model_dir, "sharp")
                self._use_cpu = True
                self._session = None
                self._ensure()
                outputs = self._session.run(None, feeds)

        names = [item.name for item in self._session.get_outputs()]
        def pick(*keys: str) -> Optional[np.ndarray]:
            for key in keys:
                for index, name in enumerate(names):
                    if key in name:
                        return np.asarray(outputs[index])
            return None

        means = pick("mean_vectors")
        scales = pick("singular_values")
        quaternions = pick("quaternions")
        colors = pick("colors")
        opacities = pick("opacities")

        if means is None or colors is None:
            raise RuntimeError("重建模型输出无法解析。")

        means = means.reshape(-1, 3)
        colors = colors.reshape(-1, 3)
        opacities = opacities.reshape(-1) if opacities is not None else np.ones(len(means), dtype=np.float32)
        scales = scales.reshape(-1, 3) if scales is not None else np.full((len(means), 3), 0.01, dtype=np.float32)
        if quaternions is None:
            quaternions = np.zeros((len(means), 4), dtype=np.float32)
            quaternions[:, 0] = 1.0
        else:
            quaternions = quaternions.reshape(-1, 4)

        order = np.argsort(-opacities)[:MAX_POINTS]
        means = means[order].astype(np.float64)
        colors = colors[order].astype(np.float64)
        scales = scales[order].astype(np.float64)
        quaternions = quaternions[order].astype(np.float64)
        opacities = opacities[order].astype(np.float64)

        # 与原项目一致：先把 NDC 均值换到米制，再按协方差重算每个高斯的朝向与尺度
        scale_x = width / (2.0 * focal_px)
        scale_y = height / (2.0 * focal_px)
        means[:, 0] *= scale_x
        means[:, 1] *= scale_y

        payload = _build_gaussian_ply(
            means, scales, quaternions, colors, opacities, scale_x, scale_y
        )
        count = len(means)

        # 全量高斯有几十 MB，直接落盘交给宿主读取，避免 base64 往返
        if output_path:
            directory = os.path.dirname(os.path.abspath(output_path))
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(output_path, "wb") as handle:
                handle.write(payload)
            return PointCloud(b"", count, width, height, focal_px, DEFAULT_FOV)

        return PointCloud(payload, count, width, height, focal_px, DEFAULT_FOV)


def png_base64(array: np.ndarray) -> str:
    return base64.b64encode(encode_png(array)).decode("ascii")
