import { useState, useEffect, useRef, useCallback } from 'react'
import './RainbowEdges.css'
import { VoiceAnalysis } from '../../types'

export type Edge = 'bottom' | 'left' | 'right' | 'top'
export interface EdgeProgress { top: number; right: number; bottom: number; left: number }

interface RainbowEdgesProps {
  active: boolean
  keystrokePulse?: number
  audioAnalysis?: VoiceAnalysis | null
  visibleEdges?: Edge[]
  edgeProgress?: React.MutableRefObject<EdgeProgress>
  shrinkEdges?: boolean
}

const extWrapBase: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' }
const thickWrapBase: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', transition: 'transform 6s cubic-bezier(0.34,1.56,0.64,1)' }

// ===== 语音电平 → 光边"线性外扩/外缩" =====
// 需求（用户）：**只改语音模式**这一路跳动；每 ~0.1s 采样一次电平，然后让光边**线性**
// 缩小/扩大到该位置 —— 重点是看得见"外缩的移动"，而不是"跳一下"。
//  · SAMPLE_MS：采样周期（0.1s）。
//  · EDGE_EXT_MS：每段插值时长。与采样周期相等 ⇒ 下一拍到来时正好走到位（匀速直线）；
//    想让移动更慢更"看得见"，把它调大（如 180）就变成"追着目标走"的黏性跟随。
//  · EXT：幅度倍率 —— **不是**原来那个 ×100。
//    ⚠ 那个 100 是从**死代码**里继承来的：写在光边元素上的 transform 一直被 CSS 呼吸动画
//      盖掉、从未生效，所以没人发现它的量级是荒唐的。现在真生效了才发现：
//      光边带宽只有 38px，×100 ⇒ scaleY(101) = 3800px = **满屏彩虹**（用户实测）。
//    光边带宽 38px ⇒ EXT=2 表示 38→114px（最响时约 3 倍），一眼看得出"外扩/外缩的移动"，
//      又不会糊满屏幕。想更强就 3（→152px），想更含蓄就 1（→76px）。
const SAMPLE_MS = 100
const EDGE_EXT_MS = 100
const EXT = 2
/** 音色倾斜：low/high 是"低频/高频谁更强"的相对比例（**不是音量**），所以不让它参与幅度，
 *  只做 ±8% 的方向差 —— 低频多一点时上/下多伸一点、左右少一点，反之亦然。 */
const TILT = 0.08

