/**
 * 扩展后台（MV3 service worker）：所有网络与浏览器写操作都在这里。
 *
 * 职责：
 *  1. 与桥接服务（127.0.0.1:8768）保持 WS 连接，上报标签页/收藏夹快照；
 *  2. 执行桥接服务下发的指令（读取/整理），并回执结果 —— 使 Dony 的 edge_browser 工具可用；
 *  3. 给浮窗（popup）与页面内视觉覆盖层（content）当唯一出口：
 *     · popup：状态查询、整理流式中继、注入视觉覆盖层
 *     · content：截屏、视觉问答流式中继
 */
import {
  DEFAULT_BRIDGE_BASE, BridgeSocket, bridgeFetch, bridgeStream, getBridgeBase, setBridgeBase,
} from '../bridge/client'
import { buildSnapshot, emptySnapshot, type Snapshot } from './snapshot'
import { deleteBookmarks, runOrganize } from './organize'
import type {
  BridgeStatus, ExtEvent, ExtRequest, BookmarkNode, TabInfo, VisualMode,
} from '../bridge/protocol'

let snapshot: Snapshot = emptySnapshot()
let snapshotTimer: number | null = null
// ⚠ 两个"进行中"必须分开：
//   sessionActive —— 浮窗发起的一轮整理会话语义（防止浮窗重复发起）；
//   writeRunning  —— 真正在写浏览器（防止并发写操作互相踩）。
// 合用一个变量会死锁：Agent 执行整理时正要下发写入指令，却被浮窗会话的标记挡下。
let sessionActive = false
let writeRunning = false
let socketConnected = false
let socketMessage = ''
let badgeShown = false

const popupPorts = new Set<chrome.runtime.Port>()
const contentPorts = new Set<chrome.runtime.Port>()

// ---------------------------------------------------------------- 快照上报

async function refreshAndPush(): Promise<void> {
  try {
    snapshot = await buildSnapshot()
  } catch (e) {
    console.warn('[intelligentSTUDIO] 构建快照失败', e)
    return
  }
  if (socket.connected) {
    socket.send({ type: 'snapshot', tabs: snapshot.tabs, bookmarks: snapshot.bookmarks })
  }
}

/** 变更事件 300ms 去抖：连续操作只上报一次 */
function scheduleSnapshot(): void {
  if (snapshotTimer !== null) return
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    void refreshAndPush()
  }, 300) as unknown as number
}

for (const evt of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved,
  chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onUpdated]) {
  evt.addListener(() => scheduleSnapshot())
}
for (const evt of [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged, chrome.bookmarks.onMoved]) {
  evt.addListener(() => scheduleSnapshot())
}

// ---------------------------------------------------------------- 状态

function setBadge(connected: boolean): void {
  if (connected === badgeShown) return
  badgeShown = connected
  void chrome.action.setBadgeText({ text: connected ? '' : '!' })
  if (!connected) void chrome.action.setBadgeBackgroundColor({ color: '#FF453A' })
}

function localStatus(message = '', base = ''): BridgeStatus {
  return {
    ok: false, paired: socketConnected, reachable: false, version: '',
    bridgeBase: base || memBridgeBase || DEFAULT_BRIDGE_BASE, browser: '',
    tabs: snapshot.tabs.length, bookmarks: countBookmarks(snapshot.bookmarks),
    agentBusy: sessionActive || writeRunning, agentPort: 8767, visionModel: '', snapshotAgeMs: -1,
    message: message || (socketConnected ? '' : socketMessage || '未连接本地服务'),
  }
}

/** 最近一次读到的桥接服务地址：状态展示用，避免每次都去读 storage */
let memBridgeBase = ''

/** 网络类异常统一给一句能指导动作的提示（fetch 失败只会是 TypeError） */
function friendlyError(e: unknown): string {
  if (e instanceof TypeError) {
    return '未连接本地服务 · 请启动 intelligentSTUDIO'
  }
  return e instanceof Error ? e.message : String(e)
}

