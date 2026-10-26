/**
 * 本地桥接服务客户端（只在 background 里运行）。
 *
 * 服务：backend/edge_bridge.py 默认 http://127.0.0.1:8768（可在 chrome.storage.local
 * 的 bridgeBase 里改，仅用于换端口或并行测试的隔离）
 * · token 引导：GET /ext/token（带 x-dony-extension 头，服务端只放行扩展来源）
 * · 扩展通道：WS /ext/ws（注册 + 心跳 + 快照 + 指令回执）
 * · 视觉代理：POST /vision/ask（SSE）
 * · 整理中继：POST /ext/organize（SSE）
 */
import type { OrganizeEvent } from './protocol'

export const DEFAULT_BRIDGE_BASE = 'http://127.0.0.1:8768'

const TOKEN_KEY = 'bridgeToken'
const BASE_KEY = 'bridgeBase'

let memToken = ''
let memBase = ''

/** 规范化地址：允许只写 "127.0.0.1:8771"，补协议并只保留 origin */
function normalizeBase(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`).origin
  } catch {
    return ''
  }
}

/** 桥接服务地址：内存 → chrome.storage → 默认端口 */
export async function getBridgeBase(): Promise<string> {
  if (memBase) return memBase
  const stored = await chrome.storage.local.get(BASE_KEY)
  const saved = typeof stored[BASE_KEY] === 'string' ? normalizeBase(stored[BASE_KEY]) : ''
  memBase = saved || DEFAULT_BRIDGE_BASE
  return memBase
}

/** 改写桥接服务地址（改完需要重连才会生效）；返回实际生效的地址 */
export async function setBridgeBase(raw: string): Promise<string> {
  const next = normalizeBase(raw) || DEFAULT_BRIDGE_BASE
  memBase = next
  await chrome.storage.local.set({ [BASE_KEY]: next })
  return next
}

function wsUrl(base: string): string {
  return `${base.replace(/^http/i, 'ws')}/ext/ws`
}

/** 取 token：内存 → chrome.storage → 向桥接服务配对（失败则抛错由调用方降级提示） */
export async function getToken(force = false): Promise<string> {
  if (!force && memToken) return memToken
  const stored = await chrome.storage.local.get(TOKEN_KEY)
  if (!force && typeof stored[TOKEN_KEY] === 'string' && stored[TOKEN_KEY]) {
    memToken = stored[TOKEN_KEY]
    return memToken
  }
  const base = await getBridgeBase()
  const resp = await fetch(`${base}/ext/token`, {
    headers: { 'x-dony-extension': '1' },
  })
  if (!resp.ok) throw new Error(`配对失败：桥接服务返回 HTTP ${resp.status}`)
  const data = (await resp.json()) as { token?: string }
  if (!data.token) throw new Error('配对失败：桥接服务没有返回 token')
  memToken = data.token
  await chrome.storage.local.set({ [TOKEN_KEY]: memToken })
  return memToken
}

/** 带 token 的请求；token 失效（换机/重置）时自动重新配对一次 */
export async function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await getBridgeBase()
  const headers = new Headers(init.headers)
  headers.set('x-dony-token', await getToken())
  let resp = await fetch(`${base}${path}`, { ...init, headers })
  if (resp.status === 401) {
    headers.set('x-dony-token', await getToken(true))
    resp = await fetch(`${base}${path}`, { ...init, headers })
  }
  return resp
}

/**
 * 读取一条 SSE 流，把 `data:` 里的 JSON 逐个交给 onEvent。
 * 返回是否正常读到结束（网络/服务异常时返回 false，由调用方给出降级提示）。
 */
export async function bridgeStream(
  path: string,
  body: unknown,
  onEvent: (payload: any) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const resp = await bridgeFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok || !resp.body) {
    let detail = `HTTP ${resp.status}`
    try {
      const text = await resp.text()
      if (text) detail = `${detail}：${text.slice(0, 200)}`
    } catch {
      /* 读取失败时保留状态码 */
    }
    onEvent({ type: 'error', message: detail, bridgeError: true })
    return false
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf('\n\n')
    while (idx !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          onEvent(JSON.parse(payload))
        } catch {
          /* 单条脏数据忽略，不影响后续分片 */
        }
      }
      idx = buffer.indexOf('\n\n')
    }
  }
  return true
}

interface SocketHandlers {
  onCommand: (cmd: any) => void
  onStateChange: (connected: boolean, message?: string) => void
}

/**
 * 与桥接服务的扩展通道。断线按 1s/2s/4s… 上限 30s 退避重连；
 * 心跳每 20s 一次，同时兼作 service worker 的保活（见 background）。
 */
export class BridgeSocket {
  private ws: WebSocket | null = null
  private retry = 0
  private timer: number | null = null
  private heartbeat: number | null = null
  private closed = false

  constructor(private handlers: SocketHandlers) {}

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.closed || this.ws) return
    let token = ''
    try {
      token = await getToken()
    } catch {
      // 配对失败基本都是「服务没起」：不要抛 "Failed to fetch" 这种框架语言给用户
      this.handlers.onStateChange(false, '未连接本地服务 · 请启动 intelligentSTUDIO')
      this.schedule()
      return
    }
    const manifest = chrome.runtime.getManifest()
    const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome'
    const ws = new WebSocket(wsUrl(await getBridgeBase()))
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      ws.send(JSON.stringify({
        type: 'register', token, browser, version: manifest.version,
      }))
      this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 20000) as unknown as number
    }
    ws.onmessage = (ev) => {
      let msg: any = null
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'registered') {
        this.handlers.onStateChange(!!msg.ok, msg.ok ? undefined : msg.message)
        if (!msg.ok) {
          const reason = String(msg.message || '')
          // 「已有另一个实例接入」不是本地凭据问题，不能清 token：清了会把唯一可用的凭据也丢掉
          if (!/另一个/.test(reason)) {
            void chrome.storage.local.remove(TOKEN_KEY).then(() => { memToken = '' })
          }
          this.closeSocket()
          this.schedule(5000)
        }
      } else if (msg.type === 'command') {
        this.handlers.onCommand(msg)
      }
    }
    ws.onclose = () => {
      this.handlers.onStateChange(false, '本地服务已断开')
      this.closeSocket()
      this.schedule()
    }
    ws.onerror = () => {
      // onerror 之后必然跟随 onclose，这里不重复处理
    }
  }

  send(message: unknown): boolean {
    if (!this.connected) return false
    try {
      this.ws!.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private closeSocket() {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  private schedule(minDelay?: number) {
    if (this.closed || this.timer !== null) return
    const delay = minDelay ?? Math.min(30000, 1000 * 2 ** this.retry)
    this.retry = Math.min(this.retry + 1, 5)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delay) as unknown as number
  }

  dispose() {
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.closeSocket()
  }
}
