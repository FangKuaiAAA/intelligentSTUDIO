const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onWake: (callback) => {
    ipcRenderer.on('wake', () => callback()); return () => ipcRenderer.removeAllListeners('wake')
  },
  onVoiceWake: (callback) => {
    ipcRenderer.on('voice-wake', () => callback()); return () => ipcRenderer.removeAllListeners('voice-wake')
  },
  onVoiceHold: (callback) => {
    ipcRenderer.on('voice-hold', () => callback()); return () => ipcRenderer.removeAllListeners('voice-hold')
  },
  /** Alt+D 在"界面已醒着、停在追问态"时的转发：语义 = 按下「继续对话」按钮 */
  onVoiceContinue: (callback) => {
    ipcRenderer.on('voice-continue', () => callback()); return () => ipcRenderer.removeAllListeners('voice-continue')
  },
  onWakeHold: (callback) => {
    ipcRenderer.on('wake-hold', () => callback()); return () => ipcRenderer.removeAllListeners('wake-hold')
  },
  onReset: (callback) => {
    ipcRenderer.on('reset', () => callback()); return () => ipcRenderer.removeAllListeners('reset')
  },
  onBlurDismiss: (callback) => {
    ipcRenderer.on('blur-dismiss', () => callback()); return () => ipcRenderer.removeAllListeners('blur-dismiss')
  },
  onVisualWake: (callback) => {
    ipcRenderer.on('visual-wake', () => callback()); return () => ipcRenderer.removeAllListeners('visual-wake')
  },
  // 视觉智能期间主进程全局捕获的 Esc：窗口未聚焦（不抢焦点 / 放行鼠标时会取消可聚焦）
  // 时网页收不到按键，由主进程转发过来，与直接按 Esc 同一条退出路径。
  onVisualEscape: (callback) => {
    ipcRenderer.on('visual-escape', () => callback()); return () => ipcRenderer.removeAllListeners('visual-escape')
  },
  // 启动彩排：主进程让渲染进程"真跑一遍光斑+光边"（窗口真显示、整窗近乎透明）
  onWarmup: (callback) => {
    ipcRenderer.on('warmup', () => callback()); return () => ipcRenderer.removeAllListeners('warmup')
  },
  /** 彩排跑完（或渲染进程兜底超时）后回报主进程：可以收窗、恢复唤醒入口了 */
  warmupDone: () => ipcRenderer.send('warmup-done'),
  // 输入建议库（主进程读桌面上的「可以问Dony的问题.txt」并解析；见 main.js）
  getSuggestions: () => ipcRenderer.invoke('suggestions'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  // 亚克力底衬专用：优先返回桌面壁纸（纯桌面、不含任何窗口），拿不到才回退实时截屏。
  // 与 captureScreen 分开：那个必须是真的屏幕画面（视觉智能要用）。
  captureDesktop: () => ipcRenderer.invoke('capture-desktop'),
  // 系统外观（Windows 模式）的深浅：'' 表示读不到，渲染进程自行回退
  getSystemTheme: () => ipcRenderer.invoke('system-theme'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  notifyState: (state) => ipcRenderer.send('overlay-state', state),
  setContentVisible: (visible) => ipcRenderer.send('overlay-content-visible', visible),
  cancelHold: () => ipcRenderer.send('cancel-hold'),
  cancelVoiceHold: () => ipcRenderer.send('cancel-voice-hold'),
  releaseMouse: () => ipcRenderer.send('release-mouse'),
  setVisualWindowMode: (collapsed) => ipcRenderer.send('visual-window-mode', collapsed),
  setVisualWindowRect: (rect) => ipcRenderer.send('visual-window-rect', rect),
  setVisualMousePassthrough: (passthrough) => ipcRenderer.send('visual-mouse-passthrough', passthrough),
  // 书写辅助：进入/退出模式、输入框临时取键盘焦点、主屏换算信息（物理像素 → DIP）
  setWritingActive: (active) => ipcRenderer.send('writing-active', active),
  setWritingFocus: (focusable) => ipcRenderer.send('writing-focus', focusable),
  // 书写辅助期间"哪些区域需要接管鼠标"（屏幕 DIP 矩形）。主进程据此轮询指针位置，
  // 不依赖渲染层的 mousemove 转发 —— 那条链路实测不可靠（标签看得见却点不动）。
  setWritingHitRects: (payload) => ipcRenderer.send('writing-hit-rects', payload),
  // 主进程按真实指针位置判定"指针是否靠近锚点"，结果回推给渲染层（标签据此显隐）
  onWritingNear: (callback) => {
    const fn = (_, near) => callback(!!near)
    ipcRenderer.on('writing-near', fn)
    return () => ipcRenderer.removeListener('writing-near', fn)
  },
  // 存活信标（每 500ms 一次，只要书写界面还挂着就发）。主进程据此把
  // "界面还在、标记却丢了"这种失配在半个心跳内补回来 —— 见 main.js 的 writing-alive。
  setWritingAlive: (alive) => ipcRenderer.send('writing-alive', alive),
  // 物理按下降在书写界面之外：主进程让出鼠标，直到下一次选区上报（见该 IPC 的处理）
  writingPointerDownOutside: () => ipcRenderer.send('writing-pointer-down-outside'),
  getWritingScreen: () => ipcRenderer.invoke('writing-screen'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  fetchLinkPreview: (url) => ipcRenderer.invoke('fetch-link-preview', url),
  sendChatRequest: (body) => ipcRenderer.send('chat-request', body),
  onChatChunk: (callback) => { const fn = (_, d) => callback(d); ipcRenderer.on('chat-chunk', fn); return () => ipcRenderer.removeListener('chat-chunk', fn) },
  onChatEnd: (callback) => { const fn = () => callback(); ipcRenderer.on('chat-end', fn); return () => ipcRenderer.removeListener('chat-end', fn) },
  onChatError: (callback) => { const fn = (_, err) => callback(err); ipcRenderer.on('chat-error', fn); return () => ipcRenderer.removeListener('chat-error', fn) },
  setAlarmInteractive: (interactive) => ipcRenderer.send('alarm-interactive', interactive),
  // 通知区（托盘）：同步"现在有没有计时器/闹钟"，并接住托盘发来的命令
  syncTray: (state) => ipcRenderer.send('tray-sync', state),
  onTrayCommand: (callback) => {
    const fn = (_, d) => callback(d)
    ipcRenderer.on('tray-command', fn)
    return () => ipcRenderer.removeListener('tray-command', fn)
  },
  // 托盘菜单：执行某一项（wake / voice / visual）
  trayAction: (cmd) => ipcRenderer.send('tray-action', cmd),
  // 托盘菜单：收起自己（Esc）
  hideTrayMenu: () => ipcRenderer.send('tray-menu-hide'),
  // 主进程每次弹出托盘菜单时通知一次，用于重播入场动画
  onTrayMenuShow: (callback) => {
    const fn = (_event, data) => callback(data)
    ipcRenderer.on('tray-menu-show', fn)
    return () => ipcRenderer.removeListener('tray-menu-show', fn)
  },
  // 菜单收起时通知：页面先回到透明状态，避免下次显示的第一帧"先亮一下"
  onTrayMenuHidden: (callback) => {
    const fn = () => callback()
    ipcRenderer.on('tray-menu-hidden', fn)
    return () => ipcRenderer.removeListener('tray-menu-hidden', fn)
  },
  // 通知智能：右下角重要通知卡片（主进程经 SSE 收到后推过来）
  onNotifyItems: (callback) => {
    const fn = (_event, payload) => callback(payload)
    ipcRenderer.on('notify-items', fn)
    return () => ipcRenderer.removeListener('notify-items', fn)
  },
  // 关闭某张卡片：主进程据此收缩窗口，卡片清空后隐藏窗口
  dismissNotify: (id) => ipcRenderer.send('notify-dismiss', id),
  // 让 Dony 自己退出（模型工具 / 点开网址卡片后收尾用）
  quitApp: () => ipcRenderer.send('quit-app'),
  // 给主进程日志留一行（用来查"点了没反应"这类问题：渲染进程到底收到了什么事件）
  logMain: (msg) => ipcRenderer.send('renderer-log', msg),
  // 指针是否停在界面内容上（主进程据此决定覆盖层要不要接管鼠标）
  notifyHover: (over) => ipcRenderer.send('overlay-hover', over),
  log: (msg) => console.log(msg),
})
