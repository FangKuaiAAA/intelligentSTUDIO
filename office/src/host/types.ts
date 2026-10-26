/** 宿主适配层的公共契约：窗格只认这一组方法，不直接碰 Office.js */

export type HostName = 'word' | 'excel' | 'powerpoint'

export interface SelectionInfo {
  /** 规范化后的选中文本（可能为空） */
  text: string
  /** true = 没有可处理的内容（Excel 空单元格、PPT 未选形状等） */
  empty: boolean
  /** 宿主定位句柄；Word 在读选区阶段为空，提交时才铸造 */
  handle: string
}

export interface Capability {
  ok: boolean
  reason?: string
}

export interface HostAdapter {
  readonly host: HostName
  readonly label: string

  readSelection(): Promise<SelectionInfo>
  readContext(): Promise<string>

  /**
   * 把 handle 指向的文字换成 next。handle 为空时按"当前选区"就地铸造一个新句柄，
   * 返回真正可用的句柄（调用方必须存起来，复原与再次保留都靠它）。
   */
  replaceText(handle: string, original: string, next: string): Promise<string>
  restoreText(handle: string, original: string): Promise<void>

  insertPlaceholder(jobId: string, widthPx: number, heightPx: number): Promise<string>
  replacePlaceholder(jobId: string, base64: string, handle: string): Promise<boolean>
  removePlaceholder(jobId: string, handle: string): Promise<void>

  /** 占位图是否还在文档里：用户删掉它就必须停止后续写入，别把图塞回别处 */
  placeholderExists(jobId: string, handle: string): Promise<boolean>

  /** 选中句柄指向的内容：改写完成后自动选中，用户可直接继续操作 */
  selectText(handle: string): Promise<void>

  /** 按句柄读回内容：追问修改时用它兜底，不依赖"当前选区"是否还在 */
  readTextByHandle(handle: string): Promise<string>

  supports(action: string): Capability
}

/** CSS 像素 → 磅（Word / Excel 的形状几何都以磅计） */
export const pxToPt = (px: number): number => Math.round(px * 0.75)

/** 比较文本用：忽略空白差异（模型常改动换行与空格） */
export const normalize = (s: string): string => (s || '').replace(/\s+/g, ' ').trim()

export interface MarkdownTable {
  rows: string[][]
}

/** 解析模型返回的 Markdown 表格；解析不出返回 null（调用方退回纯文本写入） */
export function parseMarkdownTable(text: string): MarkdownTable | null {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'))
  if (lines.length < 2) return null

  const cells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim())

  const isDivider = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line)
  const rows = lines.filter((l) => !isDivider(l)).map(cells)
  if (rows.length === 0) return null

  const width = Math.max(...rows.map((r) => r.length))
  if (width < 2) return null
  return { rows: rows.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill('')])) }
}
