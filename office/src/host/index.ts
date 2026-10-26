import type { HostAdapter, HostName } from './types'
import { createWordAdapter } from './word'
import { createExcelAdapter } from './excel'
import { createPowerPointAdapter } from './powerpoint'

export type { HostAdapter, HostName, SelectionInfo, Capability } from './types'

let cached: HostAdapter | null = null

/** 从 Office.context.host 判定宿主；不认识的一律按 Word 处理（至少能读写选区） */
export function hostName(): HostName {
  const raw = String(Office?.context?.host || '')
  if (raw === 'Excel') return 'excel'
  if (raw === 'PowerPoint') return 'powerpoint'
  return 'word'
}

export function hostLabel(host: HostName): string {
  if (host === 'excel') return 'Excel'
  if (host === 'powerpoint') return 'PowerPoint'
  return 'Word'
}

export function getHost(): HostAdapter {
  if (cached) return cached
  const host = hostName()
  cached = host === 'excel' ? createExcelAdapter() : host === 'powerpoint' ? createPowerPointAdapter() : createWordAdapter()
  return cached
}

/** Office 握手完成前 host 拿不到真值，适配器可能被误缓存成 Word —— 握手后必须复位 */
export function resetHost(): void {
  cached = null
}
