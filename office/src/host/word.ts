import type { Capability, HostAdapter, SelectionInfo } from './types'
import { normalize, parseMarkdownTable, pxToPt } from './types'

const TAG_TXT = 'dony:txt:'
const TAG_IMG = 'dony:img:'

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())

/**
 * Word 适配层。
 *
 * 锚点是**内容控件**：读选区时不改文档（只读文本），提交那一刻才把选区包进一个
 * 打了 tag 的内容控件，后续的"复原""再次保留""占位图替换"都靠 tag 找回。
 * 这样做的好处是位置与内容解耦 —— 用户中途点别处也不会写错位置；
 * 代价是文档里会留下一个不可见的内容控件（用户可直接删除，行为等同放弃锚点）。
 */
export function createWordAdapter(): HostAdapter {
  return {
    host: 'word',
    label: 'Word',

    async readSelection(): Promise<SelectionInfo> {
      return Word.run(async (ctx: any) => {
        const sel = ctx.document.getSelection()
        sel.load('text')
        await ctx.sync()
        const text = String(sel.text || '')
        return { text, empty: text.trim().length === 0, handle: '' }
      })
    },

    async readContext(): Promise<string> {
      return Word.run(async (ctx: any) => {
        const sel = ctx.document.getSelection()
        const selParas = sel.paragraphs
        const paras = ctx.document.body.paragraphs
        sel.load('text')
        selParas.load('items/text')
        paras.load('items/text')
        await ctx.sync()

        const selText = normalize(String(sel.text || ''))
        // 光标常常是折叠的（没有选中任何字）：这时"光标处上下文"就是它所在的那一段。
        // 之前只看 sel.text，折叠时得到空串，整条链路直接静默退出。
        const ownText = normalize(selParas.items.map((p: any) => String(p.text || '')).join(' '))
        const probe = selText || ownText
        const items: string[] = paras.items.map((p: any) => String(p.text || ''))
        // 长文档只在前 800 段里找：没有上限时会为了"附近两段"把整篇正文读一遍
        const idx = probe
          ? items.slice(0, 800).findIndex((t) => normalize(t).includes(probe.slice(0, 40)))
          : -1
        if (idx < 0) return (probe || '').slice(0, 600)
        return items.slice(Math.max(0, idx - 2), idx + 3).join('\n').slice(0, 800)
      })
    },

    async replaceText(handle: string, _original: string, next: string): Promise<string> {
      const tag = handle || TAG_TXT + newId()

      return Word.run(async (ctx: any) => {
        if (handle) {
          const found = ctx.document.contentControls.getByTag(tag).getFirstOrNullObject()
          found.load('isNullObject')
          await ctx.sync()
          if (!found.isNullObject) {
            found.insertText(next, 'Replace')
            await ctx.sync()
            return tag
          }
        }

        const sel = ctx.document.getSelection()
        sel.load('text')
        await ctx.sync()

        const cc = sel.insertContentControl()
        cc.tag = tag
        cc.title = '书写辅助'
        cc.cannotEdit = false

        const table = parseMarkdownTable(next)
        if (table) {
          // 「表格」动作的产物是 Markdown 表：写成真正的 Word 表格，而不是一堆竖线
          cc.insertTable(table.rows.length, table.rows[0].length, 'Replace', table.rows)
        } else {
          cc.insertText(next, 'Replace')
        }
        await ctx.sync()
        return tag
      })
    },

    async restoreText(handle: string, original: string): Promise<void> {
      await Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(handle).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (cc.isNullObject) {
          console.warn('[word] 复原失败：找不到锚点内容控件', handle)
          return
        }
        cc.insertText(original, 'Replace')
        await ctx.sync()
      })
    },

    async insertPlaceholder(jobId: string, widthPx: number, heightPx: number): Promise<string> {
      const tag = TAG_IMG + jobId
      return Word.run(async (ctx: any) => {
        const sel = ctx.document.getSelection()
        const cc = sel.insertContentControl()
        cc.tag = tag
        cc.title = '正在生成图片'
        cc.cannotEdit = false
        const pic = cc.insertInlinePictureFromBase64(placeholderBase64(widthPx, heightPx), 'Replace')
        pic.width = pxToPt(widthPx)
        pic.height = pxToPt(heightPx)
        await ctx.sync()
        return tag
      })
    },

    async replacePlaceholder(jobId: string, base64: string): Promise<boolean> {
      const tag = TAG_IMG + jobId
      return Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(tag).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (cc.isNullObject) return false

        // 先量占位图的宽高，换图后原样写回 —— 尺寸一变文档就会重排
        const pics = cc.getRange().inlinePictures
        pics.load('items/width,items/height')
        await ctx.sync()
        const prev = pics.items[0]
        if (!prev) {
          // 只剩空壳：占位图已被用户删掉，清理掉空壳并放弃本次写入
          cc.delete(false)
          await ctx.sync()
          return false
        }
        const width = prev.width
        const height = prev.height

        const pic = cc.insertInlinePictureFromBase64(base64, 'Replace')
        if (width) pic.width = width
        if (height) pic.height = height
        await ctx.sync()
        return true
      })
    },

    async removePlaceholder(jobId: string): Promise<void> {
      const tag = TAG_IMG + jobId
      await Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(tag).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (cc.isNullObject) return
        cc.delete(false)
        await ctx.sync()
      })
    },

    async placeholderExists(jobId: string): Promise<boolean> {
      const tag = TAG_IMG + jobId
      return Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(tag).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (cc.isNullObject) return false

        // 用户在 Word 里删图，只会删掉内联图片，**内容控件外壳会留下**。
        // 只看 tag 存在与否会把它误判成"占位图还在"，于是失败图被塞进空壳里 ——
        // 表现就是"删了占位图，还冒出一张生成未完成"。所以必须检查里面还有没有图片。
        const pics = cc.getRange().inlinePictures
        pics.load('items')
        await ctx.sync()
        return pics.items.length > 0
      })
    },

    async selectText(handle: string): Promise<void> {
      if (!handle) return
      await Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(handle).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (!cc.isNullObject) cc.getRange().select()
        await ctx.sync()
      })
    },

    async readTextByHandle(handle: string): Promise<string> {
      if (!handle) return ''
      return Word.run(async (ctx: any) => {
        const cc = ctx.document.contentControls.getByTag(handle).getFirstOrNullObject()
        cc.load('isNullObject')
        await ctx.sync()
        if (cc.isNullObject) return ''
        const range = cc.getRange()
        range.load('text')
        await ctx.sync()
        return String(range.text || '').trim()
      })
    },

    supports(action: string): Capability {
      if (action === 'table' && !Office.context.requirements.isSetSupported('WordApi', '1.3')) {
        return { ok: false, reason: '当前 Word 版本不支持插入表格' }
      }
      return { ok: true }
    },
  }
}

/** 占位图按需现画：尺寸可变、零资源、零网络 */
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