export function RainbowEdges({ active, keystrokePulse = 0, audioAnalysis, visibleEdges, edgeProgress, shrinkEdges = false }: RainbowEdgesProps) {
  const [pulse, setPulse] = useState(false)
  const [thickness, setThickness] = useState(3)
  const prevRef = useRef(0)
  const topRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const tlRef = useRef<HTMLDivElement>(null)
  const trRef = useRef<HTMLDivElement>(null)
  // ---- 语音电平的「外扩层」：每个边缘一层（在厚度层里面、光边元素外面）----
  // ⚠ 为什么必须是**新的一层**：光边元素自己带着 CSS 动画（breatheVert/Horz 动的正是
  //   transform），而 **CSS 动画会盖掉内联 transform** ⇒ 直接写光边元素的 transform 是死代码
  //   （原来那几处 `transform: scaleY(scaleVal)` 就是这样失效的，只剩亮度在随电平变）。
  //   放到外层后，两套 transform **相乘**：呼吸仍是呼吸，电平负责外扩。
  const extTopRef = useRef<HTMLDivElement>(null)
  const extBottomRef = useRef<HTMLDivElement>(null)
  const extLeftRef = useRef<HTMLDivElement>(null)
  const extRightRef = useRef<HTMLDivElement>(null)
  // 最新一帧电平：定时器从这里读，避免把 audioAnalysis 放进 deps（那会让定时器每帧重启）
  const audioRef = useRef<VoiceAnalysis | null>(null)
  audioRef.current = audioAnalysis ?? null

  // 光边延伸进度：直接写 transform，不经过 React 状态。
  // （原来是每 50ms setState 一次＝20fps，所以唤醒时看起来是一段一段跳出来的。）
  useEffect(() => {
    if (!active || !edgeProgress) return
    let raf = 0
    const tick = () => {
      const p = edgeProgress.current
      if (topRef.current) topRef.current.style.transform = `scaleX(${p.top})`
      if (bottomRef.current) bottomRef.current.style.transform = `scaleX(${p.bottom})`
      if (leftRef.current) leftRef.current.style.transform = `scaleY(${p.left})`
      if (rightRef.current) rightRef.current.style.transform = `scaleY(${p.right})`
      if (tlRef.current) tlRef.current.style.opacity = String(Math.min(p.top, p.left))
      if (trRef.current) trRef.current.style.opacity = String(Math.min(p.top, p.right))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, edgeProgress])

  useEffect(() => {
    if (keystrokePulse !== prevRef.current) {
      prevRef.current = keystrokePulse
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 400)
      return () => clearTimeout(t)
    }
  }, [keystrokePulse])

  useEffect(() => {
    if (shrinkEdges) { requestAnimationFrame(() => setThickness(1)) }
    else { setThickness(3) }
  }, [shrinkEdges])

  // ---- 语音电平 → 光边**线性**外扩 / 外缩（用户要求，且只影响这一路）----
  //  · 采样：每 SAMPLE_MS 读一次最新电平（从 ref 读，**不进 React 状态** ⇒ 10Hz 的持续更新
  //    不会带动整棵子树重渲染）；
  //  · 插值：外扩层与白线都挂 `EDGE_EXT_MS linear` 过渡 ⇒ 两次采样之间是**匀速直线**，
  //    所以看得见"外缩的移动"而不是"跳一下"（CSS 过渡天然可被中途重定向 = 可打断）；
  //  · 非语音路径 audioAnalysis 恒为 null ⇒ 外扩恒为 1、白线恒为 0 = 原来的静止态。
  //    （键盘脉冲那条路一个字没动。）
  useEffect(() => {
    if (!active) return
    const apply = () => {
      const a = audioRef.current
      // 音量：**不再做第二次增益** —— 后端已经把 level 归一化到 0..1（饱和点 rms≈1500）。
      // ⚠ 原来这里是 `min(1, level*3)`：它是叠在后端增益之上的**第二重放大** ⇒ 电平几乎恒为 1.0
      //   ⇒ 光边只在"满格/归零"之间跳、没有中间层次（这正是"跳一下"的根因）。
      // 只保留一条**轻微上抬**（^0.7）：安静说话也能带出看得见的位移，大声仍在 1 封顶。
      const lvl = Math.pow(Math.min(1, Math.max(0, a?.level ?? 0)), 0.7)
      // 音色只做轻微倾斜（±TILT），不参与幅度 —— low/high 是相对比例、且在两端乱翻
      const tilt = Math.max(-1, Math.min(1, (a?.low ?? 0) - (a?.high ?? 0))) * TILT
      const extV = 1 + lvl * (1 + tilt) * EXT   // 上/下：竖直外扩
      const extH = 1 + lvl * (1 - tilt) * EXT   // 左/右：水平外扩
      const glowOp = 0.82 + lvl * 0.18
      if (extTopRef.current) {
        extTopRef.current.style.transform = `scaleY(${extV})`
        extTopRef.current.style.opacity = String(glowOp)
      }
      if (extBottomRef.current) {
        extBottomRef.current.style.transform = `scaleY(${extV})`
        extBottomRef.current.style.opacity = String(glowOp)
      }
      if (extLeftRef.current) {
        extLeftRef.current.style.transform = `scaleX(${extH})`
        extLeftRef.current.style.opacity = String(glowOp)
      }
      if (extRightRef.current) {
        extRightRef.current.style.transform = `scaleX(${extH})`
        extRightRef.current.style.opacity = String(glowOp)
      }
    }
    apply()
    const timer = window.setInterval(apply, SAMPLE_MS)
    return () => window.clearInterval(timer)
  }, [active])

  if (!active) return null

  const pc = pulse ? 'keystroke-pulse' : ''
  const vis = visibleEdges ?? ['bottom', 'left', 'right', 'top']
  const t = thickness
  const show = (e: Edge) => vis.includes(e)

  // 模糊半径固定：以前它随音量每帧变化，等于每帧让浏览器重新光栅化整屏模糊（最贵的一类操作）。
  // 音量/键盘的“跳动”改用 opacity 与 scale 表达，这两个走合成器，几乎不要钱。
  const EDGE_BLUR = 20
  // ⚠ 电平 → 幅度/亮度 的映射已移到上面那个「采样 + 线性」effect 里（每 100ms 写一次 DOM）。
  //   这里**不能**再算一份并按 React 渲染写进 style ✗：那样每次 WS 消息都会把内联样式重置，
  //   把采样出来的中间值打回目标值 ⇒ 又变回"跳一下"。

  return (
    <div className="rainbow-edges">
      {show('top') && (
        <div ref={topRef} style={{ ...extWrapBase, transformOrigin: 'top center' }}>
          <div style={{ ...thickWrapBase, transform: `scaleY(${t})`, transformOrigin: 'top center' }}>
            {/* 外扩层：语音电平写成这一层的 scaleY（10Hz 采样 + 每段线性过渡）。
                ⚠ 它必须在光边元素**外面**：光边自己的 transform 归 CSS 呼吸动画所有，
                  内联写上去会被动画盖掉（原实现就是这样失效的）。 */}
            <div ref={extTopRef} className="edge-ext"
              style={{ transformOrigin: 'top center', transitionDuration: `${EDGE_EXT_MS}ms` }}>
              <div className={`edge edge-top-glow ${pc}`} style={{ filter: `blur(${EDGE_BLUR}px)` }} />
            </div>
          </div>
        </div>
      )}

      {show('bottom') && (
        <div ref={bottomRef} style={{ ...extWrapBase, transformOrigin: 'bottom center' }}>
          <div style={{ ...thickWrapBase, transform: `scaleY(${t})`, transformOrigin: 'bottom center' }}>
            <div ref={extBottomRef} className="edge-ext"
              style={{ transformOrigin: 'bottom center', transitionDuration: `${EDGE_EXT_MS}ms` }}>
              <div className={`edge edge-bottom-glow ${pc}`} style={{ filter: `blur(${EDGE_BLUR}px)` }} />
            </div>
          </div>
        </div>
      )}

      {show('left') && (
        <div ref={leftRef} style={{ ...extWrapBase, transformOrigin: 'left bottom' }}>
          <div style={{ ...thickWrapBase, transform: `scaleX(${t})`, transformOrigin: 'left center' }}>
            <div ref={extLeftRef} className="edge-ext"
              style={{ transformOrigin: 'left center', transitionDuration: `${EDGE_EXT_MS}ms` }}>
              <div className={`edge edge-left-glow ${pc}`} style={{ filter: `blur(${EDGE_BLUR}px)` }} />
            </div>
          </div>
        </div>
      )}

      {show('right') && (
        <div ref={rightRef} style={{ ...extWrapBase, transformOrigin: 'right bottom' }}>
          <div style={{ ...thickWrapBase, transform: `scaleX(${t})`, transformOrigin: 'right center' }}>
            <div ref={extRightRef} className="edge-ext"
              style={{ transformOrigin: 'right center', transitionDuration: `${EDGE_EXT_MS}ms` }}>
              <div className={`edge edge-right-glow ${pc}`} style={{ filter: `blur(${EDGE_BLUR}px)` }} />
            </div>
          </div>
        </div>
      )}

      {show('top') && show('left') && <div ref={tlRef} className="corner corner-tl" />}
      {show('top') && show('right') && <div ref={trRef} className="corner corner-tr" />}
      {show('bottom') && show('left') && <div className="corner corner-bl" />}
      {show('bottom') && show('right') && <div className="corner corner-br" />}
    </div>
  )
}
