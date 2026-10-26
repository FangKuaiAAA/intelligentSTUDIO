import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/layout.css'
import './styles/controls.css'
import { QUICK_ACTIONS, ACTION_ILLUSTRATION, ACTION_RESTORE } from './ribbonIds'
import { insertIllustration, quickAction, ribbonRestore } from './quickActions'
import type { RibbonEvent } from './quickActions'
import { resetHost } from './host'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

const root = createRoot(container)

/** 功能区动作注册：必须与清单里的 FunctionName / 控件 id 逐字一致 */
function registerRibbon(): void {
  // 老版本宿主没有 Office.actions（加载项命令 1.1 之前），此时窗格仍可用，只是功能区不响应
  if (!Office.actions?.associate) {
    console.warn('[studio] 当前 Office 不支持加载项命令，跳过功能区注册')
    return
  }

  for (const item of QUICK_ACTIONS) {
    Office.actions.associate(item.fn, (event: unknown) => {
      void quickAction(item.action, event as RibbonEvent)
    })
  }

  Office.actions.associate(ACTION_RESTORE, (event: unknown) => {
    void ribbonRestore(event as RibbonEvent)
  })
  Office.actions.associate(ACTION_ILLUSTRATION, (event: unknown) => {
    void insertIllustration(event as RibbonEvent)
  })
}

let rendered = false
const boot = (): void => {
  if (rendered) return
  rendered = true
  root.render(<App />)
}

const fatal = (text: string): void => {
  const bar = document.createElement('div')
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:8px 10px;' +
    'font:11.5px/1.5 "Segoe UI",system-ui,sans-serif;color:#fff;background:#c92a1f;' +
    'white-space:pre-wrap;word-break:break-word'
  bar.textContent = text
  document.body.appendChild(bar)
}

/** 出错时不能让窗格留白：Office 里没有控制台，错误必须画在界面上 */
window.addEventListener('error', (event) => {
  console.error('[studio] 未捕获错误', event.error || event.message)
  fatal(`运行错误：${event.message}`)
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[studio] 未处理的 Promise 拒绝', event.reason)
  fatal(`运行错误：${String(event.reason)}`)
})

// 先渲染：窗格必须在 Office 握手完成前就有内容，否则握手慢或失败时会是一片空白
boot()

if (typeof Office === 'undefined' || !Office.onReady) {
  fatal('Office.js 未加载：请确认网络可用，或重新打开任务窗格。')
} else {
  Office.onReady(() => {
    registerRibbon()
    // 握手后宿主才可知：复位适配器缓存并重挂一次，让宿主徽标与能力判断取到真值
    resetHost()
    rendered = false
    boot()
  }).catch((e: unknown) => {
    console.error('[studio] Office.onReady 失败', e)
    fatal('与 Office 的握手没有完成：请关闭窗格后重新打开。')
  })
}
