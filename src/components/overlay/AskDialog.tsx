import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import './AskDialog.css'

export interface AskRequest {
  id: string
  kind: 'confirm' | 'question'
  text: string
}

interface AskDialogProps {
  ask: AskRequest
  voiceMode: boolean
  onAnswer: (id: string, answer: { approved?: boolean; text?: string }) => void
}

/**
 * 打断询问窗内容（嵌在 DonyMorph 的方窗内）：
 * 上方询问文字，下方药丸输入框（回车确认）或 允许/不允许 双按钮。
 */
export function AskDialog({ ask, voiceMode, onAnswer }: AskDialogProps) {
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(!voiceMode)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current?.focus(), 120)
  }, [editing])

  const submitText = () => {
    const t = value.trim()
    if (t) onAnswer(ask.id, { text: t })
  }

  return (
    <div className="ask-dialog">
      <motion.div className="ask-text"
        initial={{ opacity: 0, y: 10, filter: 'blur(3px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: 0.1 }}>
        {ask.text}
      </motion.div>

      {ask.kind === 'confirm' ? (
        <motion.div className="ask-buttons"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: 0.18 }}>
          <button className="ask-btn deny" onClick={() => onAnswer(ask.id, { approved: false })}>
            不允许
          </button>
          <button className="ask-btn allow" onClick={() => onAnswer(ask.id, { approved: true })}>
            允许
          </button>
        </motion.div>
      ) : editing ? (
        <motion.div className="ask-input-pill"
          // initial={false}：这一支是「点一下输入药丸」之后换上的，
          // 再放一次 y:12 → 0 的入场动画就会变成"点一下它自己往上飞一下"。
          // 询问窗整体的入场已经由外层容器 + 上方文字负责了。
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: 0.12 }}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitText() }}
            placeholder="输入回答"
            className="ask-input"
          />
        </motion.div>
      ) : (
        <motion.button className="ask-input-pill ask-click-pill"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: 0.12 }}
          onClick={() => setEditing(true)}>
          点击输入回答
        </motion.button>
      )}
    </div>
  )
}
