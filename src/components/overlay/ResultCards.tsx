import { useContext, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CardIcon } from './cardIcons'
import { FAST_SETTLE, lineTimings } from './answerMotion'
import { ResultSequenceContext } from './resultFrame'
import { agentSocket } from '../../utils/ws'
import './ResultCards.css'

export interface ResultCardData {
  id: string
  kind: string
  theme: { from: string; to: string; direction: string }
  /** 主标题：功能/项目名（如「计时器」「WiFi」「报告.docx」），由后端按类型定 */
  title: string
  /** 副标题：状态或数值（如「5:00」「已打开」），小字在后 */
  subtitle?: string
  icon: string
  image?: string
  /** 操控项类型：switch 开关 / slider 滑块 / segments 三段式 / null 无（由后端按类型定） */
  control?: 'switch' | 'slider' | 'segments' | null
  toggle?: { key: string; on: boolean }
  slider?: { key: string; value: number; min: number; max: number; unit?: string }
  segments?: { key: string; value: string; options: { value: string; label: string }[] }
  extra?: Record<string, any>
}

/** 后端回传的真实结果：切成功就对正，切失败就翻回去（"点了不生效"的兜底） */
function useControlFeedback(key: string, apply: (m: any) => void) {
  const cb = useRef(apply)
  cb.current = apply
  useEffect(() => agentSocket.on((m) => {
    if (m.type === 'card-control' && m.key === key) cb.current(m)
  }), [key])
}

