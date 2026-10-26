import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { computeGeometry, disposeEdge, renderEdge } from '@dony/components/overlay/rainbow/rainbowPill'
import '@dony/components/overlay/rainbow/rainbow.css'
import '../styles/rainbow-pane.css'
import { IconHexagon } from './icons'

/** 与 rainbow-pane.css 里的 .st-rb 高度保持一致（几何按真实尺寸算，不靠 CSS 猜） */
const HEIGHT = 40
/** 出血余量：窗格边缘就在旁边，60 会露"断边"，14 足够容纳模糊 */
const ROOM = 14

interface RainbowPillProps {
  value: string
  onChange: (value: string) => void
  /** 不传 = 纯输入框：不渲染发送键，也不响应回车 */
  onSubmit?: () => void
  placeholder: string
  /** 为 false 时只用于输入文字，不带任何按钮（图乐园就是这种） */
  showSend?: boolean
  /** 左侧六边形图标：图乐园的输入框不要 */
  showIcon?: boolean
  /** 提交中：亮起沿边光边，同时禁用发送 */
  busy?: boolean
  disabled?: boolean
  autoFocus?: boolean
  label: string
  icon?: ReactNode
}

/**
 * 彩虹药丸输入框（书写辅助的自定义要求、图乐园的画面描述共用）。
 *
 * 几何与光边完全走 @dony/rainbow —— 也就是 rainbow-loading-pill skill 的移植：
 * 虚线起点取边端点、dash 按真实路径长度算、四层同一条虚线只按模糊分档。
 * 这里只负责"窗格尺寸 + 输入交互"，不重写任何几何。
 */
export function RainbowPill({
  value,
  onChange,
  onSubmit,
  placeholder,
  showSend = true,
  showIcon = true,
  busy = false,
  disabled = false,
  autoFocus = false,
  label,
  icon,
}: RainbowPillProps) {
  const slotRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 中文输入法合成期：这期间的 Enter 是"选字确认"，绝不能当成提交 */
  const composing = useRef(false)
  const [propSupported, setPropSupported] = useState(true)

  useEffect(() => {
    const slot = slotRef.current
    const edge = edgeRef.current
    if (!slot || !edge) return

    setPropSupported(typeof CSS !== 'undefined' && 'registerProperty' in CSS)

    const render = (): void => {
      const width = slot.clientWidth
      if (width < 8) return
      renderEdge(edge, computeGeometry({ width, height: HEIGHT, radius: HEIGHT / 2, room: ROOM }))
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(slot)
    return () => {
      observer.disconnect()
      disposeEdge(edge)
    }
  }, [])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  return (
    <div className="rb-slot st-rb" ref={slotRef} data-prop={propSupported ? 'yes' : 'no'}>
      <div ref={edgeRef} className={`rb-edge${busy ? ' is-active' : ''}`} aria-hidden="true" />
      <div className={`rb-pill rb-rainbow-on${busy ? ' is-busy' : ''}`} style={{ borderRadius: HEIGHT / 2 }}>
        <span className="rb-pill-surface" aria-hidden="true" />
        {showIcon && <span className="st-rb-icon">{icon ?? <IconHexagon size={16} />}</span>}
        <input
          ref={inputRef}
          className="st-rb-input"
          type="text"
          value={value}
          aria-label={label}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !showSend || !onSubmit) return
            if (composing.current || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (!busy && value.trim()) onSubmit()
          }}
        />
        {showSend && onSubmit && (
          <button
            type="button"
            className="st-rb-send"
            aria-label="提交"
            disabled={disabled || busy || !value.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => value.trim() && onSubmit()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
