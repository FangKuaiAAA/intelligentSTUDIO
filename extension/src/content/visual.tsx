/**
 * 页面内视觉智能覆盖层（内容脚本，单文件 IIFE）。
 *
 * 两种模式，由 background 在注入后立刻下发：
 *  · 框选（默认）：复用主项目的 VisualOverlay —— 暗化、框选、五个选项胶囊、彩虹输入框、
 *    加载光边、回答框与两类卡片，与全局 Alt+V 完全一致；
 *  · 整页：用扩展自有的 PageOverlay —— 整页截图交给模型分点归纳（组件类名与框选一致）。
 *
 * 样式全部注入 shadow root：既不污染宿主页面，也不被页面样式影响。
 */
import { createRoot, type Root } from 'react-dom/client'
import { VisualOverlay } from '@dony/components/overlay/VisualOverlay'
import overlayCss from '@dony/components/overlay/VisualOverlay.css?inline'
import { PageBridge } from './bridgePort'
import { PageOverlay } from './PageOverlay'
import { installElectronShim } from '../adapter/electronShim'

const HOST_ID = 'intelligentstudio-visual-host'
const MOUNT_FLAG = '__intelligentStudioVisualMounted'
/** 等模式消息的上限：background 注入后立刻下发，正常都在几毫秒内到达 */
const MODE_WAIT_MS = 220

type Mode = 'box' | 'page'

/** shadow root 的基础样式：宿主自成一个覆盖整屏的层，与页面样式彻底隔离 */
const BASE_CSS = `
:host {
  all: initial;
  position: fixed !important;
  inset: 0 !important;
  display: block !important;
  width: 100vw !important;
  height: 100vh !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  z-index: 2147483646 !important;
  pointer-events: auto !important;
  color-scheme: light dark;
}
.visual-overlay {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
/* 整页模式（PageOverlay）里没有"彩虹输入框"这一层：整条彩虹去掉，只留白色磨砂面。
   这条规则属于扩展自有样式，改的是扩展自己的覆盖层，不动视觉智能原组件。 */
.visual-request-pill.is-plain::before,
.visual-request-pill.is-plain::after { content: none !important; }
`

interface MountFlag {
  [MOUNT_FLAG]?: boolean
}

interface StartMessage {
  type?: string
  mode?: string
}

function mount(): void {
  const flags = window as unknown as MountFlag
  if (flags[MOUNT_FLAG] || document.getElementById(HOST_ID)) return
  flags[MOUNT_FLAG] = true

  const host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `${BASE_CSS}\n${overlayCss}`
  shadow.appendChild(style)

  const container = document.createElement('div')
  container.setAttribute('data-dony-visual-root', '')
  container.style.cssText = 'position:fixed;inset:0;'
  shadow.appendChild(container)

  document.documentElement.appendChild(host)

  const bridge = new PageBridge()
  let root: Root | null = null
  let disposeShim: (() => void) | null = null
  let closed = false
  let pending: ((mode: Mode) => void) | null = null

  const close = () => {
    if (closed) return
    closed = true
    pending = null
    try {
      chrome.runtime.onMessage.removeListener(onMessage)
    } catch {
      /* 已移除 */
    }
    try {
      bridge.cancel()
    } catch {
      /* 忽略 */
    }
    disposeShim?.()
    bridge.close()
    const current = root
    // 先卸载 React 再摘节点：避免在已移除的树上触发更新
    current?.unmount()
    root = null
    host.remove()
    delete (window as unknown as MountFlag)[MOUNT_FLAG]
  }

  const render = (mode: Mode) => {
    if (closed) return
    root?.unmount()
    root = createRoot(container)
    if (mode === 'page') {
      // 整页模式不用 Electron 适配层（它只为复用的 VisualOverlay 服务）
      disposeShim?.()
      disposeShim = null
      root.render(<PageOverlay bridge={bridge} onClose={close} />)
      return
    }
    if (!disposeShim) disposeShim = installElectronShim({ bridge, closeOverlay: close })
    root.render(<VisualOverlay onClose={close} />)
  }

  function onMessage(message: StartMessage): void {
    if (!message || message.type !== 'visual/start') return
    const mode: Mode = message.mode === 'page' ? 'page' : 'box'
    if (pending) {
      const resolve = pending
      pending = null
      resolve(mode)
      return
    }
    render(mode)
  }

  try {
    chrome.runtime.onMessage.addListener(onMessage)
  } catch {
    /* 无法监听时按默认模式 */
  }

  // 以「等模式消息」取代"先按框选渲染再切换"：后者会闪一下框选界面
  const mode = new Promise<Mode>((resolve) => {
    pending = resolve
    setTimeout(() => {
      if (pending) {
        pending = null
        resolve('box')
      }
    }, MODE_WAIT_MS)
  })
  void mode.then((value) => render(value))
  bridge.log('视觉智能覆盖层已挂载')
}

mount()
