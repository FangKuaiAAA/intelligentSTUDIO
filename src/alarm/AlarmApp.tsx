import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { agentSocket } from '../utils/ws'
import { playRingtone } from '../utils/sound'

type WinRole = 'top' | 'float'

interface TopState { id: string; kind: 'alarm' | 'timer'; label: string; duration: number }
interface FloatState { id: string; endsAt: number }

const role: WinRole = window.location.hash === '#float' ? 'float' : 'top'

function fmtRemain(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  const h = Math.floor(m / 60)
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${s ? `${s}秒` : ''}` : `${s}秒`
}

export function AlarmApp() {
  const [top, setTop] = useState<TopState | null>(null)
  const [floatSt, setFloatSt] = useState<FloatState | null>(null)
  const [now, setNow] = useState(Date.now())
  const chordTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // 铃声（设置应用可改；后端在 fire 事件里带过来）
  const ringSrc = useRef<string | undefined>(undefined)
  // 最小化后还要能点托盘把卡片叫回来，所以记着最后一个计时器
  const lastTimer = useRef<FloatState | null>(null)
  // 托盘图标：只有计时器/闹钟真的存在时才显示
  const kinds = useRef<Record<string, string>>({})
  const flags = useRef({ timer: false, alarm: false })

  // ⚠ 可见性必须走 ref：syncTray 会被挂在 useEffect([]) 里的 WS 订阅调用，
  // 那个闭包里的 floatSt 永远是初始值（null）——于是卡片刚显示就被上报成"不可见"，
  // 主进程随即把窗口打回「忽略鼠标」，表现就是"悬停有反应、点击穿透"。
  const visRef = useRef({ float: false, top: false })
  visRef.current = {
    float: role === 'float' ? !!floatSt : false,
    top: role === 'top' ? !!top : false,
  }

  const syncTray = () => {
    // 顺带告诉主进程"卡片现在可不可见"：它据此决定计时器窗口要不要接过鼠标
    //（只按 ignoreMouseEvents(true,{forward:true}) 的话，悬停有反应、点击会穿透）
    window.electronAPI?.syncTray?.({
      timer: flags.current.timer,
      alarm: flags.current.alarm,
      floatVisible: visRef.current.float,
      topVisible: visRef.current.top,
    })
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  // 取证：这个窗口到底收到了哪些鼠标事件（点了没反应时用它判断卡在哪一层）
  useEffect(() => {
    const kinds = ['mousemove', 'mousedown', 'mouseup', 'click', 'pointerdown']
    const seen = new Set<string>()
    const on = (e: Event) => {
      const key = `${e.type}@${(e.target as HTMLElement)?.className || ''}`
      if (seen.has(key)) return
      seen.add(key)
      window.electronAPI?.logMain?.(`[card-dom] ${key.slice(0, 90)}`)
    }
    kinds.forEach((k) => document.addEventListener(k, on, true))
    return () => kinds.forEach((k) => document.removeEventListener(k, on, true))
  }, [])

  useEffect(() => {
    agentSocket.connect()
    agentSocket.send({ type: 'register', role: 'alarm' })
    return agentSocket.on((m) => {
      if (m.type !== 'alarm-event') return
      switch (m.event) {
        case 'fire': {
          const st: TopState = {
            id: m.id, kind: m.kind, label: m.label || '', duration: m.duration || 0,
          }
          setTop(st)
          if (m.kind === 'timer') {
            setFloatSt(null)
            lastTimer.current = null
            flags.current.timer = false
          } else {
            flags.current.alarm = false     // 闹钟已经响了：它不再是"待着的闹钟"
          }
          delete kinds.current[m.id]
          syncTray()
          ringSrc.current = m.ringtone
          playRingtone(m.ringtone)
          if (chordTimer.current) clearInterval(chordTimer.current)
          chordTimer.current = setInterval(() => playRingtone(ringSrc.current), 3000)
          break
        }
        case 'alarm-set':
          kinds.current[m.id] = 'alarm'
          flags.current.alarm = true
          syncTray()
          break
        case 'timer-start': {
          const st = { id: m.id, endsAt: m.ends_at * 1000 }
          setFloatSt(st)
          lastTimer.current = st
          kinds.current[m.id] = 'timer'
          flags.current.timer = true
          syncTray()
          break
        }
        case 'timer-end':
        case 'timer-cancel':
          setFloatSt((f) => (f && f.id === m.id ? null : f))
          if (lastTimer.current?.id === m.id) lastTimer.current = null
          flags.current.timer = false
          delete kinds.current[m.id]
          syncTray()
          break
        case 'timer-minimized':
          // 只是收起来，最后一次的计时器信息要留着（托盘点击时用它恢复）
          setFloatSt((f) => (f && f.id === m.id ? null : f))
          break
        case 'dismissed':
        case 'alarm-cancel': {
          const kind = kinds.current[m.id]
          setTop((t) => (t && t.id === m.id ? null : t))
          setFloatSt((f) => (f && f.id === m.id ? null : f))
          if (kind === 'alarm') flags.current.alarm = false
          if (kind === 'timer' || lastTimer.current?.id === m.id) {
            flags.current.timer = false
            lastTimer.current = null
          }
          delete kinds.current[m.id]
          syncTray()
          if (chordTimer.current) { clearInterval(chordTimer.current); chordTimer.current = null }
          break
        }
      }
    })
  }, [])

  // 托盘的点击/右键：计时器图标点一下重新打开右下角卡片；右键停止计时器 / 取消闹钟
  useEffect(() => window.electronAPI?.onTrayCommand?.(({ cmd: c }) => {
    if (c === 'restore-timer') {
      if (role === 'float' && lastTimer.current) setFloatSt(lastTimer.current)
    } else if (c === 'stop-timer') {
      agentSocket.send({ type: 'alarm-cmd', cmd: 'stop-timer', id: '' })
      setFloatSt(null)
      lastTimer.current = null
      flags.current.timer = false
      syncTray()
    } else if (c === 'cancel-alarm') {
      agentSocket.send({ type: 'alarm-cmd', cmd: 'cancel-alarm', id: '' })
      setTop(null)
      flags.current.alarm = false
      syncTray()
    }
  }), [])

  // 内容显示时窗口接管鼠标，隐藏时恢复穿透
  const visible = role === 'top' ? !!top : !!floatSt
  useEffect(() => {
    window.electronAPI?.setAlarmInteractive?.(visible)
    syncTray()   // 可见性变了 → 顺便同步给主进程（它据此决定计时器窗口接不接鼠标）
  }, [visible])

  const cmd = (c: string, id: string) => agentSocket.send({ type: 'alarm-cmd', cmd: c, id })

  if (role === 'float') {
    return (
      <div className="alarm-stage float-stage">
        <AnimatePresence>
          {floatSt && (
            <motion.div className="alarm-bar float-bar"
              initial={{ opacity: 0, y: 24, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}>
              <span className="float-time">{fmtRemain(floatSt.endsAt - now)}</span>
              <div className="alarm-actions">
                {/* ⚠ 必须用 onMouseUp 而不是 onClick：这两个窗口 focusable:false，
                    实测 **mousedown 不会送到页面**（mousemove/mouseup 都会到）——
                    而 click 需要 mousedown+mouseup 配对，于是 onClick 永远不触发
                    （表现就是"鼠标移上去按钮会放大、点下去却毫无反应"）。 */}
                <button className="alarm-btn grey" title="最小化"
                  onMouseUp={() => { cmd('minimize', floatSt.id); setFloatSt(null) }}>
                  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                </button>
                <button className="alarm-btn red" title="结束计时"
                  onMouseUp={() => { cmd('dismiss', floatSt.id); setFloatSt(null) }}>
                  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <div className="alarm-stage top-stage">
      <AnimatePresence>
        {top && (
          <motion.div className="alarm-bar top-bar"
            initial={{ opacity: 0, y: -60, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -60, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}>
            <div className="alarm-info">
              <span className="alarm-kind">{top.kind === 'alarm' ? '闹钟' : '计时器'}</span>
              <span className="alarm-time">
                {top.kind === 'alarm'
                  ? new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                  : fmtDuration(top.duration)}
              </span>
              {top.label && <span className="alarm-label">{top.label}</span>}
            </div>
            <div className="alarm-actions">
              {top.kind === 'timer' && (
                <button className="alarm-btn grey" title="重新开始计时"
                  onMouseUp={() => { cmd('restart', top.id); setTop(null) }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M12 7A5 5 0 1 1 7 2c1.8 0 3.3.9 4.2 2.3M11.5 1v3.3H8.2"
                      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <button className="alarm-btn yellow" title="关闭"
                onMouseUp={() => { cmd('dismiss', top.id); setTop(null) }}>
                <svg width="13" height="13" viewBox="0 0 13 13"><path d="M3.5 3.5l6 6M9.5 3.5l-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
