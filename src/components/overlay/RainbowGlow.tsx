import { useEffect, useRef, useState } from 'react'
import { computeGeometry, disposeEdge, renderEdge } from './rainbow/rainbowPill'
import './rainbow/rainbow.css'

interface RainbowGlowProps {
  /** 依附的目标卡片（光边与彩虹层会贴合它的实时尺寸） */
  targetRef: React.RefObject<HTMLElement | null>
  /** 彩虹底层（左上→右下缓动彩虹光 + 周围细光芒） */
  active: boolean
  /** 沿边框旋转的加载光边 */
  edgeActive?: boolean
  radius?: number
}

/**
 * 彩虹流光底层：压在目标卡片图层下面。
 * 用 ResizeObserver + rAF 跟踪卡片形变，实时重算光边几何。
 */
export function RainbowGlow({ targetRef, active, edgeActive = false, radius }: RainbowGlowProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const lastSize = useRef('')

  // 呼吸灯的开关与相位：开始思考时挂上（动画从 0 相位开始，首次“吸气”就是渐显），
  // 结束时等慢速淡出跑完（比 1.35s 略长一点）再摘掉，避免在随机相位上跳一下。
  const [breathing, setBreathing] = useState(active)
  // 挂载那一刻就已经是 active（= 追问交接：胶囊是被"换上来的"，不是从药丸慢慢长成处理态）
  // ⇒ 彩虹**不做 1.35s 渐显**，直接可见（见 rainbow.css 的 [data-instant]）。
  //   否则交接后还要等 1.35s 才"亮起来"，观感就是"加载胶囊显示迟了"（用户实测）。
  const instant = useRef(active).current
  useEffect(() => {
    if (active) { setBreathing(true); return }
    const timer = window.setTimeout(() => setBreathing(false), 1450)
    return () => window.clearTimeout(timer)
  }, [active])

  useEffect(() => {
    const target = targetRef.current
    const wrap = wrapRef.current
    const edge = edgeRef.current
    if (!target || !wrap || !edge) return
    // 不需要显示彩虹时压根不用跟踪：输入态/结果态下这个 wrap 是关着的，
    // 每帧去量尺寸 + 重画光边纯属白烧 —— 唤醒后那 0.6s 主线程本来就挤。
    // ⚠ 但**必须把 breathing 也算进来**：关掉之后还有约 1.45s 的慢速淡出，
    //   那段时间彩虹仍然可见，照样要跟着卡片走 —— 否则它会停在"上一帧的几何"上
    //   （表现为：处理药丸一变成返回框，彩虹就错位跑到返回框左上方）。
    if (!active && !edgeActive && !breathing) { lastSize.current = ''; return }

    const paint = () => {
      const w = target.offsetWidth
      const h = target.offsetHeight
      if (!w || !h) return
      const r = Math.max(0, radius ?? h / 2)
      // 位置也算进 key：卡片带 y 偏移（药丸/球是 -12px），只比尺寸会漏掉位移变化
      const key = `${w}x${h}x${r}x${target.getBoundingClientRect().top}`
      if (key === lastSize.current) return
      lastSize.current = key
      wrap.style.width = `${w}px`
      wrap.style.height = `${h}px`
      // 圆角必须显式写在 wrap 上：下面两层彩虹光用的是 border-radius:inherit，
      // wrap 没圆角时它们就是直角矩形（“形状不对”就是这么来的）。
      wrap.style.borderRadius = `${r}px`
      // 卡片带 transform（y 偏移），offsetTop/Left 不是它的可见位置；
      // 用两者的 rect 差算出真实平移，彩虹才会严丝合缝贴住卡片（原来偏下 12px）。
      const parent = wrap.offsetParent as HTMLElement | null
      const tr = target.getBoundingClientRect()
      const pr = parent?.getBoundingClientRect()
      wrap.style.transform =
        `translate(${(tr.left - (pr?.left ?? 0)).toFixed(2)}px, ` +
        `${(tr.top - (pr?.top ?? 0)).toFixed(2)}px)`
      const geo = computeGeometry({ width: w, height: h, radius: r })
      renderEdge(edge, geo)
    }

    // 不做节流：这里只保留最朴素的写法（ResizeObserver → 一帧一次重算）。
    // 曾经在这里加过"约 25fps 节流 + 定时器补帧"，结果用户遇到整机卡死 ——
    // 那种"反复 clearTimeout/setTimeout"的自维持逻辑风险太高，已移除。
    // 真正的开销控制放在上游：回车上移/缩小整段根本不亮彩虹（DonyMorph 的 rainbowOn）。
    const sync = () => { paint() }

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(sync)
    })
    ro.observe(target)
    // 形变动画期间尺寸逐帧变化，ResizeObserver 已覆盖；启动时同步一次
    paint()
    const tick = () => { paint(); rafRef.current = requestAnimationFrame(tick) }
    if (edgeActive) rafRef.current = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(rafRef.current)
      lastSize.current = ''      // 下次进来必须重算一次几何
      disposeEdge(edge)          // 顺手回收这个元素对应的 keyframes 样式表
    }
  }, [targetRef, active, edgeActive, radius, breathing])

  return (
    <div ref={wrapRef} className={`rainbow-glow-wrap${active || edgeActive ? ' on' : ''}`}
      data-instant={instant ? 'true' : undefined} aria-hidden>
      <div ref={edgeRef} className={`rb-edge ${edgeActive ? 'is-active' : ''}`} />
      <div className={`rainbow-underlay${breathing ? ' breathing' : ''}`} />
    </div>
  )
}
