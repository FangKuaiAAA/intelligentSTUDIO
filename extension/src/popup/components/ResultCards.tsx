import { motion } from 'framer-motion'
import type { OrganizeCard } from '../../bridge/protocol'
import { Icon, type IconName } from './Icon'

/** 结果卡片：按操作主题配色（标签页蓝青、收藏夹紫粉、其它黑灰），与主软件的卡片语言一致 */
function toneOf(card: OrganizeCard): string {
  const key = `${card.kind || ''} ${card.subtitle || ''} ${card.title || ''}`.toLowerCase()
  if (/bookmark|收藏/.test(key)) return 'tone-bookmarks'
  if (/edge|tab|标签/.test(key)) return 'tone-tabs'
  return 'tone-default'
}

function iconOf(card: OrganizeCard): IconName {
  const key = `${card.kind || ''} ${card.subtitle || ''}`.toLowerCase()
  if (/bookmark|收藏/.test(key)) return 'bookmark'
  if (/edge|tab|标签/.test(key)) return 'layers'
  return 'info'
}

/** Dony 的 edge 卡片用的是工具 action 名，这里换成中文，避免出现 organize_tabs 这类原始标识 */
const ACTION_LABELS: Record<string, string> = {
  tabs: '读取标签页',
  bookmarks: '读取收藏夹',
  organize_tabs: '整理标签页',
  organize_bookmarks: '整理收藏夹',
}

function titleOf(card: OrganizeCard): string {
  if (card.title) return card.title
  const action = String(card.subtitle || '')
  if (ACTION_LABELS[action]) return ACTION_LABELS[action]
  if ((card.kind || '') === 'edge') return '浏览器整理'
  return card.subtitle || '操作结果'
}

function subtitleOf(card: OrganizeCard): string {
  if (!card.title) return (card.kind || '') === 'edge' ? '浏览器' : ''
  return card.subtitle || ''
}

export function ResultCards({ cards }: { cards: OrganizeCard[] }) {
  if (!cards.length) return null
  return (
    <div className="card-list">
      {cards.map((card, index) => (
        <motion.div
          key={`${card.title}-${index}`}
          className={`result-card ${toneOf(card)}`}
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="result-card-text">
            <span className="result-card-title">{titleOf(card)}</span>
            {subtitleOf(card) ? (
              <span className="result-card-sub">{subtitleOf(card)}</span>
            ) : null}
            {card.details?.length ? (
              <span className="result-card-sub">
                {card.details.map((d) => `${d.label} ${d.value}`).join(' · ')}
              </span>
            ) : null}
          </div>
          <Icon name={iconOf(card)} size={18} className="result-card-icon" />
        </motion.div>
      ))}
    </div>
  )
}
