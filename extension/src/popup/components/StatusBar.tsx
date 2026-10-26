import type { BridgeStatus } from '../../bridge/protocol'
import { Icon } from './Icon'

interface Props {
  status: BridgeStatus | null
  onRefresh: () => void
  onOpenStatus: () => void
}

/** 底栏：只报连接与否，细节都在「状态」面板里 */
export function StatusBar({ status, onRefresh, onOpenStatus }: Props) {
  const connected = !!status?.ok && !!status?.paired
  return (
    <div className={`status-bar${connected ? '' : ' warn'}`}>
      <span className={`status-dot ${connected ? 'live' : 'off'}`} />
      <button
        type="button"
        className="status-text"
        style={{ textAlign: 'left', background: 'none', padding: 0 }}
        onClick={onOpenStatus}
      >
        {connected ? '已连接' : '未连接'}
      </button>
      <button type="button" className="ghost-button" onClick={onRefresh} title="刷新状态">
        <Icon name="refresh" size={15} strokeWidth={1.9} />
      </button>
    </div>
  )
}
