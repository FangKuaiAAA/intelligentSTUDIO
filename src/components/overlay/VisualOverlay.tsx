import { useState, useRef, useEffect, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { VisualPhase, VisualOption, VisualAnswer, VisualAnswerCard, VisualLinkCard } from '../../types'
import './VisualOverlay.css'

interface Rect { x: number; y: number; w: number; h: number }

interface VisualOverlayProps {
  onClose: () => void
}

const AI_MODEL = 'deepseek-flash'

const HANDLE_SIZE = 10
const MIN_SIZE = 20

const OPTIONS: { key: VisualOption; label: string; icon: string; prompt: string }[] = [
  { key: 'understand', label: '理解内容', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z', prompt: '请详细描述这张图片的内容。请简短回复。' },
  { key: 'translate', label: '翻译内容', icon: 'M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z', prompt: '请将这张图片中的文字翻译成中文。请简短回复。' },
  { key: 'extract', label: '提取文字', icon: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z', prompt: '请提取这张图片中的所有文字内容。请简短回复。' },
  { key: 'identify', label: '识别物体', icon: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z', prompt: '请识别这张图片中的所有物体。请简短回复。' },
  { key: 'search', label: '搜索物体', icon: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z', prompt: '请识别这张图片中的主要物体并提供相关信息。请简短回复。' },
]


const PILL_WIDTH = 320
const PILL_HEIGHT = 44
const STAGE_GAP = 10
// 确认选择后覆盖层会缩小成一个普通窗口，四周留给光边与雾的扩散空间（雾的外沿约 116px）
const WINDOW_PAD = 136
// 黑框（实色部分）与彩虹输入框的相对关系：输入框压在黑框之上，两者的左边缘与上边缘
// 对齐，右侧再多出 ANSWER_RIGHT_EXTRA —— 于是黑框把输入框"包住"，右侧留一点余量。
// 左侧为 0 表示对齐（不要写成负值，否则实色会伸到输入框左边缘之外）。
const ANSWER_LEFT_INSET = 0
// 右侧加长量 = 输入框总长度的 1/5
const ANSWER_RIGHT_EXTRA = PILL_WIDTH / 5
// 实色上边缘与输入框上边缘齐平（输入框整个落在黑框之内）。
// 注意气雾会从实色边缘往各个方向铺开约 44px，所以对齐之后雾在左侧/上侧也是往输入框外铺的。
const ANSWER_TOP_OFFSET = 0
// 返回黑框淡入时长；内容要等它收尾后再进场（见 finish）
const ANSWER_FADE_MS = 500
// 缩放用的曲线：从第 0 帧就开始，整条是幂 1.22 的缓出。
// 起步速度 1.22（只比匀速略快一点，不会一上来就冲），时间过半时进度约 57%，
// 即"快段 : 减速缓冲段"的动作比约 4:3；收尾速度降到 0，是较慢缓冲。
// 浓度不走这条 —— 它要求全线性，单独配置（见 transition）。
const ANSWER_FADE_EASE = (t: number) => {
  // 必须夹到 [0,1]：缓动函数偶尔会被传入略大于 1 的 t，
  // 而 (1-u) 在 u>1 时为负，负数取小数次幂（1.22）会得到 NaN，
  // NaN 会让 opacity 直接失效 —— 表现就是黑框根本不出现。
  const u = Math.min(1, Math.max(0, t))
  return 1 - (1 - u) ** 1.22
}
// 浓度曲线：先慢后快，越往后越快（进度 = t⁶，比上一版更极端）。
// 前 3/4 的时间只走到约 18%，几乎全堆在最后一段里浓起来。
// 幂次就是强度：4 是明显、6 是更极端（当前）、8 近乎"最后一瞬才出现"。
const ANSWER_FADE_OPACITY_EASE = (t: number) => {
  const u = Math.min(1, Math.max(0, t))
  return u ** 6
}
// 【既定行为】确认后不把窗口缩成小窗，让它保持全屏铺满。
// 原因：窗口一旦不再覆盖全屏，Windows 会在那一刻切换显示模式（肉眼就是屏幕闪一下，
// 同时系统自动关掉"专注/勿扰"）。保持全屏就没有这次切换。
// 配套：窗口全屏且置顶（内容透明、不遮挡桌面），所以鼠标按区域放行 ——
// 只在输入框/回答框范围内接管，其余位置穿透给桌面；拖动输入框改为搬动窗口内的内容。
const KEEP_WINDOW_FULLSCREEN = true
// 最小尺寸就是"刚好包住输入框"：实色宽 = 输入框宽 + ANSWER_RIGHT_EXTRA
const MIN_ANSWER_WIDTH = PILL_WIDTH
const MIN_ANSWER_HEIGHT = PILL_HEIGHT + 72
// 初始宽度即最小宽度
const DEFAULT_ANSWER_WIDTH = MIN_ANSWER_WIDTH
// 初始高度：上下端（高）与侧边（实色宽）取 √2 : 1，即高 = 实色宽 × √2
const DEFAULT_ANSWER_HEIGHT = Math.round((PILL_WIDTH + ANSWER_RIGHT_EXTRA) * Math.SQRT2)

const SYSTEM_PROMPT = [
  '你是 intelligentSTUDIO 的智能视觉助手，不是 Dony。请根据用户的指令分析图片。',
  '只输出一个 JSON 对象，不要输出 markdown 代码块，不要输出任何解释文字。JSON 结构：',
  '{"text":"可选的一句到三句简短说明，没有需要说明的填空字符串","cards":[{"type":"text","content":"需要完整展示的文字内容"},{"type":"link","title":"网站标题","url":"https://完整网址","image":"可选：网站主图的图片地址"}]}',
  '规则：',
  '1. 能用卡片表达的信息尽量放进 cards，不要与 text 重复；text 只写必要的简短结论。',
  '2. 提取文字类结果放进 type=text 卡片，保留原始换行与内容，不要改写。',
  '3. 涉及网站或链接时，每个链接一张 type=link 卡片，url 必须是完整的可访问网址。',
].join('\n')

type RainbowFlowStyle = CSSProperties & Record<string, string>

function stripCodeFence(raw: string) {
  const text = raw.trim()
  if (!text.startsWith('```')) return text
  return text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
}

function normalizeUrl(url: string) {
  const text = url.trim()
  return /^https?:\/\//i.test(text) ? text : `https://${text}`
}

function hostLabel(url: string) {
  try { return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '') } catch { return url }
}

function parseAnswer(raw: string): VisualAnswer {
  const text = stripCodeFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      const summary = typeof parsed.text === 'string' ? parsed.text.trim() : ''
      const cards: VisualAnswerCard[] = []
      if (Array.isArray(parsed.cards)) {
        for (const item of parsed.cards) {
          if (!item || typeof item !== 'object') continue
          const card = item as Record<string, unknown>
          if (typeof card.content === 'string' && card.content.trim()) {
            cards.push({ type: 'text', content: card.content.replace(/\s+$/, '') })
            continue
          }
          if (typeof card.url === 'string' && card.url.trim()) {
            const url = normalizeUrl(card.url)
            const title = typeof card.title === 'string' && card.title.trim() ? card.title.trim() : hostLabel(url)
            const image = typeof card.image === 'string' && /^https?:\/\//i.test(card.image.trim()) ? card.image.trim() : undefined
            cards.push({ type: 'link', title, url, image })
          }
        }
      }
      if (summary || cards.length) return { text: summary, cards }
    } catch {}
  }
  return { text: text, cards: [] }
}

function LoadingEdge({ active }: { active: boolean }) {
  // 光带中心落在输入框边界外侧 2px；内圈用 evenodd clip-path 挖空，只留向卡片外散射的光。
  // 模糊必须用带大 region 的 SVG filter：CSS blur 会被 SVG 默认的 filter region 裁成矩形边界。
  // 路径是一个胶囊：矩形范围 (58,58)-(382,106)，即 324×48、圆角 24，
  // 相当于 viewBox 里的输入框 (60,60)-(380,104) 各向外扩 2px。
  // 注意左右两条竖边的 x 一定是 58 / 382，写成别的值会让那一侧的光带整体内移。
  // 起点取"上边的左端"（左上圆角与上边的交点），顺时针一圈，于是各条边在路径上都是连续段：
  //   上边 0→276、右端（两个半圆）276→351.4、下边 351.4→627.4、左端 627.4→702.8
  // （上边/下边各 276 单位，四个半圆各 37.7 单位，总长 702.8）
  // 于是可以用一段虚线把某条边整条盖住，且相邻两条边的首尾相接，切换时是连续的。
  // 这里刻意不用 pathLength 归一化：它在 Chromium 上不可靠（rect 上更是直接失效），
  // 所以虚线长度一律按真实路径长度来写，见 CSS 里的 visualEdgePulse。
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
        {/* 只有一层光边：四张模糊层各画同一条虚线，横截面由模糊半径形成渐淡。
            不再细分"铺满/中段/中心"三档 —— 三档叠加会在横截面上形成台阶（就是"分层轮廓"）。 */}
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

function TextAnswerCard({ content, delay }: { content: string; delay: number }) {
  return (
    <motion.div className="visual-card visual-text-card"
      initial={{ opacity: 0, transform: 'translateY(57px)' }}
      animate={{ opacity: 1, transform: 'translateY(0)' }}
      transition={{ type: 'tween', duration: 0.13, ease: [0.1, 0.9, 0.2, 1], delay }}>
      {content}
    </motion.div>
  )
}

function LinkAnswerCard({ card, delay }: { card: VisualLinkCard; delay: number }) {
  const [image, setImage] = useState(card.image ?? '')
  const [imageFailed, setImageFailed] = useState(false)
  const host = hostLabel(card.url)

  useEffect(() => {
    if (card.image) return
    let cancelled = false
    window.electronAPI?.fetchLinkPreview?.(card.url)
      .then(preview => { if (!cancelled && preview?.image) setImage(preview.image) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [card.image, card.url])

  const openLink = () => {
    if (window.getSelection()?.toString()) return
    window.electronAPI?.openExternal?.(card.url)
  }

  return (
    <motion.div className="visual-card visual-link-card" role="link" tabIndex={0}
      initial={{ opacity: 0, transform: 'translateY(42px)' }}
      animate={{ opacity: 1, transform: 'translateY(0)' }}
      transition={{ type: 'tween', duration: 0.13, ease: [0.1, 0.9, 0.2, 1], delay }}
      onClick={openLink}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLink() } }}>
      {image && !imageFailed
        ? <img className="visual-link-thumb" src={image} alt="" draggable={false} onError={() => setImageFailed(true)} />
        : <div className="visual-link-thumb-fallback">{host.slice(0, 1) || 'L'}</div>}
      <div className="visual-link-meta">
        <span className="visual-link-title">{card.title || host}</span>
        <span className="visual-link-url">{card.url}</span>
      </div>
    </motion.div>
  )
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function createRainbowFlowStyle(): RainbowFlowStyle {
  const purple = 'rgba(116, 0, 255, 1)'
  const purpleSoft = 'rgba(154, 42, 255, .92)'
  const violet = 'rgba(82, 0, 214, .98)'
  const deepBlue = 'rgba(0, 16, 150, .36)'
  const red = 'rgba(255, 0, 34, .96)'
  const redSoft = 'rgba(255, 34, 48, .78)'
  const yellow = 'rgba(255, 226, 22, .9)'
  const yellowSoft = 'rgba(255, 226, 22, .58)'
  const makePalette = () => {
    const colorOrders = [
      [purple, red, purpleSoft, yellow, violet, redSoft, purple, yellowSoft, red, purpleSoft, yellow, purple],
      [violet, yellow, purple, redSoft, purpleSoft, red, purple, yellowSoft, deepBlue, purple, red, yellow],
      [purpleSoft, red, purple, yellowSoft, redSoft, violet, purple, yellow, red, purpleSoft, yellowSoft, purple],
      [purple, yellowSoft, violet, red, purple, yellow, purpleSoft, redSoft, deepBlue, violet, yellow, red],
    ]
    return colorOrders[Math.floor(randomBetween(0, colorOrders.length))]
  }
  const stagePalettes = {
    start: makePalette(),
    surge1: makePalette(),
    surge2: makePalette(),
    stall: makePalette(),
    surge3: makePalette(),
    end: makePalette(),
  }
  const xs = [-8, 2, 12, 24, 36, 48, 60, 72, 84, 96, 108, 118]
  const baseArcX = randomBetween(35, 65)
  const baseSideY = randomBetween(56, 74)
  const basePeakY = randomBetween(22, 42)
  const curveY = (x: number, depth: number, sideLift = 0, arcShift = 0, shapePower = 1.45) => {
    const arcX = baseArcX + arcShift
    const sideY = baseSideY + randomBetween(-3, 3)
    const peakY = basePeakY + randomBetween(-5, 5)
    const t = Math.min(1, Math.abs(x - arcX) / 58)
    return sideY + sideLift - (sideY - peakY) * (1 - Math.pow(t, shapePower)) * depth
  }
  const glowBackground = (colors: string[], depth: number, jitter: number, sideLift = 0, arcShift = 0) => xs.map((x, index) => {
    const y = curveY(x, depth, sideLift, arcShift, randomBetween(1.08, 2.35)) + randomBetween(-jitter, jitter)
    const color = colors[index]
    const isYellow = color === yellow || color === yellowSoft
    const isBlue = color === deepBlue
    const w = isBlue ? randomBetween(18, 28) : randomBetween(26, 42)
    const h = isBlue ? randomBetween(54, 76) : randomBetween(72, 108)
    const solid = isBlue ? randomBetween(16, 24) : randomBetween(22, 34)
    const fade = isBlue ? randomBetween(70, 82) : randomBetween(76, 90)
    const bridge = isYellow ? 'rgba(255, 40, 44, .16)' : 'rgba(116, 0, 255, .14)'
    return `radial-gradient(ellipse ${w.toFixed(1)}% ${h.toFixed(1)}% at ${x.toFixed(1)}% ${y.toFixed(1)}%, ${color} 0%, ${color} ${solid.toFixed(1)}%, ${bridge} ${randomBetween(44, 58).toFixed(1)}%, transparent ${fade.toFixed(1)}%)`
  }).join(', ')
  const waterShape = (topLift = 0, bottomLift = 0, arcShift = 0, strength = 1) => {
    const topArcX = randomBetween(24, 76) + arcShift
    const bottomArcX = randomBetween(18, 82) + arcShift * randomBetween(.35, .75)
    const topBase = randomBetween(17, 29) + topLift
    const bottomBase = randomBetween(74, 88) + bottomLift
    const topDepth = randomBetween(8, 19) * strength
    const bottomDepth = randomBetween(10, 24) * strength
    const edgeXs = [-16, 0, 18, 37, 55, 74, 92, 116]
    const topPoints = edgeXs.map(x => {
      const t = Math.max(0, 1 - Math.abs(x - topArcX) / randomBetween(34, 58))
      const y = topBase - Math.pow(t, randomBetween(1.25, 2.2)) * topDepth + randomBetween(-5.5, 5.5) * strength
      return `${x.toFixed(1)}% ${y.toFixed(1)}%`
    })
    const bottomPoints = [...edgeXs].reverse().map(x => {
      const t = Math.max(0, 1 - Math.abs(x - bottomArcX) / randomBetween(36, 62))
      const y = bottomBase - Math.pow(t, randomBetween(1.15, 2.05)) * bottomDepth + randomBetween(-7.5, 7.5) * strength
      return `${x.toFixed(1)}% ${y.toFixed(1)}%`
    })
    return [...topPoints, ...bottomPoints].join(', ')
  }
  const duration = Math.round(randomBetween(430, 580))
  const stallY = randomBetween(-112, -138)

  return {
    '--visual-flow-duration': `${duration}ms`,
    '--visual-flow-color-start-x': `${randomBetween(8, 76).toFixed(2)}%`,
    '--visual-flow-color-start-y': `${randomBetween(18, 78).toFixed(2)}%`,
    '--visual-flow-color-mid-x': `${randomBetween(6, 94).toFixed(2)}%`,
    '--visual-flow-color-mid-y': `${randomBetween(8, 88).toFixed(2)}%`,
    '--visual-flow-color-end-x': `${randomBetween(20, 118).toFixed(2)}%`,
    '--visual-flow-color-end-y': `${randomBetween(2, 82).toFixed(2)}%`,
    '--visual-flow-skew': `${randomBetween(-6.5, 6.5).toFixed(2)}deg`,
    '--visual-flow-scale': randomBetween(1.08, 1.18).toFixed(3),
    '--visual-flow-length-start': randomBetween(.82, 1.02).toFixed(3),
    '--visual-flow-length-surge1': randomBetween(1.12, 1.38).toFixed(3),
    '--visual-flow-length-surge2': randomBetween(.96, 1.18).toFixed(3),
    '--visual-flow-length-stall': randomBetween(1.34, 1.62).toFixed(3),
    '--visual-flow-length-surge3': randomBetween(.72, .94).toFixed(3),
    '--visual-flow-length-end': randomBetween(1.06, 1.34).toFixed(3),
    '--visual-flow-y-stall': `${stallY.toFixed(2)}%`,
    '--visual-flow-y-stall-end': `${(stallY - randomBetween(2.5, 6.5)).toFixed(2)}%`,
    '--visual-flow-y-surge3': `${randomBetween(-218, -258).toFixed(2)}%`,
    '--visual-flow-y-end': `${randomBetween(-402, -456).toFixed(2)}%`,
    '--visual-flow-shape-start': waterShape(4, 6, randomBetween(-8, 8), .82),
    '--visual-flow-shape-surge1': waterShape(0, -2, randomBetween(-14, 14), 1.05),
    '--visual-flow-shape-surge2': waterShape(-3, -5, randomBetween(-20, 20), 1.34),
    '--visual-flow-shape-stall': waterShape(2, 3, randomBetween(-12, 12), 1.1),
    '--visual-flow-shape-surge3': waterShape(-6, -9, randomBetween(-24, 24), 1.48),
    '--visual-flow-shape-end': waterShape(1, 5, randomBetween(-16, 16), 1.18),
    '--visual-flow-bg-start': glowBackground(stagePalettes.start, .72, 5, 6, randomBetween(-16, 16)),
    '--visual-flow-bg-surge1': glowBackground(stagePalettes.surge1, 1.22, 8, 0, randomBetween(-22, 22)),
    '--visual-flow-bg-surge2': glowBackground(stagePalettes.surge2, 1.68, 11, -3, randomBetween(-28, 28)),
    '--visual-flow-bg-stall': glowBackground(stagePalettes.stall, .86, 7, 2, randomBetween(-20, 20)),
    '--visual-flow-bg-surge3': glowBackground(stagePalettes.surge3, 1.92, 13, -5, randomBetween(-34, 34)),
    '--visual-flow-bg-end': glowBackground(stagePalettes.end, 1.18, 9, 3, randomBetween(-24, 24)),
  }
}
// 选区截图的长边上限。全屏截图动辄 2560×1440，PNG 无损时请求体能到数 MB，
// 上传 + 服务端视觉编码会明显变慢（实测出现过 90s 内一个字节都没回的超时）。
// 1400 对界面文字仍然清晰，PNG 保持无损，但像素量降一个数量级。
const MAX_IMAGE_SIDE = 1400

function cropFromScreen(img: HTMLImageElement, rect: Rect): string {
  const imgScale = img.naturalWidth / img.width
  const sw = rect.w * imgScale
  const sh = rect.h * imgScale
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * k))
  canvas.height = Math.max(1, Math.round(sh * k))
  const ctx = canvas.getContext('2d')!
  // 缩小用高质量插值，避免细笔画/文字在小字号下糊掉
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, rect.x * imgScale, rect.y * imgScale, sw, sh,
    0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export function VisualOverlay({ onClose }: VisualOverlayProps) {
  const [phase, setPhase] = useState<VisualPhase>('selecting')
  const [selRect, setSelRect] = useState<Rect | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragEnd, setDragEnd] = useState({ x: 0, y: 0 })
  const [resizing, setResizing] = useState<'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null>(null)
  const [customPrompt, setCustomPrompt] = useState('')
  const [requestText, setRequestText] = useState('')
  const [answer, setAnswer] = useState<VisualAnswer>({ text: '', cards: [] })
  const [answerRevealed, setAnswerRevealed] = useState(false)
  const [edgeActive, setEdgeActive] = useState(false)
  const [answerSize, setAnswerSize] = useState({ w: DEFAULT_ANSWER_WIDTH, h: DEFAULT_ANSWER_HEIGHT })
  // 验证版窗口不移动，拖动输入框时改为搬动窗口内的内容
  const [stageOffset, setStageOffset] = useState({ x: 0, y: 0 })
  // 实际视口尺寸：确认态窗口会在全屏与"小窗"之间切换，用它来判断窗口是否已收缩
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  /** 确认后是否已进入"彩虹淡出 + 输入框加深"的终态（见下方 isConfirmPhase 处的过渡逻辑） */
  const [settled, setSettled] = useState(false)
  // 确认后覆盖层变成"普通窗口"，这里维护窗口的屏幕矩形（位置 + 尺寸）
  const windowRectRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const applyWindowRect = useCallback((patch: Partial<{ x: number; y: number; width: number; height: number }>) => {
    // 窗口始终保持全屏，任何尺寸上报都必须丢弃：
    // 否则窗口会被缩到左上角，内容落在窗口之外，看起来就是"窗口没了"
    if (KEEP_WINDOW_FULLSCREEN) return
    const next = { ...windowRectRef.current, ...patch }
    windowRectRef.current = next
    window.electronAPI?.setVisualWindowRect?.(next)
  }, [])

  const contentWindowSize = useCallback((width: number, height: number) => ({
    width: Math.max(PILL_WIDTH, width) + WINDOW_PAD * 2,
    height: Math.max(PILL_HEIGHT, height) + WINDOW_PAD * 2,
  }), [])

  // 选框彩虹扫描开始时的提示音（public/Visual.mp3）。
  // 路径写成相对形式：dev 下解析为 http://localhost:5173/Visual.mp3，
  // 打包后解析为 file://.../dist/Visual.mp3，两种运行方式都能命中。
  const soundRef = useRef<HTMLAudioElement | null>(null)
  const playVisualSound = useCallback(() => {
    try {
      if (!soundRef.current) {
        const audio = new Audio('./Visual.mp3')
        audio.volume = 0.8
        soundRef.current = audio
      }
      // 复用同一个实例，但要回到开头，否则连续触发时第二次不会响
      soundRef.current.currentTime = 0
      void soundRef.current.play().catch(() => {})
    } catch {}
  }, [])

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [showRainbowEffect, setShowRainbowEffect] = useState(false)
  const [rainbowFlowStyle, setRainbowFlowStyle] = useState<RainbowFlowStyle>(() => createRainbowFlowStyle())
  const responseRef = useRef('')
  const screenImgRef = useRef<HTMLImageElement | null>(null)
  const panelDragRef = useRef<{ lastX: number; lastY: number } | null>(null)
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null)
  const dragRafRef = useRef(0)
  const resizeDragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([])
  const answerBoxRef = useRef<HTMLDivElement | null>(null)
  const resultCloseButtonRef = useRef<HTMLButtonElement | null>(null)

  const getSelectionRect = useCallback((): Rect => {
    const x = Math.min(dragStart.x, dragEnd.x)
    const y = Math.min(dragStart.y, dragEnd.y)
    const w = Math.abs(dragEnd.x - dragStart.x)
    const h = Math.abs(dragEnd.y - dragStart.y)
    return { x, y, w, h }
  }, [dragStart, dragEnd])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (phase === 'selecting') {
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY })
      setDragEnd({ x: e.clientX, y: e.clientY })
      return
    }
    if (phase === 'options' && selRect) {
      const { x, y, w, h } = selRect
      if (e.clientX < x || e.clientX > x + w || e.clientY < y || e.clientY > y + h) {
        setSelRect(null)
        setPhase('selecting')
        setRequestText('')
        setAnswer({ text: '', cards: [] })
        setAnswerRevealed(false)
        setEdgeActive(false)
        setCustomPrompt('')
      }
    }
  }, [phase, selRect])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setDragEnd({ x: e.clientX, y: e.clientY })
      return
    }
    if (resizing && selRect) {
      e.preventDefault()
      const r = { ...selRect }
      const mx = e.clientX
      const my = e.clientY
      if (resizing.includes('e')) r.w = Math.max(MIN_SIZE, mx - r.x)
      if (resizing.includes('w')) { const nr = r.x + r.w - mx; r.x = mx; r.w = Math.max(MIN_SIZE, nr) }
      if (resizing.includes('s')) r.h = Math.max(MIN_SIZE, my - r.y)
      if (resizing.includes('n')) { const nr = r.y + r.h - my; r.y = my; r.h = Math.max(MIN_SIZE, nr) }
      setSelRect(r)
    }
  }, [isDragging, resizing, selRect])

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false)
      const r = getSelectionRect()
      if (r.w < MIN_SIZE || r.h < MIN_SIZE) return
      setSelRect(r)
      setPhase('options')
      return
    }
    setResizing(null)
  }, [isDragging, getSelectionRect])

  const startResize = useCallback((dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw', e: React.MouseEvent) => {
    e.stopPropagation()
    setResizing(dir)
  }, [])

  const runVisualRequest = useCallback(async (option: VisualOption | null, extraPrompt: string) => {
    if (!selRect) return
    const opt = option ? OPTIONS.find(o => o.key === option) ?? null : null
    const extra = extraPrompt.trim()

    setRequestText(opt ? opt.label : extra)
    setAnswer({ text: '', cards: [] })
    setAnswerRevealed(false)
    setEdgeActive(true)
    setRainbowFlowStyle(createRainbowFlowStyle())
    setShowRainbowEffect(true)
    // 彩虹扫描动画开始的同一刻给一声提示音
    playVisualSound()
    setPhase('processing')

    const basePrompt = opt ? opt.prompt : extra
    const fullPrompt = opt && extra ? `${basePrompt}\n\n用户补充要求：${extra}` : basePrompt

    responseRef.current = ''
    await new Promise(resolve => setTimeout(resolve, 620))
    setShowRainbowEffect(false)
    setPhase('loading')

    const finish = (raw: string) => {
      setAnswer(parseAnswer(raw))
      setEdgeActive(false)
      setPhase('responding')
      // 内容进场排在黑框淡入收尾之后：淡入途中把占位换成卡片会额外触发一次重绘，
      // 在透明窗口上就表现为"淡入一半闪一下"。已经过了淡入的话不再等。
      const sinceFade = fadeStartRef.current ? performance.now() - fadeStartRef.current : 0
      const wait = Math.max(160, ANSWER_FADE_MS + 80 - sinceFade)
      window.setTimeout(() => setAnswerRevealed(true), wait)
    }

    try {
      const dataUrl = await window.electronAPI.captureScreen()
      const img = new Image()
      img.onload = async () => {
        screenImgRef.current = img
        const cropped = cropFromScreen(img, selRect)
        try {
          const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: [{ type: 'text', text: fullPrompt }, { type: 'image_url', image_url: { url: cropped } }] },
          ]
          await new Promise<void>((resolve, reject) => {
            const cleanups: (() => void)[] = []
            cleanups.push(window.electronAPI.onChatChunk((d: string) => {
              try {
                responseRef.current += JSON.parse(d).choices?.[0]?.delta?.content || ''
              } catch {}
            }))
            cleanups.push(window.electronAPI.onChatEnd(() => {
              cleanups.forEach(fn => fn()); resolve()
            }))
            cleanups.push(window.electronAPI.onChatError((err: string) => {
              cleanups.forEach(fn => fn()); reject(new Error(err))
            }))
            window.electronAPI.sendChatRequest({ messages, model: AI_MODEL })
          })
          finish(responseRef.current)
        } catch (err) {
          finish(`抱歉，AI 服务暂不可用。\n（${err instanceof Error ? err.message : String(err)}）`)
        }
      }
      img.onerror = () => finish('抱歉，AI 服务暂不可用。\n（屏幕截图读取失败）')
      img.src = dataUrl
    } catch (err) {
      finish(`抱歉，AI 服务暂不可用。\n（${err instanceof Error ? err.message : String(err)}）`)
      }
      }, [selRect, playVisualSound])

  const handleOptionClick = useCallback((option: VisualOption) => {
    void runVisualRequest(option, customPrompt)
  }, [runVisualRequest, customPrompt])

  const handleCustomSubmit = useCallback(() => {
    const text = customPrompt.trim()
    if (!text) return
    void runVisualRequest(null, text)
  }, [runVisualRequest, customPrompt])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  // 唤醒后立刻截屏作为底衬。此时窗口内容为空，截图不会带上遮罩，
  // 且它让遮罩/回答框的 backdrop-filter 有可模糊的对象（透明窗口无法模糊桌面）。


  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // 上面的 keydown 只在窗口有焦点时生效。视觉智能按设计不抢焦点（showInactive 唤醒），
  // 确认阶段放行鼠标时主进程还会取消可聚焦并失焦，此时按键到不了这里 —— 主进程在视觉智能
  // 期间挂了一个全局 Esc 兜底（见 main.js 的 registerVisualEscape），这里接住它，
  // 与直接按 Esc 走同一个 onClose。
  useEffect(() => {
    const off = window.electronAPI?.onVisualEscape?.(() => onClose())
    return () => off?.()
  }, [onClose])

  const sel = selRect ?? getSelectionRect()
  const showDim = phase === 'selecting' || phase === 'options'
  const showSelection = (isDragging || phase === 'options' || phase === 'processing') && sel.w > 0 && sel.h > 0
  const showHandles = showDim && selRect && phase === 'options'
  const showOptionsPanel = selRect && (phase === 'options' || phase === 'processing' || phase === 'loading' || phase === 'responding')
  const isConfirmPhase = phase === 'processing' || phase === 'loading' || phase === 'responding'
  const isAnswerVisible = phase === 'loading' || phase === 'responding'

  // 用户确认选择后，彩虹单独用 0.5s 淡出，同一段时间里把输入框的不透明度从 60% 提到 93%
  // （图标、文字、加载光边、黑框、回答框都不受影响）。
  // 用状态 + CSS 过渡而不是挂载即生效的 CSS 动画：彩虹输入框（pill）是确认那一刻才挂载的，
  // 需要"先渲染出彩虹可见的一帧，再翻状态"，否则首帧就已经是终态，看不到过渡过程。
  useEffect(() => {
    if (!isConfirmPhase) {
      setSettled(false)
      return
    }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [isConfirmPhase])

  // 一律按"全屏尺寸"算面板位置：框选本来就在全屏窗口上发生，这样子坐标始终是屏幕坐标。
  // 若跟着 window.innerWidth 走，窗口收缩成小窗后这里会重算成窗口内坐标，
  // 位置就会在收缩前后跳变（表现为输入框跑到左上角）。
  const FLOW_W = window.screen.availWidth
  const FLOW_H = window.screen.availHeight
  const PANEL_W = Math.min(520, FLOW_W - 32)
  const panelTop = selRect
    ? Math.max(16, Math.min(selRect.y, FLOW_H - PILL_HEIGHT - 16))
    : 0
  const panelRightX = selRect ? selRect.x + selRect.w + 12 : 0
  const preferredPanelLeft = selRect
    ? (panelRightX + PANEL_W <= FLOW_W - 16 ? panelRightX : selRect.x + selRect.w - PANEL_W - 8)
    : 0
  const panelLeft = Math.max(16, Math.min(preferredPanelLeft, FLOW_W - PANEL_W - 16))
  const displayedPanelLeft = panelLeft
  const displayedPanelTop = panelTop
  // 窗口是否真的已经收缩成小窗。收缩要经 IPC → 主进程 setBounds，是异步的，
  // 所以不能只看 phase：那段时间里窗口尺寸和定位基准不一致，输入框就会错位到左上角。
  // 以渲染进程的实际视口为准，窗口一旦变小就立刻切到窗口内定位。
  const isCollapsedWindow = !KEEP_WINDOW_FULLSCREEN && isAnswerVisible && viewport.w < FLOW_W - 40
  // 顺序反过来：黑框先在全屏窗口上淡完，之后再收缩窗口。
  // 淡入与"窗口重建渲染表面"是两件都会触发重绘的事，彻底错开就不会互相打断。
  const [answerStageReady, setAnswerStageReady] = useState(false)
  const fadeStartRef = useRef(0)
  useEffect(() => {
    if (!isAnswerVisible) { setAnswerStageReady(false); fadeStartRef.current = 0; return }
    const timer = window.setTimeout(() => setAnswerStageReady(true), ANSWER_FADE_MS + 120)
    return () => window.clearTimeout(timer)
  }, [isAnswerVisible])
  // 记录淡入起点：内容进场要比它晚，避开淡入途中那次重绘
  useEffect(() => {
    if (isAnswerVisible) fadeStartRef.current = performance.now()
  }, [isAnswerVisible])
  // 确认输入后每个选项胶囊向上飞入请求框后方被遮盖（退场）
  // 展开动画即该动画的反向：从请求框内侧向外逐个落位
  const pillFlyDistance = useCallback((index: number) => {
    const pill = pillRefs.current[index]
    const slot = slotRef.current
    if (!pill || !slot) return -(49 + index * 43)
    return -(pill.offsetTop + pill.offsetHeight / 2 - slot.offsetHeight / 2)
  }, [])

  const startPanelDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // 窗口收成小窗时，拖动 = 移动窗口；验证版窗口一直全屏，则改为在窗口内搬动内容。
    // 若在窗口还全屏（选区扫描/收缩之前）时按下，抓取偏移是按全屏窗口算出来的，
    // 等窗口一收缩基准就变了，拖动时整个窗口会被甩到屏幕左上角 —— 所以那时不接管。
    if (!KEEP_WINDOW_FULLSCREEN && !isCollapsedWindow) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    panelDragRef.current = { lastX: e.screenX, lastY: e.screenY }
  }, [isCollapsedWindow])

  const movePanelDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = panelDragRef.current
    if (!drag) return
    const dx = e.screenX - drag.lastX
    const dy = e.screenY - drag.lastY
    if (dx === 0 && dy === 0) return
    drag.lastX = e.screenX
    drag.lastY = e.screenY
    if (KEEP_WINDOW_FULLSCREEN) {
      setStageOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }))
      return
    }
    // 按"窗口当前真实位置 + 本次光标位移"推进，而不是"光标绝对位置 - 固定抓取偏移"。
    // 这样窗口何时收缩、何时被系统挪动都不影响拖动结果。
    pendingPosRef.current = {
      x: Math.round(window.screenX + dx),
      y: Math.round(window.screenY + dy),
      ...contentWindowSize(answerSize.w + ANSWER_RIGHT_EXTRA, answerSize.h),
    }
    if (dragRafRef.current) return
    // 每帧最多同步一次窗口位置，避免高频 setBounds 卡顿
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = 0
      const pos = pendingPosRef.current
      if (pos) applyWindowRect(pos)
    })
  }, [applyWindowRect, contentWindowSize, answerSize])

  const endPanelDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!panelDragRef.current) return
    panelDragRef.current = null
    if (dragRafRef.current) { window.cancelAnimationFrame(dragRafRef.current); dragRafRef.current = 0 }
    const pos = pendingPosRef.current
    pendingPosRef.current = null
    if (pos) applyWindowRect(pos)
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [applyWindowRect])

  const startAnswerResize = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeDragRef.current = { startX: e.clientX, startY: e.clientY, startW: answerSize.w, startH: answerSize.h }
  }, [answerSize])

  const moveAnswerResize = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = resizeDragRef.current
    if (!drag) return
    // 窗口会随内容一起放大（内容 + 两侧 WINDOW_PAD），限制到屏幕可用区域内，雾才不会被屏幕边裁掉
    const maxW = Math.max(MIN_ANSWER_WIDTH, window.screen.availWidth - WINDOW_PAD * 2)
    const maxH = Math.max(MIN_ANSWER_HEIGHT, window.screen.availHeight - WINDOW_PAD * 2)
    setAnswerSize({
      w: Math.max(MIN_ANSWER_WIDTH, Math.min(drag.startW + (e.clientX - drag.startX), maxW)),
      h: Math.max(MIN_ANSWER_HEIGHT, Math.min(drag.startH + (e.clientY - drag.startY), maxH)),
    })
  }, [displayedPanelLeft, displayedPanelTop])

  const endAnswerResize = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!resizeDragRef.current) return
    resizeDragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  // 确认选择后不立刻缩小窗口：选区线条高亮与选区内的彩虹扫描还要在这块屏幕上播完（约 0.5s），
  // 一旦提前缩成小窗，选区就落到窗口之外，动画会直接"消失"，收缩那一帧还会留下错位残影。
  // 之后也不马上收：黑框要在这块全屏窗口上把淡入做完，等 answerStageReady 才切换成"普通窗口"
  // （只包住输入框与回答框、取消置顶、不接管鼠标），这样它不会被其它窗口遮挡抢焦点，
  // 也不再干扰任务栏与窗口管理。
  useEffect(() => {
    if (KEEP_WINDOW_FULLSCREEN) return
    if (!isAnswerVisible) {
      window.electronAPI?.setVisualWindowMode?.(false)
      return
    }
    if (!answerStageReady) return
    applyWindowRect({
      x: displayedPanelLeft - WINDOW_PAD,
      y: displayedPanelTop - WINDOW_PAD,
      ...contentWindowSize(answerSize.w + ANSWER_RIGHT_EXTRA, answerSize.h),
    })
    window.electronAPI?.setVisualWindowMode?.(true)
    return () => { window.electronAPI?.setVisualWindowMode?.(false) }
  }, [isAnswerVisible, answerStageReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // 穿透开关去重：mousemove 每次都会调用它，而每次调用都会重建窗口的输入区域
  // （一次 IPC 加一次系统调用）。高频反复重建足以让窗口表现异常（例如整块不再绘制），
  // 所以只在状态真的变化时才下发。
  const passthroughRef = useRef(false)
  const applyPassthrough = useCallback((value: boolean) => {
    if (passthroughRef.current === value) return
    passthroughRef.current = value
    window.electronAPI?.setVisualMousePassthrough?.(value)
  }, [])

  // 验证开关打开时：窗口一直全屏且置顶，所以按"光标是否落在输入框/回答框上"动态放行鼠标，
  // 其余位置一律穿透，桌面照常可用。框选阶段绝不穿透，否则连选区都画不出来。
  useEffect(() => {
    if (!KEEP_WINDOW_FULLSCREEN) return
    if (!isConfirmPhase) {
      applyPassthrough(false)
      return
    }
    const contains = (rect: DOMRect | null | undefined, x: number, y: number) =>
      !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    const handleMove = (e: MouseEvent) => {
      // 拖动中必须一直接收鼠标：光标一旦移出输入框就被判成穿透的话，拖动会当场断掉
      if (panelDragRef.current) {
        applyPassthrough(false)
        return
      }
      const inside = contains(slotRef.current?.getBoundingClientRect(), e.clientX, e.clientY)
        || contains(answerBoxRef.current?.getBoundingClientRect(), e.clientX, e.clientY)
      applyPassthrough(!inside)
    }
    window.addEventListener('mousemove', handleMove)
    applyPassthrough(false)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      applyPassthrough(false)
    }
  }, [isConfirmPhase, applyPassthrough])

  useEffect(() => {
    if (KEEP_WINDOW_FULLSCREEN) return
    if (!isAnswerVisible) return
    applyWindowRect(contentWindowSize(answerSize.w + ANSWER_RIGHT_EXTRA, answerSize.h))
  }, [isAnswerVisible, answerSize, applyWindowRect, contentWindowSize])

  // 窗口真的收起后对一次位置：主进程的 setBounds 是异步的，若落地时位置有偏差，
  // 这里按同一基准纠回来，避免小窗停在屏幕左上角。
  useEffect(() => {
    if (!isCollapsedWindow) return
    const x = displayedPanelLeft - WINDOW_PAD
    const y = displayedPanelTop - WINDOW_PAD
    if (Math.abs(window.screenX - x) > 1 || Math.abs(window.screenY - y) > 1) {
      applyWindowRect({ x, y })
    }
  }, [isCollapsedWindow]) // eslint-disable-line react-hooks/exhaustive-deps



  return (
    <div className="visual-overlay">
      <div className={`visual-dim-layer${isConfirmPhase ? ' visual-dim-layer-passive' : ''}`} style={{ cursor: phase === 'selecting' ? 'crosshair' : 'default' }} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
        {showDim && !showSelection && <div className="visual-dim-cover" />}
        <AnimatePresence initial={false}>
          {showSelection && (
            <motion.div key="visual-cutout" className="visual-cutout"
              exit={{ opacity: 0 }}
              // 黑幕渐隐比黑框淡入短：它是整屏大小的一层，早一点退完，
              // 屏幕范围内同时变化的全屏/半透明层就少一层
              transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
              style={{
                left: sel.x, top: sel.y, width: sel.w, height: sel.h,
                boxShadow: showRainbowEffect ? '0 0 0 9999px rgba(0,0,0,0)' : '0 0 0 9999px rgba(0,0,0,0.7)',
              }}>
              <div className="visual-cutout-border" />
              <div className="visual-cutout-glow" />
              {showRainbowEffect && <div className="visual-rainbow-flow" style={rainbowFlowStyle} />}
            </motion.div>
          )}
        </AnimatePresence>
        {showDim && !selRect && !isDragging && (
          <div className="visual-dim-bg" />
        )}
        {showHandles && (
          <>
            <div className="visual-resize-handle visual-rh-n"
              onMouseDown={(e) => startResize('n', e)}
              style={{ left: sel.x + sel.w / 2 - HANDLE_SIZE / 2, top: sel.y - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-s"
              onMouseDown={(e) => startResize('s', e)}
              style={{ left: sel.x + sel.w / 2 - HANDLE_SIZE / 2, top: sel.y + sel.h - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-e"
              onMouseDown={(e) => startResize('e', e)}
              style={{ left: sel.x + sel.w - HANDLE_SIZE / 2, top: sel.y + sel.h / 2 - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-w"
              onMouseDown={(e) => startResize('w', e)}
              style={{ left: sel.x - HANDLE_SIZE / 2, top: sel.y + sel.h / 2 - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-ne"
              onMouseDown={(e) => startResize('ne', e)}
              style={{ left: sel.x + sel.w - HANDLE_SIZE / 2, top: sel.y - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-nw"
              onMouseDown={(e) => startResize('nw', e)}
              style={{ left: sel.x - HANDLE_SIZE / 2, top: sel.y - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-se"
              onMouseDown={(e) => startResize('se', e)}
              style={{ left: sel.x + sel.w - HANDLE_SIZE / 2, top: sel.y + sel.h - HANDLE_SIZE / 2 }} />
            <div className="visual-resize-handle visual-rh-sw"
              onMouseDown={(e) => startResize('sw', e)}
              style={{ left: sel.x - HANDLE_SIZE / 2, top: sel.y + sel.h - HANDLE_SIZE / 2 }} />
          </>
        )}
        {isDragging && (
          <div className="visual-drag-rect" style={{
            left: Math.min(dragStart.x, dragEnd.x),
            top: Math.min(dragStart.y, dragEnd.y),
            width: Math.abs(dragEnd.x - dragStart.x),
            height: Math.abs(dragEnd.y - dragStart.y),
          }} />
        )}
      </div>

      <AnimatePresence>
        {showOptionsPanel && (
          <div key="options-panel" ref={stageRef} className="visual-confirm-stage"
            style={{
              // 窗口真的收起后才取窗口内的固定位置，屏幕上的位置由窗口位置决定
              // （拖动输入框 = 移动窗口）；在此之前窗口仍是全屏，stage 直接用屏幕坐标。
              // 判断以实际视口为准，否则窗口还在收缩途中就把基准换掉，输入框会闪到左上角。
              left: (isCollapsedWindow ? WINDOW_PAD : displayedPanelLeft) + stageOffset.x,
              top: (isCollapsedWindow ? WINDOW_PAD : displayedPanelTop) + stageOffset.y,
            }}>
            <div className="visual-request-slot" ref={slotRef}>
              <AnimatePresence>
                {!isConfirmPhase ? (
                  <motion.div key="editor" className="visual-request-card"
                    style={{ position: 'absolute', inset: 0 }}
                    initial={{ opacity: 0, y: 40 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 20, mass: 0.8 }}>
                    <div className="visual-custom-input-wrap">
                      {/* 输入框图标：黑线描在上，同一份路径的彩虹描边（模糊）垫在下 = 彩色光晕。
                          不能用多层同色 drop-shadow —— 它们都作用在同一个剪影上，红会压掉其余颜色，
                          只剩一团偏红的光；彩虹渐变描边才会让红/橙/黄/蓝/紫沿图形铺开。 */}
                      <svg className="visual-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
                        <defs>
                          <linearGradient id="visual-input-icon-gradient" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stopColor="#FF323C" />
                            <stop offset="22%" stopColor="#FF8C1E" />
                            <stop offset="42%" stopColor="#FFDC32" />
                            <stop offset="62%" stopColor="#1E3CC8" />
                            <stop offset="82%" stopColor="#B432FF" />
                            <stop offset="100%" stopColor="#FF323C" />
                          </linearGradient>
                          <g id="visual-input-icon-shape">
                            <path d="M12,2.4 C12.7,2.4 13.4,2.8 14.1,3.2 L18.4,5.7 C20,6.6 20.8,7.8 20.8,9.6 L20.8,14.4 C20.8,16.2 20,17.4 18.4,18.3 L14.1,20.8 C13.4,21.2 12.7,21.6 12,21.6 C11.3,21.6 10.6,21.2 9.9,20.8 L5.6,18.3 C4,17.4 3.2,16.2 3.2,14.4 L3.2,9.6 C3.2,7.8 4,6.6 5.6,5.7 L9.9,3.2 C10.6,2.8 11.3,2.4 12,2.4" />
                            <path d="M4.8,12 C6.4,9.1 10,8.35 12,8.35 C14,8.35 17.6,9.1 19.2,12 C17.6,14.9 14,15.65 12,15.65 C10,15.65 6.4,14.9 4.8,12" />
                            <circle cx="12" cy="12" r="2.2" />
                            <path d="M10.9,11.35 C11.4,10.86 12.35,10.78 13.02,11.22" strokeWidth=".72" opacity=".9" />
                          </g>
                        </defs>
                        <use href="#visual-input-icon-shape" className="visual-icon-glow-far" stroke="url(#visual-input-icon-gradient)" />
                        <use href="#visual-input-icon-shape" className="visual-icon-glow" stroke="url(#visual-input-icon-gradient)" />
                        <use href="#visual-input-icon-shape" className="visual-icon-ink" stroke="#000" />
                        <circle cx="12.78" cy="11.22" r=".42" fill="#000" stroke="none" />
                      </svg>
                      {!customPrompt && <span className="visual-input-placeholder">视觉请求</span>}
                      <input className="visual-custom-input" type="text"
                        aria-label="视觉请求"
                        value={customPrompt}
                        onChange={(e) => { e.stopPropagation(); setCustomPrompt(e.target.value) }}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && customPrompt.trim()) handleCustomSubmit() }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        spellCheck={false} />
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="request-pill"
                    className={`visual-request-pill${(KEEP_WINDOW_FULLSCREEN || isCollapsedWindow) ? '' : ' is-drag-locked'}${settled ? ' is-settled' : ''}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                    onPointerDown={startPanelDrag}
                    onPointerMove={movePanelDrag}
                    onPointerUp={endPanelDrag}
                    onPointerCancel={endPanelDrag}>
                    <div className="visual-request-pill-surface" />
                    {/* 确认后的输入框图标：同样黑线描 + 彩虹渐变光晕 */}
                    <svg className="visual-request-pill-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
                      <defs>
                        <linearGradient id="visual-request-icon-gradient" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                          <stop offset="0%" stopColor="#FF323C" />
                          <stop offset="22%" stopColor="#FF8C1E" />
                          <stop offset="42%" stopColor="#FFDC32" />
                          <stop offset="62%" stopColor="#1E3CC8" />
                          <stop offset="82%" stopColor="#B432FF" />
                          <stop offset="100%" stopColor="#FF323C" />
                        </linearGradient>
                        <g id="visual-request-icon-shape">
                          <path d="M12,2.4 C12.7,2.4 13.4,2.8 14.1,3.2 L18.4,5.7 C20,6.6 20.8,7.8 20.8,9.6 L20.8,14.4 C20.8,16.2 20,17.4 18.4,18.3 L14.1,20.8 C13.4,21.2 12.7,21.6 12,21.6 C11.3,21.6 10.6,21.2 9.9,20.8 L5.6,18.3 C4,17.4 3.2,16.2 3.2,14.4 L3.2,9.6 C3.2,7.8 4,6.6 5.6,5.7 L9.9,3.2 C10.6,2.8 11.3,2.4 12,2.4" />
                          <path d="M4.8,12 C6.4,9.1 10,8.35 12,8.35 C14,8.35 17.6,9.1 19.2,12 C17.6,14.9 14,15.65 12,15.65 C10,15.65 6.4,14.9 4.8,12" />
                          <circle cx="12" cy="12" r="2.2" />
                          <path d="M10.9,11.35 C11.4,10.86 12.35,10.78 13.02,11.22" strokeWidth=".72" opacity=".9" />
                        </g>
                      </defs>
                      <use href="#visual-request-icon-shape" className="visual-icon-glow-far" stroke="url(#visual-request-icon-gradient)" />
                      <use href="#visual-request-icon-shape" className="visual-icon-glow" stroke="url(#visual-request-icon-gradient)" />
                      <use href="#visual-request-icon-shape" className="visual-icon-ink" stroke="#000" />
                      <circle cx="12.78" cy="11.22" r=".42" fill="#000" stroke="none" />
                    </svg>
                    <motion.span className="visual-request-pill-text"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.36, delay: 0.1, ease: [0.23, 1, 0.32, 1] }}>
                      {requestText}
                    </motion.span>
                    <LoadingEdge active={edgeActive} />
                    <button ref={resultCloseButtonRef} className="visual-answer-close-btn"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onClose() }}
                      aria-label="关闭视觉智能">
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                        <path d="M4 4L12 12M12 4L4 12" stroke="#5a5a62" strokeWidth="2.8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {(phase === 'options' || phase === 'processing') && OPTIONS.map((opt, i) => (
                <motion.button key={opt.key}
                  ref={(el) => { pillRefs.current[i] = el }}
                  className={`visual-option-pill pill-${opt.key}`}
                  style={{ width: (opt.key === 'identify' || opt.key === 'search') ? 110 : 160 }}
                  layout="position"
                  initial={{ opacity: 0, y: pillFlyDistance(i) }}
                  animate={phase === 'processing'
                    ? { y: pillFlyDistance(i) }
                    : { opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                  transition={phase === 'processing'
                    ? { type: 'spring', stiffness: 150, damping: 20, mass: 0.6, delay: i * 0.035 }
                    : { delay: 0.06 + i * 0.05, type: 'spring', stiffness: 180, damping: 14, mass: 0.55 }}
                  onClick={(e) => { e.stopPropagation(); handleOptionClick(opt.key) }}>
                  <span>{opt.label}</span>
                </motion.button>
              ))}
            </AnimatePresence>

            <AnimatePresence>
              {isAnswerVisible && (
                <motion.div key="answer" ref={answerBoxRef} className="visual-answer-box"
                  style={{
                    // 实色左边缘与输入框左边缘对齐、上边缘与输入框上边缘齐平，
                    // 右侧再多出 ANSWER_RIGHT_EXTRA —— 黑框把输入框包住，且整体压在输入框之下
                    // （层叠见 CSS 里 .visual-answer-box 的 z-index）。
                    // 气雾（box-shadow）从元素边界起算，会跟着实色一起走。
                    width: answerSize.w + ANSWER_RIGHT_EXTRA,
                    height: answerSize.h,
                    position: 'absolute',
                    left: ANSWER_LEFT_INSET,
                    top: ANSWER_TOP_OFFSET,
                  }}
                  // 由大变小 + 由淡变浓：以中心为原点从 1.18 收到 1，浓度同时从 0 到 1。
                  // 两者共用同一条曲线，所以"收拢"与"凝实"完全同步，不会有先后。
                  initial={{ opacity: 0, scale: 1.18 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } }}
                  // 返回黑框（连同外圈气雾）进入动画，两条曲线分开配置：
                  // 缩放：走 ANSWER_FADE_EASE（快段 : 减速缓冲段 ≈ 4 : 3，收尾减速）；
                  // 浓度：走 ANSWER_FADE_OPACITY_EASE（先慢后快，幂 6，越往后越快）。
                  // 输入框与加载光边不参与这次动画。
                  transition={{
                    scale: { duration: ANSWER_FADE_MS / 1000, ease: ANSWER_FADE_EASE },
                    opacity: { duration: ANSWER_FADE_MS / 1000, ease: ANSWER_FADE_OPACITY_EASE },
                  }}>
                  <div className="visual-answer-scroll">
                    {answerRevealed ? (
                      <>
                        {answer.text.split(/\r?\n/).filter(line => line.trim().length > 0).map((line, i) => (
                          <motion.p key={`answer-text-${i}`} className="visual-answer-text"
                            initial={{ opacity: 0, transform: 'translateY(57px)' }}
                            animate={{ opacity: 1, transform: 'translateY(0)' }}
                            transition={{ type: 'tween', duration: 0.13, ease: [0.1, 0.9, 0.2, 1], delay: 0 }}>
                            {line}
                          </motion.p>
                        ))}
                        {answer.cards.map((card, i) => card.type === 'text'
                          ? <TextAnswerCard key={`answer-card-${i}`} content={card.content} delay={0} />
                          : <LinkAnswerCard key={`answer-card-${i}`} card={card} delay={0} />)}
                      </>
                    ) : (
                      <span className="visual-response-placeholder">正在分析...</span>
                    )}
                  </div>
                  <div className="visual-answer-resize"
                    onPointerDown={startAnswerResize}
                    onPointerMove={moveAnswerResize}
                    onPointerUp={endAnswerResize}
                    onPointerCancel={endAnswerResize} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>

      {!isConfirmPhase && <button className="visual-close-btn" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12M12 4L4 12" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>}
    </div>
  )
}
