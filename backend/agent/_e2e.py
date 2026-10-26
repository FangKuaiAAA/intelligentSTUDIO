import asyncio, json, sys, time
import websockets

MSG = sys.argv[1] if len(sys.argv) > 1 else "现在CPU和内存占用怎么样"

async def t():
    async with websockets.connect('ws://127.0.0.1:8767') as ws:
        t0 = time.time()
        print('init:', await ws.recv())
        await ws.send(json.dumps({'type': 'user-message', 'text': MSG, 'voice': False}))
        async for raw in ws:
            m = json.loads(raw)
            dt = time.time() - t0
            if m['type'] == 'text-chunk':
                print(f"[{dt:5.1f}s] chunk: {m['delta'][:40]!r}")
            elif m['type'] == 'ask':
                print(f"[{dt:5.1f}s] ASK {m['kind']}: {m['text']}")
                await ws.send(json.dumps({'type': 'ask-response', 'id': m['id'], 'approved': True}))
            elif m['type'] == 'done':
                print(f"[{dt:5.1f}s] DONE elapsed={m.get('elapsed_ms')}ms text={m['text'][:120]!r}")
                break
            else:
                print(f"[{dt:5.1f}s] {m['type']}: {json.dumps({k: v for k, v in m.items() if k != 'type'}, ensure_ascii=False)[:200]}")

asyncio.run(t())
