import type { Capability, HostAdapter, SelectionInfo } from './types'
import { parseMarkdownTable, pxToPt } from './types'

const TAG_IMG = 'dony:img:'
/** 定位时的最大测量范围：超过它就是"在表尾之外"，按上限对齐即可 */
const MEASURE_CAP = 40

const cellText = (values: unknown): string => {
  if (!Array.isArray(values)) return ''
  return values
    .map((row) => (Array.isArray(row) ? row.map((v) => (v == null ? '' : String(v))).join('\t') : String(row)))
    .join('\n')
}

/**
 * Excel 适配层。
 *
 * Excel 没有"文档流"，一切以地址为单位：文字改写只写回**选区左上角那个单元格**
 * （多单元格选区里的段落型文本没有别的合理落点），复原靠同一地址重新写值。
 * 图片只能用浮动形状（ExcelApi 1.9 的 shapes.addImage），位置要按列宽/行高累加算出来
 * —— Excel 没有任何"把 Range 转成像素矩形"的接口。
 */
export function createExcelAdapter(): HostAdapter {
  return {
    host: 'excel',
    label: 'Excel',

    async readSelection(): Promise<SelectionInfo> {
      return Excel.run(async (ctx: any) => {
        const range = ctx.workbook.getSelectedRange()
        range.load('address,values')
        await ctx.sync()
        const text = cellText(range.values)
        return {
          text,
          empty: text.trim().length === 0,
          handle: String(range.address || ''),
        }
      })
    },

    async readContext(): Promise<string> {
      return Excel.run(async (ctx: any) => {
        const sel = ctx.workbook.getSelectedRange()
        sel.load('address,rowIndex,columnIndex,rowCount,columnCount')
        await ctx.sync()

        // 选区上下各扩两行、右边扩两列：够模型判断"这一段在讲什么"
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const rowStart = Math.max(0, Number(sel.rowIndex) - 2)
        const rows = Number(sel.rowCount) + 4
        const cols = Math.max(3, Number(sel.columnCount) + 2)
        const area = sheet.getRangeByIndexes(rowStart, Math.max(0, Number(sel.columnIndex) - 1), rows, cols)
        area.load('values')
        await ctx.sync()
        return cellText(area.values).slice(0, 800)
      })
    },

    async replaceText(handle: string, _original: string, next: string): Promise<string> {
      return Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const address = handle || String(ctx.workbook.getSelectedRange().address)
        const anchor = sheet.getRange(address).getCell(0, 0)

        const table = parseMarkdownTable(next)
        if (table) {
          // 「表格」：把二维数据摊到从锚点开始的区域，行数/列数按模型给的表走
          const target = sheet.getRangeByIndexes(
            Number(anchor.rowIndex),
            Number(anchor.columnIndex),
            table.rows.length,
            table.rows[0].length
          )
          target.values = table.rows
        } else {
          anchor.values = [[next]]
        }
        await ctx.sync()
        return address
      })
    },

    async restoreText(handle: string, original: string): Promise<void> {
      await Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        sheet.getRange(handle).getCell(0, 0).values = [[original]]
        await ctx.sync()
      })
    },

    async insertPlaceholder(jobId: string, widthPx: number, heightPx: number): Promise<string> {
      const name = TAG_IMG + jobId
      return Excel.run(async (ctx: any) => {
        if (!Office.context.requirements.isSetSupported('ExcelApi', '1.9')) {
          throw new Error('当前 Excel 版本不支持插入图片（需要 ExcelApi 1.9）')
        }
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const sel = ctx.workbook.getSelectedRange()
        sel.load('rowIndex,columnIndex')
        await ctx.sync()

        const box = await measure(ctx, sheet, Number(sel.rowIndex), Number(sel.columnIndex), widthPx, heightPx)
        const shape = sheet.shapes.addImage(placeholderBase64(widthPx, heightPx))
        shape.name = name
        shape.placement = 'MoveAndSize'
        shape.left = box.left
        shape.top = box.top
        shape.width = box.width
        shape.height = box.height
        await ctx.sync()
        return name
      })
    },

    async replacePlaceholder(jobId: string, base64: string): Promise<boolean> {
      const name = TAG_IMG + jobId
      return Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const found = sheet.shapes.getItemOrNullObject(name)
        found.load('isNullObject,left,top,width,height')
        await ctx.sync()
        if (found.isNullObject) return false

        const box = { left: found.left, top: found.top, width: found.width, height: found.height }
        found.delete()
        const shape = sheet.shapes.addImage(base64)
        shape.name = name
        shape.placement = 'MoveAndSize'
        shape.left = box.left
        shape.top = box.top
        shape.width = box.width
        shape.height = box.height
        await ctx.sync()
        return true
      })
    },

    async removePlaceholder(jobId: string): Promise<void> {
      const name = TAG_IMG + jobId
      await Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const found = sheet.shapes.getItemOrNullObject(name)
        found.load('isNullObject')
        await ctx.sync()
        if (!found.isNullObject) found.delete()
        await ctx.sync()
      })
    },

    async placeholderExists(jobId: string): Promise<boolean> {
      const name = TAG_IMG + jobId
      return Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const found = sheet.shapes.getItemOrNullObject(name)
        found.load('isNullObject')
        await ctx.sync()
        return !found.isNullObject
      })
    },

    async selectText(handle: string): Promise<void> {
      if (!handle) return
      await Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        sheet.getRange(handle).select()
        await ctx.sync()
      })
    },

    async readTextByHandle(handle: string): Promise<string> {
      if (!handle) return ''
      return Excel.run(async (ctx: any) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet()
        const range = sheet.getRange(handle)
        range.load('values')
        await ctx.sync()
        const rows: any[][] = range.values || []
        return rows
          .map((row) => row.filter((c) => c !== '' && c !== null && c !== undefined).join(' '))
          .filter(Boolean)
          .join('\n')
      })
    },

    supports(action: string): Capability {
      if (!Office.context.requirements.isSetSupported('ExcelApi', '1.9')) {
        return { ok: false, reason: '当前 Excel 版本不支持插入图片' }
      }
      return { ok: true }
    },
  }
}

