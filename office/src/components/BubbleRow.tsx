import { motion } from 'framer-motion'
import type { ElementInfo } from '../api/client'

interface BubbleRowProps {
  elements: ElementInfo[]
  selected: string[]
  loading: boolean
  onToggle: (name: string) => void
}

/**
 * 元素气泡：一行五颗、横向滑动浏览全部。
 *
 * 选中态用 2px 彩虹细边 + 1.06 放大（带一点下落回弹）—— 这是全区域里唯一允许过冲的
 * 动效，因为它对应"把东西放进去"的物理动作；其余形变一律临界阻尼。
 */
export function BubbleRow({ elements, selected, loading, onToggle }: BubbleRowProps) {
  if (loading && elements.length === 0) {
    return <div className="st-status">载入中</div>
  }
  if (elements.length === 0) {
    return <div className="st-status">元素不可用</div>
  }

  return (
    <div className="st-bubbles" role="list" aria-label="画面元素">
      {elements.map((element) => {
        const on = selected.includes(element.name)
        return (
          <motion.button
            key={element.name}
            type="button"
            role="listitem"
            className="st-bubble"
            data-on={on ? 'true' : 'false'}
            aria-pressed={on}
            title={element.name}
            onClick={() => onToggle(element.name)}
            animate={on ? { scale: [1, 1.08, 1.06], y: [0, -3, 0] } : { scale: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}
          >
            <img src={element.file} alt="" loading="lazy" draggable={false} />
          </motion.button>
        )
      })}
    </div>
  )
}
