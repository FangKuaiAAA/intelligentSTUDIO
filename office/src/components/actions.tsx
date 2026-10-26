import type { JSX } from 'react'
import {
  IconConcise,
  IconFormal,
  IconFriendly,
  IconList,
  IconProofread,
  IconRewrite,
  IconTable,
} from './icons'

export interface ActionDef {
  key: string
  label: string
  icon: JSX.Element
  /** 一句话说明，出现在结果卡标题行；也是按钮的 title */
  hint: string
}

/**
 * 七个动作：与后端 agent/writing.py 的 ACTIONS 同源，只少了「摘要」「要点」。
 * 顺序、文案与桌面端菜单一致，避免用户在两个入口看到不同的叫法。
 */
export const ACTIONS: ActionDef[] = [
  { key: 'proofread', label: '校对', icon: <IconProofread size={18} />, hint: '只改错别字、标点与语病' },
  { key: 'rewrite', label: '改写', icon: <IconRewrite size={18} />, hint: '更通顺、整洁、条理清楚' },
  { key: 'friendly', label: '友好', icon: <IconFriendly size={18} />, hint: '语气更亲切' },
  { key: 'formal', label: '正式', icon: <IconFormal size={18} />, hint: '书面、专业' },
  { key: 'concise', label: '简洁', icon: <IconConcise size={18} />, hint: '删冗词、留关键' },
  { key: 'list', label: '列表', icon: <IconList size={18} />, hint: '整理为有序列表' },
  { key: 'table', label: '表格', icon: <IconTable size={18} />, hint: '整理为表格' },
]

export const actionLabel = (key: string): string =>
  ACTIONS.find((a) => a.key === key)?.label ?? '改写'
