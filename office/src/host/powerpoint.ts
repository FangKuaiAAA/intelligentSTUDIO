import type { Capability, HostAdapter, SelectionInfo } from './types'
import { normalize, pxToPt } from './types'

const TAG_IMG = 'dony:img:'

/** 用通用 API 插图：PowerPoint 的形状集合长期没有稳定的"按坐标加图片"方法 */
function insertImage(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Office.context.document.setSelectedDataAsync(
      base64,
      { coercionType: Office.CoercionType.Image },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) resolve()
        else reject(new Error(result.error?.message || '插入图片失败'))
      }
    )
  })
}

/** 在所有幻灯片里按 id 找形状（幻灯片数量通常很少，逐个 sync 可接受） */
async function findShape(ctx: any, shapeId: string): Promise<any | null> {
  const slides = ctx.presentation.slides
  slides.load('items')
  await ctx.sync()
  for (const slide of slides.items) {
    const shapes = slide.shapes
    shapes.load('items')
    await ctx.sync()
    const hit = shapes.items.find((s: any) => String(s.id) === String(shapeId))
    if (hit) return hit
  }
  return null
}

/** 取"刚插入的那个形状"：插入后它是选中的，且名字还不是我们的 tag */
async function takeInsertedShape(ctx: any): Promise<any | null> {
  const shapes = ctx.presentation.getSelectedShapes()
  shapes.load('items/id,items/name')
  await ctx.sync()
  const items = shapes.items || []
  return items.length ? items[items.length - 1] : null
}

/**
 * PowerPoint 适配层。
 *
 * 文本以 "形状 id" 为句柄；图片只能走 setSelectedDataAsync（跨版本最稳），
 * 因此占位图替换的顺序是**先插新的、按记录的位置摆好，再删占位图** ——
 * 反过来做会失去"插入落点"，新图只能回到幻灯片中心。
 */
export function createPowerPointAdapter(): HostAdapter {
  return {
    host: 'powerpoint',
    label: 'PowerPoint',

    async readSelection(): Promise<SelectionInfo> {
      return PowerPoint.run(async (ctx: any) => {
        const shapes = ctx.presentation.getSelectedShapes()
        shapes.load('items/id')
        await ctx.sync()
        const first = (shapes.items || [])[0]
        if (!first) return { text: '', empty: true, handle: '' }

        let text = ''
        try {
          first.textFrame.textRange.load('text')
          await ctx.sync()
          text = String(first.textFrame.textRange.text || '')
        } catch (e) {
          console.error('[ppt] 该形状没有文本框', e)
        }
        return { text, empty: text.trim().length === 0, handle: String(first.id) }
      })
    },

    async readContext(): Promise<string> {
      return PowerPoint.run(async (ctx: any) => {
        const slides = ctx.presentation.slides
        slides.load('items')
        await ctx.sync()
        if (!slides.items.length) return ''
        const shapes = slides.items[0].shapes
        shapes.load('items')
        await ctx.sync()

        const parts: string[] = []
        for (const shape of shapes.items) {
          try {
            shape.textFrame.textRange.load('text')
            await ctx.sync()
            const t = String(shape.textFrame.textRange.text || '').trim()
            if (t) parts.push(t)
          } catch (e) {
            // 图片/线条等没有文本框，跳过即可
          }
        }
        return normalize(parts.join('\n')).slice(0, 800)
      })
    },

    async replaceText(handle: string, _original: string, next: string): Promise<string> {
      return PowerPoint.run(async (ctx: any) => {
        const shape = handle ? await findShape(ctx, handle) : await takeInsertedShape(ctx)
        if (!shape) throw new Error('没有找到要改写的文本框，请重新选中文字')
        shape.textFrame.textRange.text = next
        await ctx.sync()
        return String(shape.id)
      })
    },

    async restoreText(handle: string, original: string): Promise<void> {
      await PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        if (!shape) {
          console.warn('[ppt] 复原失败：找不到形状', handle)
          return
        }
        shape.textFrame.textRange.text = original
        await ctx.sync()
      })
    },

    async insertPlaceholder(jobId: string, widthPx: number, heightPx: number): Promise<string> {
      await insertImage(placeholderBase64(widthPx, heightPx))
      return PowerPoint.run(async (ctx: any) => {
        const shape = await takeInsertedShape(ctx)
        if (!shape) throw new Error('占位图插入后没有取到形状')
        shape.name = TAG_IMG + jobId
        shape.width = pxToPt(widthPx)
        shape.height = pxToPt(heightPx)
        await ctx.sync()
        return String(shape.id)
      })
    },

    async replacePlaceholder(jobId: string, base64: string, handle: string): Promise<boolean> {
      const located = await PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        if (!shape) return null
        shape.load('left,top,width,height')
        await ctx.sync()
        const box = { left: shape.left, top: shape.top, width: shape.width, height: shape.height }
        await shape.delete()
        await ctx.sync()
        return box
      })
      if (!located) return false

      await insertImage(base64)
      await PowerPoint.run(async (ctx: any) => {
        const shape = await takeInsertedShape(ctx)
        if (!shape) return
        shape.name = TAG_IMG + jobId
        shape.left = located.left
        shape.top = located.top
        shape.width = located.width
        shape.height = located.height
        await ctx.sync()
      })
      return true
    },

    async removePlaceholder(_jobId: string, handle: string): Promise<void> {
      await PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        if (!shape) return
        await shape.delete()
        await ctx.sync()
      })
    },

    async placeholderExists(_jobId: string, handle: string): Promise<boolean> {
      if (!handle) return false
      return PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        return Boolean(shape)
      })
    },

    async selectText(handle: string): Promise<void> {
      if (!handle) return
      await PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        if (shape) shape.textFrame.textRange.select()
        await ctx.sync()
      })
    },

    async readTextByHandle(handle: string): Promise<string> {
      if (!handle) return ''
      return PowerPoint.run(async (ctx: any) => {
        const shape = await findShape(ctx, handle)
        if (!shape) return ''
        shape.textFrame.textRange.load('text')
        await ctx.sync()
        return String(shape.textFrame.textRange.text || '').trim()
      })
    },

    supports(action: string): Capability {
      if (action === 'table') return { ok: false, reason: 'PowerPoint 暂不支持插入表格' }
      return { ok: true }
    },
  }
}

/** 占位图现画：与 Word / Excel 同一版式 */
function placeholderBase64(widthPx: number, heightPx: number): string {
  const w = Math.max(120, Math.round(widthPx))
  const h = Math.max(90, Math.round(heightPx))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (g) {
    g.fillStyle = '#f4f4f7'
    g.fillRect(0, 0, w, h)
    g.strokeStyle = 'rgba(0,0,0,0.12)'
    g.lineWidth = 2
    g.strokeRect(1, 1, w - 2, h - 2)
    const cx = w / 2
    const cy = h / 2 - 10
    const r = Math.min(w, h) * 0.13
    g.strokeStyle = 'rgba(94,92,230,0.65)'
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
    g.fillStyle = 'rgba(29,29,31,0.55)'
    g.font = `${Math.max(11, Math.round(h * 0.06))}px "Segoe UI", system-ui, sans-serif`
    g.textAlign = 'center'
    g.fillText('正在生成图片', cx, cy + r + Math.max(18, h * 0.11))
  }
  return canvas.toDataURL('image/png').split(',')[1] || ''
}
