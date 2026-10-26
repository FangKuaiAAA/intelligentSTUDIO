/**
 * 共享运行时里的事件总线：功能区（ExecuteFunction）与窗格（React）跑在同一个 JS 运行时，
 * 所以一个模块级单例就够了，不需要 postMessage，也不需要轮询。
 *
 * 为什么要有待发队列：功能区按钮可以**在窗格关闭时**被点（例如「预览原文」先唤起窗格、
 * 再投递事件）。若先 emit 后挂载，事件就丢了。这里在无订阅者时把事件压进队列，
 * 窗格挂载后一次性取走；队列封顶 8 条，避免长期关闭窗格时无限堆积。
 */

export type BusEvent =
  | { kind: 'notice'; text: string; tone: 'info' | 'error' | 'success' }
  | { kind: 'reveal-original' }
  | { kind: 'focus-writing' }

type Listener = (e: BusEvent) => void

const MAX_PENDING = 8
const listeners = new Set<Listener>()
let pending: BusEvent[] = []

export function emit(e: BusEvent): void {
  if (listeners.size > 0) {
    listeners.forEach((fn) => fn(e))
    return
  }
  pending.push(e)
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING)
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  if (pending.length) {
    const rest = pending
    pending = []
    rest.forEach((e) => fn(e))
  }
  return () => listeners.delete(fn)
}
