/* 彩虹药丸 + 沿边框旋转加载光边 —— 几何计算（移植自 rainbow-loading-pill skill，保持纯函数） */

export interface RainbowGeometry {
  viewBox: string
  room: number
  path: string
  L: number
  longLen: number
  capLen: number
  b0: number
  dFront: number
  dBack: number
}

const MIN_SPEED = 0.15
const easeAccel = (u: number) => (1 - MIN_SPEED) * u ** 3 + MIN_SPEED * u
const easeDecel = (u: number) => 1 - easeAccel(1 - u)
const SUB_U = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]
const SUB_PCT = SUB_U.map((u) => +(u * 25).toFixed(2))

export function computeGeometry({ width, height, radius, bleed = 2, room = 60 }: {
  width: number; height: number; radius?: number; bleed?: number; room?: number
}): RainbowGeometry {
  const r = Math.min(radius ?? height / 2, height / 2) + bleed
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
  return {
    viewBox: `0 0 ${(width + room * 2).toFixed(2)} ${(height + room * 2).toFixed(2)}`,
    room, path, L, longLen, capLen, b0, dFront, dBack,
  }
}

function buildKeyframes(geo: RainbowGeometry, name: string): string {
  const { L, longLen, capLen, b0, dFront, dBack } = geo
  const f0 = b0 + capLen
  const lines: string[] = []
  const emit = (pct: number, start: number, len: number, widthVar: string | null) => {
    lines.push(
      `  ${pct}% { stroke-dashoffset: ${(-start).toFixed(2)}; ` +
      `stroke-dasharray: ${len.toFixed(2)} ${(L - len).toFixed(2)};` +
      (widthVar ? ` stroke-width: var(${widthVar});` : '') + ' }'
    )
  }
  for (let round = 0; round < 2; round++) {
    const off = round * (L / 2)
    emit(round * 50, b0 + off, capLen, '--rb-w-wide')
    SUB_U.forEach((u, i) => {
      const s = easeAccel(u)
      emit(round * 50 + SUB_PCT[i], b0 + off + dBack * s, capLen + (dFront - dBack) * s, null)
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
    emit(round * 50 + 50, b1 + dFront, (f1 + dBack) - (b1 + dFront), '--rb-w-wide')
  }
  return `@keyframes ${name} {\n${lines.join('\n')}\n}`
}

// 光边的模糊半径：越小越贴边。原来最大 4（外溢很远），收紧到 2.2
const BLUR_STD = [0.45, 0.9, 1.5, 2.2]

export function buildSvg(geo: RainbowGeometry, idPrefix: string): string {
  const filters = BLUR_STD.map((std, i) => `
      <filter id="${idPrefix}-blur-${i + 1}" x="-60%" y="-260%" width="220%" height="620%"
              colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="${std}" />
      </filter>`).join('')
  const paths = BLUR_STD.map((_, i) =>
    `      <path class="rb-e${i + 1}" filter="url(#${idPrefix}-blur-${i + 1})" d="${geo.path}" />`
  ).join('\n')
  return [
    `<svg viewBox="${geo.viewBox}">`,
    '  <defs>' + filters,
    '  </defs>',
    '  <g>',
    paths,
    '  </g>',
    '</svg>',
  ].join('\n')
}

/** 只建一次的空壳：defs + 四条空 path，靠 setAttribute 更新几何（不重建 DOM） */
function buildSvgShell(idPrefix: string): string {
  const filters = BLUR_STD.map((std, i) => `
      <filter id="${idPrefix}-blur-${i + 1}" x="-60%" y="-260%" width="220%" height="620%"
              colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="${std}" />
      </filter>`).join('')
  const paths = BLUR_STD.map((_, i) =>
    `      <path class="rb-e${i + 1}" filter="url(#${idPrefix}-blur-${i + 1})" d="" />`
  ).join('\n')
  return [
    `<svg viewBox="0 0 100 100">`,
    '  <defs>' + filters,
    '  </defs>',
    '  <g>',
    paths,
    '  </g>',
    '</svg>',
  ].join('\n')
}

let seq = 0

interface EdgeParts {
  name: string
  style: HTMLStyleElement     // 每个元素只留这一条 keyframes 样式表
  svg: SVGSVGElement
  paths: SVGPathElement[]
}

// 按元素缓存：以前每次尺寸变化都 appendChild 一条新 @keyframes（只增不减），
// 文档里的样式表会无限膨胀 → 样式重算越来越慢，越用越卡、首次唤醒也卡。
const partsRegistry = new WeakMap<HTMLElement, EdgeParts>()

function ensureParts(edgeEl: HTMLElement): EdgeParts {
  const cached = partsRegistry.get(edgeEl)
  if (cached) return cached
  const name = `rbEdgePulse${++seq}`
  const style = document.createElement('style')
  document.head.appendChild(style)
  edgeEl.innerHTML = buildSvgShell(`rb-edge-${name}`)
  const svg = edgeEl.querySelector('svg') as SVGSVGElement
  const paths = Array.from(edgeEl.querySelectorAll('path')) as SVGPathElement[]
  // 动画名固定：更新 keyframes 内容时动画不会重启，形变过程中更连续
  paths.forEach((p) => { p.style.animationName = name })
  const parts: EdgeParts = { name, style, svg, paths }
  partsRegistry.set(edgeEl, parts)
  return parts
}

/** 把光边渲染进一个 .rb-edge 元素：更新几何与 keyframes（复用已有 DOM 与样式表）。 */
export function renderEdge(edgeEl: HTMLElement, geo: RainbowGeometry): string {
  const parts = ensureParts(edgeEl)
  edgeEl.style.setProperty('--rb-room', `${geo.room}px`)
  parts.svg.setAttribute('viewBox', geo.viewBox)
  for (const path of parts.paths) path.setAttribute('d', geo.path)
  parts.style.textContent = buildKeyframes(geo, parts.name)
  return parts.name
}

/** 元素卸载时回收它的样式表，避免 document.head 里留下垃圾。 */
export function disposeEdge(edgeEl: HTMLElement | null): void {
  if (!edgeEl) return
  const parts = partsRegistry.get(edgeEl)
  if (!parts) return
  parts.style.remove()
  partsRegistry.delete(edgeEl)
}