/** 单步可取消的操作：开关 */
function CardToggle({ cardKey, initialOn }: { cardKey: string; initialOn: boolean }) {
  const [on, setOn] = useState(initialOn)
  // 后端说"没切成"就把开关翻回去，别让用户以为已经改了
  useControlFeedback(cardKey, (m) => { if (typeof m.on === 'boolean') setOn(m.on) })
  const flip = () => {
    const next = !on
    setOn(next)
    agentSocket.send({ type: 'toggle-card', key: cardKey, on: next })
  }
  return (
    <button
      className={`rc-toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={(e) => { e.stopPropagation(); flip() }}
    >
      <span className="rc-toggle-thumb" />
    </button>
  )
}

/** 数值项（音量/亮度）：滑块。拖动时只更新本地，松手再发给后端，避免刷屏 */
function CardSlider({ cardKey, value, min, max, unit }: {
  cardKey: string; value: number; min: number; max: number; unit?: string
}) {
  const [val, setVal] = useState(value)
  const lastSent = useRef(0)
  // 后端回读到的真实音量/亮度（可能被系统夹到别的值）
  useControlFeedback(cardKey, (m) => { if (typeof m.value === 'number') setVal(m.value) })
  const send = (v: number, force = false) => {
    const now = Date.now()
    if (!force && now - lastSent.current < 120) return
    lastSent.current = now
    agentSocket.send({ type: 'card-value', key: cardKey, value: v })
  }
  return (
    <div className="rc-slider" onClick={(e) => e.stopPropagation()}>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={val}
        aria-label={`${cardKey} ${val}${unit ?? ''}`}
        onChange={(e) => { const v = Number(e.target.value); setVal(v); send(v) }}
        onPointerUp={() => send(val, true)}
        onKeyUp={() => send(val, true)}
      />
      <span className="rc-slider-value">{val}{unit ?? ''}</span>
    </div>
  )
}

/** 固定几档里选一个（如电源模式：节能/均衡/高性能）：三段式控件 */
function CardSegments({ cardKey, value, options, onPick }: {
  cardKey: string
  value: string
  options: { value: string; label: string }[]
  onPick?: (v: string) => void
}) {
  const [val, setVal] = useState(value)
  // 系统没接受这一档 → 弹回原来的档位
  useControlFeedback(cardKey, (m) => {
    if (m.ok === false) setVal(value)
    else if (typeof m.value === 'string') setVal(m.value)
  })
  const pick = (v: string) => {
    if (v === val) return
    setVal(v)
    onPick?.(v)
    agentSocket.send({ type: 'card-value', key: cardKey, value: v })
  }
  return (
    <div className="rc-segments" role="radiogroup" onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === val}
          className={`rc-segment ${o.value === val ? 'on' : ''}`}
          onClick={() => pick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 计时器/闹钟的副标题按截止时刻实时走秒（主标题始终是功能的名称） */
function useCountdown(endsAt?: number) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!endsAt) { setText(''); return }
    const tick = () => {
      const left = Math.max(0, Math.round(endsAt - Date.now() / 1000))
      if (left <= 0) { setText('已结束'); return }
      const m = Math.floor(left / 60)
      const s = left % 60
      setText(m >= 60
        ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [endsAt])
  return text
}

interface CardDetail { label: string; value: string }

/* 天气图标不按文字推导（那套规则会把明细里的"降雨概率/风力"也当成天气）。
   图标由模型在 show_card 时挑，可选图标见后端 ICONS。 */

function ResultCard({ card, timing }: {
  card: ResultCardData; timing: { duration: number; delay: number }
}) {
  const isWeather = card.kind === 'weather'
  const isWebsite = card.kind === 'website'
  const hasImage = !!card.image
  // 网址卡片：点一下用默认浏览器打开，然后让 Dony 自己退出（链接由后端从卡片内容里取）
  const siteUrl = isWebsite ? String(card.extra?.url || '') : ''
  const openSite = () => {
    if (!siteUrl) return
    window.electronAPI?.openExternal?.(siteUrl)
    // 按要求：点开网址后把 Dony 界面收起来（只是收起界面，宿主程序继续运行）
    setTimeout(() => window.electronAPI?.hideOverlay?.(), 400)
  }
  // 结果卡片：被当作"飞入序列里的条目"看待，与正文文字**同一套节奏**（步长由
  // ResultCards 按序列总数算好、以 timing 传进来）。从下方起飞、**不做模糊**、不缩放。
  const CARD_DISTANCE = 30
  const deg = card.theme.direction === 'horizontal' ? '90deg' : '180deg'
  // 天气卡片展示的明细（降雨/风/湿度等），由后端 extra.details 提供
  const details: CardDetail[] = isWeather ? (card.extra?.details ?? []) : []
  // 计时器/闹钟：副标题跟着剩余时间走（没有 ends_at 就显示后端给的静态文字）
  const countdown = useCountdown(card.extra?.ends_at)
  // 三段式：用户点了哪一档，副标题立刻跟着显示哪一档
  const [pickedLabel, setPickedLabel] = useState<string | null>(null)
  const subtitle = countdown || pickedLabel || card.subtitle
  const hasControl = card.control === 'switch' || card.control === 'slider'
    || card.control === 'segments'

  return (
    <motion.div
      className="rc-morph"
      // 外层只做淡入、**不做高度展开**：
      // 高度展开会让"结果框提前量高度"量到卡片还没撑开时的值 → 框先到小高度、
      // 卡片再把框撑高，看起来就是一次多余的二次增长。改成直接以最终高度占位。
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, delay: timing.delay }}
    >
      <motion.div
        className={`result-card${siteUrl ? ' clickable' : ''}`}
        style={{ background: `linear-gradient(${deg}, ${card.theme.from}, ${card.theme.to})` }}
        // 与正文文字同一套：从下方飞入，不模糊
        initial={{ y: CARD_DISTANCE }}
        animate={{ y: 0 }}
        transition={{ duration: timing.duration, ease: FAST_SETTLE, delay: timing.delay }}
        onClick={siteUrl ? openSite : undefined}
      >
        {isWeather ? (
          <>
            <div className="rc-weather-top">
              <div className="rc-icon rc-icon-left"><CardIcon name={card.icon} size={38} /></div>
              <div className="rc-body rc-body-right">
                <div className="rc-title rc-weather-title">{card.title}</div>
                {subtitle && <div className="rc-subtitle">{subtitle}</div>}
              </div>
            </div>
            {details.length > 0 && (
              <div className="rc-details">
                {details.map((d, i) => (
                  <div className="rc-detail" key={i}>
                    <span className="rc-detail-label">{d.label}</span>
                    <span className="rc-detail-value">{d.value}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {/* 网址卡片：网站主图在**左**、右侧**不要线描图标**（主图后端自己去抓，模型不用管） */}
            {isWebsite && hasImage && (
              <div className="rc-image rc-image-left">
                {/* 主图是后端抓来的外部地址，加载失败就整块收掉（不留破图） */}
                <img src={card.image} alt=""
                  onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
              </div>
            )}
            {/* 其它卡片：有开关/滑块 → 图标放最左（操控项在右端）；没有 → 图标在右端 */}
            {!isWebsite && hasControl && !hasImage && (
              <div className="rc-icon"><CardIcon name={card.icon} size={30} /></div>
            )}
            <div className="rc-body">
              <div className="rc-title">{card.title}</div>
              {subtitle && <div className="rc-subtitle">{subtitle}</div>}
            </div>
            {isWebsite ? null : hasImage ? (
              <div className="rc-image"><img src={card.image} alt="" /></div>
            ) : !hasControl && (
              <div className="rc-icon"><CardIcon name={card.icon} size={30} /></div>
            )}
            {card.control === 'switch' && card.toggle && (
              <CardToggle cardKey={card.toggle.key} initialOn={card.toggle.on} />
            )}
            {card.control === 'slider' && card.slider && (
              <CardSlider
                cardKey={card.slider.key}
                value={card.slider.value}
                min={card.slider.min}
                max={card.slider.max}
                unit={card.slider.unit}
              />
            )}
            {card.control === 'segments' && card.segments && (
              <CardSegments
                cardKey={card.segments.key}
                value={card.segments.value}
                options={card.segments.options}
                onPick={(v) => setPickedLabel(
                  card.segments?.options.find((o) => o.value === v)?.label ?? null)}
              />
            )}
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

/** 主题渐变结果卡片群：逐行飞入（与文字飞入同时进行） */
export function ResultCards({ cards }: { cards: ResultCardData[] }) {
  const { lineCount, cardCount } = useContext(ResultSequenceContext)
  if (!cards.length) return null
  // 与正文**同一条飞入序列**：卡片接在文字后面，用同一个总数算步长。
  // 于是最后一张卡片飞完 = 最后一行飞完 = 框扩到位（总时长仍然只有一个来源）。
  const timings = lineTimings(lineCount + cardCount)
  return (
    <div className="result-cards">
      {cards.map((c, i) => (
        <ResultCard key={c.id} card={c} timing={timings[lineCount + i]} />
      ))}
    </div>
  )
}
