/**
 * 浏览器数据快照：把 chrome.tabs / chrome.bookmarks 的现状整理成桥接服务可缓存的形状。
 *
 * 只在上报时构建（不做常驻轮询），且由 tabs/bookmarks 变更事件驱动、300ms 去抖，
 * 避免频繁切换标签页时反复序列化整棵收藏夹树。
 */
import type { BookmarkNode, TabInfo } from '../bridge/protocol'

export interface Snapshot {
  tabs: TabInfo[]
  bookmarks: BookmarkNode[]
  at: number
}

export const emptySnapshot = (): Snapshot => ({ tabs: [], bookmarks: [], at: 0 })

/** 单次上报的体积上限：收藏夹条目数过多时截断，避免 WS 帧过大 */
const MAX_BOOKMARK_NODES = 400

async function groupTitles(windowIds: number[]): Promise<Map<number, string>> {
  const titles = new Map<number, string>()
  for (const windowId of windowIds) {
    try {
      for (const group of await chrome.tabGroups.query({ windowId })) {
        titles.set(group.id, group.title || '')
      }
    } catch (e) {
      console.warn('[intelligentSTUDIO] 读取标签页分组失败', windowId, e)
    }
  }
  return titles
}

export async function buildTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({})
  const windowIds = [...new Set(tabs.map((t) => t.windowId).filter((id): id is number => id !== undefined))]
  const titles = await groupTitles(windowIds)
  return tabs
    .filter((t) => t.id !== undefined)
    .map((t) => ({
      id: t.id as number,
      windowId: t.windowId ?? -1,
      index: t.index ?? 0,
      title: (t.title || '').slice(0, 300),
      url: t.url || '',
      active: !!t.active,
      pinned: !!t.pinned,
      audible: !!t.audible,
      groupId: t.groupId ?? -1,
      groupTitle: t.groupId !== undefined ? titles.get(t.groupId) || '' : '',
    }))
}

interface WalkState { count: number }

async function walkNodes(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  state: WalkState,
): Promise<BookmarkNode[]> {
  const out: BookmarkNode[] = []
  for (const node of nodes) {
    if (state.count >= MAX_BOOKMARK_NODES) break
    if (node.url) {
      out.push({ type: 'bookmark', id: node.id, title: node.title || '', url: node.url })
      state.count += 1
    } else {
      state.count += 1
      out.push({
        type: 'folder',
        id: node.id,
        title: node.title || '',
        children: await walkNodes(node.children ?? [], state),
      })
    }
  }
  return out
}

export async function buildBookmarks(): Promise<BookmarkNode[]> {
  const tree = await chrome.bookmarks.getTree()
  const state: WalkState = { count: 0 }
  return walkNodes(tree, state)
}

export async function buildSnapshot(): Promise<Snapshot> {
  const [tabs, bookmarks] = await Promise.all([buildTabs(), buildBookmarks()])
  return { tabs, bookmarks, at: Date.now() }
}
