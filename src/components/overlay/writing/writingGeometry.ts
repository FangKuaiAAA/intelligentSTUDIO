/**
 * 书写辅助的坐标与布局换算。
 *
 * 后端（UIA）给的是**屏幕物理像素**，而覆盖层窗口内用的是 **DIP**：
 * 在 125% / 150% 缩放下不换算会整体偏移几十像素，所以所有几何都必须先过 `toDip`。
 * 缩放比与屏幕原点由主进程提供（`getWritingScreen`），不要用 devicePixelRatio 自己猜 ——
 * 那在混合 DPI 的多屏环境下会错。
 */

/** 后端给的矩形：[left, top, right, bottom]，屏幕物理像素 */
export type PhysRect = [number, number, number, number]

/** 换算后的窗口内矩形（DIP） */
export interface DipRect { x: number; y: number; w: number; h: number }

export interface ScreenInfo {
  scaleFactor: number
  bounds: { x: number; y: number; width: number; height: number }
}

/** 浮层与屏幕边缘的最小间距（避免贴着屏幕边、以及被任务栏压住） */
const EDGE_MARGIN = 10

export function toDip(rect: PhysRect, screen: ScreenInfo): DipRect {
  const scale = screen.scaleFactor || 1
  const bx = screen.bounds?.x ?? 0
  const by = screen.bounds?.y ?? 0
  return {
    x: rect[0] / scale - bx,
    y: rect[1] / scale - by,
    w: Math.max(1, (rect[2] - rect[0]) / scale),
    h: Math.max(1, (rect[3] - rect[1]) / scale),
  }
}

export function toDipList(rects: PhysRect[], screen: ScreenInfo): DipRect[] {
  return rects.map((r) => toDip(r, screen))
}

/** 所有矩形的并集（用于判断"整体框在哪"，例如横框该放哪一行之上） */
export function unionRect(rects: DipRect[]): DipRect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 }
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 指针是否靠近某矩形（外扩 pad 像素）—— 标签"只有鼠标靠近时显示"就靠它 */
export function isNearPoint(p: { x: number; y: number }, rect: DipRect, pad = 28): boolean {
  return p.x >= rect.x - pad && p.x <= rect.x + rect.w + pad
    && p.y >= rect.y - pad && p.y <= rect.y + rect.h + pad
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 标签尺寸：圆角本体的宽/高 + 右侧凸点长度（凸点指向选区里的第一个字）。
 *
 * ⚠ 本体的宽与高必须分开给。早先的写法是"body 同时当宽和高"（本体按正方形做），
 * 本体一旦按参考图的比例改成 18×21，垂直居中就会差 1.5px。
 */
export interface TagSize { bodyW: number; bodyH: number; tip: number }

/**
 * 标签小框的位置：贴在第一行**左侧外部**，与第一行**垂直居中**，尖角指向第一个字。
 *
 * 与拖拽方向无关 —— 锚点是文本逻辑起点（见后端 selection.py），从右往左划选时
 * 鼠标按下点在末尾，按按下点定位会跑到选区尾部去。
 *
 * 左侧放不下（选区紧贴屏幕左缘）时依次退到第一行上方、下方，水平位置始终贴着第一个字。
 */
export function layoutTag(
  anchor: DipRect, tag: TagSize, viewport: { w: number; h: number }, gap = 8,
): { x: number; y: number } {
  const w = tag.bodyW + tag.tip
  const h = tag.bodyH
  const clampY = (v: number) => clamp(v, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.h - h - EDGE_MARGIN))
  const centerY = clampY(anchor.y + anchor.h / 2 - h / 2)
  const leftX = anchor.x - w - gap
  if (leftX >= EDGE_MARGIN) return { x: leftX, y: centerY }
  const alignX = Math.max(EDGE_MARGIN, Math.min(anchor.x, viewport.w - w - EDGE_MARGIN))
  const aboveY = anchor.y - h - gap
  if (aboveY >= EDGE_MARGIN) return { x: alignX, y: aboveY }
  return { x: alignX, y: clampY(anchor.y + anchor.h + gap) }
}

export interface MenuLayout {
  x: number
  y: number
  /** 弹出方向：left = 从锚点向左生长（首选），right = 左侧空间不足时向右 */
  dir: 'left' | 'right'
}

/**
 * 修改选择框的落位。
 *
 * 需求是"从锚点向左扩大弹出"，所以右边缘贴住锚点左边缘、宽度从 0 长到目标宽；
 * 左侧空间不足时整体翻到锚点右侧，同样从 0 长到目标宽。
 * 纵向按"顶部对齐锚点"起算，超出屏幕则整体上移。
 */
export function layoutMenu(
  anchor: DipRect, menuW: number, menuH: number, viewport: { w: number; h: number }, gap = 14,
): MenuLayout {
  const rightSideX = anchor.x + anchor.w + gap
  const leftSideX = anchor.x - gap - menuW
  const fitsLeft = leftSideX >= EDGE_MARGIN
  const fitsRight = rightSideX + menuW <= viewport.w - EDGE_MARGIN

  let dir: 'left' | 'right' = 'left'
  let x = leftSideX
  if (!fitsLeft && fitsRight) {
    dir = 'right'
    x = rightSideX
  } else if (!fitsLeft && !fitsRight) {
    // 两侧都放不下（屏幕很窄 / 选区横向几乎占满）：优先向左，并夹到屏幕内
    x = clamp(leftSideX, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.w - menuW - EDGE_MARGIN))
  }

  const y = clamp(anchor.y - 6, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.h - menuH - EDGE_MARGIN))
  return { x, y, dir }
}

/**
 * 横框的落位：选区**上方**短距离处，水平以选区中心对齐（贴边时夹到屏幕内）。
 * 上方放不下就翻到选区下方 —— 顶部的选区在真实文档里很常见。
 */
export function layoutBar(
  union: DipRect, barW: number, barH: number, viewport: { w: number; h: number }, gap = 16,
): { x: number; y: number; flipped: boolean } {
  const centerX = union.x + union.w / 2 - barW / 2
  const x = clamp(centerX, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.w - barW - EDGE_MARGIN))
  const above = union.y - gap - barH
  const flipped = above < EDGE_MARGIN
  const y = flipped ? union.y + union.h + gap : above
  return { x, y, flipped }
}
