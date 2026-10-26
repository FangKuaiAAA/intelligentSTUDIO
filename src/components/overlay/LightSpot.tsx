import { useRef, useEffect } from 'react'

export type Edge = 'bottom' | 'left' | 'right' | 'top'
export interface EdgeProgress { top: number; right: number; bottom: number; left: number }

interface LightSpotProps {
  onEdgeReached: (edge: Edge) => void
  onEdgeProgress: (p: EdgeProgress) => void
  onComplete: () => void
  onHaloGone: () => void
  waking: boolean
}

export function LightSpot({ onEdgeReached, onEdgeProgress, onComplete, onHaloGone, waking }: LightSpotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const startRef = useRef<number>(0)
  const edgesReached = useRef<Set<Edge>>(new Set())

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const W = window.innerWidth
    const H = window.innerHeight
    // 光斑全是柔和渐变，不需要按物理像素满分辨率渲染：稍微降一点后备分辨率
    // 就能明显减少每帧要填充的像素量（软内容看不出差别），高分屏收益最大。
    const rs = Math.min(dpr, 1.25)
    canvas.width = Math.round(W * rs)
    canvas.height = Math.round(H * rs)
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`

    const ctx = canvas.getContext('2d')!
    ctx.scale(rs, rs)

    const cx = W / 2
    const cy = H
    const maxR = Math.sqrt(W * W + H * H) + 1600
    const duration = 1400
    const triggerAt = 0.28
    const fadeDuration = 0.60
    const triggerEased = 1 - Math.pow(1 - triggerAt, 2.2)
    const screenMax = Math.sqrt(cx * cx + cy * cy)
    let haloGoneCalled = false

    const ryShrink = 0.55
    const M = maxR - 80
    const disc = (M - 68) * (M - 68) - 4 * ryShrink * M * (cy - 80)
    const topReachEased = disc > 0 ? (M - 68 - Math.sqrt(disc)) / (2 * ryShrink * M) : 0
    const topReachRaw = 1 - Math.pow(1 - topReachEased, 1 / 2.2)

    const computeProgress = (eased: number): EdgeProgress => {
      const rx = 80 + (maxR - 80) * eased
      const ry = rx * (1 - ryShrink * eased)
      const vertP = rx <= cx ? 0 : Math.min(1, ry * Math.sqrt(1 - (cx / rx) * (cx / rx)) / cy)
      const horizP = ry <= cy ? 0 : Math.min(1, rx * Math.sqrt(1 - (cy / ry) * (cy / ry)) / cx * 1.5)
      const bottomP = Math.min(1, rx / cx)
      return { top: horizP, right: vertP, bottom: bottomP, left: vertP }
    }

    const checkEdge = (eased: number) => {
      const rx = 80 + (maxR - 80) * eased
      const ry = rx * (1 - ryShrink * eased)
      const set = edgesReached.current
      if (!set.has('bottom')) { set.add('bottom'); onEdgeReached('bottom') }
      if (!set.has('left') && cx - rx <= 0) { set.add('left'); onEdgeReached('left') }
      if (!set.has('right') && cx + rx >= W) { set.add('right'); onEdgeReached('right') }
      if (!set.has('top') && cy - ry <= 0) { set.add('top'); onEdgeReached('top') }
    }

    const drawHalo = (rx: number, ry: number) => {
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.clip()

      // 只在椭圆的外接矩形里填：椭圆之外本来就被 clip 掉了，
      // 原来每层都填满整屏（4 层 × 全屏像素），是最贵的一笔开销。
      const bx = cx - rx, by = cy - ry, bw = rx * 2, bh = ry * 2

      const g1 = ctx.createRadialGradient(cx, cy, rx * 0.08, cx, cy, rx)
      g1.addColorStop(0, 'rgba(255,0,255,0.14)')
      g1.addColorStop(0.2, 'rgba(255,0,255,0.22)')
      g1.addColorStop(0.4, 'rgba(0,0,255,0.23)')
      g1.addColorStop(0.58, 'rgba(0,200,255,0.22)')
      g1.addColorStop(0.74, 'rgba(0,255,200,0.17)')
      g1.addColorStop(0.87, 'rgba(255,255,0,0.10)')
      g1.addColorStop(1, 'rgba(255,0,0,0)')
      ctx.fillStyle = g1; ctx.fillRect(bx, by, bw, bh)

      const g2 = ctx.createRadialGradient(cx - rx * 0.25, cy - ry * 0.4, rx * 0.02, cx, cy, rx * 0.8)
      g2.addColorStop(0, 'rgba(255,0,0,0.14)')
      g2.addColorStop(0.35, 'rgba(255,0,130,0.21)')
      g2.addColorStop(0.65, 'rgba(255,0,255,0.14)')
      g2.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.9; ctx.fillStyle = g2; ctx.fillRect(bx, by, bw, bh)

      const g3 = ctx.createRadialGradient(cx + rx * 0.2, cy - ry * 0.25, rx * 0.02, cx, cy, rx * 0.85)
      g3.addColorStop(0, 'rgba(0,0,255,0.14)')
      g3.addColorStop(0.4, 'rgba(0,255,200,0.15)')
      g3.addColorStop(0.7, 'rgba(0,255,255,0.10)')
      g3.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.9; ctx.fillStyle = g3; ctx.fillRect(bx, by, bw, bh)

      const g4 = ctx.createRadialGradient(cx, cy - ry * 0.1, rx * 0.05, cx, cy, rx * 0.7)
      g4.addColorStop(0, 'rgba(255,255,0,0.11)')
      g4.addColorStop(0.5, 'rgba(255,128,0,0.12)')
      g4.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.78; ctx.fillStyle = g4; ctx.fillRect(bx, by, bw, bh)
      ctx.globalAlpha = 1
      ctx.restore()
    }

    const drawEffects = (rx: number, ry: number) => {
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 0.94, ry * 0.94, 0, 0, Math.PI * 2)
      ctx.ellipse(cx, cy, rx * 0.87, ry * 0.87, 0, Math.PI * 2, 0, true)
      const tr = ctx.createRadialGradient(cx, cy, rx * 0.87, cx, cy, rx * 0.94)
      tr.addColorStop(0, 'rgba(0,0,0,0)'); tr.addColorStop(0.55, 'rgba(5,2,20,0.06)'); tr.addColorStop(1, 'rgba(5,2,20,0)')
      ctx.fillStyle = tr; ctx.fill()
      ctx.restore()

      const crest = ctx.createRadialGradient(cx, cy, rx * 0.92, cx, cy, rx * 1.005)
      crest.addColorStop(0, 'rgba(0,0,255,0)'); crest.addColorStop(0.3, 'rgba(255,0,255,0.12)')
      crest.addColorStop(0.52, 'rgba(255,0,0,0.21)'); crest.addColorStop(0.65, 'rgba(255,0,255,0.23)')
      crest.addColorStop(0.76, 'rgba(255,255,0,0.17)'); crest.addColorStop(0.86, 'rgba(0,255,255,0.11)')
      crest.addColorStop(1, 'rgba(0,0,255,0)')
      ctx.save()   // 去掉了 ctx.filter='blur(2px)'：Canvas2D 的 filter 走软件路径且首次要现场编译，是首帧掉帧的来源之一（这条环只有几像素宽，肉眼几乎无差别）
      ctx.beginPath(); ctx.ellipse(cx, cy, rx * 1.005, ry * 1.005, 0, 0, Math.PI * 2)
      ctx.ellipse(cx, cy, rx * 0.92, ry * 0.92, 0, Math.PI * 2, 0, true)
      ctx.fillStyle = crest; ctx.fill()
      ctx.restore()

      const lead = ctx.createRadialGradient(cx, cy, rx, cx, cy, rx * 1.1)
      lead.addColorStop(0, 'rgba(200,80,255,0.07)'); lead.addColorStop(0.5, 'rgba(255,110,160,0.04)')
      lead.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.save(); ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2)
      ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 2, 0, true)
      ctx.fillStyle = lead; ctx.fill()
      ctx.restore()
    }

    const animate = (timestamp: number) => {
      if (!startRef.current) startRef.current = timestamp
      const elapsed = timestamp - startRef.current
      const raw = Math.min(elapsed / duration, 1)

      const activeRaw = Math.min(raw, triggerAt)
      const eased = 1 - Math.pow(1 - activeRaw, 2.2)
      const breathe = 1 + Math.sin(activeRaw * Math.PI * 1.5) * 0.025 * (1 - activeRaw)

      if (raw <= triggerAt) {
        checkEdge(eased)
        onEdgeProgress(computeProgress(eased))
      }

      const useEased = raw <= triggerAt ? eased : triggerEased
      const useBreathe = raw <= triggerAt ? breathe : 1

      const rx = 80 + (maxR - 80) * useEased
      const ry = rx * (1 - ryShrink * useEased) * useBreathe

      // Fade: starts when halo touches screen top
      let fp = 0
      if (raw > topReachRaw) {
        if (!haloGoneCalled) { haloGoneCalled = true; onHaloGone() }
        fp = Math.min((raw - topReachRaw) / fadeDuration, 1)
        if (fp >= 1) {
      ctx.clearRect(0, 0, W, H)
          onComplete()
          return
        }
      }

      ctx.clearRect(0, 0, W, H)

      drawHalo(rx, ry)
      drawEffects(rx, ry)

      if (raw <= triggerAt && eased < 0.3) {
        const ca = Math.max(0, 1 - eased / 0.3)
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 140)
        cg.addColorStop(0, `rgba(255,240,255,${ca * 0.8})`)
        cg.addColorStop(0.15, `rgba(200,80,220,${ca * 0.7})`)
        cg.addColorStop(0.45, `rgba(80,140,255,${ca * 0.3})`)
        cg.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, 140, 0, Math.PI * 2)
        ctx.fillStyle = cg; ctx.fill(); ctx.restore()
      }

      if (fp > 0) {
        const innerR = fp * screenMax
        const outerR = fp * maxR * 4
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR)
        grad.addColorStop(0, 'rgba(0,0,0,1)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }

    if (waking) {
      animRef.current = requestAnimationFrame(animate)
    }
    }

    // 预热：唤醒前先按真实路径画一帧很小的光斑再擦掉。
    // 「启动后第一次唤醒会卡」主要是首次执行这些渐变/裁剪要现场建的绘制管线，
    // 在这里提前付掉，等真正唤醒时就直接复用缓存了。
    if (!waking) {
      drawHalo(80, 80 * (1 - ryShrink))
      drawEffects(80, 80 * (1 - ryShrink))
      ctx.clearRect(0, 0, W, H)
    }

    if (waking) {
      animRef.current = requestAnimationFrame(animate)
    }
    return () => {
      cancelAnimationFrame(animRef.current)
      startRef.current = 0
      edgesReached.current.clear()
    }
  }, [onEdgeReached, onEdgeProgress, onComplete, onHaloGone, waking])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed', top: 0, left: 0,
        width: '100%', height: '100%',
        zIndex: 10, pointerEvents: 'none',
      }}
    />
  )
}
