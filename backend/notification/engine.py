"""本地 Qwen2.5-0.5B INT4 推理会话（onnxruntime-genai，CPU）。

重要性与摘要共用同一份模型，推理用锁串行，避免两个任务互相挤占内存。
超时在推理线程内部按截止时间判断，避免取消线程后仍在使用模型。
"""

import asyncio
import gc
import json
import time
from typing import Optional

from . import config


class InferenceTimeout(Exception):
    pass


class QwenEngine:
    def __init__(self, model_dir: str = config.MODEL_DIR):
        self.model_dir = model_dir
        self._model = None
        self._tokenizer = None
        self._lock = asyncio.Lock()
        self._loaded_at = 0.0
        self._last_used = 0.0
        self._busy = 0
        self._loading = False
        self._error = ""
        self._load_count = 0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def status(self) -> dict:
        files = config.model_files_ready(self.model_dir)
        return {
            "ready": files["ready"],
            "loaded": self.loaded,
            "model_dir": self.model_dir,
            "missing": [name for name, ok in files.items()
                        if name not in ("dir", "ready") and not ok],
            "error": self._error,
            "load_count": self._load_count,
        }

    def _load_sync(self) -> None:
        import onnxruntime_genai as og

        started = time.perf_counter()
        # 先记时间戳：加载期间 housekeeping 可能并发检查，未初始化的时间戳会被误判为「空闲很久」
        self._last_used = time.time()
        self._model = og.Model(self.model_dir)
        self._tokenizer = og.Tokenizer(self._model)
        self._loaded_at = time.time()
        self._last_used = self._loaded_at
        self._load_count += 1
        self._error = ""
        print(f"[notify] model loaded in {time.perf_counter() - started:.2f}s", flush=True)

    def _run_sync(self, messages: list[dict], max_new_tokens: int,
                  sample: bool, deadline: float) -> str:
        import onnxruntime_genai as og

        assert self._model is not None and self._tokenizer is not None
        prompt = self._tokenizer.apply_chat_template(
            json.dumps(messages, ensure_ascii=False), add_generation_prompt=True,
        )
        prompt_tokens = self._tokenizer.encode(prompt)
        params = og.GeneratorParams(self._model)
        params.set_search_options(
            do_sample=sample,
            max_length=len(prompt_tokens) + max_new_tokens,
            temperature=0.7 if sample else 0.0,
            top_p=0.9,
            repetition_penalty=1.05,
        )
        generator = og.Generator(self._model, params)
        generator.append_tokens(prompt_tokens)
        while not generator.is_done():
            if time.time() > deadline:
                raise InferenceTimeout()
            generator.generate_next_token()
        sequence = generator.get_sequence(0)
        generated = sequence[len(prompt_tokens):]
        return self._tokenizer.decode(generated).strip()

    async def generate(self, messages: list[dict], max_new_tokens: int,
                       timeout: float, sample: bool = False) -> str:
        async with self._lock:
            if self._model is None:
                self._loading = True
                try:
                    await asyncio.to_thread(self._load_sync)
                except Exception as exc:
                    self._error = f"{type(exc).__name__}: {exc}"
                    raise
                finally:
                    self._loading = False
            self._busy += 1
            self._last_used = time.time()
            deadline = time.time() + timeout
            try:
                return await asyncio.to_thread(
                    self._run_sync, messages, max_new_tokens, sample, deadline,
                )
            except InferenceTimeout:
                self._error = f"timeout>{timeout:.1f}s"
                raise
            finally:
                self._busy -= 1
                self._last_used = time.time()

    def _drop(self) -> None:
        self._model = None
        self._tokenizer = None
        gc.collect()
        print("[notify] model unloaded (idle)", flush=True)

    async def maybe_unload(self, now: float, idle_seconds: float, max_hold: float) -> bool:
        # 与 generate 共用同一把锁：推理/加载期间不判空闲，结束后按最新时间戳重新判断
        async with self._lock:
            if self._model is None or self._loading or self._busy > 0:
                return False
            idle = now - self._last_used
            held = now - self._loaded_at
            if idle < idle_seconds and held < max_hold:
                return False
            print(
                f"[notify] unload: idle={idle:.0f}s held={held:.0f}s "
                f"limit=({idle_seconds:.0f},{max_hold:.0f})",
                flush=True,
            )
            self._drop()
            return True

    async def unload(self) -> None:
        async with self._lock:
            if self._model is None:
                return
            self._drop()