/** 算锚点单元格左上角的磅坐标；列宽/行高各自累加（两者单位都是磅） */
async function measure(
  ctx: any,
  sheet: any,
  row: number,
  col: number,
  widthPx: number,
  heightPx: number
): Promise<{ left: number; top: number; width: number; height: number }> {
  const colCap = Math.min(col, MEASURE_CAP)
  const rowCap = Math.min(row, MEASURE_CAP)
  const colCells: any[] = []
  const rowCells: any[] = []

  for (let c = 0; c < colCap; c++) {
    const cell = sheet.getRangeByIndexes(0, c, 1, 1)
    cell.format.load('columnWidth')
    colCells.push(cell)
  }
  for (let r = 0; r < rowCap; r++) {
    const cell = sheet.getRangeByIndexes(r, 0, 1, 1)
    cell.format.load('rowHeight')
    rowCells.push(cell)
  }
  const anchor = sheet.getRangeByIndexes(row, col, 1, 1)
  anchor.format.load('columnWidth,rowHeight')
  await ctx.sync()

  const left = colCells.reduce((sum, cell) => sum + Number(cell.format.columnWidth || 0), 0)
  const top = rowCells.reduce((sum, cell) => sum + Number(cell.format.rowHeight || 0), 0)
  const cellWidth = Number(anchor.format.columnWidth || 64)
  const targetWidth = Math.min(Math.max(pxToPt(widthPx), cellWidth), 270)
  const targetHeight = Math.round(targetWidth * (heightPx / Math.max(1, widthPx)))

  return { left, top, width: targetWidth, height: targetHeight }
}

/** 占位图现画：与 Word 侧同一套版式（灰底 + 细边 + 六边形 + 一句说明） */
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
