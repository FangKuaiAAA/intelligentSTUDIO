/**
 * 「整页」归纳覆盖层（扩展自有，不改动主项目的视觉智能组件）。
 *
 * 与「框选」共用同一套外观类（.visual-request-pill / .visual-answer-box / .visual-card …），
 * 所以观感与 Alt+V 一致，但没有框选这一步：直接整页截图 → 交给模型分点归纳 → 显示回答。
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { captureFullPage } from './pageCapture'
import type { PageBridge, VisionEvent } from './bridgePort'

const PILL_WIDTH = 320
const PILL_HEIGHT = 44
const PILL_TOP = 24
/**
 * 整页模式的黑框沿用「黑框不再包裹输入框之前」的形态：
 * 落在输入框下底边之下、左右各内缩 24px（即比输入框窄 48），与输入框各自独立。
 */
const ANSWER_TOP = PILL_TOP + PILL_HEIGHT + 40
const ANSWER_WIDTH = PILL_WIDTH - 48
const ANSWER_HEIGHT = 360

const SYSTEM_PROMPT = [
  '你是 intelligentSTUDIO 的智能视觉助手，不是 Dony。请根据用户的指令分析这张整页截图。',
  '只输出一个 JSON 对象，不要输出 markdown 代码块，不要输出任何解释文字。JSON 结构：',
  '{"text":"分点归纳，每点一行，行首用 ·","cards":[{"type":"text","content":"需要完整保留的长文本"}]}',
  '规则：',
  '1. 归纳写进 text：每点一行、行首用「·」，控制在 3 到 8 点。',
  '2. 忽略广告、推广、导航、页脚与弹窗。',
  '3. 只有在需要完整保留原文（如正文引用）时才用 type=text 卡片。',
].join('\n')

const USER_PROMPT = '请分点归纳这个网页的主要内容。'

interface AnswerCard {
  type: 'text' | 'link'
  content?: string
  title?: string
  url?: string
  image?: string
}

interface Answer {
  text: string
  cards: AnswerCard[]
}

const EMPTY: Answer = { text: '', cards: [] }

function stripCodeFence(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('```')) return text
  return text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
}

function parseAnswer(raw: string): Answer {
  const text = stripCodeFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const summary = typeof parsed.text === 'string' ? parsed.text.trim() : ''
      const cards: AnswerCard[] = []
      if (Array.isArray(parsed.cards)) {
        for (const item of parsed.cards) {
          if (!item || typeof item !== 'object') continue
          const card = item as Record<string, unknown>
          if (typeof card.content === 'string' && card.content.trim()) {
            cards.push({ type: 'text', content: card.content.replace(/\s+$/, '') })
          }
        }
      }
      if (summary || cards.length) return { text: summary, cards }
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return { text, cards: [] }
}

/** 与主项目视觉智能同一份光边结构（内部组件未导出，这里按同样的类名与几何复刻） */
function LoadingEdge({ active }: { active: boolean }) {
  const edgePath = 'M82 58 H358 A24 24 0 0 1 382 82 A24 24 0 0 1 358 106 H82 A24 24 0 0 1 58 82 A24 24 0 0 1 82 58 Z'
  return (
    <div className={`visual-loading-edge${active ? ' is-active' : ''}`} aria-hidden>
      <svg viewBox="0 0 440 164">
        <defs>
          <clipPath id="visual-edge-outside" clipPathUnits="userSpaceOnUse">
            <path clipRule="evenodd" d="M0 0H440V164H0Z M60 82a22 22 0 0 1 22-22h276a22 22 0 0 1 22 22a22 22 0 0 1-22 22H82a22 22 0 0 1-22-22Z" />
          </clipPath>
          <filter id="visual-edge-blur-a" x="-20%" y="-70%" width="140%" height="240%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation=".75" />
          </filter>
          <filter id="visual-edge-blur-b" x="-30%" y="-120%" width="160%" height="340%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
          <filter id="visual-edge-blur-c" x="-40%" y="-180%" width="180%" height="460%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          <filter id="visual-edge-blur-d" x="-60%" y="-260%" width="220%" height="620%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        <g clipPath="url(#visual-edge-outside)">
          <path className="edge-halo" filter="url(#visual-edge-blur-d)" d={edgePath} />
          <path className="edge-glow" filter="url(#visual-edge-blur-c)" d={edgePath} />
          <path className="edge-mid" filter="url(#visual-edge-blur-b)" d={edgePath} />
          <path className="edge-head" filter="url(#visual-edge-blur-a)" d={edgePath} />
        </g>
      </svg>
    </div>
  )
}

