import { AnimatePresence, motion } from 'framer-motion'

/** 选区矩形（屏幕 DIP，窗口内坐标）。宽高两种写法都兼容（项目里 DipRect 用 w/h）。 */
type Rect = {
  x: number
  y: number
  width?: number
  height?: number
  w?: number
  h?: number
}

/**
 * 选区的一次性提示：**1 秒内全部区域淡入 50% 半透明紫色，再淡出**。
 *
 * 需求明确：这与模型是否返回无关 —— 它只是"这段文字被接手了"的一下视觉确认，
 * 所以由 `visible`（横框一出现）驱动、自己做一遍就结束，不跟 busy/结果绑定。
 * 原来那套沿文字逐行扫描的彩虹动画已整体移除。
 */
export function RainbowScan({ rects, visible }: { rects: Rect[]; visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && rects.map((r, i) => (
        <motion.div
          key={`${r.x},${r.y},${i}`}
          className="wt-flash"
          style={{
            left: r.x,
            top: r.y,
            width: r.width ?? r.w ?? 0,
            height: r.height ?? r.h ?? 0,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.8, 0] }}
          transition={{ duration: 1, times: [0, 0.45, 1], ease: 'easeInOut' }}
        />
      ))}
    </AnimatePresence>
  )
}
