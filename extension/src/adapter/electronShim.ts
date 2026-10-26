/**
 * `window.electronAPI` 适配层 —— 让主项目的视觉智能组件在浏览器里原样跑起来。
 *
 * 视觉智能组件（src/components/overlay/VisualOverlay.tsx）对 Electron 的依赖只有 6 处：
 * captureScreen / sendChatRequest / onChatChunk / onChatEnd / onChatError / onVisualEscape。
 * 这里把它们映射成扩展能力，组件源码一行不改（这是硬约束）。
 *
 * 两个必要的"环境对齐"，都只作用于内容脚本所在的隔离世界，不影响宿主页面：
 *  1. `screen.availWidth/availHeight` → 视口尺寸：组件按全屏窗口坐标系算面板位置，
 *     在页面里坐标系是视口，不改的话选区靠下时选项胶囊会被算到视口之外。
 *  2. `new Audio('./Visual.mp3')` → 扩展内的提示音资源：相对路径在页面里会解析到站点域名下。
 */
import type { ElectronAPI } from '@dony/types'
import type { PageBridge, VisionEvent } from '../content/bridgePort'

export interface ShimOptions {
  bridge: PageBridge
  closeOverlay: () => void
}

const noop = () => undefined
const noSub = () => noop

/** 只影响隔离世界：让组件把"视口"当成它的全屏窗口 */
function patchScreen(restore: (() => void)[]): void {
  const real = window.screen
  if (!real) return
  try {
    const fake = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'availWidth' || prop === 'width') return window.innerWidth
        if (prop === 'availHeight' || prop === 'height') return window.innerHeight
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    Object.defineProperty(window, 'screen', { value: fake, configurable: true })
    restore.push(() => {
      try {
        Object.defineProperty(window, 'screen', { value: real, configurable: true })
      } catch {
        /* 还原失败不影响页面 */
      }
    })
  } catch (e) {
    console.warn('[intelligentSTUDIO] 无法对齐 screen 尺寸（面板定位可能略有偏差）', e)
  }
}

/** 把 './Visual.mp3' 指到扩展内的资源 */
function patchAudio(restore: (() => void)[]): void {
  const Native = window.Audio
  const url = chrome.runtime.getURL('Visual.mp3')
  const Shim = class {
    constructor(src?: string) {
      const target = typeof src === 'string' && /(^|\/)Visual\.mp3$/i.test(src) ? url : src
      return new Native(target) as HTMLAudioElement
    }
  } as unknown as typeof Audio
  try {
    window.Audio = Shim
    restore.push(() => { window.Audio = Native })
  } catch (e) {
    console.warn('[intelligentSTUDIO] 提示音资源映射失败', e)
  }
}

/** 截屏归一化：captureVisibleTab 返回的是 DPR 放大后的整块可见区域，
 *  而视觉智能的裁剪按 CSS 像素计算 —— 必须重绘到「视口 CSS 尺寸」的画布上。 */
async function normalizedCapture(bridge: PageBridge): Promise<string> {
  const raw = await bridge.capture()
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('截图解码失败'))
    img.src = raw
  })
  const width = Math.max(1, Math.round(window.innerWidth))
  const height = Math.max(1, Math.round(window.innerHeight))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

export function installElectronShim({ bridge, closeOverlay }: ShimOptions): () => void {
  const restore: (() => void)[] = []
  patchScreen(restore)
  patchAudio(restore)

  const chunkListeners = new Set<(data: string) => void>()
  const endListeners = new Set<() => void>()
  const errorListeners = new Set<(message: string) => void>()
  const escapeListeners = new Set<() => void>()

  const offVision = bridge.onVision((ev: VisionEvent) => {
    if (ev.kind === 'delta' && ev.delta) {
      // 组件按 OpenAI 分片格式解析，这里把桥接的 {delta} 还原成它期望的形状
      const payload = JSON.stringify({ choices: [{ delta: { content: ev.delta } }] })
      for (const cb of chunkListeners) cb(payload)
    } else if (ev.kind === 'done') {
      for (const cb of endListeners) cb()
    } else if (ev.kind === 'error') {
      for (const cb of errorListeners) cb(ev.message || '视觉请求失败')
    }
  })

  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    for (const cb of escapeListeners) cb()
  }
  // 捕获阶段监听：即使页面在冒泡阶段吞掉按键，视觉智能的 Esc 退出仍然有效
  window.addEventListener('keydown', onEscape, true)

  const api: ElectronAPI = {
    // ---- 组件真正用到的那 6 项 ----
    captureScreen: () => normalizedCapture(bridge),
    captureDesktop: () => normalizedCapture(bridge),
    sendChatRequest: (body) => bridge.ask(body.messages),
    onChatChunk: (cb) => {
      chunkListeners.add(cb)
      return () => chunkListeners.delete(cb)
    },
    onChatEnd: (cb) => {
      endListeners.add(cb)
      return () => endListeners.delete(cb)
    },
    onChatError: (cb) => {
      errorListeners.add(cb)
      return () => errorListeners.delete(cb)
    },
    onVisualEscape: (cb) => {
      escapeListeners.add(cb)
      return () => escapeListeners.delete(cb)
    },

    // ---- 浏览器里没有对应物、但组件会调用的项 ----
    openExternal: (url) => {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener')
    },
    fetchLinkPreview: async () => null,   // 跨站抓取受 CORS 限制，链接卡片退化为无主图
    getSystemTheme: async () => '',
    hideOverlay: () => closeOverlay(),
    log: (msg) => bridge.log(msg),

    // ---- 原生窗口专有：无害化 ----
    setVisualWindowMode: noop,
    setVisualWindowRect: noop,
    setVisualMousePassthrough: noop,
    releaseMouse: noop,
    cancelHold: noop,
    cancelVoiceHold: noop,
    warmupDone: noop,
    notifyState: noop,
    setContentVisible: noop,
    notifyHover: noop,
    quitApp: noop,
    logMain: noop,
    getSuggestions: async () => [],
    onWake: noSub,
    onVoiceWake: noSub,
    onVoiceContinue: noSub,
    onVoiceHold: noSub,
    onWakeHold: noSub,
    onReset: noSub,
    onBlurDismiss: noSub,
    onVisualWake: noSub,
    onWarmup: noSub,
  }

  const previous = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
  ;(window as unknown as { electronAPI: ElectronAPI }).electronAPI = api

  return () => {
    window.removeEventListener('keydown', onEscape, true)
    offVision()
    if (previous) (window as unknown as { electronAPI?: ElectronAPI }).electronAPI = previous
    else delete (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
    for (const fn of restore) fn()
  }
}
