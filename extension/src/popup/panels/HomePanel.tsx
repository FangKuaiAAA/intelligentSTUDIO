import { motion } from 'framer-motion'
import type { BridgeKind } from '../../bridge/protocol'
import { Icon, type IconName } from '../components/Icon'

interface Props {
  onVisual: () => void
  onOrganize: (target: BridgeKind) => void
}

interface Entry {
  key: string
  chip: string
  icon: IconName
  title: string
  action: () => void
}

export function HomePanel({ onVisual, onOrganize }: Props) {
  const entries: Entry[] = [
    { key: 'visual', chip: 'visual', icon: 'eye', title: '视觉智能', action: onVisual },
    { key: 'tabs', chip: 'tabs', icon: 'layers', title: '整理标签页', action: () => onOrganize('tabs') },
    { key: 'bookmarks', chip: 'bookmarks', icon: 'bookmark', title: '整理收藏夹', action: () => onOrganize('bookmarks') },
  ]

  return (
    <div className="entry-list">
      {entries.map((entry, index) => (
        <motion.button
          key={entry.key}
          type="button"
          className="entry"
          onClick={entry.action}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1], delay: index * 0.05 }}
          whileTap={{ scale: 0.985 }}
        >
          <span className={`entry-chip ${entry.chip}`}>
            <Icon name={entry.icon} size={17} strokeWidth={1.7} />
          </span>
          <span className="entry-text">
            <span className="entry-title">{entry.title}</span>
          </span>
          <Icon name="forward" size={15} className="entry-chevron" />
        </motion.button>
      ))}
    </div>
  )
}
