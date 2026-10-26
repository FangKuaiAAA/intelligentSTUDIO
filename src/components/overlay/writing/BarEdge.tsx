import { useEffect, useMemo } from 'react'

/**
 * 横框的加载光边。
 *
 * 照搬自 rainbow-loading-pill（同源：视觉智能的加载光边），只取「光边」，不带彩虹胶囊。
 * 原实现的要点全部保留：
 *   · 一圈虚线在圆角矩形路径上跑，起点取**边的端点**（上边左端切点）；
 *   · 长度与位移都用**路径上的绝对长度**算，不按比例缩放；
 *   · 四段各占 25%：段 1/3 走加速曲线（长度 capLen → longLen），段 2/4 走减速曲线；
 *   · 粗细随长度联动（圆头态用 --rb-w-wide、长边态用 --rb-w-band）；
 *   · 四层不同模糊叠出「中间实、外圈散」。
 */

/** 最小速度（占平均速度的比例）。0.15 → 峰值 2.7，圆头处仍在持续慢走。 */
const MIN_SPEED = 0.15
const easeAccel = (u: number) => (1 - MIN_SPEED) * u ** 3 + MIN_SPEED * u
const easeDecel = (u: number) => 1 - easeAccel(1 - u)
/** 每段取 6 个子段（曲线弯曲较大，密一些才不会看出台阶） */
const SUB_U = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]
const SUB_PCT = SUB_U.map((u) => +(u * 25).toFixed(2))
/** 四层模糊：内层最锐、外层最散 */
const BLUR_STD = [0.75, 1.5, 2.5, 4]
const KEYFRAME_NAME = 'wtBarEdgePulse'
const STYLE_ID = 'wt-bar-edge-kf'

interface Geo {
  viewBox: string
  path: string
  L: number
  longLen: number
  capLen: number
  b0: number
  dFront: number
  dBack: number
}

/** 由卡片尺寸推导光边几何量（与原实现同一套公式） */
function computeGeometry(
  { width, height, radius, bleed = 2, room = 60 }:
  { width: number; height: number; radius: number; bleed?: number; room?: number },
): Geo {
  const r = Math.min(radius, height / 2) + bleed
  const x0 = room - bleed
  const y0 = room - bleed
  const x1 = room + width + bleed
  const y1 = room + height + bleed

  const LONG = (x1 - x0) - 2 * r
  const CAP = (y1 - y0) - 2 * r + Math.PI * r
  const L = 2 * LONG + 2 * CAP

  const longLen = LONG + CAP / 3
  const capLen = (CAP * 2) / 3

  const dFront = (L / 2 + (longLen - capLen)) / 2
  const dBack = (L / 2 - (longLen - capLen)) / 2
  const b0 = 2 * LONG + 1.5 * CAP - capLen / 2

  const R = r
  const path = [
    `M${(x0 + R).toFixed(2)} ${y0.toFixed(2)}`,
    `H${(x1 - R).toFixed(2)}`,
    `A${R.toFixed(2)} ${R.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${(y0 + R).toFixed(2)}`,
    `V${(y1 - R).toFixed(2)}`,
    `A${R.toFixed(2)} ${R.toFixed(2)} 0 0 1 ${(x1 - R).toFixed(2)} ${y1.toFixed(2)}`,
    `H${(x0 + R).toFixed(2)}`,
    `A${R.toFixed(2)} ${R.toFixed(2)} 0 0 1 ${x0.toFixed(2)} ${(y1 - R).toFixed(2)}`,
    `V${(y0 + R).toFixed(2)}`,
    `A${R.toFixed(2)} ${R.toFixed(2)} 0 0 1 ${(x0 + R).toFixed(2)} ${y0.toFixed(2)}`,
    'Z',
  ].join(' ')

  return { viewBox: `0 0 ${width + room * 2} ${height + room * 2}`, path, L, longLen, capLen, b0, dFront, dBack }
}

/** 按真实路径长度生成 keyframes（CSS 里那份是固定尺寸的兜底值） */
function buildKeyframes(geo: Geo): string {
  const { L, longLen, capLen, b0, dFront, dBack } = geo
  const f0 = b0 + capLen
  const lines: string[] = []
  const emit = (pct: number, start: number, len: number, widthVar: string | null) => {
    lines.push(
      `  ${pct}% { stroke-dashoffset: ${(-start).toFixed(2)}; `
      + `stroke-dasharray: ${len.toFixed(2)} ${(L - len).toFixed(2)};`
      + (widthVar ? ` stroke-width: var(${widthVar});` : '') + ' }',
    )
  }

  for (let round = 0; round < 2; round += 1) {
    const off = round * (L / 2)
    emit(round * 50, b0 + off, capLen, '--rb-w-wide')
    SUB_U.forEach((u, i) => {
      const s = easeAccel(u)
      emit(round * 50 + SUB_PCT[i], b0 + off + dBack * s,
        capLen + (dFront - dBack) * s, null)
    })
    const b1 = b0 + off + dBack
    const f1 = f0 + off + dFront
    emit(round * 50 + 25, b1, longLen, '--rb-w-band')

    SUB_U.forEach((u, i) => {
      const s = easeDecel(u)
      const b = b1 + dFront * s
      const f = f1 + dBack * s
      emit(round * 50 + 25 + SUB_PCT[i], b, f - b, null)
    })
    const b2 = b1 + dFront
    const f2 = f1 + dBack
    emit(round * 50 + 50, b2, f2 - b2, '--rb-w-wide')
  }
  return `@keyframes ${KEYFRAME_NAME} {\n${lines.join('\n')}\n}`
}

interface BarEdgeProps {
  /** 模型回答期间为 true（光边淡入；结束淡出） */
  active: boolean
  width: number
  height: number
}

export function BarEdge({ active, width, height }: BarEdgeProps) {
  const geo = useMemo(
    () => computeGeometry({ width, height, radius: height / 2 }),
    [width, height],
  )

  // keyframes 按真实路径长度注入（同名覆盖，重复渲染幂等）
  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = buildKeyframes(geo)
  }, [geo])

  return (
    <div className={`wt-bar-edge${active ? ' is-active' : ''}`} aria-hidden="true">
      <svg viewBox={geo.viewBox}>
        <defs>
          {/* 把卡片本身挖空：光边只朝外扩散，内圈不会有一道光横穿卡片内部。
              视觉智能那边用的是 evenodd 的 clipPath，这里用等效的 mask（白色保留、黑色挖掉）。 */}
          <mask id="wt-bar-edge-mask">
            <rect x="0" y="0" width={width + 120} height={height + 120} fill="#fff" />
            <rect
              x={60} y={60} width={width} height={height}
              rx={height / 2} ry={height / 2} fill="#000"
            />
          </mask>
          {BLUR_STD.map((std, i) => (
            <filter
              key={`f${i}`}
              id={`wt-bar-edge-blur-${i + 1}`}
              x="-60%" y="-260%" width="220%" height="620%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur stdDeviation={std} />
            </filter>
          ))}
        </defs>
        <g>
          {BLUR_STD.map((_, i) => (
            <path
              key={`p${i}`}
              className={`rb-e${i + 1}`}
              filter={`url(#wt-bar-edge-blur-${i + 1})`}
              d={geo.path}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}
