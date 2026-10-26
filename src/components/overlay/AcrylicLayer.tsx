import { createContext, useContext, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import './acrylic.css'

/**
 * 亚克力底衬（桌面壁纸 / 唤醒瞬间的桌面快照）通过 Context 下发：
 * 药丸/卡片只要放一个 <AcrylicLayer/> 就自动拿到，不必层层透传 prop。
 */
export const SnapshotContext = createContext<string | null>(null)

/**
 * 各宿主的模糊半径：面板越大模糊越强（与 Windows 原生亚克力的观感一致）。
 * 数值是 DIP，和原生一样不随分辨率/缩放变化。
 *
 * ⚠ 曾经试过"唤醒时把模糊烤进底图"（canvas 里 blur + toDataURL）——已回退：
 *   canvas 渲染 + JPEG 编码是**同步的、几十毫秒的主线程阻塞**，而且正好发生在
 *   唤醒那一刻 → 结果变成"每次唤醒光边都卡一回"。
 */
export const ACRYLIC_BLUR = {
  pill: 56,      // 药丸（159×36 / 输入药丸）
  ball: 50,      // 任务加载球（64×64）
  card: 68,      // 伸长药丸、追问药丸
  asking: 70,    // 打断询问方窗（460×280）
  result: 96,    // 结果框（500×auto）
} as const

/** 底图与视口的比例差小于这个值就算"同屏等比"（截屏、已裁剪壁纸都是这种） */
const RATIO_EPS = 0.005

interface AcrylicLayerProps {
  /** 显式指定底图；省略时用 SnapshotContext 里的那份 */
  snapshot?: string | null
  /** 模糊半径（px，DIP） */
  blur?: number
}

/**
 * 亚克力材质层：铺在宿主（卡片/药丸）内部，由宿主的 overflow + 圆角裁切。
 *
 * 底图的定位由宿主的 --dcx/--dcy 驱动（见 App.tsx 的同步器）：底图在屏幕上
 * 保持不动，宿主形变/位移时磨砂里的桌面不跟着跑 —— 这才是真实亚克力的表现。
 *
 * 底图还没到（读壁纸/截屏约 100ms）时只显示色调层，到了再淡入 —— 不会闪白。
 */
export function AcrylicLayer({ snapshot, blur = ACRYLIC_BLUR.card }: AcrylicLayerProps) {
  const ctx = useContext(SnapshotContext)
  const img = snapshot ?? ctx
  // 底图的铺法与居中修正：按"底图真实像素 vs 视口"算出来，保证任何分辨率/长宽比都不变形
  const [fit, setFit] = useState({ size: '100vw 100vh', dx: 0, dy: 0 })

  useEffect(() => {
    if (!img) {
      setFit({ size: '100vw 100vh', dx: 0, dy: 0 })
      return
    }
    let alive = true
    const probe = new Image()
    probe.onload = () => {
      if (!alive) return
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      const iw = probe.naturalWidth || vw
      const ih = probe.naturalHeight || vh
      // 比例一致（截屏，或已按屏幕裁过的壁纸）→ 严格按视口铺，与屏幕逐像素对应
      if (Math.abs(iw / ih - vw / vh) / (vw / vh) < RATIO_EPS) {
        setFit({ size: '100vw 100vh', dx: 0, dy: 0 })
        return
      }
      // 比例不一致（TranscodedWallpaper 这种未裁剪的原图）→ 等比放大到盖满视口并居中，
      // 绝不拉伸变形（同名壁纸在系统里通常也是"填充"显示）
      const scale = Math.max(vw / iw, vh / ih)
      const w = Math.round(iw * scale)
      const h = Math.round(ih * scale)
      setFit({ size: `${w}px ${h}px`, dx: Math.round((vw - w) / 2), dy: Math.round((vh - h) / 2) })
    }
    probe.onerror = () => { if (alive) setFit({ size: '100vw 100vh', dx: 0, dy: 0 }) }
    probe.src = img
    return () => { alive = false }
  }, [img])

  return (
    <div
      className="dony-acrylic"
      aria-hidden="true"
      style={{
        '--dony-acrylic-blur': `${blur}px`,
        '--dony-snap-size': fit.size,
        '--dony-snap-dx': `${fit.dx}px`,
        '--dony-snap-dy': `${fit.dy}px`,
      } as CSSProperties}
    >
      <div
        className={`dony-acrylic-snap${img ? ' is-ready' : ''}`}
        style={img ? { backgroundImage: `url("${img}")` } : undefined}
      />
      <div className="dony-acrylic-tint" />
      <div className="dony-acrylic-exclusion" />
      <div className="dony-acrylic-noise" />
    </div>
  )
}
