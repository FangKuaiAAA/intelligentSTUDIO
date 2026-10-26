"""通知重要性判定：bge-small-zh 句向量 + 最近示例（kNN），纯模型判断。

模型体积约 24 MB（INT8 ONNX），单条 5～8 ms，不依赖 torch。
类别向量由 scripts/build_notification_classifier.py 从示例集离线计算并写入
models/bge-small-zh-v1.5/classifier.json；运行时不使用关键词或规则。
"""

import asyncio
import json
import os
import time
from typing import Optional

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from . import config
from .listener import Incoming

MAX_CHARS = 300


class EmbeddingClassifier:
    def __init__(self, model_dir: str = config.CLASSIFIER_DIR):
        self.model_dir = model_dir
        self._session = None
        self._tokenizer = None
        self._positive = None
        self._negative = None
        self._threshold = 0.0
        self._input_names: set[str] = set()
        self._lock = asyncio.Lock()
        self._last_used = 0.0
        self._error = ""
        self._loads = 0

    @property
    def loaded(self) -> bool:
        return self._session is not None

    def files(self) -> dict:
        return config.classifier_files_ready(self.model_dir)

    def status(self) -> dict:
        info = self.files()
        return {
            "ready": info["ready"],
            "loaded": self.loaded,
            "model_dir": self.model_dir,
            "missing": [name for name, ok in info.items()
                        if name not in ("dir", "ready") and not ok],
            "error": self._error,
            "threshold": self._threshold,
            "loads": self._loads,
        }

    def _load_sync(self) -> None:
        info = self.files()
        if not info["ready"]:
            raise FileNotFoundError("分类模型文件不完整")
        started = time.perf_counter()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        self._session = ort.InferenceSession(
            os.path.join(self.model_dir, "onnx", "model_quantized.onnx"),
            sess_options=options, providers=["CPUExecutionProvider"],
        )
        self._input_names = {item.name for item in self._session.get_inputs()}
        self._tokenizer = Tokenizer.from_file(os.path.join(self.model_dir, "tokenizer.json"))
        self._tokenizer.enable_truncation(max_length=128)
        self._tokenizer.enable_padding(length=128)
        with open(os.path.join(self.model_dir, "classifier.json"), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self._positive = np.atleast_2d(np.asarray(payload["positive"], dtype=np.float32))
        self._negative = np.atleast_2d(np.asarray(payload["negative"], dtype=np.float32))
        self._threshold = float(payload.get("threshold", 0.0))
        self._last_used = time.time()
        self._loads += 1
        self._error = ""
        print(
            f"[notify] classifier loaded in {time.perf_counter() - started:.2f}s "
            f"threshold={self._threshold:+.3f}",
            flush=True,
        )

    def _embed_sync(self, text: str) -> np.ndarray:
        encoding = self._tokenizer.encode(text)
        inputs = {
            "input_ids": np.array([encoding.ids], dtype=np.int64),
            "attention_mask": np.array([encoding.attention_mask], dtype=np.int64),
        }
        if "token_type_ids" in self._input_names:
            inputs["token_type_ids"] = np.array([encoding.type_ids], dtype=np.int64)
        vector = self._session.run(None, inputs)[0][0, 0]
        norm = float(np.linalg.norm(vector))
        return vector / (norm + 1e-9)

    def _score_sync(self, text: str) -> float:
        # kNN：与「最像的一条正例」和「最像的一条负例」比较，避免质心被平均稀释
        vector = self._embed_sync(text)
        return float((self._positive @ vector).max() - (self._negative @ vector).max())

    async def classify(self, item: Incoming, timeout: float) -> Optional[bool]:
        # 只用标题+正文：类别向量按同样方式构建；应用名（可能是任意字符串）只作展示
        text = f"{item.title} {item.body}".strip()
        if not text:
            text = item.app
        text = text[:MAX_CHARS]
        async with self._lock:
            if self._session is None:
                try:
                    await asyncio.to_thread(self._load_sync)
                except Exception as exc:
                    self._error = f"{type(exc).__name__}: {exc}"
                    print(f"[notify] classifier unavailable: {self._error}", flush=True)
                    return None
            self._last_used = time.time()
            try:
                score = await asyncio.to_thread(self._score_sync, text)
            except Exception as exc:
                self._error = f"{type(exc).__name__}: {exc}"
                print(f"[notify] classify failed: {self._error}", flush=True)
                return None
        important = score >= self._threshold
        print(
            f"[notify] classify app={item.app} score={score:+.3f} "
            f"threshold={self._threshold:+.3f} important={important}",
            flush=True,
        )
        return important

    async def maybe_unload(self, now: float, idle_seconds: float) -> bool:
        async with self._lock:
            if self._session is None:
                return False
            if now - self._last_used < idle_seconds:
                return False
            self._session = None
            self._tokenizer = None
            self._positive = None
            self._negative = None
            print("[notify] classifier unloaded (idle)", flush=True)
            return True

    async def unload(self) -> None:
        async with self._lock:
            self._session = None
            self._tokenizer = None
            self._positive = None
            self._negative = None


classifier = EmbeddingClassifier()
