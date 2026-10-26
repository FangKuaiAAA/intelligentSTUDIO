import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IconUndo, IconEye } from './WritingIcons'
import { BarEdge } from './BarEdge'

/** 横框尺寸：几何计算与动画都以它为准 */
export const BAR_WIDTH = 420
export const BAR_HEIGHT = 44

/** 飞入用「快速起步 + 末尾减速」的缓出曲线（与项目里其它飞入保持一致） */
const FLY_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]

interface ActionBarProps {
  layout: { x: number; y: number; flipped: boolean }
  /** 当前操作名（校对 / 改写 / 友好…），显示在横框中部 */
  label: string
  phase: 'working' | 'result'
  /** 结果是否已经写入选区；未写入时「复原」退化为"结束本次" */
  applied: boolean
  /** 失败或提示文字（显示在中部，取不到时显示操作名） */
  message?: string
  /** 原文：按住预览按钮时以浮层显示 */
  original: string
  onKeep: () => void
  onRevert: () => void
  onCancel: () => void
}

/**
 * 选区上方的横框：确定或撤回本次更改。
 *
 * 两个阶段共用一个框（不换元素、不重新飞入）：
 *   working —— 左端「复原」当"撤回"用（此时还没有改动可还原），右端「保留」置灰；
 *   result  —— 左端「复原」把选区文字写回原文，右端「保留」收尾。
 * 中部的圆形按钮是「按住预览原文」：按住浮层显示原文，松开即回到改写结果。
 *
 * 飞入方向按落位自适应：横框在选区上方时从下往上飞，翻到下方时从上往下飞。
 */
export function ActionBar({
  layout, label, phase, applied, message, original, onKeep, onRevert, onCancel,
}: ActionBarProps) {
  const [holding, setHolding] = useState(false)
  const working = phase === 'working'
  const canPreview = phase === 'result' && applied && original.trim().length > 0
  // 标题固定显示"要做什么"（校对 / 友好 / 改写…），处理中也不加"中…"、不换成省略号：
  // 横框上另有加载光边表示进度，文字再变来变去只会让人读不到重点。
  const centerText = message || label

  return (
    <motion.div
      className="wt-bar"
      data-wt-hit="1"
      style={{ left: layout.x, top: layout.y, width: BAR_WIDTH, height: BAR_HEIGHT }}
      initial={{ opacity: 0, y: layout.flipped ? -18 : 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: layout.flipped ? -14 : 14 }}
      transition={{ duration: 0.24, ease: FLY_EASE }}
    >
      {/* 加载光边：照搬 rainbow-loading-pill（与视觉智能同源），只用光边、不做彩虹 */}
      <BarEdge active={working} width={BAR_WIDTH} height={BAR_HEIGHT} />

      <AnimatePresence>
        {holding && canPreview && (
          <motion.div
            key="wt-preview"
            className="wt-preview"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
          >
            <div className="wt-preview-title">原文</div>
            <div className="wt-preview-body">{original}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        className="wt-bar-revert"
        data-wt-hit="1"
        onClick={working || !applied ? onCancel : onRevert}
      >
        <IconUndo size={15} />
        <span>复原</span>
      </button>

      <span className={`wt-bar-label${message ? ' is-note' : ''}`} title={centerText}>
        {centerText}
      </span>

      <button
        type="button"
        className="wt-bar-preview"
        data-wt-hit="1"
        disabled={!canPreview}
        aria-label="按住查看原文"
        title="按住查看原文"
        onMouseDown={() => setHolding(true)}
        onMouseUp={() => setHolding(false)}
        onMouseLeave={() => setHolding(false)}
        onBlur={() => setHolding(false)}
      >
        <IconEye size={17} />
      </button>

      <button
        type="button"
        className="wt-bar-keep"
        data-wt-hit="1"
        disabled={working}
        onClick={onKeep}
      >
        保留
      </button>
    </motion.div>
  )
}
