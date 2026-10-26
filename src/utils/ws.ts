/** 共享的 Agent WS 连接封装：自动重连、消息分发。 */
export type AgentMessage = { type: string; [k: string]: any }

const AGENT_WS = 'ws://127.0.0.1:8767'

export class AgentSocket {
  private ws: WebSocket | null = null
  private handlers = new Set<(m: AgentMessage) => void>()
  private retry: ReturnType<typeof setTimeout> | null = null
  private queue: object[] = []

  connect() {
    // 幂等：已连接/连接中时直接返回，避免 StrictMode 双执行或 effect 重跑创建重复会话
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    try {
      this.ws = new WebSocket(AGENT_WS)
      this.ws.onopen = () => {
        while (this.queue.length && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(this.queue.shift()))
        }
      }
      this.ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data)
          this.handlers.forEach((h) => h(m))
        } catch {}
      }
      this.ws.onclose = () => {
        this.ws = null
        this.retry = setTimeout(() => this.connect(), 3000)
      }
      this.ws.onerror = () => this.ws?.close()
    } catch {
      this.retry = setTimeout(() => this.connect(), 5000)
    }
  }

  on(fn: (m: AgentMessage) => void) {
    this.handlers.add(fn)
    return () => { this.handlers.delete(fn) }
  }

  send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
    else this.queue.push(o)
  }
}

export const agentSocket = new AgentSocket()
