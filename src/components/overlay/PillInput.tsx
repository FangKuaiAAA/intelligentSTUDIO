import { useRef, useEffect, useCallback, useState } from 'react'
import { AcrylicLayer, ACRYLIC_BLUR } from './AcrylicLayer'
import './PillInput.css'

/** 首屏药丸最小宽度（空输入时的定宽） */
const MIN_W = 380
/**
 * 首屏药丸最大宽度：文字再多也不再长，超出的部分在两侧被裁切、随光标左移。
 * ⚠ 只用于**首屏**：追问药丸两侧没有控件、文字是居中的，保持它原来的"随文字长宽、不封顶"。
 */
const MAX_W = 560
/**
 * 首屏两侧"控件区"的宽度（左侧线描图标、右侧发送键），同时也是**文字两端的裁切边界**：
 * 取两倍于圆角半径，控件中心就正好落在药丸两端半圆的圆心上（半圆圆心 = 高度一半）。
 */
const ICON_BOX = 50
/** 追问药丸的左右内边距（它两侧都没有控件，保持对称）—— 26 → 22，随返回框一起收小 */
const FOLLOW_PAD = 22
/** 追问药丸的最小宽度 —— 336 → 300，随返回框一起收小 */
const FOLLOW_MIN_W = 300

/** 建议升起/收起的时间。⚠ 必须与 PillInput.css 里那两条 transition 保持一致。 */
const SG_IN_MS = 560           // 单条升起的时长（慢速）
const SG_IN_STAGGER = 90       // 三条依次升起的间隔
const SG_OUT_MS = 620          // 单条收起的时长（比升起更慢一点）
const SG_OUT_STAGGER = 110     // 收起是展开的反向：最后一条先收
/** 三条建议全部收完需要的总时长 —— "收完才算用户按了回车"（见 onSuggestCollapseDone） */
const SUGGEST_COLLAPSE_MS = SG_OUT_MS + SG_OUT_STAGGER * 2 + 60

interface PillInputProps {
  value: string
  onChange: (value: string) => void
  onKeystroke?: () => void
  onEsc?: () => void
  onSubmit: () => void
  placeholder?: string
  isFollowUp?: boolean
  inMorph?: boolean
  /** 输入建议（只在**首次**键入对话时由 App 传入；空数组 = 不显示） */
  suggestions?: string[]
  /** 点了某条建议：把它的文字拼到"已经输入的内容"后面（不管原来有没有文字） */
  onPickSuggestion?: (text: string) => void
  /** 收起动画播完 —— 到这刻才算用户"发出了请求"，由 App 去 submit */
  onSuggestCollapseDone?: () => void
  /**
   * 启动彩排专用：**只绘制、不交互**。
   * 彩排要付掉"键入模式首唤醒"独有的首帧成本（左侧图标的 conic 彩虹 + blur(8px) +
   * 混合模式、送信键 SVG、字体、以及本组件的首次执行）。为此必须在窗口里**真的画一遍**
   * ——但绝不能抢焦点、也不能接住任何点击（窗口此时近乎全透明，谁都不知道它在那儿）。
   */
  prewarm?: boolean
}

