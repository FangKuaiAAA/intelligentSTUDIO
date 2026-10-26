/**
 * 功能区标识的单一来源。
 *
 * 分两类，很容易混：
 *  - **FunctionName**（qrProofread / ribbonKeep …）：`Office.actions.associate` 用它绑定处理函数，
 *    全清单唯一、与宿主无关；
 *  - **控件 id**（BtnKeep_W / BtnKeep_X …）：只用于 `Office.ribbon.requestUpdate`，
 *    必须与清单里 `Control id` 逐字一致。三个宿主各写一份清单段，这里按宿主加后缀，
 *    避免"id 在清单内必须唯一"的约束被踩到。
 */

import type { HostName } from './host'

export const ACTION_RESTORE = 'ribbonRestore'
export const ACTION_ILLUSTRATION = 'insertIllustration'

/** 功能区「快速改写」菜单项 → 动作键（与后端 ACTIONS 对齐，去掉摘要/要点） */
export const QUICK_ACTIONS = [
  { fn: 'qrProofread', action: 'proofread', label: '校对' },
  { fn: 'qrRewrite', action: 'rewrite', label: '改写' },
  { fn: 'qrFriendly', action: 'friendly', label: '友好' },
  { fn: 'qrFormal', action: 'formal', label: '正式' },
  { fn: 'qrConcise', action: 'concise', label: '简洁' },
  { fn: 'qrList', action: 'list', label: '列表' },
  { fn: 'qrTable', action: 'table', label: '表格' },
] as const

export type QuickAction = (typeof QUICK_ACTIONS)[number]['action']

export interface RibbonIds {
  tab: string
  groupResult: string
  restore: string
}

export function idsFor(host: HostName): RibbonIds {
  const suffix = host === 'excel' ? 'X' : host === 'powerpoint' ? 'P' : 'W'
  return {
    tab: `TabIntelligentStudio_${suffix}`,
    groupResult: `GroupResult_${suffix}`,
    restore: `BtnRestore_${suffix}`,
  }
}
