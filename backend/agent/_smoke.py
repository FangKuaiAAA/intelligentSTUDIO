import asyncio, json
import websockets

async def t():
    async with websockets.connect('ws://127.0.0.1:8767') as ws:
        print('init:', await ws.recv())
        await ws.send(json.dumps({'type': 'alarm-cmd', 'cmd': 'dismiss', 'id': 'x'}))
        await ws.send(json.dumps({'type': 'cancel'}))
        print('cancel:', await ws.recv())

asyncio.run(t())
