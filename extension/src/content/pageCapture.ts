/**
 * 整页截图：滚动 + 逐屏截取 + 拼接成一张长图，再等比压缩为可上送的 JPEG。
 *
 * 为什么不是"一次截整页"：扩展能用的只有 chrome.tabs.captureVisibleTab（只截可见区域），
 * 真正的全页截图要么上 chrome.debugger（会在顶部挂"正在调试"横幅，观感差），
 * 要么像我这样滚动拼接。滚动拼接的代价是固定/粘性元素会重复出现 —— 所以拼接前
 * 先把它们临时隐藏，结束后原样恢复。
 */

export interface FullPageOptions {
  /** 取一次可见区域截图（由调用方经 background 转发） */
  capture: () => Promise<string>
  /** 最多截几屏（页面对超长页面做上限保护） */
  maxSteps?: number
  maxWidth?: number
  maxPixels?: number
  maxChars?: number
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('截图无法解码'))
    img.src = src
  })
}

interface HiddenElement { el: HTMLElement; visibility: string }

/** 临时隐藏固定/粘性元素：否则每一屏的页头都会拼进长图 */
function freezeFixedElements(): HiddenElement[] {
  const hidden: HiddenElement[] = []
  const nodes = document.querySelectorAll<HTMLElement>('body *')
  let scanned = 0
  for (const el of nodes) {
    scanned += 1
    if (scanned > 6000) break
    const style = getComputedStyle(el)
    if (style.position !== 'fixed' && style.position !== 'sticky') continue
    if (style.visibility === 'hidden' || style.display === 'none') continue
    hidden.push({ el, visibility: el.style.visibility })
    el.style.visibility = 'hidden'
  }
  return hidden
}

function thaw(hidden: HiddenElement[]): void {
  for (const item of hidden) item.el.style.visibility = item.visibility
}

/** 等比缩小并编码为 JPEG；过大时逐级再缩，保证 dataURL 不超上限 */
function shrink(source: HTMLCanvasElement, maxWidth: number, maxPixels: number, maxChars: number): string {
  let scale = Math.min(1, maxWidth / source.width)
  if (source.width * source.height * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (source.width * source.height))
  }
  const out = document.createElement('canvas')
  let dataUrl = ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    out.width = Math.max(320, Math.round(source.width * scale))
    out.height = Math.max(200, Math.round(source.height * scale))
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, out.width, out.height)
    dataUrl = out.toDataURL('image/jpeg', 0.72)
    if (dataUrl.length <= maxChars) break
    scale *= 0.78
  }
  return dataUrl
}

export async function captureFullPage(options: FullPageOptions): Promise<string> {
  const maxSteps = options.maxSteps ?? 12
  const maxWidth = options.maxWidth ?? 1180
  const maxPixels = options.maxPixels ?? 1_600_000
  const maxChars = options.maxChars ?? 2_600_000

  const scroller = document.scrollingElement ?? document.documentElement
  const startX = window.scrollX
  const startY = window.scrollY
  const dpr = window.devicePixelRatio || 1
  const viewportW = Math.max(320, Math.round(window.visualViewport?.width ?? window.innerWidth))
  const viewportH = Math.max(240, Math.round(window.visualViewport?.height ?? window.innerHeight))
  const totalH = Math.max(scroller.scrollHeight, document.body?.scrollHeight ?? 0, viewportH)

  const frozen = freezeFixedElements()
  let canvas: HTMLCanvasElement | null = null
  let drawn = 0
  try {
    const steps = Math.min(maxSteps, Math.max(1, Math.ceil(totalH / viewportH)))
    canvas = document.createElement('canvas')
    canvas.width = Math.round(viewportW * dpr)
    canvas.height = Math.round(Math.min(totalH, steps * viewportH) * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')

    for (let step = 0; step < steps; step += 1) {
      window.scrollTo(0, Math.round(step * viewportH))
      await nextFrame()
      await nextFrame()
      // ⚠ captureVisibleTab 有「每秒最多 2 次」的配额：间隔必须拉开，否则整组截图会在
      // 第二屏就被配额拒绝（表现为「截图失败」）。520ms 留出安全余量。
      await delay(step === 0 ? 200 : 520)
      const img = await loadImage(await options.capture())
      // 按**真实**滚动位置裁掉与上一屏重合的部分：滚到底后被系统夹住时不会重复贴同一段
      const scrollTop = Math.round(window.scrollY)
      const top = Math.max(drawn, scrollTop)
      const bottom = Math.min(scrollTop + viewportH, scrollTop + Math.round(img.naturalHeight / dpr))
      if (bottom <= top) continue
      const srcY = Math.round((top - scrollTop) * dpr)
      const srcH = Math.round((bottom - top) * dpr)
      ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH, 0, Math.round(top * dpr), canvas.width, srcH)
      drawn = bottom
      if (drawn >= totalH) break
    }
  } finally {
    thaw(frozen)
    window.scrollTo(startX, startY)
  }

  if (!canvas || drawn <= 0) throw new Error('整页截图失败')
  return shrink(canvas, maxWidth, maxPixels, maxChars)
}
