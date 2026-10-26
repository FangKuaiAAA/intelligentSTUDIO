/**
 * 扩展内部的契约定义（三处共用）：
 *   popup（浮窗） ↔ background（service worker） ↔ content（页面内视觉覆盖层）
 * 以及与本地桥接服务 backend/edge_bridge.py 的数据形状。
 *
 * ⚠ 所有网络请求都收口在 background：popup 与 content 只通过 Port 通信。
 * 这样 token、WS 注册、快照缓存都只有一个持有者，浮窗不接触任何密钥。
 */

export type BridgeKind = 'tabs' | 'bookmarks'

/** 视觉智能的两种入口：框选当前区域 / 归纳整页 */
export type VisualMode = 'box' | 'page'

export interface TabInfo {
  id: number
  windowId: number
  index: number
  title: string
  url: string
  active: boolean
  pinned: boolean
  audible: boolean
  groupId: number
  groupTitle: string
}

export interface BookmarkNode {
  type: 'folder' | 'bookmark'
  /** chrome.bookmarks 的节点 id：模型据此精确指定要删除的收藏项 */
  id?: string
  title: string
  url?: string
  children?: BookmarkNode[]
}

/** 删除指定收藏项的目标集合（三者取并集，任一命中即删除） */
export interface DeleteTargets {
  ids?: string[]
  urls?: string[]
  titles?: string[]
  /** 只做匹配、不真删（供 Dony 工具先向用户确认） */
  dryRun?: boolean
}

export interface BridgeStatus {
  ok: boolean
  /** 扩展自身与桥接服务的 WS 是否已注册成功 */
  paired: boolean
  /** 桥接服务是否可达（HTTP 探测） */
  reachable: boolean
  /** 桥接服务版本（拿不到时为空） */
  version: string
  /** 当前使用的桥接服务地址（默认 127.0.0.1:8768，可在 storage 里改） */
  bridgeBase: string
  browser: string
  tabs: number
  bookmarks: number
  agentBusy: boolean
  agentPort: number
  visionModel: string
  snapshotAgeMs: number
  message?: string
}

/** Dony Agent 的出站事件（桥接服务原样转发；浮窗按需渲染） */
export interface OrganizeEvent {
  type:
    | 'mode'
    | 'plan'
    | 'tool-start'
    | 'tool-end'
    | 'cards'
    | 'done'
    | 'error'
    | 'ask'
    | 'ask-resolved'
    | 'cancelled'
    | 'text-reset'
  mode?: 'fast' | 'task'
  steps?: string[]
  name?: string
  label?: string
  op?: string
  ok?: boolean
  cards?: OrganizeCard[]
  text?: string
  message?: string
  id?: string
  kind?: string
  elapsed_ms?: number
}

export interface OrganizeCard {
  kind?: string
  title?: string
  subtitle?: string
  icon?: string
  state?: boolean
  value?: string
  details?: { label: string; value: string }[]
}

/** popup / content → background */
export type ExtRequest =
  | { kind: 'status' }
  | { kind: 'organize'; target: BridgeKind; request: string }
  | { kind: 'organize/answer'; id: string; text?: string; approved?: boolean }
  | { kind: 'organize/cancel' }
  | { kind: 'visual/start'; mode: VisualMode }
  | { kind: 'reconnect' }
  | { kind: 'bridge/base'; base: string }
  | { kind: 'capture' }
  | { kind: 'vision/ask'; messages: unknown[] }
  | { kind: 'vision/cancel' }
  | { kind: 'snapshot/refresh' }
  | { kind: 'log'; message: string }

/** background → popup / content */
export type ExtEvent =
  | { kind: 'status'; status: BridgeStatus }
  | { kind: 'organize-event'; event: OrganizeEvent }
  | { kind: 'vision-delta'; delta: string }
  | { kind: 'vision-done' }
  | { kind: 'vision-error'; message: string }
  | { kind: 'capture'; dataUrl: string }
  | { kind: 'ok'; message?: string }
  | { kind: 'error'; message: string }

/** 桥接服务下发给扩展的指令 */
export interface BridgeCommand {
  type: 'command'
  id: string
  action: 'tabs' | 'bookmarks' | 'organize_tabs' | 'organize_bookmarks' | 'delete_bookmarks'
  payload?: {
    closeDuplicateTabs?: boolean
    groupByDomain?: boolean
    ids?: string[]
    urls?: string[]
    titles?: string[]
    dryRun?: boolean
  }
}

/** 扩展上报给桥接服务的消息 */
export type ExtToBridge =
  | { type: 'register'; token: string; browser: string; version: string }
  | { type: 'heartbeat' }
  | { type: 'snapshot'; tabs: TabInfo[]; bookmarks: BookmarkNode[] }
  | { type: 'command-result'; id: string; ok: boolean; detail: string }
  | { type: 'log'; message: string }
