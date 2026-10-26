import type { Capability } from '../host'
import { ACTIONS } from './actions'
import { RainbowEdge } from './RainbowEdge'

interface ActionGridProps {
  busy: boolean
  /** 正在执行的动作键：只有这一格亮光边，其余降透明 */
  activeKey: string | null
  supports: (key: string) => Capability
  onPick: (key: string) => void
}

/**
 * 七动作网格。处理中的那一格出现沿边旋转光边（同 rainbow-loading-pill 的 .rb-edge），
 * 其余格降到 55% 且不接收点击 —— 用"光边走一圈"代替文字变成"处理中…"，
 * 位置和文案都不跳，读起来更稳。
 */
export function ActionGrid({ busy, activeKey, supports, onPick }: ActionGridProps) {
  return (
    <div className="st-grid" data-busy={busy ? 'true' : 'false'}>
      {ACTIONS.map((action) => {
        const cap = supports(action.key)
        const active = activeKey === action.key
        return (
          <button
            key={action.key}
            type="button"
            className="st-action"
            data-active={active ? 'true' : 'false'}
            style={{ position: 'relative' }}
            disabled={busy || !cap.ok}
            title={cap.ok ? action.hint : cap.reason}
            onClick={() => onPick(action.key)}
          >
            <RainbowEdge active={active} inset={5} radius={10} />
            <span style={{ position: 'relative', zIndex: 2, display: 'grid', placeItems: 'center' }}>{action.icon}</span>
            <span className="st-action-label">{action.label}</span>
            {!cap.ok && <span className="st-action-hint">不可用</span>}
          </button>
        )
      })}
    </div>
  )
}