export function PillInput({
  value, onChange, onKeystroke, onEsc, onSubmit,
  placeholder = '键入以使用Dony',
  isFollowUp = false,
  suggestions,
  onPickSuggestion,
  onSuggestCollapseDone,
  prewarm = false,
}: PillInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 建议的展开/收起相位。这里**故意不用 framer-motion 的 exit**：
  // 用户自己回车时建议必须"瞬间消失、不干扰药丸向上飞入"，卸载元素最干净
  //（而点建议时走的是 is-out 那条 CSS 过渡，见 pickSuggestion）。
  const [sgPhase, setSgPhase] = useState<'mount' | 'in' | 'out'>('mount')
  const sgTimer = useRef<ReturnType<typeof setTimeout>>()
  const sgListRef = useRef<HTMLDivElement>(null)
  const sgItemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // ⚠ 彩排副本**不抢焦点**：它只是被"画"出来付首帧成本，不是真输入框。
  useEffect(() => { if (!prewarm) inputRef.current?.focus() }, [prewarm])

  // 建议一拿到：先按"未展开"渲染一帧，下一帧再上 is-in —— 这样过渡才会真的播，
  // 而不是一挂载就是最终状态（那样就"瞬移"到位了，没有升起感）。
  useEffect(() => {
    if (!suggestions || !suggestions.length) return
    setSgPhase('mount')
    const r = requestAnimationFrame(() => setSgPhase('in'))
    return () => cancelAnimationFrame(r)
  }, [suggestions])
  useEffect(() => () => clearTimeout(sgTimer.current), [])

  // 「完全从输入框底下（图层下方）飞出来」：三条**从同一个原点**起飞，原点在**药丸身内**
  //（不是药丸下方 —— 那样会露在下面）。
  // 列表底距药丸顶 10px（见 CSS），原点再往下 16px 就是"药丸顶 +16"：整条建议（高约 30px）
  // 都落在药丸身体里，被药丸自己挡住 → 所以完全不需要淡入淡出，只见它从底下钻出来。
  // 每条要往下偏的距离 = (列表高度 - 自己的 offsetTop) + 26。
  // 必须布局完之后量，所以放在这个 effect（它在上面那个 rAF 之前跑，赶得上定起点）；
  // 量到之前元素是 visibility:hidden，不会先闪一帧。
  useEffect(() => {
    const listEl = sgListRef.current
    if (!listEl || !suggestions?.length) return
    const from = listEl.offsetHeight + 26
    suggestions.forEach((_, i) => {
      const el = sgItemRefs.current[i]
      if (el) el.style.setProperty('--sg-from', `${Math.round(from - el.offsetTop)}px`)
    })
  }, [suggestions])

  // 「用户自己回车 → 建议瞬间消失」：这里**直接写 DOM**，不等 React。
  // 实测过：那一刻主线程正在跑药丸起飞（形变 + 光边重绘），setSuggestions([]) 触发的
  // 那次提交会被推迟约 200ms —— 建议会一直挂在飞行途中。同步写 display 后，
  // 它和起飞的第一帧一起消失（随后那次 React 渲染会把它整个卸载，不冲突）。
  const hideSuggestNow = useCallback(() => {
    if (sgListRef.current) sgListRef.current.style.display = 'none'
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) { hideSuggestNow(); onSubmit() }
    if (e.key === 'Escape') onEsc?.()
  }, [value, onSubmit, onEsc, hideSuggestNow])

  const pickSuggestion = useCallback((text: string) => {
    if (sgPhase === 'out') return                      // 已经在收：忽略重复点击
    setSgPhase('out')
    onPickSuggestion?.(text)                           // App 把它拼到已输入文字后面
    // 收起动画播完 = 用户"发出请求"（由 App 在那时 submit）—— 时长与 CSS 对齐
    clearTimeout(sgTimer.current)
    sgTimer.current = setTimeout(() => onSuggestCollapseDone?.(), SUGGEST_COLLAPSE_MS)
  }, [sgPhase, onPickSuggestion, onSuggestCollapseDone])

  useEffect(() => {
    const el = measureRef.current
    const box = containerRef.current
    if (!el || !box) return
    el.textContent = value || placeholder
    const tw = el.offsetWidth
    // 宽度是**形变**（卡片尺寸由 DonyMorph 量内容得到，会跟着一起变形），不是 scale。
    // 首屏：两侧各有 50px 控件区（图标 / 发送键），所以文字可用宽度 = 总宽 - 100；
    //       超过 MAX_W 就把宽度固定住，多出来的部分在两侧被裁掉（随光标左移）。
    // 追问：两侧没有控件，文字居中，保持原来"随文字长宽"的行为（不封顶、左右对称留白）。
    const w = isFollowUp
      ? Math.max(FOLLOW_MIN_W, tw + FOLLOW_PAD * 2)
      : Math.min(MAX_W, Math.max(MIN_W, tw + ICON_BOX * 2))
    box.style.width = `${w}px`
  }, [value, placeholder, isFollowUp])

  const list = suggestions ?? []
  const showSuggest = !isFollowUp && list.length > 0

  return (
    <div className={`pill-input-wrapper ${isFollowUp ? 'follow-up' : ''}${prewarm ? ' pill-prewarm' : ''}`}>
      {/* 输入建议：绝对定位在药丸左端**上方** → 不参与布局，
          所以不会影响卡片的形变尺寸（DonyMorph 量到的高度/宽度都不变）。 */}
      {showSuggest && (
        <div className={`pill-suggest-list is-${sgPhase}`} ref={sgListRef}>
          {list.map((s, i) => (
            <button key={s + i} type="button" className="pill-suggest-item"
              ref={(el) => { sgItemRefs.current[i] = el }}
              // 亚克力宿主：材质（磨砂壁纸 + 色调 + 噪点）由 AcrylicLayer 铺在文字下面。
              // 标了 data-acrylic-host 之后，App 的每帧同步器会把快照**钉在屏幕上** →
              // 挡板飞行时磨砂里的桌面不跟着跑（与药丸完全相同的物理表现）。
              data-acrylic-host=""
              style={{
                // 展开顺序：**离输入框最近的那条（列表最后一条）先飞**，往上依次跟上。
                // 这是"每条延迟不同、彼此重叠"，不是"上一条飞完才轮到下一条"。
                '--sg-in-delay': `${(list.length - 1 - i) * SG_IN_STAGGER}ms`,
                // 收起 = 展开的直接反向：最上面那条先收，往下依次。
                '--sg-out-delay': `${i * SG_OUT_STAGGER}ms`,
              } as React.CSSProperties}
              // 别把输入框的焦点抢走（否则收起后光标没了）
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickSuggestion(s)}>
              {/* 模糊半径取"卡片"那一档 —— 与下方输入药丸用的完全相同 */}
              <AcrylicLayer blur={ACRYLIC_BLUR.card} />
              {s}
            </button>
          ))}
        </div>
      )}
      <div className={`pill-input-container${isFollowUp ? ' follow-up' : ''}`}
        ref={containerRef} data-acrylic-host="">
        <AcrylicLayer blur={ACRYLIC_BLUR.card} />
        {!isFollowUp && (
          // 线描六边形包裹线描圆形：颜色与输入文字一致（浅色黑 / 深色白）。
          // 位置：药丸左侧圆角的圆心处（CSS 固定 50px 宽的方框 + 居中）。
          <span className="pill-input-icon" aria-hidden>
            {/* 彩虹灯光：垫在线描背后的旋转彩团。
                只在这里出现 —— 追问药丸（!isFollowUp 才渲染图标）天然不受影响。 */}
            <span className="pill-icon-glow" />
            <svg viewBox="0 0 64 64" width="30" height="30">
              {/* 六边形：尖角版本（原来的写法）。
                  只靠 strokeLinejoin="round" 自带的那点小圆角（上限是半个线宽 = 2.75）。 */}
              <polygon
                points="32,12 49,22 49,42 32,52 15,42 15,22"
                fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinejoin="round" />
              <circle cx="32" cy="32" r="10" fill="none" stroke="currentColor" strokeWidth="5.5" />
            </svg>
          </span>
        )}
        <input ref={inputRef} type="text" className="pill-input"
          // 彩排副本不参与 Tab 次序（它不该被任何人"摸到"）
          tabIndex={prewarm ? -1 : undefined}
          value={value}
          onChange={(e) => { onChange(e.target.value); onKeystroke?.() }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={false} />
        {!isFollowUp && (
          // 右侧发送键：位置镜像左侧图标（同样 50px 方框 + 居中 → 落在右侧圆角圆心）。
          // 点它 = 按回车（onSubmit 内部会自己判空）。
          <button type="button" className="pill-send" aria-label="发送"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { hideSuggestNow(); onSubmit() }}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              {/* 线描向上箭头：一根竖杆 + 两笔 45° 斜撇，**只描边、不填充、无外框**；
                  所有线端与转角都带圆角（strokeLinecap / strokeLinejoin = round）。
                  颜色由按钮的 color 给（蓝色，见 .pill-send）。 */}
              {/* 宽度对齐高度：竖杆 4.8~20（高 15.2），两撇向左右各拉到 4.4 / 19.6（宽 15.2） */}
              <path d="M12 20 V4.8 M12 4.8 L4.4 11.3 M12 4.8 L19.6 11.3"
                fill="none" stroke="currentColor"
                strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <span ref={measureRef} className="pill-measure" aria-hidden="true" />
    </div>
  )
}
