/**
 * 占位图：在文档里"占住落点"的唯一视觉载体。
 *
 * 三个宿主共用一份画法，避免三处各写一遍导致观感不一致（此前 Word/Excel/PPT 各有一份）。
 * 只用 canvas 现画：尺寸可变、零网络、零资源。
 *
 * loading —— 灰底细边 + 六边形 + 「正在生成图片」
 * failed  —— 同版式换红灰配色 + 「生成未完成」，让失败在文档里也看得见
 *            （非共享运行时的功能区无法弹出任何界面，这是唯一可用的反馈通道）
 */

export type PlaceholderMode = 'loading' | 'failed'

export function placeholderBase64(widthPx: number, heightPx: number, mode: PlaceholderMode = 'loading'): string {
  const w = Math.max(120, Math.round(widthPx))
  const h = Math.max(90, Math.round(heightPx))
  const failed = mode === 'failed'

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (g) {
    g.fillStyle = failed ? '#fdf3f3' : '#f4f4f7'
    g.fillRect(0, 0, w, h)
    g.strokeStyle = failed ? 'rgba(201, 42, 31, 0.35)' : 'rgba(0, 0, 0, 0.12)'
    g.lineWidth = 2
    g.strokeRect(1, 1, w - 2, h - 2)

    const cx = w / 2
    const cy = h / 2 - 10
    const r = Math.min(w, h) * 0.13
    g.strokeStyle = failed ? 'rgba(201, 42, 31, 0.6)' : 'rgba(94, 92, 230, 0.65)'
    g.lineWidth = 3
    g.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.closePath()
    g.stroke()

    g.fillStyle = failed ? 'rgba(201, 42, 31, 0.75)' : 'rgba(29, 29, 31, 0.55)'
    g.font = `${Math.max(11, Math.round(h * 0.06))}px "Segoe UI", system-ui, sans-serif`
    g.textAlign = 'center'
    g.fillText(failed ? '生成未完成' : '正在生成图片', cx, cy + r + Math.max(18, h * 0.11))
  }
  return canvas.toDataURL('image/png').split(',')[1] || ''
}
