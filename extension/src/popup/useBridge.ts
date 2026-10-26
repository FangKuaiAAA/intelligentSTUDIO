/**
 * 浮窗与 background 的通道（Port）+ 整理过程的状态归约。
 *
 * 浮窗不直接联网、不接触 token：所有请求都发给 background，事件再由它回流。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BridgeKind, BridgeStatus, ExtEvent, ExtRequest, OrganizeCard, OrganizeEvent, VisualMode,
} from '../bridge/protocol'

export interface TimelineRow {
  id: number
  text: string
  tone: 'mode' | 'plan' | 'tool' | 'fail'
  active: boolean
}

export interface LogRow {
  id: number
  time: string
  text: string
}

export interface OrganizeState {
  running: boolean
  target: BridgeKind | null
  mode: '' | 'fast' | 'task'
  plan: string[]
  timeline: TimelineRow[]
  answer: string
  cards: OrganizeCard[]
  ask: { id: string; kind: string; text: string } | null
  error: string
  done: boolean
  elapsedMs: number
}

export interface Notice {
  tone: 'ok' | 'error'
  text: string
}

const emptyOrganize = (): OrganizeState => ({
  running: false, target: null, mode: '', plan: [], timeline: [],
  answer: '', cards: [], ask: null, error: '', done: false, elapsedMs: 0,
})

let seq = 0
const nextId = () => (seq += 1)

function pushRow(rows: TimelineRow[], text: string, tone: TimelineRow['tone'], active = false): TimelineRow[] {
  return [...rows.map((r) => (r.active ? { ...r, active: false } : r)), { id: nextId(), text, tone, active }]
}

function reduce(state: OrganizeState, evt: OrganizeEvent): OrganizeState {
  switch (evt.type) {
    case 'mode':
      return {
        ...state,
        mode: evt.mode === 'task' ? 'task' : 'fast',
        timeline: pushRow(state.timeline,
          evt.mode === 'task' ? '判断为任务模式，开始规划' : '判断为快速模式，直接执行', 'mode'),
      }
    case 'plan': {
      const steps = evt.steps ?? []
      return {
        ...state,
        plan: steps,
        timeline: pushRow(state.timeline, `计划 ${steps.length} 步：${steps.join('；')}`, 'plan'),
      }
    }
    case 'tool-start':
      return {
        ...state,
        timeline: pushRow(state.timeline, `正在执行：${evt.label || evt.name || '操作'}`, 'tool', true),
      }
    case 'tool-end':
      return {
        ...state,
        timeline: state.timeline.map((r) =>
          r.active ? { ...r, active: false, tone: evt.ok === false ? 'fail' : r.tone } : r),
      }
    case 'cards':
      return { ...state, cards: [...state.cards, ...(evt.cards ?? [])] }
    case 'ask':
      return { ...state, ask: { id: evt.id ?? '', kind: evt.kind ?? 'question', text: evt.text ?? '' } }
    case 'ask-resolved':
      return { ...state, ask: null }
    case 'text-reset':
      return state
    case 'done':
      return {
        ...state,
        running: false,
        done: true,
        answer: evt.text || state.answer,
        elapsedMs: evt.elapsed_ms ?? 0,
        timeline: pushRow(state.timeline, '整理完成', 'tool'),
      }
    case 'error':
      return { ...state, running: false, error: evt.message || '整理失败' }
    case 'cancelled':
      return { ...state, running: false, error: '已取消' }
    default:
      return state
  }
}

export function useBridge() {
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [organize, setOrganize] = useState<OrganizeState>(emptyOrganize)
  const [logs, setLogs] = useState<LogRow[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)

  const log = useCallback((text: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs((prev) => [{ id: nextId(), time, text }, ...prev].slice(0, 40))
  }, [])

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'popup' })
    portRef.current = port
    port.onMessage.addListener((event: ExtEvent) => {
      switch (event.kind) {
        case 'status':
          setStatus(event.status)
          return
        case 'organize-event':
          setOrganize((prev) => reduce(prev, event.event))
          return
        case 'ok':
          if (event.message) {
            setNotice({ tone: 'ok', text: event.message })
            log(event.message)
          }
          return
        case 'error':
          setNotice({ tone: 'error', text: event.message })
          log(`错误：${event.message}`)
          return
        default:
          return
      }
    })
    port.onDisconnect.addListener(() => {
      portRef.current = null
      setStatus((prev) => (prev ? { ...prev, ok: false, message: '后台连接已断开' } : prev))
    })
    log('已连接后台')
    return () => {
      port.disconnect()
      portRef.current = null
    }
  }, [log])

  const send = useCallback((request: ExtRequest) => {
    portRef.current?.postMessage(request)
  }, [])

  const refreshStatus = useCallback(() => {
    send({ kind: 'status' })
  }, [send])

  const reconnect = useCallback(() => {
    log('请求重新连接本地桥接服务')
    send({ kind: 'reconnect' })
  }, [log, send])

  const startVisual = useCallback((mode: VisualMode) => {
    log(mode === 'page' ? '视觉智能 · 整页' : '视觉智能 · 框选')
    send({ kind: 'visual/start', mode })
  }, [log, send])

  const startOrganize = useCallback((target: BridgeKind, requirement: string) => {
    setOrganize({ ...emptyOrganize(), running: true, target })
    setNotice(null)
    log(target === 'tabs' ? '开始整理标签页' : '开始整理收藏夹')
    send({ kind: 'organize', target, request: requirement })
  }, [log, send])

  const answerAsk = useCallback((id: string, answer: { text?: string; approved?: boolean }) => {
    setOrganize((prev) => ({ ...prev, ask: null }))
    send({ kind: 'organize/answer', id, ...answer })
    log(answer.approved === undefined ? '已提交回答' : `已选择：${answer.approved ? '允许' : '不允许'}`)
  }, [log, send])

  const cancelOrganize = useCallback(() => {
    send({ kind: 'organize/cancel' })
    setOrganize((prev) => ({ ...prev, running: false, ask: null, error: '已取消本次整理。' }))
    log('已取消本次整理')
  }, [log, send])

  const resetOrganize = useCallback(() => setOrganize(emptyOrganize()), [])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return {
    status, organize, logs, notice,
    refreshStatus, reconnect, startVisual,
    startOrganize, answerAsk, cancelOrganize, resetOrganize, dismissNotice, log,
  }
}

export type BridgeController = ReturnType<typeof useBridge>
