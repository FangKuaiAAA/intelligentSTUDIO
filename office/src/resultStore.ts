/**
 * 「复原」按钮的状态源。
 *
 * 为什么不用内存：这台 Office 2021 不支持共享运行时，功能区（FunctionFile）与任务窗格
 * 是**两个 JS 运行时**，各自的模块单例互不可见。若把"刚改了哪段、原文是什么"放在
 * 内存里，功能区点复原必然读到空状态 —— 表现就是"按了没反应"。
 *
 * 解决：把记录写进同源 localStorage（两个运行时共享同一份 origin 存储），
 * 且**只存句柄与原文**，复原时按句柄定位，不去搜索文本内容 —— 文档里同样的句子
 * 出现多次也不会认错。
 *
 * ⚠ localStorage 按 origin 存，不跟着文档走：换一台电脑或清过浏览器数据后，
 *   旧记录的句柄会失效；复原时会因找不到锚点而静默失败，这是可接受的降级。
 */

import { getHost } from './host'
import { idsFor } from './ribbonIds'

export type ResultStatus = 'idle' | 'preview' | 'applied'

export interface ResultState {
  status: ResultStatus
  /** 动作键：proofread / rewrite / … */
  action?: string
  /** 动作中文名，用于结果卡标题 */
  label?: string
  /** 模型给的一句话改动说明 */
  note?: string
  /** 宿主定位句柄（Word 内容控件 tag / Excel 地址 / PPT 形状 id） */
  handle?: string
  original?: string
  next?: string
}

const KEY = 'studio:last-edit'
const EMPTY: ResultState = { status: 'idle' }
const listeners = new Set<(s: ResultState) => void>()

function read(): ResultState {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as ResultState
    return parsed && typeof parsed === 'object' ? parsed : EMPTY
  } catch (e) {
    console.error('[studio] 读取上次改动失败', e)
    return EMPTY
  }
}

function write(state: ResultState): void {
  try {
    if (state.status === 'idle') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(state))
  } catch (e) {
    console.error('[studio] 保存上次改动失败', e)
  }
}

/** 每次都从存储读：另一个运行时可能刚写过 */
export function getResult(): ResultState {
  return read()
}

// 另一个运行时改动时同步通知本页（storage 事件只会在同一 origin 的其它上下文里触发）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== KEY) return
    const next = read()
    listeners.forEach((fn) => fn(next))
  })
}

export function setResult(next: ResultState): void {
  write(next)
  listeners.forEach((fn) => fn(next))
  refreshRibbon()
}

export function patchResult(patch: Partial<ResultState>): void {
  setResult({ ...read(), ...patch })
}

export function resetResult(): void {
  setResult(EMPTY)
}

export function subscribeResult(fn: (s: ResultState) => void): () => void {
  listeners.add(fn)
  fn(read())
  return () => listeners.delete(fn)
}

/** 把复原按钮的可点状态推给功能区；RibbonApi 不可用时静默跳过 */
export function refreshRibbon(): void {
  const supported =
    typeof Office !== 'undefined' &&
    Office.context?.requirements?.isSetSupported?.('RibbonApi', '1.1')
  if (!supported) return

  const ids = idsFor(getHost().host)
  const data: Office.RibbonUpdaterData = {
    tabs: [
      {
        id: ids.tab,
        groups: [
          {
            id: ids.groupResult,
            // 结果组只剩「复原」：待定时取消本次，已写入时写回原文
            controls: [{ id: ids.restore, enabled: true }],
          },
        ],
      },
    ],
  }

  console.info('[studio] ribbon 刷新', read().status)
  Office.ribbon.requestUpdate(data)
}
