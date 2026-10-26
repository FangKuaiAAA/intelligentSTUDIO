/**
 * 页面内覆盖层 → background 的通道。
 *
 * 内容脚本不直接联网：截屏（captureVisibleTab 是后台 API）与视觉问答的模型请求
 * 都经 background 转发，页面内只有一个 Port。
 */
import type { ExtEvent } from '../bridge/protocol'

export interface VisionEvent {
  kind: 'delta' | 'done' | 'error'
  delta?: string
  message?: string
}

export class PageBridge {
  private port: chrome.runtime.Port | null = null
  private pendingCapture: { resolve: (dataUrl: string) => void; reject: (e: Error) => void } | null = null
  private listeners = new Set<(ev: VisionEvent) => void>()

  constructor() {
    this.connect()
  }

  private connect(): void {
    const port = chrome.runtime.connect({ name: 'content' })
    this.port = port
    port.onMessage.addListener((message: ExtEvent) => this.handle(message))
    port.onDisconnect.addListener(() => {
      this.port = null
      // 后台被回收：把在途请求标记失败，覆盖层会给出可读提示而不是一直转圈
      const pending = this.pendingCapture
      this.pendingCapture = null
      pending?.reject(new Error('后台连接已断开 · 请重新打开浮窗'))
      this.emit({ kind: 'error', message: '后台连接已断开 · 请重新打开浮窗' })
    })
  }

  private handle(message: ExtEvent): void {
    if (message.kind === 'capture') {
      const pending = this.pendingCapture
      this.pendingCapture = null
      pending?.resolve(message.dataUrl)
      return
    }
    if (message.kind === 'error') {
      const pending = this.pendingCapture
      if (pending) {
        this.pendingCapture = null
        pending.reject(new Error(message.message))
        return
      }
      this.emit({ kind: 'error', message: message.message })
      return
    }
    if (message.kind === 'vision-delta') {
      this.emit({ kind: 'delta', delta: message.delta })
      return
    }
    if (message.kind === 'vision-done') {
      this.emit({ kind: 'done' })
      return
    }
    if (message.kind === 'vision-error') {
      this.emit({ kind: 'error', message: message.message })
    }
  }

  private emit(ev: VisionEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev)
      } catch (e) {
        console.error('[intelligentSTUDIO] 视觉事件回调异常', e)
      }
    }
  }

  onVision(cb: (ev: VisionEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 取当前标签页可见区域的截图（原图，DPR 缩放未处理；归一化在覆盖层里做） */
  capture(): Promise<string> {
    if (!this.port) this.connect()
    if (!this.port) return Promise.reject(new Error('扩展后台不可用'))
    return new Promise<string>((resolve, reject) => {
      // 同一时刻只会有一次截图请求（覆盖层的交互是线性的）
      this.pendingCapture?.reject(new Error('新的截图请求取代了上一次'))
      this.pendingCapture = { resolve, reject }
      this.port!.postMessage({ kind: 'capture' })
      setTimeout(() => {
        if (this.pendingCapture) {
          this.pendingCapture = null
          reject(new Error('截图超时'))
        }
      }, 8000)
    })
  }

  ask(messages: unknown[]): void {
    this.port?.postMessage({ kind: 'vision/ask', messages })
  }

  cancel(): void {
    this.port?.postMessage({ kind: 'vision/cancel' })
  }

  log(message: string): void {
    this.port?.postMessage({ kind: 'log', message })
  }

  close(): void {
    try {
      this.port?.disconnect()
    } catch {
      /* 已断开 */
    }
    this.port = null
  }
}