function countBookmarks(nodes: BookmarkNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.type === 'bookmark') n += 1
    else n += countBookmarks(node.children ?? [])
  }
  return n
}

async function currentStatus(): Promise<BridgeStatus> {
  const base = await getBridgeBase()
  memBridgeBase = base
  try {
    const resp = await bridgeFetch('/ext/status')
    if (!resp.ok) return localStatus(`桥接服务返回 HTTP ${resp.status}`, base)
    const data = await resp.json() as Record<string, any>
    return {
      ok: true,
      paired: socketConnected,
      reachable: true,
      version: String(data.version || ''),
      bridgeBase: base,
      browser: String(data.browser || ''),
      tabs: Number(data.tabs || 0),
      bookmarks: Number(data.bookmarks || 0),
      agentBusy: !!data.agent_busy || sessionActive || writeRunning,
      agentPort: Number(data.agent_port || 8767),
      visionModel: String(data.vision_model || ''),
      snapshotAgeMs: Number(data.snapshot_age_ms ?? -1),
      message: socketConnected ? '' : socketMessage,
    }
  } catch {
    // fetch 抛错基本都是「服务没起」：给一句能指导用户动作的话，而不是 Failed to fetch
    return localStatus('未连接本地服务 · 请启动 intelligentSTUDIO', base)
  }
}

function broadcast(event: ExtEvent): void {
  for (const port of [...popupPorts, ...contentPorts]) {
    try {
      port.postMessage(event)
    } catch {
      /* 端口已断开 */
    }
  }
}

async function sendStatus(port: chrome.runtime.Port): Promise<void> {
  port.postMessage({ kind: 'status', status: await currentStatus() } satisfies ExtEvent)
}

// ---------------------------------------------------------------- 桥接服务指令

async function handleCommand(cmd: any): Promise<void> {
  const id = String(cmd?.id || '')
  const action = String(cmd?.action || '')
  try {
    if (action === 'tabs' || action === 'bookmarks') {
      await refreshAndPush()
      const count = action === 'tabs' ? snapshot.tabs.length : countBookmarks(snapshot.bookmarks)
      socket.send({ type: 'command-result', id, ok: true, detail: `已刷新${action === 'tabs' ? '标签页' : '收藏夹'}快照（${count} 项）` })
      return
    }
    if (action === 'organize_tabs' || action === 'organize_bookmarks') {
      if (writeRunning) {
        socket.send({ type: 'command-result', id, ok: false, detail: '上一次写入还在进行中' })
        return
      }
      writeRunning = true
      try {
        const detail = await runOrganize(action === 'organize_tabs' ? 'tabs' : 'bookmarks', cmd?.payload)
        await refreshAndPush()
        console.log('[intelligentSTUDIO] 整理完成：', detail)
        socket.send({ type: 'command-result', id, ok: true, detail })
      } finally {
        writeRunning = false
      }
      return
    }
    if (action === 'delete_bookmarks') {
      if (writeRunning) {
        socket.send({ type: 'command-result', id, ok: false, detail: '上一次写入还在进行中' })
        return
      }
      const dryRun = !!cmd?.payload?.dryRun
      // 只做匹配的预演不需要占用写入闸门
      if (!dryRun) writeRunning = true
      try {
        const detail = await deleteBookmarks(cmd?.payload ?? {})
        if (!dryRun) await refreshAndPush()
        console.log(`[intelligentSTUDIO] ${dryRun ? '删除预演' : '删除收藏项'}：`, detail.slice(0, 120))
        // 匹配不到就当作失败返回：模型需要据此改为先读取收藏夹
        const ok = dryRun || !/^(没有给出|没有匹配到|匹配到 \d+ 条，超过)/.test(detail)
        socket.send({ type: 'command-result', id, ok, detail })
      } finally {
        if (!dryRun) writeRunning = false
      }
      return
    }
    socket.send({ type: 'command-result', id, ok: false, detail: `未知指令 ${action}` })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[intelligentSTUDIO] 指令执行失败', action, e)
    socket.send({ type: 'command-result', id, ok: false, detail: message })
  }
}

