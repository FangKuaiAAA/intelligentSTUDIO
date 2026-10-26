import type { ReactNode } from 'react'
import { IconBack } from './icons'

interface IdentityBarProps {
  title: string
  /** 有值时显示返回按钮（选择页不显示） */
  onBack?: () => void
  /** 右侧宿主胶囊：Word / Excel / PowerPoint 文字 */
  hostLabel: string
  /** 选择页用应用图标替代返回按钮 */
  leading?: ReactNode
}

/**
 * 40px 身份条：固定不随内容滚动。
 *
 * 为什么必须有它：Office 任务窗格的标题栏固定显示加载项名称，两个功能页的标题
 * 一模一样，用户只能靠这条身份条判断"现在在哪、怎么回去"。
 */
export function IdentityBar({ title, onBack, hostLabel, leading }: IdentityBarProps) {
  return (
    <div className="st-identity">
      {onBack ? (
        <button type="button" className="st-back" onClick={onBack} aria-label="返回选择页" title="返回">
          <IconBack size={16} />
        </button>
      ) : (
        leading
      )}
      <span className="st-identity-title">{title}</span>
      <span className="st-identity-spacer" />
      <span className="st-host-pill">{hostLabel}</span>
    </div>
  )
}
