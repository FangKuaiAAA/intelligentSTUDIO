import { useEffect, useRef, useState } from 'react'
import { runWriting } from '../api/client'
import { getHost } from '../host'
import { patchResult, resetResult } from '../resultStore'
import { IdentityBar } from '../components/IdentityBar'
import { RainbowPill } from '../components/RainbowPill'
import { StatusLine } from '../components/StatusLine'
import type { StatusMessage } from '../components/StatusLine'

interface WritingProps {
  hostLabel: string
  onBack: () => void
  notify: (text: string, tone: StatusMessage['tone']) => void
  status: StatusMessage | null
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 写入文档后的句柄：恢复按钮靠它定位，不依赖当前选区 */
  handle?: string
  /** 写回前的原文；空串表示这段是"光标处创作"，恢复即清空 */
  original?: string
  restored?: boolean
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())

/**
 * 书写辅助：对话式改写。
 *
 * 和模型说话，返回的就是改好的正文 —— 不再有动作网格、结果卡或进度条：
 *  · 有选区：以选区文字为素材改写，写回文档后把结果作为一条气泡回显；
 *  · 没选区：让模型直接在光标处创作；
 *  · 气泡底部的「恢复」按句柄写回原文（空原文则清空该段），不依赖当前选区；
 *  · 读选区失败不再单独提示，直接按"没有选区"处理 —— 用户关心的是结果，不是内部状态。
 */
export function Writing({ hostLabel, onBack, notify, status }: WritingProps) {
  const host = getHost()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  /** 最近一次写入的句柄：追问时靠它把"刚才那段"读回来 */
  const lastHandle = useRef('')

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  const send = (): void => {
    const instruction = draft.trim()
    if (!instruction || busy) return

    setDraft('')
    setMessages((prev) => [...prev, { id: newId(), role: 'user', text: instruction }])
    setBusy(true)

    host
      .readSelection()
      // 读不到就当没有选区：不提示、不中断
      .catch(() => ({ text: '', handle: '', empty: true }) as { text: string; handle: string; empty: boolean })
      .then(async (selection) => {
        let handle = selection.handle || ''
        let original = selection.empty ? '' : selection.text

        // 追问修改：点进输入框后文档选区常常已经塌陷，
        // 这时改为按上一次的句柄把那段文字读回来，直接在同一段上继续改。
        if (!original && lastHandle.current) {
          const previous = await host.readTextByHandle(lastHandle.current).catch(() => '')
          if (previous) {
            original = previous
            handle = lastHandle.current
          }
        }

        const result = await runWriting('custom', original, instruction)
        const next = result.text.trim()

        // 模型有时会把"没有内容"写成一句话返回：这种不能当成正文写进文档
        if (!next || /^(未选择|没有选中|请先选择|请提供|抱歉|无法)/.test(next)) {
          throw new Error('没有可处理的内容')
        }

        const nextHandle = await host.replaceText(handle, original, next)
        lastHandle.current = nextHandle
        return { handle: nextHandle, original, text: next }
      })
      .then(({ handle, original, text }) => {
        setMessages((prev) => [...prev, { id: newId(), role: 'assistant', text, handle, original }])
        // 同步给功能区「复原」：它读的是同源存储，两个运行时都能拿到这次改动
        patchResult({ status: 'applied', action: 'custom', handle, original, next: text })
        host.selectText(handle).catch(() => undefined)
      })
      .catch((e) => {
        console.error('[studio] 改写失败', e)
        notify(e instanceof Error ? e.message : '改写失败', 'error')
      })
      .finally(() => setBusy(false))
  }

  const restore = (message: Message): void => {
    if (!message.handle) return
    host
      .restoreText(message.handle, message.original || '')
      .then(() => {
        setMessages((prev) =>
          prev.map((m) => (m.id === message.id ? { ...m, restored: true } : m))
        )
        // 已回退：清掉记录，避免功能区「复原」再写一次
        resetResult()
        notify('已恢复', 'success')
      })
      .catch((e) => {
        console.error('[studio] 恢复失败', e)
        notify(e instanceof Error ? e.message : '恢复失败', 'error')
      })
  }

  return (
    <>
      <IdentityBar title="书写辅助" hostLabel={hostLabel} onBack={onBack} />

      <div className="st-body st-chat">
        {messages.map((message) => (
          <div key={message.id} className="st-msg" data-role={message.role}>
            <div className="st-msg-bubble" data-role={message.role}>
              {message.text}
            </div>
            {message.role === 'assistant' && !message.restored && (
              <button type="button" className="st-restore" onClick={() => restore(message)}>
                恢复
              </button>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="st-footer">
        <div className="st-stack">
          <RainbowPill
            label="修改要求"
            placeholder="描述修改"
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            busy={busy}
            icon={<img src="./icons/ui/edit-dark.png" alt="" width={15} height={15} draggable={false} />}
          />
          <StatusLine message={status} />
        </div>
      </div>
    </>
  )
}
