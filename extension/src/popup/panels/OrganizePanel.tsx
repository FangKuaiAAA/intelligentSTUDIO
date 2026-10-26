import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { BridgeKind } from '../../bridge/protocol'
import { Icon } from '../components/Icon'
import { Timeline } from '../components/Timeline'
import { ResultCards } from '../components/ResultCards'
import type { OrganizeState } from '../useBridge'

interface Props {
  target: BridgeKind
  state: OrganizeState
  onBack: () => void
  onStart: (requirement: string) => void
  onAnswer: (id: string, answer: { text?: string; approved?: boolean }) => void
  onCancel: () => void
}

export function OrganizePanel({ target, state, onBack, onStart, onAnswer, onCancel }: Props) {
  const [requirement, setRequirement] = useState('')
  const [askValue, setAskValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setRequirement('')
    setAskValue('')
  }, [target])

  useEffect(() => {
    if (!state.running && !state.ask) setTimeout(() => inputRef.current?.focus(), 120)
  }, [state.running, state.ask])

  const submitRequirement = () => onStart(requirement.trim())

  const title = target === 'tabs' ? '整理标签页' : '整理收藏夹'
  const started = state.running || state.done || !!state.answer || !!state.error || state.timeline.length > 0

  return (
    <div>
      <div className="nav-row">
        <button type="button" className="nav-back" onClick={onBack} title="返回">
          <Icon name="back" size={16} />
        </button>
        <span className="nav-title">{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {state.running ? (
            <button type="button" className="ghost-button" onClick={onCancel}>
              取消
            </button>
          ) : started ? (
            <button type="button" className="ghost-button" onClick={submitRequirement}>
              再次执行
            </button>
          ) : null}
        </span>
      </div>

      <div className="pill-input-wrap">
        <span className="pill-prefix">{title}</span>
        <input
          ref={inputRef}
          className="pill-input"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRequirement()
          }}
          placeholder="额外要求"
          disabled={state.running}
        />
        <button
          type="button"
          className="pill-submit"
          onClick={submitRequirement}
          disabled={state.running}
          title="交给 Dony 执行"
        >
          <Icon name="send" size={15} strokeWidth={1.8} />
        </button>
      </div>

      <Timeline rows={state.timeline} />

      {state.answer ? (
        <motion.div
          className="answer-text"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
        >
          {state.answer}
        </motion.div>
      ) : null}

      <ResultCards cards={state.cards} />

      {state.ask ? (
        <motion.div
          className="ask-box"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="ask-text">{state.ask.text}</div>
          {state.ask.kind === 'confirm' ? (
            <div className="ask-actions">
              <button
                type="button"
                className="action-pill plain"
                onClick={() => onAnswer(state.ask!.id, { approved: false })}
              >
                不允许
              </button>
              <button
                type="button"
                className="action-pill"
                onClick={() => onAnswer(state.ask!.id, { approved: true })}
              >
                允许
              </button>
            </div>
          ) : (
            <div className="pill-input-wrap" style={{ boxShadow: 'none' }}>
              <input
                className="pill-input"
                value={askValue}
                onChange={(e) => setAskValue(e.target.value)}
                onKeyDown={(e) => {
                  const text = askValue.trim()
                  if (e.key === 'Enter' && text) {
                    onAnswer(state.ask!.id, { text })
                    setAskValue('')
                  }
                }}
                placeholder="回答"
                autoFocus
              />
              <button
                type="button"
                className="pill-submit"
                disabled={!askValue.trim()}
                onClick={() => {
                  const text = askValue.trim()
                  if (!text) return
                  onAnswer(state.ask!.id, { text })
                  setAskValue('')
                }}
                title="提交回答"
              >
                <Icon name="send" size={15} strokeWidth={1.8} />
              </button>
            </div>
          )}
        </motion.div>
      ) : null}

      {state.error ? (
        <motion.div
          className="error-text"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
        >
          {state.error}
        </motion.div>
      ) : null}
    </div>
  )
}
