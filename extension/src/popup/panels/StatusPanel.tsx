import type { BridgeStatus } from '../../bridge/protocol'
import { Icon } from '../components/Icon'
import type { LogRow } from '../useBridge'

interface Props {
  status: BridgeStatus | null
  logs: LogRow[]
  onRefresh: () => void
  onReconnect: () => void
}

export function StatusPanel({ status, logs, onRefresh, onReconnect }: Props) {
  const online = !!status?.ok
  const connected = online && !!status?.paired
  return (
    <div>
      <h2 className="section-title">连接</h2>
      <div className="panel">
        <div className="kv">
          <span className="kv-key">本地服务</span>
          <span className="kv-value">{status?.bridgeBase || 'http://127.0.0.1:8768'}</span>
        </div>
        <div className="kv">
          <span className="kv-key">状态</span>
          <span className="kv-value">
            {connected ? `已连接${status?.browser ? `（${status.browser}）` : ''}` : status?.message || '未连接'}
          </span>
        </div>
        <div className="kv">
          <span className="kv-key">浏览器数据</span>
          <span className="kv-value">标签页 {status?.tabs ?? 0} · 收藏夹 {status?.bookmarks ?? 0}</span>
        </div>
        <div className="kv">
          <span className="kv-key">Dony Agent</span>
          <span className="kv-value">
            127.0.0.1:{status?.agentPort ?? 8767}
            {status?.agentBusy ? ' · 整理中' : ''}
          </span>
        </div>
        <div className="kv">
          <span className="kv-key">版本</span>
          <span className="kv-value">
            扩展 {chrome.runtime.getManifest().version} · 服务 {status?.version || '未知'}
          </span>
        </div>
        <div className="kv">
          <span className="kv-key">视觉模型</span>
          <span className="kv-value">{status?.visionModel || '未知'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="action-pill" onClick={onReconnect}>
            重新连接
          </button>
          <button type="button" className="action-pill plain" onClick={onRefresh}>
            刷新状态
          </button>
        </div>
      </div>

      <h2 className="section-title" style={{ marginTop: 18 }}>
        最近日志
      </h2>
      <div className="panel">
        {logs.length ? (
          <div className="log-list">
            {logs.map((row) => (
              <div className="log-row" key={row.id}>
                <span className="log-time">{row.time}</span>
                <span className="log-text">{row.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            暂无日志
          </p>
        )}
      </div>
    </div>
  )
}
