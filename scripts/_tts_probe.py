"""TTS 排查探针：直接调 edge-tts 合成一小段，打印成败与错误类型。"""
import asyncio
import importlib.metadata as md
import sys


async def main() -> None:
    import edge_tts

    print("edge-tts", md.version("edge-tts"), "| python", sys.version.split()[0])
    print("module  ", edge_tts.__file__)
    for voice in ("zh-CN-YunxiNeural", "zh-CN-XiaoxiaoNeural",
                  "en-US-JennyNeural", "en-US-AriaNeural"):
        text = "Hello, this is a test." if voice.startswith("en") else "测试"
        try:
            n = 0
            async for ch in edge_tts.Communicate(text, voice, rate="+15%").stream():
                if ch.get("type") == "audio":
                    n += len(ch["data"])
            print(f"OK   {voice}: audio_bytes={n}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {voice}: {type(e).__name__}: {str(e)[:260]}")


asyncio.run(main())