function createSocket(): BridgeSocket {
  return new BridgeSocket({
    onCommand: (cmd) => { void handleCommand(cmd) },
    onStateChange: (connected, message) => {
      socketConnected = connected
      socketMessage = message || ''
      setBadge(connected)
      if (connected) void refreshAndPush()
      void broadcast({ kind: 'status', status: localStatus() })
    },
  })
}

let socket = createSocket()
void socket.connect()

/** 状态面板的「重新连接」：丢弃旧连接重新握手（服务端重启/换 token 后靠它恢复） */
function reconnectSocket(): void {
  socket.dispose()
  socket = createSocket()
  void socket.connect()
}

// ---------------------------------------------------------------- 页面内视觉智能

async function startVisual(port: chrome.runtime.Port, mode: VisualMode): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    port.postMessage({ kind: 'error', message: '找不到当前标签页' } satisfies ExtEvent)
    return
  }
  if (/^(chrome|edge|about|devtools|extension):/i.test(tab.url || '')) {
    port.postMessage({
      kind: 'error',
      message: '内部页面不支持 · 请在普通网页上使用',
    } satisfies ExtEvent)
    return
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    // 注入后再下发模式：内容脚本以「等这条消息」决定挂框选还是整页，避免先闪一下框选
    await chrome.tabs.sendMessage(tab.id, { type: 'visual/start', mode })
    port.postMessage({ kind: 'ok', message: '视觉智能已启动' } satisfies ExtEvent)
    // 浮窗会随焦点转移自动关闭，这里不等结果
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    port.postMessage({
      kind: 'error',
      // 注入与 activeTab 授权绑在一起：用户开完浮窗又切过标签页时会落到这里
      message: /activeTab|all_urls|Cannot access|permission/i.test(detail)
        ? '当前页面未授权 · 请在目标网页重新点击图标'
        : '无法在此页面启动，请重试',
    } satisfies ExtEvent)
  }
}

// ---------------------------------------------------------------- 消息路由

let visionAbort: AbortController | null = null
let organizeAbort: AbortController | null = null

async function handlePopupRequest(port: chrome.runtime.Port, req: ExtRequest): Promise<void> {
  switch (req.kind) {
    case 'status':
      await sendStatus(port)
      return
    case 'visual/start':
      await startVisual(port, req.mode === 'page' ? 'page' : 'box')
      return
    case 'reconnect':
      reconnectSocket()
      port.postMessage({ kind: 'ok', message: '正在重新连接' } satisfies ExtEvent)
      return
    case 'bridge/base': {
      // 换桥接服务地址（默认 127.0.0.1:8768）：改完立刻重连，返回实际生效的地址
      const next = await setBridgeBase(String(req.base || ''))
      memBridgeBase = next
      reconnectSocket()
      port.postMessage({ kind: 'ok', message: `桥接服务地址已设为 ${next}` } satisfies ExtEvent)
      return
    }
    case 'snapshot/refresh':
      await refreshAndPush()
      port.postMessage({ kind: 'ok', message: '已刷新' } satisfies ExtEvent)
      return
    case 'organize': {
      if (sessionActive) {
        port.postMessage({ kind: 'error', message: '正在整理' } satisfies ExtEvent)
        return
      }
      sessionActive = true
      organizeAbort?.abort()
      organizeAbort = new AbortController()
      try {
        await refreshAndPush()
        await bridgeStream(
          '/ext/organize',
          { kind: req.target, request: req.request },
          (payload) => port.postMessage({ kind: 'organize-event', event: payload } satisfies ExtEvent),
          organizeAbort.signal,
        )
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          port.postMessage({
            kind: 'organize-event',
            event: { type: 'error', message: friendlyError(e) },
          } satisfies ExtEvent)
        }
      } finally {
        sessionActive = false
        organizeAbort = null
      }
      return
    }
    case 'organize/answer':
      await bridgeFetch('/ext/organize/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id, text: req.text, approved: req.approved }),
      }).catch((e) => console.warn('[intelligentSTUDIO] 回填答复失败', e))
      return
    case 'organize/cancel':
      organizeAbort?.abort()
      await bridgeFetch('/ext/organize/cancel', { method: 'POST' }).catch(() => undefined)
      return
    case 'log':
      console.log('[popup]', req.message)
      return
    default:
      return
  }
}

