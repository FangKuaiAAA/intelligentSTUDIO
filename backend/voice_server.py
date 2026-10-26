"""
APPXInteligent Voice Server
sherpa-onnx ASR (TMSpeech engine) + Edge TTS via WebSocket.
"""
import asyncio, json, os, sys, time, queue, tempfile, threading, base64
from typing import Dict, Optional
import numpy as np

def _tts_settings():
    """动态读取 TTS 开关与音色（Dony 应用可随时修改，无需重启）。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from agent import store
        return store.tts_enabled(), store.tts_voice()
    except Exception:
        return True, os.getenv("TTS_VOICE", "zh-CN-YunxiNeural")


TTS_VOICE   = _tts_settings()[1]  # 启动时快照，实际合成前会重新读取
# 在听但始终没听到任何内容时的上限：超时通知前端收起界面。
# 不这样做的话界面会一直停在「在听」状态，主进程仍认为界面已唤醒，
# 后续所有快捷键都会被静默忽略（表现为「说话没反应」「Alt+D 偶发失效」）。
IDLE_TIMEOUT_SEC = 8.0

def _tts_rate() -> str:
    """语速：与 Dony 应用设置页的试听朗读共用同一个来源（store.TTS_RATE）。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from agent import store
        return store.TTS_RATE
    except Exception:
        return os.getenv("TTS_RATE", "+15%")
SILENCE_SEC = 2.0
SAMPLE_RATE = 16000
FRAME_SIZE  = 512
# 音量归一化的"满格"参考值（int16 的 rms）：约 -27dBFS。调大 = 更迟钝，调小 = 更容易拉满。
LEVEL_FULL_SCALE = 1500.0

MODEL_DIR = os.getenv("SHERPA_MODEL_DIR",
    os.path.join(os.path.dirname(__file__) or ".", "..", "models",
                 "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"))

_pyaudio = None; _edge_tts = None

def _get_pyaudio():
    global _pyaudio
    if _pyaudio is None:
        try: import pyaudio; _pyaudio = pyaudio
        except ImportError as e:
            print(f"[voice] PyAudio 未安装：语音输入(麦克风)不可用 → {e}", flush=True)
            print("[voice] 请用运行本服务的解释器执行: pip install pyaudio", flush=True)
            _pyaudio = False
    return _pyaudio

def _get_edge_tts():
    global _edge_tts
    if _edge_tts is None:
        try: import edge_tts; _edge_tts = edge_tts
        except ImportError as e:
            print(f"[voice] edge-tts 未安装：语音朗读(TTS)不可用 → {e}", flush=True)
            _edge_tts = False
    return _edge_tts

def analyse_audio(samples: bytes) -> dict:
    data = np.frombuffer(samples, dtype=np.int16).astype(np.float64); n = len(data)
    if n == 0: return {"level":0,"low":0,"high":0}
    # 音量：**饱和点**定在 rms ≈ 1500（约 -27dBFS，正常说话的高段）。
    # ⚠ 原来写的是 `min(1, rms/1000)` 再 `*6` —— 两次夹取叠加后等效于 rms≈167
    #   （约 -46dBFS）就封顶，几乎任何说话声都在rms 之上 ⇒ 前端永远只收到 0 或 1，
    #   光边只能"满格 / 归零"地跳、没有中间层次（用户实测："跳一下"）。
    #   归一化只做一次 —— 前端不再叠第二重增益（见 RainbowEdges 的采样 effect）。
    rms = float(np.sqrt(np.mean(data**2))); level = min(1.0, rms/LEVEL_FULL_SCALE)
    fft = np.abs(np.fft.rfft(data)); freqs = np.fft.rfftfreq(n, 1.0/SAMPLE_RATE)
    lo = (freqs>=80)&(freqs<=500); hi = (freqs>500)&(freqs<=4000)
    low_e = float(np.mean(fft[lo])) if np.any(lo) else 0
    high_e = float(np.mean(fft[hi])) if np.any(hi) else 0
    # low/high 是"低频与高频哪边更强"的**相对**比例（不是音量大小）：
    # 强的那边固定给到 ~1.0，弱的那边按比例缩小。前端只拿它做"轻微倾斜"，不再当幅度用。
    mv = max(low_e, high_e, 1)
    return {"level":level,"low":min(1.0,(low_e/mv)*6.0) if mv else 0,"high":min(1.0,(high_e/mv)*6.0) if mv else 0}

