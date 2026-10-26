import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface NotifyItem {
  kind: 'important' | 'summary'
  id: string | number
  app: string
  title: string
  body: string
  at: number
}

interface Payload {
  items: NotifyItem[]
  lifetime?: number
}

const DEFAULT_LIFETIME = 8000
const FLY_IN = { duration: 0.42, ease: [0.16, 1, 0.3, 1] as const }
const FLY_OUT = { duration: 0.18, ease: [0.4, 0, 1, 1] as const }
const FADE_OUT = { duration: 0.16, ease: 'easeOut' as const }

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

function formatTime(value: number) {
  const date = new Date(value)
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function NotifyCard({ item, lifetime, onDismiss }: {
  item: NotifyItem
  lifetime: number
  onDismiss: (id: string | number) => void
}) {
  const [paused, setPaused] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const remaining = useRef(lifetime)
  const startedAt = useRef(Date.now())
  // 每张卡片的彩虹起始角度随机，避免每次看起来一模一样
  const hue = useMemo(() => `${Math.floor(Math.random() * 360)}deg`, [])

  useEffect(() => {
    if (paused || leaving) return
    startedAt.current = Date.now()
    const timer = window.setTimeout(() => setLeaving(true), Math.max(600, remaining.current))
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(600, remaining.current - (Date.now() - startedAt.current))
    }
  }, [paused, leaving, item.id])

  return (
    <motion.div
      className={`notify-card notify-${item.kind}`}
      style={{ '--notify-hue': hue } as CSSProperties}
      initial={{ x: 70, opacity: 0 }}
      animate={leaving ? { x: 96, opacity: 0 } : { x: 0, opacity: 1 }}
      exit={{ opacity: 0, transition: FADE_OUT }}
      transition={leaving ? FLY_OUT : FLY_IN}
      onAnimationComplete={() => { if (leaving) onDismiss(item.id) }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => setLeaving(true)}
      role="button"
      tabIndex={0}
      aria-label={`${item.app} ${item.title}`}
    >
      <span className="notify-glow" aria-hidden="true" />
      <div className="notify-surface">
        <div className="notify-head">
          <span className="notify-bell"><BellIcon /></span>
          <span className="notify-badge">{item.kind === 'important' ? '重要通知' : '通知摘要'}</span>
          <span className="notify-app">{item.app}</span>
          <span className="notify-time">{formatTime(item.at)}</span>
        </div>
        <div className="notify-title">{item.title || item.app}</div>
        <div className="notify-body">{item.body || '点击查看详情'}</div>
      </div>
    </motion.div>
  )
}

export default function NotifyApp() {
  const [items, setItems] = useState<NotifyItem[]>([])
  const [lifetime, setLifetime] = useState(DEFAULT_LIFETIME)
  const dismissRef = useRef<(id: string | number) => void>(() => {})

  dismissRef.current = (id) => {
    setItems((current) => current.filter((item) => String(item.id) !== String(id)))
    window.electronAPI?.dismissNotify?.(id)
  }

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onNotifyItems) return
    return api.onNotifyItems((payload: Payload) => {
      setLifetime(payload.lifetime ?? DEFAULT_LIFETIME)
      setItems(payload.items ?? [])
    })
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && items.length) dismissRef.current(items[items.length - 1].id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items])

  return (
    <div className="notify-root">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <NotifyCard
            key={`${item.kind}-${item.id}`}
            item={item}
            lifetime={lifetime}
            onDismiss={(id) => dismissRef.current(id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}
