import { useState } from 'react'
import { motion } from 'framer-motion'
import { AcrylicLayer, ACRYLIC_BLUR } from '../AcrylicLayer'
import { HexagonOutline } from './HexagonOutline'

/**
 * 左侧竖居中面板：摘要/要点的结果，以及「创作」的需求输入，都用它。
 *
 * 结构与修改面板**同源**（同一套 `.wt-menu` 容器 + `.wt-menu-card` 亚克力材质 +
 * `.wt-menu-tail` 三角形），所以材质、圆角、细线、三角形完全一致 —— 不是另画一套。
 * 位置固定为"左侧 + 竖直居中"。
 */
export function SidePanel({
  mode, title, text, busy, anchor, onCreate, onReplace, onCopy, onClose,
}: {
  /** 选区矩形（窗口内 DIP）：面板贴在它左侧 */
  anchor?: { x: number; y: number; w: number; h: number } | null
  /** result = 展示处理结果；create = 输入创作需求 */
  mode: 'result' | 'create'
  title: string
  /** result 模式下的正文（create 模式下不用） */
  text: string
  busy: boolean
  onCreate?: (requirement: string) => void
  onReplace?: () => void
  onCopy?: () => void
  onClose?: () => void
}) {
  const [requirement, setRequirement] = useState('')
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <motion.div
      className="wt-menu wt-side"
      data-dir="left"
      // 位置与修改面板同一套：贴在**选区左侧**，竖直方向对齐**选区文字的中心**。
      // 做法：给外层一个以选区中心为中线的高度带（400px），内部再用 flex 居中 ——
      // 这样面板多高都居中，且不会和 framer 的 scale 抢 transform。
      style={{
        left: anchor ? Math.max(16, anchor.x - 360 - 20) : 16,
        top: anchor ? anchor.y + anchor.h / 2 - 200 : undefined,
        height: 400,
        transformOrigin: 'right center',
      }}
      initial={{ opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
      transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
    >
      <div className="wt-menu-tail" aria-hidden="true">
        <div className="wt-menu-tail-fill" data-acrylic-host>
          <AcrylicLayer blur={ACRYLIC_BLUR.asking} />
        </div>
        <svg className="wt-menu-tail-line" viewBox="0 0 13 28" preserveAspectRatio="none">
          <path
            d="M0.6 1.4 L11.3 14 L0.6 26.6"
            fill="none"
            stroke="var(--dony-acrylic-edge)"
            strokeWidth="1"
            strokeLinejoin="round"
            strokeLinecap="butt"
          />
        </svg>
      </div>

      <div className="wt-menu-card" data-acrylic-host>
        <AcrylicLayer blur={ACRYLIC_BLUR.asking} />
        <div className="wt-side-inner">
          <div className="wt-side-title">{title}</div>

          {mode === 'result' ? (
            <>
              <div className="wt-side-body">{text || (busy ? '处理中…' : '')}</div>
              <div className="wt-side-actions">
                <button type="button" className="wt-side-btn wt-side-primary" data-wt-hit="1"
                  disabled={busy || !text} onClick={onReplace}>
                  替换
                </button>
                <button type="button" className="wt-side-btn" data-wt-hit="1"
                  disabled={!text} onClick={copy}>
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* 与修改面板同一个输入框样式（彩虹 + 六边形图标） */}
              <div className="wt-input rb-pill rb-rainbow-on">
                <span className="rb-pill-surface" />
                <span className="wt-input-icon">
                  <HexagonOutline size={16} strokeWidth={2} rainbow={false} />
                </span>
                <input
                  className="wt-input-field"
                  data-wt-focus="1"
                  type="text"
                  value={requirement}
                  placeholder="创作需求....."
                  spellCheck={false}
                  onMouseDown={() => window.electronAPI?.setWritingFocus?.(true)}
                  onBlur={() => window.electronAPI?.setWritingFocus?.(false)}
                  onChange={(e) => setRequirement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && requirement.trim()) {
                      e.preventDefault()
                      onCreate?.(requirement.trim())
                    }
                  }}
                />
              </div>
              <div className="wt-side-actions">
                <button type="button" className="wt-side-btn wt-side-primary" data-wt-hit="1"
                  disabled={busy || !requirement.trim()}
                  onClick={() => onCreate?.(requirement.trim())}>
                  开始
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  )
}