class VoiceServer:
    def __init__(self):
        self.state = "idle"
        self.cmd_q: queue.Queue = queue.Queue()
        self._stream = None; self._pa = None
        self._running = False; self._audio_thread_started = False
        self._last_speech = 0.0; self._text = ""; self._partial = ""
        self._listen_started = 0.0      # 本次「在听」的开始时间（用于静默超时）
        self._tts_task = None; self._text_lock = threading.Lock()
        # 每个连接一条发送队列；事件只发给当前操作者，避免多连接互相抢事件
        self._clients: Dict[int, queue.Queue] = {}
        self._primary: Optional[int] = None
        self._clients_lock = threading.Lock()

        self._recognizer = None
        self._sherpa_stream = None
        self._last_hypothesis = ""

    def _emit(self, msg: dict):
        """把事件发给「当前操作者」那个连接（没有就用全部连接）。"""
        text = json.dumps(msg, ensure_ascii=False)
        with self._clients_lock:
            primary = self._clients.get(self._primary) if self._primary is not None else None
            targets = [primary] if primary is not None else list(self._clients.values())
        for q in targets:
            q.put(text)

    def _init_recognizer(self):
        import sherpa_onnx
        tokens_f = os.path.join(MODEL_DIR, "tokens.txt")
        # Try int8 quantized files first (smaller/faster), fall back to fp32
        encoder_f = os.path.join(MODEL_DIR, "encoder-epoch-99-avg-1.int8.onnx")
        if not os.path.exists(encoder_f):
            encoder_f = os.path.join(MODEL_DIR, "encoder-epoch-99-avg-1.onnx")
        decoder_f = os.path.join(MODEL_DIR, "decoder-epoch-99-avg-1.onnx")
        joiner_f = os.path.join(MODEL_DIR, "joiner-epoch-99-avg-1.int8.onnx")
        if not os.path.exists(joiner_f):
            joiner_f = os.path.join(MODEL_DIR, "joiner-epoch-99-avg-1.onnx")

        for f in [tokens_f, encoder_f, decoder_f, joiner_f]:
            if not os.path.exists(f):
                raise FileNotFoundError(f"Model file not found: {f}")

        self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens_f, encoder=encoder_f, decoder=decoder_f, joiner=joiner_f,
            num_threads=2, sample_rate=16000, feature_dim=80,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=300,
            decoding_method="greedy_search", max_active_paths=4, provider="cpu",
        )

    def _open_mic(self) -> bool:
        """打开麦克风：始终使用系统默认输入设备（input_device_index=None）。"""
        try:
            if self._stream is not None:
                try: self._stream.stop_stream(); self._stream.close()
                except Exception: pass
                self._stream = None
            if self._pa is None:
                pa = _get_pyaudio()
                if not pa: return False
                self._pa = pa.PyAudio()
            try:
                info = self._pa.get_default_input_device_info()
                print(f"[voice] 使用系统默认麦克风: {info.get('name')} "
                      f"(index={info.get('index')}, 声道={info.get('maxInputChannels')})", flush=True)
            except Exception as e:
                print(f"[voice] 读取系统默认麦克风信息失败: {e}", flush=True)
            self._stream = self._pa.open(
                format=self._pa.get_format_from_width(2), channels=1,
                rate=SAMPLE_RATE, input=True, frames_per_buffer=FRAME_SIZE,
                input_device_index=None)  # None = 跟随 Windows 默认录音设备
            print("[voice] Mic opened (system default)", flush=True)
            return True
        except Exception as e:
            print(f"[voice] Mic error: {e}", flush=True)
            self._stream = None
            return False

    def _audio_loop(self):
        if not _get_pyaudio(): return
        # 麦克风打开失败不致命：主循环会持续按系统默认设备重试（用户可能稍后接入设备）
        self._open_mic()

        # Init sherpa-onnx
        try:
            self._init_recognizer()
        except Exception as e:
            print(f"[voice] sherpa-onnx init failed: {e}", flush=True)
            print(f"[voice] Model dir: {MODEL_DIR}", flush=True)
            if self._stream: self._stream.close()
            if self._pa: self._pa.terminate()
            return

        print("[voice] Ready (sherpa-onnx/TMSpeech)", flush=True)
        self._running = True

        fails = 0
        while self._running:
            try:
                pcm = self._stream.read(FRAME_SIZE, exception_on_overflow=False)
                fails = 0
            except (OSError, AttributeError):
                fails += 1
                # 读取连续失败（设备被拔出/切换）：按系统默认设备重开
                if fails >= 50:
                    fails = 0
                    print("[voice] Mic 读取失败，尝试按系统默认设备重开", flush=True)
                    self._open_mic()
                time.sleep(0.01); continue
            self._process_cmds()

            if self.state == "listening":
                # 单帧出错不能让整条音频线程死掉：线程一旦退出，语音功能会静默失效
                # （界面照常亮着，但再也不会识别），这里必须兜住并继续。
                try:
                    self._feed_listening(pcm)
                except Exception as e:
                    print(f"[voice] 识别出错（跳过这一帧继续）: {type(e).__name__}: {e}", flush=True)
                    time.sleep(0.02)

            elif self.state == "speaking":
                t = time.time()
                self._emit({"type":"audio-analysis","level":min(1.0,0.5+abs(np.sin(t*6))*0.5),
                    "low":min(1.0,0.4+abs(np.sin(t*4))*0.6),"high":min(1.0,0.4+abs(np.sin(t*5))*0.6)})

        if self._stream: self._stream.stop_stream(); self._stream.close()
        if self._pa: self._pa.terminate()
        if self._sherpa_stream: self._sherpa_stream = None

    def _feed_listening(self, pcm: bytes):
        """处理一帧「在听」时的音频：识别、转发文本、静默提交/静默超时。"""
        self._emit({"type":"audio-analysis", **analyse_audio(pcm)})

        # Convert int16 PCM to float32 for sherpa-onnx
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        self._sherpa_stream.accept_waveform(SAMPLE_RATE, samples)
        while self._recognizer.is_ready(self._sherpa_stream):
            self._recognizer.decode_stream(self._sherpa_stream)

        is_endpoint = self._recognizer.is_endpoint(self._sherpa_stream)
        hypothesis = self._recognizer.get_result(self._sherpa_stream)

        if hypothesis and hypothesis != self._last_hypothesis:
            self._last_hypothesis = hypothesis
            with self._text_lock:
                display = (self._text + hypothesis) if self._text else hypothesis
                self._last_speech = time.time()
            self._emit({"type":"partial-result","text":display})
            self._partial = hypothesis

        if is_endpoint and hypothesis:
            with self._text_lock:
                self._text = (self._text + hypothesis) if self._text else hypothesis
                self._partial = ""
            self._last_hypothesis = ""
            self._recognizer.reset(self._sherpa_stream)
            self._emit({"type":"final-result","text":self._text})

        # 听到内容后的静默自动提交
        with self._text_lock:
            has_text = bool(self._text.strip() or self._partial.strip())
        if has_text and time.time() - self._last_speech >= SILENCE_SEC:
            with self._text_lock:
                submit = self._text.strip() or self._partial.strip()
                self._text = ""; self._partial = ""; self._last_hypothesis = ""
            if submit:
                print(f"[voice] Submit: {submit}", flush=True)
                self._emit({"type":"silence-timeout","text":submit})
                self._stop_recognition(); self.state = "submitted"
            return

        # 一直没有听到任何内容：超时收起界面（前端会据此复位，避免快捷键被吞）
        if not has_text and self._listen_started and \
                time.time() - self._listen_started >= IDLE_TIMEOUT_SEC:
            print(f"[voice] {IDLE_TIMEOUT_SEC:.0f} 秒没有听到内容，收起界面", flush=True)
            self._listen_started = 0.0
            self._emit({"type":"silence-timeout","text":""})
            self._stop_recognition(); self.state = "idle"

    def _start_recognition(self) -> bool:
        if not self._recognizer:
            print("[voice] Recognizer not ready（识别模型未就绪，无法开始收听）", flush=True)
            return False
        self._sherpa_stream = self._recognizer.create_stream()
        self._last_hypothesis = ""
        print("[voice] Recognition started (sherpa-onnx)", flush=True)
        return True

    def _stop_recognition(self):
        if self._sherpa_stream:
            self._recognizer.reset(self._sherpa_stream)
            self._sherpa_stream = None
        self._last_hypothesis = ""

    def _process_cmds(self):
        try:
            while True: self._handle_cmd(self.cmd_q.get_nowait())
        except queue.Empty: pass

    def _handle_cmd(self, cmd):
        t = cmd.get("type","")
        if t == "start-listening":
            # 识别没起来就别进入 listening：否则接下来每帧都会对着空流操作，
            # 音频线程会直接崩掉，语音从此静默失效。
            if self._start_recognition():
                self.state = "listening"
                with self._text_lock: self._text = ""; self._partial = ""
                self._last_speech = time.time()
                self._listen_started = time.time()
                self._emit({"type":"listening-started"})
            else:
                self.state = "idle"
                self._listen_started = 0.0
                self._emit({"type":"cancelled"})   # 前端据此复位，不留下卡住的界面
        elif t == "stop-listening":
            self._stop_recognition(); self.state = "submitted"
            self._listen_started = 0.0
            self._emit({"type":"listening-stopped"})
        elif t == "cancel":
            self._stop_recognition(); self.state = "idle"
            with self._text_lock: self._text = ""; self._partial = ""
            self._last_hypothesis = ""
            self._listen_started = 0.0
            self._emit({"type":"cancelled"})

    async def handle_ws(self, ws):
        """一个连接一条发送队列：事件只发给「当前正在操作的那个客户端」。

        以前所有连接共用一条 send_q，谁的 writer 先取走就算谁的：
        界面一刷新/重连（旧连接还没断），新界面就再也收不到识别结果，
        表现就是「说话没反应」。现在按连接分开，并让最近发过命令的连接优先。
        """
        cid = id(ws)
        out_q: queue.Queue = queue.Queue()
        with self._clients_lock:
            self._clients[cid] = out_q
            if self._primary is None:
                self._primary = cid

        enabled, _voice = _tts_settings()
        await ws.send(json.dumps({"type":"init","tts":bool(_get_edge_tts()) and enabled,
                                  "model":"sherpa-onnx"}))

        async def reader():
            try:
                async for raw in ws:
                    try: cmd = json.loads(raw)
                    except: continue
                    ct = cmd.get("type","")
                    if ct == "start-tts":
                        self.state = "speaking"
                        self._tts_task = asyncio.create_task(self._do_tts(ws, cmd.get("text","")))
                    elif ct == "stop-tts":
                        if self._tts_task: self._tts_task.cancel(); self._tts_task = None
                        self.state = "submitted"; self._emit({"type":"tts-done"})
                    else:
                        # 发过命令的连接就是此刻在用的界面（新连接会自然接管）
                        with self._clients_lock: self._primary = cid
                        self.cmd_q.put(cmd)
            except Exception:
                pass          # 连接断开：由 finally 负责清理

        async def writer():
            while True:
                try:
                    while True: await ws.send(out_q.get_nowait())
                except queue.Empty:
                    pass
                except Exception:
                    break     # 连接已断开，不再往里写
                await asyncio.sleep(0.02)

        try:
            await asyncio.gather(reader(), writer())
        finally:
            with self._clients_lock:
                self._clients.pop(cid, None)
                if self._primary == cid:
                    self._primary = None

    async def _do_tts(self, ws, text):
        edge = _get_edge_tts()
        if not text or not edge: self._emit({"type":"tts-error"}); self.state = "submitted"; return
        # 每次朗读前重新读取设置：Dony 应用里改开关/音色后立即生效
        enabled, voice = _tts_settings()
        if not enabled:
            self._emit({"type":"tts-done"}); self.state = "submitted"; return
        tmp = None
        try:
            tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False); tmp.close()
            await edge.Communicate(text, voice, rate=_tts_rate()).save(tmp.name)
            with open(tmp.name,"rb") as f: b64 = base64.b64encode(f.read()).decode()
            await ws.send(json.dumps({"type":"tts-audio","data":b64}))
            await asyncio.sleep(max(2, len(text)/4.6))
            self._emit({"type":"tts-done"})
        except asyncio.CancelledError: pass
        except Exception as e: self._emit({"type":"tts-error","message":str(e)})
        finally:
            if tmp and os.path.exists(tmp.name):
                try: os.unlink(tmp.name)
                except: pass
            if self.state == "speaking": self.state = "submitted"

async def main():
    server = VoiceServer()
    server._running = True
    threading.Thread(target=server._audio_loop, daemon=True).start()
    import websockets
    print(f"[voice-server] ws://127.0.0.1:8766 (sherpa-onnx) TTS音色={TTS_VOICE}", flush=True)
    async with websockets.serve(server.handle_ws, "127.0.0.1", 8766): await asyncio.Future()

def port_in_use(port: int) -> bool:
    """端口是否已被监听（重复启动时友好退出，而不是抛 bind 10048 错误）。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    if port_in_use(8766):
        print("[voice-server] 8766 已在运行，本次启动跳过", flush=True)
        raise SystemExit(0)
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
