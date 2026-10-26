/**
 * 浏览器整理动作的执行器（确定性，不依赖模型）。
 *
 * 桥接服务转发来的 action 与 Dony 工具 edge_browser 的语义一一对应：
 *   organize_tabs      按域名分组 + 关闭重复标签页
 *   organize_bookmarks 按域名收纳收藏夹 + 合并完全重复的网址
 *   delete_bookmarks   删除指定收藏项（按 id / 网址 / 标题匹配，先可 dryRun 预演）
 * 模型负责判断与汇报，实际写操作在这里完成；整理类动作**幂等**，重复执行不会持续产生新变化。
 */
import type { BridgeKind } from '../bridge/protocol'
import { selectBookmarkTargets } from './match'

const GROUP_COLORS = ['blue', 'cyan', 'purple', 'pink', 'green', 'orange', 'yellow', 'red', 'grey']

/** 只对真实站点做分组/收纳，跳过浏览器内部页与脚本地址 */
function safeHost(url?: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return ''
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function keepPriority(tab: chrome.tabs.Tab): number {
  // 数值越小越该保留：固定 > 当前 > 有声 > 靠前
  return (tab.pinned ? 0 : 10) + (tab.active ? 0 : 4) + (tab.audible ? 0 : 2) + ((tab.index ?? 99) % 2)
}

export async function organizeTabs(): Promise<string> {
  const tabs = await chrome.tabs.query({})
  const real = tabs.filter((t) => t.id !== undefined && safeHost(t.url))
  const byUrl = new Map<string, chrome.tabs.Tab[]>()
  for (const t of real) {
    const key = t.url as string
    const list = byUrl.get(key)
    if (list) list.push(t)
    else byUrl.set(key, [t])
  }

  // 1) 关闭重复标签页（同一网址只保留优先级最高的那一个）
  const toClose: number[] = []
  for (const list of byUrl.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => keepPriority(a) - keepPriority(b))
    for (const t of sorted.slice(1)) toClose.push(t.id as number)
  }
  if (toClose.length) await chrome.tabs.remove(toClose)

  // 2) 按域名分组：只处理「还没进任何分组」的标签页，且同域名至少两个，避免制造一堆单标签分组
  let created = 0
  let grouped = 0
  const alive = (await chrome.tabs.query({})).filter(
    (t) => t.id !== undefined && !t.pinned && t.groupId === chrome.tabs.TAB_GROUP_ID_NONE && safeHost(t.url),
  )
  const byHost = new Map<string, chrome.tabs.Tab[]>()
  for (const t of alive) {
    const host = safeHost(t.url)
    const list = byHost.get(host)
    if (list) list.push(t)
    else byHost.set(host, [t])
  }
  const multi = [...byHost.entries()].filter(([, list]) => list.length >= 2)
  multi.sort((a, b) => b[1].length - a[1].length)
  for (const [host, list] of multi) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: list.map((t) => t.id as number) })
      await chrome.tabGroups.update(groupId, {
        title: host,
        color: GROUP_COLORS[created % GROUP_COLORS.length],
        collapsed: false,
      })
      created += 1
      grouped += list.length
    } catch (e) {
      console.warn('[intelligentSTUDIO] 建立标签页分组失败', host, e)
    }
  }

  const parts = [`关闭了 ${toClose.length} 个重复标签页`]
  parts.push(created ? `按域名建立了 ${created} 个分组（共收纳 ${grouped} 个标签页）` : '没有需要新建的分组')
  return parts.join('，') + '。'
}

interface BookmarkPlan {
  existingFolders: Map<string, string>   // 标题 → 文件夹 id
  hosts: Map<string, chrome.bookmarks.BookmarkTreeNode[]>
  duplicates: chrome.bookmarks.BookmarkTreeNode[]
}

function planForRoot(children: chrome.bookmarks.BookmarkTreeNode[]): BookmarkPlan {
  const existingFolders = new Map<string, string>()
  const hosts = new Map<string, chrome.bookmarks.BookmarkTreeNode[]>()
  const seen = new Map<string, string>()   // url → 首次出现的书签 id
  const duplicates: chrome.bookmarks.BookmarkTreeNode[] = []
  for (const node of children) {
    if (!node.url) {
      if (node.title) existingFolders.set(node.title.toLowerCase(), node.id)
      continue
    }
    if (seen.has(node.url)) duplicates.push(node)
    else seen.set(node.url, node.id)
    const host = safeHost(node.url)
    if (!host) continue
    const list = hosts.get(host)
    if (list) list.push(node)
    else hosts.set(host, [node])
  }
  return { existingFolders, hosts, duplicates }
}

