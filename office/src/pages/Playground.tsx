import { useEffect, useRef, useState } from 'react'
import { cancelImage, generateImage, getToken, listElements } from '../api/client'
import type { ElementInfo } from '../api/client'
import { fetchRaw, placeholderSize, toInsertableBase64 } from '../api/image'
import { placeholderBase64 } from '../api/placeholder'
import { getHost } from '../host'
import { IdentityBar } from '../components/IdentityBar'
import { RainbowPill } from '../components/RainbowPill'
import { StatusLine } from '../components/StatusLine'
import type { StatusMessage } from '../components/StatusLine'

interface PlaygroundProps {
  hostLabel: string
  onBack: () => void
  notify: (text: string, tone: StatusMessage['tone']) => void
  status: StatusMessage | null
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())

const FALLBACK_STYLES = [
  { key: 'illustration', name: '插画' },
  { key: 'comic', name: '漫画' },
  { key: 'sketch', name: '素描' },
  { key: 'realistic', name: '写实' },
  { key: 'emoji', name: '表情' },
  { key: 'any', name: '任意风格' },
]

/**
 * 图乐园：风格 + 生成按钮 → 12 张元素卡 → 描述输入框。
 *
 * 交互上刻意做减法：
 *  · 输入框只收文字，不带发送键，回车不触发任何动作（生成只由顶部按钮发起）；
 *  · 生成期间除了文档里那张占位图，窗格不给任何进度、阶段文字或结果卡 ——
 *    点下按钮后按钮变暗即止；
 *  · 中止＝删掉文档里的占位图：每 2 秒探活，一旦消失就取消后端任务。
 */
export function Playground({ hostLabel, onBack, notify, status }: PlaygroundProps) {
  const host = getHost()
  const [elements, setElements] = useState<ElementInfo[]>([])
  const [styles, setStyles] = useState(FALLBACK_STYLES)
  const [selected, setSelected] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('illustration')
  const [busy, setBusy] = useState(false)

  const jobRef = useRef('')
  const handleRef = useRef('')
  const pollRef = useRef(0)

  useEffect(() => {
    listElements()
      .then((data) => {
        setElements(data.elements || [])
        if (data.styles?.length) setStyles(data.styles)
      })
      .catch((e) => {
        console.error('[studio] 元素清单加载失败', e)
        notify('元素不可用', 'error')
      })
  }, [])

  const toggle = (name: string): void => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  const run = (): void => {
    const text = prompt.trim()
    if (!text && selected.length === 0) {
      notify('先描述画面或选择元素', 'info')
      return
    }

    const jobId = newId()
    const size = placeholderSize(window.innerWidth)
    const composed = [text, selected.length ? `画面包含：${selected.join('、')}` : '']
      .filter(Boolean)
      .join('；')

    jobRef.current = jobId
    setBusy(true)

    let cancelled = false
    const cancelOnDelete = (): void => {
      if (cancelled) return
      cancelled = true
      window.clearInterval(pollRef.current)
      cancelImage(jobId).catch(() => undefined)
      host.removePlaceholder(jobId, handleRef.current).catch(() => undefined)
    }

    host
      .insertPlaceholder(jobId, size.width, size.height)
      .then((handle) => {
        handleRef.current = handle
        pollRef.current = window.setInterval(() => {
          host
            .placeholderExists(jobId, handle)
            .then((alive) => {
              if (!alive) cancelOnDelete()
            })
            .catch(() => undefined)
        }, 2000)
        return generateImage({ jobId, prompt: composed, style, size: 1024 })
      })
      .then((res) => {
        window.clearInterval(pollRef.current)
        if (cancelled) return
        if (!res.ok) throw new Error(res.error || '生成失败')
        return getToken()
          .then((token) => fetchRaw(jobId, token))
          .then((blob) => toInsertableBase64(blob))
          .then(({ base64 }) => host.replacePlaceholder(jobId, base64, handleRef.current))
      })
      .catch((e) => {
        window.clearInterval(pollRef.current)
        if (cancelled) return
        console.error('[studio] 生成失败', e)
        // 窗格里不做生成中反馈，失败也必须落在文档上：把占位图换成失败态
        if (handleRef.current) {
          host
            .replacePlaceholder(jobId, placeholderBase64(size.width, size.height, 'failed'), handleRef.current)
            .catch(() => undefined)
        }
        notify(e instanceof Error ? e.message : '生成失败', 'error')
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <IdentityBar title="图乐园" hostLabel={hostLabel} onBack={onBack} />

      <div className="st-body">
        <div className="st-row">
          <select
            className="st-select"
            value={style}
            aria-label="画风"
            disabled={busy}
            onChange={(e) => setStyle(e.target.value)}
          >
            {styles.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={run}>
            生成
          </button>
        </div>

        <div className="st-elgrid">
          {elements.map((element) => {
            const on = selected.includes(element.name)
            return (
              <button
                key={element.id}
                type="button"
                className="st-elcard"
                data-on={on ? 'true' : 'false'}
                aria-pressed={on}
                disabled={busy}
                onClick={() => toggle(element.name)}
              >
                <img src={element.file} alt="" loading="lazy" draggable={false} />
                <span>{element.name}</span>
              </button>
            )
          })}
        </div>

        <RainbowPill
          label="画面描述"
          placeholder="描述画面"
          value={prompt}
          onChange={setPrompt}
          showSend={false}
          showIcon={false}
          disabled={busy}
        />
      </div>

      <div className="st-footer">
        <StatusLine message={status} />
      </div>
    </>
  )
}
