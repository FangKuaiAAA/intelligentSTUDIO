import { motion } from 'framer-motion'
import type { VisualMode } from '../../bridge/protocol'
import { Icon, type IconName } from '../components/Icon'

interface Props {
  onBack: () => void
  onStart: (mode: VisualMode) => void
}

const MODES: { mode: VisualMode; icon: IconName; label: string }[] = [
  { mode: 'box', icon: 'crop', label: '框选' },
  { mode: 'page', icon: 'page', label: '整页' },
]

/** 「视觉智能」的两种入口：框选当前区域、归纳整页 */
export function VisualPanel({ onBack, onStart }: Props) {
  return (
    <div>
      <div className="nav-row">
        <button type="button" className="nav-back" onClick={onBack} title="返回">
          <Icon name="back" size={16} />
        </button>
        <span className="nav-title">视觉智能</span>
      </div>

      <div className="entry-list">
        {MODES.map((item, index) => (
          <motion.button
            key={item.mode}
            type="button"
            className="entry"
            onClick={() => onStart(item.mode)}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1], delay: index * 0.05 }}
            whileTap={{ scale: 0.985 }}
          >
            <span className="entry-chip visual">
              <Icon name={item.icon} size={17} strokeWidth={1.7} />
            </span>
            <span className="entry-text">
              <span className="entry-title">{item.label}</span>
            </span>
            <Icon name="forward" size={15} className="entry-chevron" />
          </motion.button>
        ))}
      </div>
    </div>
  )
}
