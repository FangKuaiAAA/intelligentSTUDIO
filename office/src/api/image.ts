/**
 * 图片搬运：1024 PNG 的 base64 可达 1.5–3MB，直接塞给 Office.js 会让 context.sync
 * 明显卡顿。这里统一先降采样到目标显示宽度、转 JPEG q0.85（约 200–400KB），
 * 并去掉 data: 前缀 —— insertInlinePictureFromBase64 / addImage 都只吃裸 base64。
 */

const TARGET_WIDTH = 640
const QUALITY = 0.85

export async function fetchRaw(jobId: string, token: string): Promise<Blob> {
  const response = await fetch(`/api/image/raw?job=${encodeURIComponent(jobId)}`, {
    headers: { 'x-dony-token': token },
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`取图失败（${response.status}）`)
  return response.blob()
}

/** 任意位图 → 目标宽度 JPEG 的裸 base64 */
export async function toInsertableBase64(blob: Blob): Promise<{ base64: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob)
  const width = Math.min(TARGET_WIDTH, bitmap.width)
  const height = Math.round((bitmap.height / bitmap.width) * width)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('浏览器不支持 canvas，无法压缩图片')
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
  return { base64: dataUrl.split(',')[1] || '', width, height }
}

/** 文档里占位图的推荐尺寸：4:3、宽度按窗格宽度收，避免撑破版心 */
export function placeholderSize(paneWidth: number): { width: number; height: number } {
  const width = Math.max(220, Math.min(420, Math.round(paneWidth * 1.15)))
  return { width, height: Math.round((width * 3) / 4) }
}

/** 本地预览用：同一张图给窗格里的图卡显示 */
export async function blobToObjectUrl(blob: Blob): Promise<string> {
  return URL.createObjectURL(blob)
}
