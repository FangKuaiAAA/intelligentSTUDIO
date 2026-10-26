export type WakeState =
  | 'idle'
  | 'holding'
  | 'waking'
  | 'ready'
  | 'loading'
  | 'responding'
  | 'followUp'

export type MorphStage = 'ready' | 'loading' | 'responding'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface VoiceAnalysis {
  level: number
  low: number
  high: number
}

/** 右下角通知卡片（重要通知 / 摘要兜底） */
export interface NotifyItem {
  kind: 'important' | 'summary'
  id: string | number
  app: string
  title: string
  body: string
  at: number
}

export interface ElectronAPI {
  onWake: (callback: () => void) => () => void
  onVoiceWake: (callback: () => void) => () => void
  /** Alt+D：界面已醒着且停在追问态时，主进程转发过来（= 按下「继续对话」按钮） */
  onVoiceContinue: (callback: () => void) => () => void
  onVoiceHold: (callback: () => void) => () => void
  onWakeHold: (callback: () => void) => () => void
  onReset: (callback: () => void) => () => void
  onBlurDismiss: (callback: () => void) => () => void
  onVisualWake: (callback: () => void) => () => void
  /** 视觉智能期间由主进程全局捕获并转发的 Esc（窗口未聚焦时网页收不到按键） */
  onVisualEscape: (callback: () => void) => () => void
  /** 启动彩排：真跑一遍光斑/光边（窗口真显示但近乎全透明），只为把"首次独有"的一次性绘制成本提前付掉 */
  onWarmup: (callback: () => void) => () => void
  /** 彩排结束回报（含渲染进程自己的兜底超时） */
  warmupDone: () => void
  /** 输入建议库（问题清单）。主进程读文件并解析，渲染进程只负责随机抽 3 条 */
  getSuggestions: () => Promise<string[]>
  captureScreen: () => Promise<string>
  /** 亚克力底衬：优先桌面壁纸（纯桌面、不含任何窗口），拿不到才回退截屏 */
  captureDesktop: () => Promise<string>
  /** 系统外观（Windows 模式）深浅：'dark' / 'light' / ''（读不到） */
  getSystemTheme: () => Promise<string>
  hideOverlay: () => void
  /** 上报界面状态（idle/holding/waking/ready/loading/responding/followUp），主进程据此决定快捷键是否唤醒 */
  notifyState?: (state: string) => void
  /** 上报当前是否真的画了内容：没有内容时主进程会放行鼠标，避免看不见的窗口吃掉所有点击 */
  setContentVisible?: (visible: boolean) => void
  cancelHold: () => void
  cancelVoiceHold: () => void
  releaseMouse: () => void
  setVisualWindowMode: (collapsed: boolean) => void
  setVisualWindowRect: (rect: { x: number; y: number; width: number; height: number }) => void
  setVisualMousePassthrough?: (passthrough: boolean) => void
  /** 书写辅助：进入/退出模式（覆盖层收到选区事件后调用；主进程据此豁免自动收窗并调整鼠标） */
  setWritingActive?: (active: boolean) => void
  /** 书写辅助：输入框需要键盘焦点时临时恢复可聚焦，用完立刻交还目标程序 */
  setWritingFocus?: (focusable: boolean) => void
  /** 书写辅助：当前需要接管鼠标的区域（屏幕 DIP 矩形），主进程据此轮询指针决定是否接管。
   *  另外带一块"靠近区"：主进程用它判断指针是否靠近锚点，再回推 writing-near ——
   *  标签的显隐因此不再依赖渲染层能否收到 mousemove。 */
  setWritingHitRects?: (payload:
  | Array<{ x: number; y: number; width: number; height: number }>
  | {
    rects: Array<{ x: number; y: number; width: number; height: number }>
    zone: { x: number; y: number; width: number; height: number } | null
  }) => void
  /** 书写辅助：主进程按真实指针位置判定"指针是否靠近锚点"，结果回推给渲染层 */
  onWritingNear?: (callback: (near: boolean) => void) => () => void
  /** 书写辅助：存活信标。界面还挂着就每隔 500ms 发一次，主进程据此补回丢失的书写模式标记 */
  setWritingAlive?: (alive: boolean) => void
  /** 书写辅助：物理按下降在界面之外（编辑器里）→ 主进程立刻让出鼠标，直到下一次选区上报 */
  writingPointerDownOutside?: () => void
  /** 书写辅助：主屏缩放与原点（UIA 给的是物理像素，要换算成窗口内 DIP） */
  getWritingScreen?: () => Promise<{
    scaleFactor: number
    bounds: { x: number; y: number; width: number; height: number }
    /** 当前指针位置（DIP）：用于判断标签"要不要一上来就显示" */
    cursor: { x: number; y: number }
    /** Windows 系统主题色（标签小框的底色；读不到时主进程给系统默认蓝） */
    accent: string
  }>
  setAlarmInteractive?: (interactive: boolean) => void
  /** 通知智能：主进程把重要通知/摘要兜底推给右下角通知窗口 */
  onNotifyItems?: (callback: (payload: { items: NotifyItem[]; lifetime?: number }) => void) => () => void
  /** 通知智能：关闭某张卡片（主进程负责收缩窗口） */
  dismissNotify?: (id: string | number) => void
  syncTray?: (state: {
    timer?: boolean; alarm?: boolean; floatVisible?: boolean; topVisible?: boolean
  }) => void
  onTrayCommand?: (callback: (data: { cmd: string }) => void) => () => void
  /** 托盘菜单：执行某一项（wake / voice / visual） */
  trayAction?: (cmd: string) => void
  /** 托盘菜单：收起菜单（Esc） */
  hideTrayMenu?: () => void
  /** 托盘菜单每次弹出时通知一次（withQuit 决定是否显示「退出STUDIO」） */
  onTrayMenuShow?: (callback: (data?: { withQuit?: boolean }) => void) => () => void
  /** 托盘菜单收起时通知（页面回到透明，避免下次首帧闪亮） */
  onTrayMenuHidden?: (callback: () => void) => () => void
  quitApp?: () => void
  logMain?: (msg: string) => void
  /** 指针是否停在内容上（覆盖层据此决定是否接管鼠标） */
  notifyHover?: (over: boolean) => void
  openExternal?: (url: string) => void
  fetchLinkPreview?: (url: string) => Promise<{ title?: string; image?: string } | null>
  sendChatRequest: (body: { messages: any[], model: string }) => void
  onChatChunk: (callback: (data: string) => void) => () => void
  onChatEnd: (callback: () => void) => () => void
  onChatError: (callback: (err: string) => void) => () => void
  log: (msg: string) => void
}

export type VisualPhase =
  | 'capturing'    // screen capture in progress
  | 'selecting'    // user drag-select on screen
  | 'options'      // show pill options below selection
  | 'processing'   // rainbow flow effect on selection
  | 'loading'      // waiting for AI response
  | 'responding'   // AI response displayed

export type VisualOption = 'understand' | 'translate' | 'extract' | 'identify' | 'search'

export interface VisualTextCard {
  type: 'text'
  content: string
}

export interface VisualLinkCard {
  type: 'link'
  title: string
  url: string
  image?: string
}

export type VisualAnswerCard = VisualTextCard | VisualLinkCard

export interface VisualAnswer {
  text: string
  cards: VisualAnswerCard[]
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