interface Props {
  bridge: PageBridge
  onClose: () => void
}

export function PageOverlay({ bridge, onClose }: Props) {
  const [busy, setBusy] = useState(true)
  const [answer, setAnswer] = useState<Answer>(EMPTY)
  const [message, setMessage] = useState('')
  const [revealed, setRevealed] = useState(false)
  const rawRef = useRef('')
  const startedRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    const off = bridge.onVision((ev: VisionEvent) => {
      if (cancelled) return
      if (ev.kind === 'delta') {
        rawRef.current += ev.delta ?? ''
        return
      }
      if (ev.kind === 'done') {
        bridge.log('整页：模型返回完成')
        setAnswer(parseAnswer(rawRef.current))
        setRevealed(true)
        setBusy(false)
        return
      }
      if (ev.kind === 'error') {
        bridge.log(`整页：模型错误 ${ev.message || ''}`)
        setBusy(false)
        setMessage(ev.message || '归纳失败 · 请重试')
      }
    })

    void (async () => {
      try {
        bridge.log('整页：开始滚动截屏')
        // 覆盖层自己是固定定位元素，拼接时会先把它隐藏，所以长图里不会出现这层 UI
        const image = await captureFullPage({ capture: () => bridge.capture() })
        if (cancelled) return
        bridge.log(`整页：已拼接 ${Math.round(image.length / 1024)}KB，开始请求模型`)
        rawRef.current = ''
        bridge.ask([
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: USER_PROMPT },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ])
      } catch (e) {
        if (cancelled) return
        bridge.log(`整页：失败 ${e instanceof Error ? e.message : String(e)}`)
        setBusy(false)
        setMessage(e instanceof Error ? e.message : '整页截图失败')
      }
    })()

    return () => {
      cancelled = true
      off()
    }
  }, [bridge])

  const showAnswer = revealed || (!busy && !!answer.text)

  return (
    <div className="visual-overlay" style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: '50%', top: PILL_TOP, transform: 'translateX(-50%)', pointerEvents: 'auto' }}>
        {/* is-plain：整页模式没有"彩虹输入框"这一层，彩虹整条去掉，只留白色磨砂面 */}
        <div className="visual-request-pill is-plain" style={{ width: PILL_WIDTH, height: PILL_HEIGHT }}>
          <div className="visual-request-pill-surface" />
          <span className="visual-request-pill-text">整页</span>
          <LoadingEdge active={busy || !showAnswer} />
          <button className="visual-answer-close-btn" onClick={onClose} aria-label="关闭">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12M12 4L4 12" stroke="#5a5a62" strokeWidth="2.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {(showAnswer || message) && (
          <motion.div
            className="visual-answer-box"
            style={{
              position: 'absolute',
              left: '50%',
              top: ANSWER_TOP,
              width: ANSWER_WIDTH,
              height: ANSWER_HEIGHT,
              marginLeft: -ANSWER_WIDTH / 2,
              pointerEvents: 'auto',
            }}
            initial={{ opacity: 0, scale: 1.18 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          >
            {/* 该黑框里没有"压在框上的输入框"，所以把默认预留的顶部内边距还原 */}
            <div className="visual-answer-scroll" style={{ paddingTop: 18 }}>
              {message ? (
                <p className="visual-answer-text">{message}</p>
              ) : (
                answer.text
                  .split(/\r?\n/)
                  .filter((line) => line.trim().length > 0)
                  .map((line, index) => (
                    <motion.p
                      key={`page-line-${index}`}
                      className="visual-answer-text"
                      initial={{ opacity: 0, transform: 'translateY(40px)' }}
                      animate={{ opacity: 1, transform: 'translateY(0)' }}
                      transition={{ duration: 0.14, ease: [0.1, 0.9, 0.2, 1] }}
                    >
                      {line}
                    </motion.p>
                  ))
              )}
              {answer.cards.map((card, index) => (
                <motion.div
                  key={`page-card-${index}`}
                  className="visual-card visual-text-card"
                  initial={{ opacity: 0, transform: 'translateY(40px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0)' }}
                  transition={{ duration: 0.14, ease: [0.1, 0.9, 0.2, 1] }}
                >
                  {card.content}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
