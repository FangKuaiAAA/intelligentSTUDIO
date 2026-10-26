import { useEffect, useState } from 'react'
import type { ResultState } from '../resultStore'
import { actionLabel } from './actions'
import { IconEye, IconUndo } from './icons'

interface ResultCardProps {
  result: ResultState
  busy: boolean
  /** 每次自增：功能区点了「预览原文」，这里把原文浮层亮一下 */
  revealSignal: number
  onKeep: () => void
  onRevert: () => void
  onCopy: () => void
}

/**
 * 结果卡：**先预览、不改文档**，四个按钮与桌面端横框同语义。
 *
 * 复原 / 按住看原文 / 保留 / 复制 —— 顺序照桌面端那排横框排（左复原、右保留），
 * 因为用户已经在那里形成了肌肉记忆。
 */
export function ResultCard({ result, busy, revealSignal, onKeep, onRevert, onCopy }: ResultCardProps) {
  const [holding, setHolding] = useState(false)
  const [copied, setCopied] = useState(false)

  // 功能区的「预览原文」没有浮层可用：唤起窗格后由这里的卡片亮一次
  useEffect(() => {
    if (!revealSignal || !result.original) return
    setHolding(true)
    const timer = window.setTimeout(() => setHolding(false), 1600)
    return () => window.clearTimeout(timer)
  }, [revealSignal, result.original])

  const applied = result.status === 'applied'
  // 优先用后端给的 label：自定义要求走的是 custom，它的中文名是「创作」而不是「改写」
  const title = `${result.label || actionLabel(result.action || 'rewrite')}${applied ? ' · 已写入' : ''}`

  const copy = (): void => {
    navigator.clipboard.writeText(result.next || '').then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      (e) => console.error('[studio] 复制失败', e)
    )
    onCopy()
  }

  return (
    <div className="st-card st-result">
      <div className="st-card-title">
        <span>{title}</span>
      </div>

      {holding && result.original ? (
        <div className="st-original">{result.original}</div>
      ) : (
        <div className="st-card-body" style={{ maxHeight: 180, overflowY: 'auto' }}>
          {result.next}
        </div>
      )}

      <div className="st-result-actions">
        <button type="button" className="st-btn st-btn--ghost" disabled={busy} onClick={onRevert} title="把原文写回文档">
          <IconUndo size={15} />
          复原
        </button>
        <button
          type="button"
          className="st-btn st-btn--ghost st-btn--icon"
          disabled={!result.original}
          aria-label="按住查看原文"
          title="按住查看原文"
          onMouseDown={() => setHolding(true)}
          onMouseUp={() => setHolding(false)}
          onMouseLeave={() => setHolding(false)}
          onBlur={() => setHolding(false)}
        >
          <IconEye size={15} />
        </button>
        <span className="st-grow" />
        <button type="button" className="st-btn" onClick={copy} disabled={!result.next}>
          {copied ? '已复制' : '复制'}
        </button>
        <button
          type="button"
          className="st-btn st-btn--primary"
          disabled={busy || applied || !result.next}
          onClick={onKeep}
          title={applied ? '已写入文档' : '把结果写入文档，可 Ctrl+Z 撤销'}
        >
          保留
        </button>
      </div>
    </div>
  )
}
