/**
 * 功能区动作：在没有 UI 的运行时里执行（FunctionFile）。
 *
 * 三条纪律：
 *  1. 直改文档后立刻把结果写进 resultStore —— 这样功能区「复原」马上可用；
 *  2. 任何失败都必须唤起窗格说明原因（功能区没有 Toast，静默失败等于骗人）；
 *  3. 每次执行结束都要调用 event.completed()，否则按钮会一直处于"处理中"。
 */

import { buildPromptFromContext, cancelImage, generateImage, getToken, runWriting } from './api/client'
import { fetchRaw, placeholderSize, toInsertableBase64 } from './api/image'
import { placeholderBase64 } from './api/placeholder'
import { emit } from './bus'
import { getHost } from './host'
import { patchResult, resetResult, getResult } from './resultStore'
import { actionLabel } from './components/actions'

export type RibbonEvent = { completed?: () => void }

const showPane = (): void => {
  const addin = Office?.addin
  if (!addin?.showAsTaskpane) return
  addin.showAsTaskpane().catch((e) => console.error('[studio] 唤起窗格失败', e))
}

const fail = (message: string): void => {
  showPane()
  emit({ kind: 'notice', text: message, tone: 'error' })
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())

/** 选区为空时的统一提示：功能区无法弹窗，只能把窗格拉起来说一句 */
const needSelection = (): void => {
  showPane()
  emit({ kind: 'notice', text: '先选中文字。', tone: 'info' })
}

/** 功能区「改写选中文字」：读选区 → 模型 → 直接写回 → 自动选中改写结果 */
export async function quickAction(action: string, event?: RibbonEvent): Promise<void> {
  const host = getHost()
  try {
    const selection = await host.readSelection()
    if (selection.empty) {
      needSelection()
      return
    }

    const capability = host.supports(action)
    if (!capability.ok) {
      fail(capability.reason || '当前版本不支持')
      return
    }

    const result = await runWriting(action, selection.text)
    const handle = await host.replaceText(selection.handle, selection.text, result.text)

    patchResult({
      status: 'applied',
      action,
      label: result.label || actionLabel(action),
      note: result.note,
      handle,
      original: selection.text,
      next: result.text,
    })

    // 改写完成后自动选中新文字：用户可以立刻继续改，也让"刚改的是哪一段"一目了然
    await host.selectText(handle)
    emit({ kind: 'notice', text: '已改写，Ctrl+Z 可撤销', tone: 'success' })
  } catch (e) {
    console.error('[studio] 功能区动作失败', e)
    fail(e instanceof Error ? e.message : '改写失败')
  } finally {
    event?.completed?.()
  }
}

/** 功能区「复原」：待定时取消本次，已写入时把原文写回（按句柄定位，不依赖当前选区） */
export async function ribbonRestore(event?: RibbonEvent): Promise<void> {
  const host = getHost()
  try {
    const state = getResult()
    if (state.status === 'preview') {
      resetResult()
      showPane()
      emit({ kind: 'notice', text: '已取消。', tone: 'info' })
      return
    }
    if (state.status === 'applied' && state.handle) {
      await host.restoreText(state.handle, state.original || '')
      resetResult()
      emit({ kind: 'notice', text: '已复原为原文', tone: 'success' })
      return
    }
    showPane()
    emit({ kind: 'notice', text: '没有可复原的修改。', tone: 'info' })
  } catch (e) {
    console.error('[studio] 复原失败', e)
    fail(e instanceof Error ? e.message : '复原失败')
  } finally {
    event?.completed?.()
  }
}

/**
 * 功能区「智能插图」：光标处上下文 → 主模型写提示词 → 占位图 → 生图 → 原位替换。
 *
 * 两个关键决策：
 *  · 先插占位图再写提示词。模型写提示词要几秒，不先把落点占住，用户会以为没点动；
 *  · 每个任务有独立 jobId，占位图按 jobId 命名，文档里同时有多张也不会串。
 *    轮询占位图是否还在：用户把它删了，就取消后端任务，绝不把结果塞到别处。
 */
export async function insertIllustration(event?: RibbonEvent): Promise<void> {
  const host = getHost()
  let jobId = ''
  let handle = ''
  let poll = 0
  let cancelled = false
  let size = { width: 0, height: 0 }

  try {
    // 先插占位图：它不依赖任何模型或文本，是这条链路上唯一能"先给个回执"的动作。
    // 之前的顺序是先读上下文、为空就返回，于是"读不到上下文"表现为彻底没反应。
    jobId = newId()
    size = placeholderSize(420)
    handle = await host.insertPlaceholder(jobId, size.width, size.height)

    const context = await host.readContext()
    if (!context.trim()) {
      await host
        .replacePlaceholder(jobId, placeholderBase64(size.width, size.height, 'failed'), handle)
        .catch(() => undefined)
      fail('光标附近没有可参考的文字')
      return
    }

    const currentJob = jobId
    const currentHandle = handle
    poll = window.setInterval(() => {
      host
        .placeholderExists(currentJob, currentHandle)
        .then((alive) => {
          if (!alive && !cancelled) {
            cancelled = true
            window.clearInterval(poll)
            cancelImage(currentJob).catch(() => undefined)
            // 顺手清掉 Word 里可能残留的空内容控件外壳
            host.removePlaceholder(currentJob, currentHandle).catch(() => undefined)
            console.info('[studio] 占位图已删除，停止生成', currentJob)
          }
        })
        .catch(() => undefined)
    }, 2000)

    const { prompt } = await buildPromptFromContext(context, 'illustration', [])
    if (cancelled) return

    const result = await generateImage({ jobId: currentJob, prompt, style: 'illustration', size: 1024 })
    window.clearInterval(poll)
    if (cancelled) return
    if (!result.ok) throw new Error(result.error || '生成失败')

    const token = await getToken()
    const blob = await fetchRaw(currentJob, token)
    const { base64 } = await toInsertableBase64(blob)
    const replaced = await host.replacePlaceholder(currentJob, base64, currentHandle)
    if (!replaced) {
      emit({ kind: 'notice', text: '占位图已删除，未插入。', tone: 'info' })
      return
    }
    emit({ kind: 'notice', text: '已插入插图', tone: 'success' })
  } catch (e) {
    console.error('[studio] 智能插图失败', e)
    // 非共享运行时里功能区弹不出任何界面：把占位图换成失败态，
    // 让"失败了"这件事至少写在文档里；连占位图都没插上就退化为直接移除。
    if (jobId && handle && size.width) {
      await host
        .replacePlaceholder(jobId, placeholderBase64(size.width, size.height, 'failed'), handle)
        .catch(() => undefined)
    } else if (jobId && handle) {
      host.removePlaceholder(jobId, handle).catch(() => undefined)
    }
    fail(e instanceof Error ? e.message : '插图失败')
  } finally {
    if (poll) window.clearInterval(poll)
    event?.completed?.()
  }
}