export async function organizeBookmarks(): Promise<string> {
  const tree = await chrome.bookmarks.getTree()
  const roots = tree[0]?.children ?? []
  let removed = 0
  let createdFolders = 0
  let moved = 0

  for (const root of roots) {
    // 只整理两个根目录的**直接子项**：不动用户已有的深层结构
    const plan = planForRoot(root.children ?? [])
    for (const dup of plan.duplicates) {
      try {
        await chrome.bookmarks.remove(dup.id)
        removed += 1
      } catch (e) {
        console.warn('[intelligentSTUDIO] 合并重复书签失败', dup.title, e)
      }
    }
    for (const [host, list] of plan.hosts) {
      const loose = list.filter((n) => !plan.duplicates.includes(n))
      if (loose.length === 0) continue
      let folderId = plan.existingFolders.get(host)
      // 单条且没有对应文件夹时不建文件夹（否则收藏夹会被切成一行行单条目录）
      if (!folderId && loose.length < 2) continue
      if (!folderId) {
        try {
          const folder = await chrome.bookmarks.create({ parentId: root.id, title: host })
          folderId = folder.id
          plan.existingFolders.set(host, folderId)
          createdFolders += 1
        } catch (e) {
          console.warn('[intelligentSTUDIO] 新建收藏夹目录失败', host, e)
          continue
        }
      }
      for (const node of loose) {
        try {
          await chrome.bookmarks.move(node.id, { parentId: folderId })
          moved += 1
        } catch (e) {
          console.warn('[intelligentSTUDIO] 收纳书签失败', node.title, e)
        }
      }
    }
  }

  return `收纳了 ${moved} 条书签到 ${createdFolders} 个新建的域名文件夹，合并了 ${removed} 条重复书签。`
}

// ---------------------------------------------------------------- 删除收藏项

/** 单次调用的删除上限：模型误判时也不至于把整个收藏夹清空 */
const MAX_DELETE = 200

interface WalkedBookmark {
  node: chrome.bookmarks.BookmarkTreeNode
  path: string
}

/** 展开整棵收藏夹树（含两个根目录的深层结构），只取真正的书签项 */
function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]): WalkedBookmark[] {
  const out: WalkedBookmark[] = []
  for (const node of nodes) {
    if (node.url) {
      out.push({ node, path: path.join('/') || '收藏夹' })
    } else {
      out.push(...flattenBookmarks(node.children ?? [], [...path, node.title || '未命名']))
    }
  }
  return out
}

/**
 * 删除指定收藏项（按 id / 网址 / 标题匹配，三者取并集）。
 *
 * 设计要点：
 *  1. 只删书签项，不删文件夹 —— 模型能删的是「收藏夹里的条目」，避免误删整棵目录；
 *  2. dryRun 只回匹配结果 —— Dony 工具据此先让用户确认，再真正下发删除；
 *  3. 匹配不到时明确列出没匹配上的目标，模型可据此改为先读取再重试。
 */
export async function deleteBookmarks(targets: {
  ids?: string[]
  urls?: string[]
  titles?: string[]
  dryRun?: boolean
}): Promise<string> {
  const hasTarget = Boolean(
    (targets.ids ?? []).length || (targets.urls ?? []).length || (targets.titles ?? []).length,
  )
  if (!hasTarget) {
    return '没有给出要删除的目标：需要提供 ids、urls 或 titles 之一（可先读取收藏夹拿到 id）。'
  }

  const tree = await chrome.bookmarks.getTree()
  const all = flattenBookmarks(tree, [])
  const { matched, fuzzy } = selectBookmarkTargets(
    all.map((item) => ({
      id: item.node.id,
      title: item.node.title || '',
      url: item.node.url || '',
      path: item.path,
    })),
    targets,
  )

  if (!matched.length) {
    return `没有匹配到任何收藏项（收藏夹共 ${all.length} 条）。请先读取收藏夹，用列表里的 [id=…] 或完整网址作为目标。`
  }
  if (matched.length > MAX_DELETE) {
    return `匹配到 ${matched.length} 条，超过单次上限 ${MAX_DELETE} 条：请缩小范围后分批删除。`
  }
  if (targets.dryRun) {
    const head = matched.slice(0, 20).map((item, i) => `${i + 1}. ${item.path}/${item.title || '(无标题)'} — ${item.url}`).join('\n')
    const more = matched.length > 20 ? `\n……（其余 ${matched.length - 20} 条已省略）` : ''
    const how = fuzzy ? '（按关键字近似匹配，请核对）' : ''
    return `将删除 ${matched.length} 条收藏项${how}：\n${head}${more}`
  }

  const removed: string[] = []
  const failed: string[] = []
  for (const item of matched) {
    try {
      await chrome.bookmarks.remove(item.id)
      removed.push(item.title || item.url || item.id)
    } catch (e) {
      console.warn('[intelligentSTUDIO] 删除收藏项失败', item.id, e)
      failed.push(item.title || item.url || item.id)
    }
  }
  const head = removed.slice(0, 12).join('、')
  const more = removed.length > 12 ? ` 等 ${removed.length} 条` : ''
  let detail = `已删除 ${removed.length} 条收藏项：${head}${more}。`
  if (failed.length) detail += `另有 ${failed.length} 条删除失败：${failed.slice(0, 5).join('、')}。`
  return detail
}

export async function runOrganize(kind: BridgeKind, payload?: { closeDuplicateTabs?: boolean; groupByDomain?: boolean }): Promise<string> {
  if (kind === 'tabs') {
    const detail = await organizeTabs()
    return payload && payload.groupByDomain === false
      ? detail.replace(/，按域名建立了[\s\S]*$/, '。')
      : detail
  }
  return organizeBookmarks()
}
