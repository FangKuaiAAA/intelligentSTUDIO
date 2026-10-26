import { motion } from 'framer-motion'
import type { TimelineRow } from '../useBridge'

/** 整理过程的阶段行：逐行飞入（快速进入 + 末尾减速缓冲），进行中的一行带呼吸点 */
export function Timeline({ rows }: { rows: TimelineRow[] }) {
  if (!rows.length) return null
  return (
    <div className="timeline">
      {rows.map((row) => (
        <motion.div
          key={row.id}
          className="timeline-row"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
        >
          <span className={`timeline-dot ${row.tone}${row.active ? ' active' : ''}`} />
          <span>{row.text}</span>
        </motion.div>
      ))}
    </div>
  )
}
