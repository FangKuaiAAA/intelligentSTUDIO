import { useEffect, useState } from 'react'

export interface StatusMessage {
  text: string
  tone: 'info' | 'success' | 'error'
  /** 自增：同样的文案再次出现时也要重新计时 */
  seq: number
}

interface StatusLineProps {
  message: StatusMessage | null
}

/** 一行状态：成功留 3 秒淡出，错误留着直到下一次操作（错误信息不该自己消失） */
export function StatusLine({ message }: StatusLineProps) {
  const [visible, setVisible] = useState<StatusMessage | null>(message)

  useEffect(() => {
    setVisible(message)
    if (!message || message.tone === 'error') return
    const timer = window.setTimeout(() => setVisible(null), 3000)
    return () => window.clearTimeout(timer)
  }, [message])

  if (!visible) return null

  return (
    <div className="st-status" data-tone={visible.tone} role={visible.tone === 'error' ? 'alert' : 'status'}>
      <span className="st-dot" data-tone={visible.tone} />
      <span>{visible.text}</span>
    </div>
  )
}