async function handleContentRequest(port: chrome.runtime.Port, req: ExtRequest): Promise<void> {
  switch (req.kind) {
    case 'capture': {
      // 页面内覆盖层铺满视口，截屏必须取「该标签页所在窗口的可见区域」
      const tabId = port.sender?.tab?.id
      try {
        const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : undefined
        let dataUrl = ''
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'png' })
        } catch (first) {
          // 整页拼接会连续截多屏，撞上「每秒 2 次」的配额是常态：等一拍重试一次
          const detail = first instanceof Error ? first.message : String(first)
          if (!/quota|MAX_CAPTURE/i.test(detail)) throw first
          await new Promise((resolve) => { setTimeout(resolve, 700) })
          dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'png' })
        }
        port.postMessage({ kind: 'capture', dataUrl } satisfies ExtEvent)
      } catch (e) {
        // 截图与注入需要同一份 activeTab 授权：用户在点开浮窗后又切过标签页时就会落到这里
        const detail = e instanceof Error ? e.message : String(e)
        port.postMessage({
          kind: 'error',
          message: /activeTab|all_urls/i.test(detail)
            ? '当前页面未授权 · 请在目标网页重新点击图标'
            : '截图失败 · 请重试',
        } satisfies ExtEvent)
      }
      return
    }
    case 'vision/ask': {
      visionAbort?.abort()
      visionAbort = new AbortController()
      try {
        await bridgeStream(
          '/vision/ask',
          { messages: req.messages },
          (payload) => {
            if (typeof payload?.delta === 'string') {
              port.postMessage({ kind: 'vision-delta', delta: payload.delta } satisfies ExtEvent)
            } else if (payload?.done) {
              port.postMessage({ kind: 'vision-done' } satisfies ExtEvent)
            } else if (payload?.error) {
              port.postMessage({ kind: 'vision-error', message: String(payload.error) } satisfies ExtEvent)
            }
          },
          visionAbort.signal,
        )
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          port.postMessage({ kind: 'vision-error', message: friendlyError(e) } satisfies ExtEvent)
        }
      } finally {
        visionAbort = null
      }
      return
    }
    case 'vision/cancel':
      visionAbort?.abort()
      return
    case 'log':
      console.log('[content]', req.message)
      return
    default:
      return
  }
}

chrome.runtime.onConnect.addListener((port) => {
  const isPopup = port.name === 'popup'
  const pool = isPopup ? popupPorts : contentPorts
  pool.add(port)
  port.onDisconnect.addListener(() => pool.delete(port))
  port.onMessage.addListener((message: ExtRequest) => {
    const request = message as ExtRequest
    const task = isPopup ? handlePopupRequest(port, request) : handleContentRequest(port, request)
    task.catch((e) => console.error('[intelligentSTUDIO] 处理消息失败', request?.kind, e))
  })
  if (isPopup) void sendStatus(port)
})

// ---------------------------------------------------------------- 保活与初始上报

// MV3 的 service worker 空闲约 30s 会被回收（WebSocket 消息不算活动）。
// 周期性调用一次扩展 API，让 WS 与快照缓存保持一致；重连由 BridgeSocket 自己负责。
setInterval(() => { void chrome.runtime.getPlatformInfo() }, 20000)

void refreshAndPush()
