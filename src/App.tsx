import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WakeState, VoiceAnalysis } from './types'
import { LightSpot, Edge, EdgeProgress } from './components/overlay/LightSpot'
import { RainbowEdges } from './components/overlay/RainbowEdges'
import { PillInput } from './components/overlay/PillInput'
import { ResponseBox } from './components/overlay/ResponseBox'
import { VoicePillInput } from './components/overlay/VoicePillInput'
import { VoiceResponseBox } from './components/overlay/VoiceResponseBox'
import { VisualOverlay } from './components/overlay/VisualOverlay'
import { WritingTools } from './components/overlay/writing/WritingTools'
import { DonyMorph } from './components/overlay/DonyMorph'
import { ResultCards } from './components/overlay/ResultCards'
import { useDonyAgent } from './agent/useDonyAgent'
import { SnapshotContext, AcrylicLayer, ACRYLIC_BLUR } from './components/overlay/AcrylicLayer'
import { ResultSequenceContext } from './components/overlay/resultFrame'
import {
  splitAnswerLines, VOICE_RISE_SECONDS, VOICE_RISE_EASE, voiceRiseFrom, PILL_COLLAPSE,
} from './components/overlay/answerMotion'
import { playPianoChord } from './utils/sound'

const VOICE_WS = 'ws://127.0.0.1:8766'

/** 稳定引用的空回调：给"彩排预热副本"用（每次渲染新建函数会让它白重渲染） */
const noop = () => {}

// ===== 输入药丸统一的飞入动画（首唤醒 / 追问 / 语音过渡共用一套）=====
// DonyAG：所有“飞入动画”必须是「快速飞入 + 末尾减速缓冲」——用 ease-out 曲线，不用回弹弹簧。
// 曲线与 DonyMorph 的内容飞入（CONTENT 系列）保持一致，避免出现两套观感。
const PILL_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]
const PILL_FLY_IN = { duration: 0.28, ease: PILL_EASE }
const PILL_FLY_OUT = { duration: 0.2, ease: PILL_EASE }
// 药丸的进出场只用「位移 + 浓度」：尺寸变化交给 DonyMorph 的宽高形变（width/height/borderRadius）。
// 不再用 scale —— 缩放不是形变，会让药丸看起来在"抽"，而且退出时缩到 0.5 更像是在缩小消失。
const PILL_FROM = { opacity: 0 }
const PILL_TO = { opacity: 1, y: 0 }
// ⚠ 这里**不能**再带 y（原来是 y: 44）—— 它是"向下 44px"✗，用户实测就是那句
//   "追问输入框仍是向下飞出"。药丸要离开时只做淡出；形状由 VoicePillInput 的
//   盒子形变（collapse）负责，方向由此处显式表达，不再交给位移。
const PILL_EXIT = { opacity: 0, filter: 'blur(3px)' } as const

function App() {
  const [state, setState] = useState<WakeState>('idle')
  // 唤醒瞬间的桌面快照：亚克力卡片靠它才能"看见桌面被磨砂"
  //（Windows 的亚克力是窗口级材质，透明窗口里的 backdrop-filter 取不到桌面）
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [voiceMode, setVoiceMode] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceText, setVoiceText] = useState('')
  const [voiceAnalysis, setVoiceAnalysis] = useState<VoiceAnalysis | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [userInput, setUserInput] = useState('')
  const [followUpInput, setFollowUpInput] = useState('')
  const [keystrokePulse, setKeystrokePulse] = useState(0)
  const [dismissing, setDismissing] = useState(false)
  const [visibleEdges, setVisibleEdges] = useState<Edge[]>([])
  const edgeProgressRef = useRef<EdgeProgress>({ top: 0, right: 0, bottom: 0, left: 0 })
  const [edgesOvershoot, setEdgesOvershoot] = useState(false)
  // ---- 启动彩排（主进程在启动后发起）----
  // 让光斑 + 光边**真跑一遍**（窗口真显示、整窗近乎透明），只为了把"第一次独有"的
  // 一次性成本提前付掉：绘制管线/着色器程序编译、首次大面积填充、光边 12 个
  // filter/mask 层的首份光栅。动画本体不动 —— 这里只是把回调换成"吞掉"的版本，
  // 所以彩排期间**不进状态机、不写任何界面状态**。
  const [warmup, setWarmup] = useState(false)
  // 彩排期间光边要跟着光斑的真实进度一起延伸：进度写到这个专用 ref，
  // 不碰真实的 edgeProgressRef（否则会污染下一次真实唤醒的起手值）。
  const warmupProgressRef = useRef<EdgeProgress>({ top: 0, right: 0, bottom: 0, left: 0 })
  // 渲染器自己的兜底计时器：万一光斑的完成回调没来，也必须把彩排收回，
  // 否则光边会一直挂着、光斑会一直转下去。
  const warmupFailsafeRef = useRef<ReturnType<typeof setTimeout>>()

  // ---- 输入建议（**只在首次键入对话**出现）----
  // 建议库来自桌面上的「可以问Dony的问题.txt」，由主进程解析后经 IPC 交过来
  //（文件在项目之外，渲染进程读不到；见 main.js 的 readSuggestionLibrary）。
  const [suggestions, setSuggestions] = useState<string[]>([])
  const suggestionPoolRef = useRef<string[]>([])
  /** 建议库是否已经取过（懒加载：只在第一次要用它时才去主进程读，见下面 ready 的 effect） */
  const suggestionFetchedRef = useRef(false)
  // 选中某条建议后要发送的"完整文本"（已输入内容 + 建议）：
  // 收起动画播完那一刻才用它去 submit（用户要求"收起播完才算回车"）。
  const suggestPickRef = useRef('')
  const dismissRef = useRef<ReturnType<typeof setTimeout>>()
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsCtxRef = useRef<AudioContext | null>(null)
  const ttsRafRef = useRef<number>(0)
  const wsRef = useRef<WebSocket | null>(null)
  const voiceModeRef = useRef(false)
  const voiceTurnRef = useRef(false)
  const [visualMode, setVisualMode] = useState(false)
  // 书写辅助（选区改写）：由后端广播的选区事件**被动触发**，与视觉智能、Dony 会话互斥。
  // 它不参与上面那套 WakeState 状态机（界面自己管自己的阶段），这里只记两件事：
  // 是否激活（互斥 + 亚克力底衬同步要用），以及一个自增的重置信号。
  const [writingMode, setWritingMode] = useState(false)
  const [writingReset, setWritingReset] = useState(0)
  const [isFollowUpTransition, setIsFollowUpTransition] = useState(false)
  // 药丸「形变收拢」标记：过渡收尾前 ~0.3s 打开 → 药丸把自己的盒子收缩到加载胶囊尺寸，
  // 然后再卸载（见下面语音静默分支里的两个定时器）。用受控状态驱动、而不是 AnimatePresence
  // 的 exit，是因为 exit 只能动它自己那个元素，动不了内部的药丸容器（见 VoicePillInput 注释）。
  const [pillCollapsing, setPillCollapsing] = useState(false)
  // 静默收尾的两个定时器（形变卸载 / overlay 收尾）：存 ref 以便 reset 能取消——
  // 否则中途 reset 后定时器仍会触发，把 shrinking 留成 true（下次过渡药丸直接不显示）。
  const voiceSilenceTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  // 语音药丸是否正在"飞入" —— **首次唤醒与追问过渡共用这一个标记**（用户要求用一套代码）。
  // 药丸自己正在飞的时候，里面的文字不做逐字飞入，只做"模糊 → 确认后清晰"。
  // 触发点 = "这一轮第一次出现文字"（那正是新药丸出现的瞬间），升完之后自动落下。
  // ⚠ 之前是用 state === 'waking' 判断的 —— 语音模式下第一个字到达时状态往往已经是
  //   ready 了，所以那个条件几乎永远为假 → "首个文字你没做模糊"就是这个原因。
  const [voiceEntering, setVoiceEntering] = useState(false)
  const voiceEnterTimer = useRef<ReturnType<typeof setTimeout>>()
  const markVoiceEntering = useCallback(() => {
    setVoiceEntering(true)
    clearTimeout(voiceEnterTimer.current)
    voiceEnterTimer.current = setTimeout(() => setVoiceEntering(false), VOICE_RISE_SECONDS * 1000 + 60)
  }, [])
  const [transitionPhase, setTransitionPhase] = useState(0)
  const [shrinking, setShrinking] = useState(false)
  // 首屏输入框回车那一下：卡片要"边缩小边快速上移"形变为处理药丸。
  // 用一个短暂的标记让 DonyMorph 知道该用幂曲线的上冲形变（而不是常规弹簧）。
  const [submitKick, setSubmitKick] = useState(false)
  const submitKickTimer = useRef<ReturnType<typeof setTimeout>>()
  const submitRef = useRef<(t: string, f: boolean) => void>(() => {})
  const sendCmdRef = useRef<(o: object) => void>(() => {})
  const playTtsRef = useRef<(b64: string) => void>(() => {})
  const prevVoiceTextRef = useRef('')
  const closingRef = useRef(false)
  const stateRef = useRef<WakeState>('idle')

  useEffect(() => { voiceModeRef.current = voiceMode }, [voiceMode])
  useEffect(() => { stateRef.current = state }, [state])
  // 把界面状态同步给主进程：它据此判断“这次快捷键该不该唤醒”，
  // 而不是只靠一个可能残留的 isAwake 标记（那会让快捷键静默失效）。
  useEffect(() => { window.electronAPI?.notifyState?.(state) }, [state])

  // 指针在不在"有内容"的地方：主进程据此决定覆盖层要不要接管鼠标。
  // 不接管 → 底下的计时器/闹钟卡片才点得动；接管 → Dony 自己的卡片/开关/输入框才点得动。
  // （只做一次判定后上报变化，不动 focus，避免又把输入框的焦点弄丢。）
  useEffect(() => {
    // 书写辅助期间**整条都不注册**：那段时间的鼠标接管由主进程按"上报的矩形"轮询决定
    // （见 WritingTools 的 setWritingHitRects 与 main.js 的 pollWritingHover）。
    // 若这里还照常上报，两条来源会互相覆盖 —— overlayHovering 被反复翻转，鼠标就点不动了。
    // 只靠回调里判断会有"状态刚切换、effect 还没换"的窗口期，所以直接按依赖不注册。
    if (writingMode) return
    let last = true
    let pending: ReturnType<typeof setTimeout> | null = null
    const onMove = (e: MouseEvent) => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        const cls = (el?.className || '').toString()
        // 判定"是不是真的在能点的东西上"，两道并存：
        // ① 计算样式 pointer-events：none 的一律不算（覆盖所有装饰层，以后新增也不漏）；
        // ② 类名白名单：**必须保留** —— 因为 `.overlay-container>*` 会把每个直接子元素
        //    设成 pointer-events:auto，全屏光边（RainbowEdges）正好是直接子元素，
        //    光靠 ① 它会算成"内容"→ 覆盖层全屏接管鼠标 → 点击全被吃掉
        //    （Dony 的坐标点击 gui_click 就是这样被吃掉的）。
        const empty = !el || el === document.body || el === document.documentElement
          || /rainbow|edges/i.test(cls)
          || getComputedStyle(el).pointerEvents === 'none'
        const over = !empty
        if (over !== last) {
          last = over
          window.electronAPI?.notifyHover?.(over)
        }
      }, 10)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (pending) clearTimeout(pending)
    }
  }, [writingMode])

  const stopTtsPlayback = useCallback(() => {
    if (ttsAudioRef.current) { ttsAudioRef.current.pause(); ttsAudioRef.current = null }
    if (ttsCtxRef.current) { ttsCtxRef.current.close(); ttsCtxRef.current = null }
    cancelAnimationFrame(ttsRafRef.current)
    setVoiceAnalysis(null)
    window.speechSynthesis?.cancel()
  }, [])

  // ---- Dony Agent（WS 8767） ----
  const agent = useDonyAgent({
    isVoice: () => voiceModeRef.current,
    speak: (text) => sendCmdRef.current({ type: 'start-tts', text }),
    onSettled: () => { setState('followUp'); window.electronAPI?.setVisualMousePassthrough?.(false) },
    onCancel: () => {},
  })

  const reset = useCallback(() => {
    setState('idle'); setVisualMode(false); setVoiceMode(false); setVoiceListening(false)
    // 书写辅助也一起收：它常驻挂载，靠这个自增信号静默退出（窗口已由别处处理，不重复收窗）
    setWritingMode(false); setWritingReset((n) => n + 1)
    setVoiceText(''); setVoiceAnalysis(null); setIsSpeaking(false)
    setUserInput(''); setFollowUpInput(''); setDismissing(false); setVisibleEdges([])
    edgeProgressRef.current = { top: 0, right: 0, bottom: 0, left: 0 }; setEdgesOvershoot(false)
    // 任何真实唤醒开始都要把彩排状态收干净：万一彩排卡住（完成回调没来），
    // 也不会让"warmup 为真"把随后的真实唤醒一直顶在彩排模式上。
    setWarmup(false); clearTimeout(warmupFailsafeRef.current)
    warmupProgressRef.current = { top: 0, right: 0, bottom: 0, left: 0 }
    voiceTurnRef.current = false; setTransitionPhase(0); setShrinking(false)
    // ⚠ 清残留（用户实测："每重新唤醒一次（第一次以外）都会出现一个不存在的返回卡片飞出"）：
    //   上一轮的 follow-up 状态若留在 state 里，下一次唤醒就会**凭空**渲染出整套 follow-up UI
    //   —— 包括"不存在的返回卡上飞"（card-responding）和那颗未说话就出现的近圆卵形
    //   （= 无文字时的 VoicePillInput：宽 40 / 高 ~52 + 圆角 999px）。
    //   这里连同"让首批文字只模糊"的 voiceEntering 与它的计时器一起清干净。
    setIsFollowUpTransition(false)
    setVoiceEntering(false)
    setPillCollapsing(false)
    voiceSilenceTimersRef.current.forEach(clearTimeout)
    voiceSilenceTimersRef.current = []
    clearTimeout(voiceEnterTimer.current)
    setVoiceText('')
    closingRef.current = false
    stopTtsPlayback()
    agent.resetAgent()
    if (dismissRef.current) clearTimeout(dismissRef.current)
  }, [agent, stopTtsPlayback])

  // 唤醒瞬间抓一张桌面快照。此刻覆盖层内容还是空的（光斑都还没画），
  // 抓到的就是纯桌面 —— 与视觉链路的做法一致。
  const captureSnapshot = useCallback(() => {
    // 用 captureDesktop（壁纸优先）：亚克力底衬要的是"纯桌面、不含任何窗口"。
    // 千万别用 captureScreen —— 那是视觉智能要的**真实屏幕画面**，混用会让视觉
    // 智能只截到背景、看不到窗口内容。
    window.electronAPI?.captureDesktop?.().then(setSnapshot).catch(() => {})
  }, [])

  // 深浅色跟随 Win11「应用模式」（CSS 的 prefers-color-scheme 就是这个）。
  // （读注册表 SystemUsesLightTheme 走「Windows 模式」的那条路保留在主进程里，
  //  以后想改用系统模式，把 acrylic.css 的选择器换回 [data-dony-theme] 即可。）
  // 键入模式唤醒**不播提示音**（MUS.mp3 只在语音模式播）：
  // 键入模式是"静默就位、等你说"，声音交给语音那条链路。
  const doWake = useCallback(() => {
    reset(); captureSnapshot(); setState('waking')
  }, [reset, captureSnapshot])
  const doVoiceWake = useCallback(() => {
    reset(); captureSnapshot(); playPianoChord(); setVoiceMode(true); setState('waking')
  }, [reset, captureSnapshot])
  const doVoiceHold = useCallback(() => { setVoiceMode(true); setState('holding') }, [])
  const doWakeHold = useCallback(() => { setState('holding') }, [])
  const doVisualWake = useCallback(() => { reset(); setVisualMode(true) }, [reset])

  // Electron IPC
  useEffect(() => {
    const u1 = window.electronAPI?.onWake(doWake); const u1v = window.electronAPI?.onVoiceWake(doVoiceWake)
    const u1vh = window.electronAPI?.onVoiceHold(doVoiceHold); const u1h = window.electronAPI?.onWakeHold(doWakeHold)
    const u1vw = window.electronAPI?.onVisualWake(doVisualWake)
    // Alt+D 在「继续对话」按钮显示时的语义 = 按下它（主进程只在 overlayState==='followUp' 时发）。
    // 这里再核对一次"按钮真的在显示"（与 JSX 里那颗按钮同一个条件），然后走与点击**完全相同**
    // 的 startVoiceFollowUp() ⇒ 按钮随即消失（!voiceListening 不再成立）。
    // ⚠ 用 ref 取值：IPC 回调是一次性注册的，闭包里的 state / 回调都会过期；
    //   也不能把 ref 加进 deps（deps 在渲染期求值，会踩下面 const 的 TDZ）。
    const u1vc = window.electronAPI?.onVoiceContinue(() => {
      if (followContinueRef.current) altDContinueRef.current()
    })
    const u2 = window.electronAPI?.onReset(reset)
    const u3 = window.electronAPI?.onBlurDismiss(() => {
      // 思考/执行期间不退出：用户可自由操作其他窗口
      if (stateRef.current === 'loading') return
      if (stateRef.current !== 'idle' && stateRef.current !== 'holding' && stateRef.current !== 'waking' && !dismissing) {
        window.electronAPI?.releaseMouse?.()
        setDismissing(true); window.electronAPI?.hideOverlay()
      }
    })
    return () => { u1?.(); u1v?.(); u1vc?.(); u1vh?.(); u1h?.(); u1vw?.(); u2?.(); u3?.() }
  }, [reset, doWake, doVoiceWake, doVoiceHold, doVisualWake, dismissing])

  // 启动彩排：主进程让渲染器"真跑一遍光斑 + 光边"（窗口真显示、整窗近乎透明）。
  // 这里只切一个本地开关，**不进状态机、不写任何界面状态** —— 动画照跑，
  // 但回调被换成"吞掉"的版本（见下面 LightSpot 那处的三元）。
  useEffect(() => {
    const off = window.electronAPI?.onWarmup?.(() => {
      warmupProgressRef.current = { top: 0, right: 0, bottom: 0, left: 0 }
      setWarmup(true)
      // ⚠ 彩排期间**唯一的**一处"写界面状态"，且是有意为之：
      //   亚克力的首帧光栅化（全屏桌面快照 → 解码 → 模糊）是两次首唤醒里最大的一笔开销，
      //   而它**只能**在有真实快照时才付得掉。两条路的差别正在这里：
      //     · 语音：waking 期间不挂卡片 ⇒ 这笔开销落到"第一个字出现时"，不挤压唤醒那 0.6s；
      //     · 键入：卡片在 waking 期间就挂 ⇒ 这笔开销正落在唤醒的主线程高峰期 ✗（用户实测的卡顿）。
      //   所以彩排先把快照抓下来，让下面那颗"预热药丸"把模糊光栅付掉。
      //   代价与安全性：这张快照会在真正唤醒时被 doWake/doVoiceWake 重新抓取覆盖 ✓，
      //   而彩排结束到首次唤醒之间界面是空的（state=idle）⇒ 不会拿它去画任何东西 ✓。
      captureSnapshot()
      // 渲染器兜底：光斑完成回调没来的话（几何边界情况），到点也必须收回彩排
      // 渲染器兜底：光斑完成回调没来的话（几何边界情况），到点也必须收回彩排
      clearTimeout(warmupFailsafeRef.current)
      warmupFailsafeRef.current = setTimeout(() => {
        setWarmup(false)
        window.electronAPI?.warmupDone?.()
      }, 2600)
    })
    return () => { off?.(); clearTimeout(warmupFailsafeRef.current) }
  }, [])

  // ⚠ 建议库**不再在页面加载时取**（用户实测："每次启动都在 electron cmd 里看到它载入一遍"）。
  //   清单现在固化在主进程的一份常量里（main.js 的 BUILTIN_SUGGESTIONS，不再读任何文件），
  //   所以这次请求只是取一份内存数组、没有 IO；再**懒一点**仍有好处：
  //   语音唤醒、或一唤醒就打字回车的那次启动，连这次 IPC 都不必发生。
  //   见下面那个 ready 的 effect（第一次真的要显示建议时才取）。

  // 升起输入建议的时机：「光边动画播完」= 状态进入 ready（首屏输入的窗口）之后。
  // 再等 3 秒，若用户还没发出请求（仍停在 ready 就说明没提交过），随机抽 3 条升起来。
  // ⚠ 只有 ready 会给建议：追问是 followUp 状态、语音走另一条链路 —— 天然满足"必须为首次"。
  useEffect(() => {
    if (state !== 'ready' || voiceMode || visualMode || warmup) return
    let alive = true
    let t: ReturnType<typeof setTimeout> | undefined
    const start = () => {
      t = setTimeout(() => {
        if (!alive) return
        const pool = suggestionPoolRef.current
        if (!pool.length) return
        const rest = [...pool]
        const picked: string[] = []
        while (picked.length < 3 && rest.length) {
          picked.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0])
        }
        setSuggestions(picked)
      }, 3000)
    }
    // 懒加载：第一次进 ready 才去主进程取（整个进程只取一次，之后用 ref 里的池子）
    if (suggestionFetchedRef.current) {
      start()
    } else {
      suggestionFetchedRef.current = true
      const p = window.electronAPI?.getSuggestions?.()
      if (p && typeof p.then === 'function') {
        // ⚠ 取到之后**才**起那 3 秒计时：否则取回慢的那次会在计时结束时拿到空池子 ⇒ 建议永不出现
        p.then((list) => { if (alive) suggestionPoolRef.current = Array.isArray(list) ? list : [] })
          .catch(() => { if (alive) suggestionPoolRef.current = [] })
          .then(() => { if (alive) start() })
      } else {
        start()
      }
    }
    // 离开 ready（提交 / Esc / 收起）就把建议清干净，
    // 否则下次唤醒会"一醒来就挂着上一轮那 3 条"（而且没等 3 秒就出现）。
    return () => { alive = false; if (t) clearTimeout(t); setSuggestions([]) }
  }, [state, voiceMode, visualMode, warmup])

  // 执行期间的鼠标策略：**一律整窗放行鼠标**。
  //   · 否则 Dony 自己的覆盖层会挡住它要点的地方——截图里报“被 intelligentSTUDIO 完全遮挡”、
  //     以及“光标移过去却点不下”，根因都是它；
  //   · 只有「打断询问」需要用户真的能点/输入，这时才恢复交互。
  // 不能按“悬停到卡片上就恢复交互”来做：放行鼠标时 mousemove 仍会转发给页面，
  // 鼠标一划过卡片窗口就变成可点击状态，那一瞬间的点击正好被吞掉。
  useEffect(() => {
    if (!window.electronAPI) return
    window.electronAPI.setVisualMousePassthrough?.(state === 'loading' && !agent.ask)
  }, [state, agent.ask])

  // Dev keyboard fallback
  useEffect(() => {
    if (window.electronAPI) return
    const h = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (state === 'idle' || state === 'holding')) { e.preventDefault(); doWake() }
      // ⚠ 追问按钮显示中：Alt+D 同 `voice-continue`，走与点击按钮同一条路（不用按住）
      if (e.code === 'KeyD' && e.altKey && followContinueRef.current) {
        e.preventDefault(); altDContinueRef.current(); return
      }
      if (e.code === 'KeyD' && e.altKey && (state === 'idle' || state === 'holding')) { e.preventDefault(); doVoiceWake() }
      if (e.code === 'KeyV' && e.altKey && (state === 'idle' || state === 'holding')) { e.preventDefault(); doVisualWake() }
      if (e.code === 'Escape' && state !== 'idle') reset()
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [state, doWake, doVoiceWake, reset])

  // 用户在 follow-up 录音中说第一个字：旧结果框上飞 + 药丸飞到首次位置
  useEffect(() => {
    if (voiceMode && voiceListening && state === 'followUp' && voiceText && !prevVoiceTextRef.current) {
      setIsFollowUpTransition(true); setTransitionPhase(1)
    }
    // 这一轮第一次出现文字 = 新药丸开始出现的那一刻（首唤醒与追问**共用**这一个标记）：
    // 接下来 0.62s 内药丸都在飞，文字只做"模糊 → 清晰"，不做逐字飞入。
    if (voiceMode && voiceText && !prevVoiceTextRef.current) markVoiceEntering()
    prevVoiceTextRef.current = voiceText
  }, [voiceText, voiceMode, voiceListening, state, markVoiceEntering])

  // Voice WebSocket（ASR/TTS，保持原有通道）
  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout>
    const connect = () => {
      try {
        ws = new WebSocket(VOICE_WS); wsRef.current = ws
        ws.onopen = () => console.log('[ws] connected')
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data)
            switch (m.type) {
              case 'partial-result':
              case 'final-result':
                setVoiceText(m.text)
                setKeystrokePulse(n => n + 1)
                break
              case 'silence-timeout': {
                setVoiceListening(false)
                // ⚠ 时间轴（"追问框消失"的根因）：旧写法 t=0 就 setShrinking(true)
                //   ⇒ 药丸被 {!shrinking && …} 门**立刻卸载** ⇒ 480ms 后才触发的
                //   pillCollapsing 打在已卸载的组件上（no-op）⇒ 只剩 0.2s 淡出 = "消失"。
                // 之后的空窗问题：overlay 曾拖到 780ms 才收 ⇒ showMorph = !inVoiceTransition
                //   在 340~780ms 之间为 false ⇒ 加载胶囊（DonyMorph）没挂载 = "淡出后空窗"。
                //   现在 overlay 收尾与卸载**同刻（340ms）**：药丸收拢完成的那一帧，
                //   DonyMorph 即刻挂载 —— 两者中心已逐像素对齐（PILL_COLLAPSE.y），无缝交接。
                setPillCollapsing(true)
                voiceSilenceTimersRef.current.forEach(clearTimeout)
                voiceSilenceTimersRef.current = [
                  setTimeout(() => {
                    setShrinking(true)
                    setIsFollowUpTransition(false); setTransitionPhase(0); setShrinking(false)
                    setPillCollapsing(false)
                  }, 340),
                ]
                // 一个字都没听到（噪声/麦克风没拾到声音）：直接收起界面回到 idle。
                // 否则会停在“在听、但语音模式下什么都不显示”的状态：
                // 主进程仍认为界面已唤醒，于是后续所有快捷键都会被静默忽略（Alt+D 偶发失效的根因）。
                if (!(m.text || '').trim()) {
                  console.warn('[voice] 静默超时但没有识别到内容，收起界面')
                  sendCmdRef.current({ type: 'cancel' })
                  voiceTurnRef.current = false
                  reset()
                  window.electronAPI?.releaseMouse?.()
                  window.electronAPI?.hideOverlay()
                  break
                }
                submitRef.current(m.text, voiceTurnRef.current)
                voiceTurnRef.current = true
                break
              }
              case 'audio-analysis':
                setVoiceAnalysis({ level: m.level, low: m.low, high: m.high })
                setKeystrokePulse(n => n + 1)
                break
              case 'tts-audio':
                playTtsRef.current(m.data)
                break
              case 'tts-done':
              case 'tts-error':
                setIsSpeaking(false); setVoiceText('')
                break
              case 'cancelled': reset(); break
            }
          } catch {}
        }
        ws.onclose = () => { wsRef.current = null; reconnect = setTimeout(connect, 3000) }
        ws.onerror = () => ws?.close()
      } catch { reconnect = setTimeout(connect, 5000) }
    }
    connect()
    return () => { clearTimeout(reconnect); ws?.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendCmd = useCallback((o: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(o))
  }, [])
  useEffect(() => { sendCmdRef.current = sendCmd }, [sendCmd])

  const playTts = useCallback((b64: string) => {
    try {
      stopTtsPlayback()
      const bytes = new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)))
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const a = new Audio(url); a.volume = 1.0
      ttsAudioRef.current = a

      const ctx = new AudioContext()
      ttsCtxRef.current = ctx
      ctx.resume()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      const src = ctx.createMediaElementSource(a)
      src.connect(analyser)
      analyser.connect(ctx.destination)

      const buf = new Uint8Array(analyser.fftSize)
      const readLevel = () => {
        if (ttsCtxRef.current !== ctx) { setVoiceAnalysis(null); return }
        analyser.getByteTimeDomainData(buf)
        const rms = Math.sqrt(Array.from(buf).reduce((s, v) => { const d = (v - 128) / 128; return s + d * d }, 0) / buf.length)
        const level = Math.min(1, rms * 8)
        setVoiceAnalysis({ level, low: level * 0.8, high: level })
        ttsRafRef.current = requestAnimationFrame(readLevel)
      }
      readLevel()

      a.onended = () => {
        ttsAudioRef.current = null; URL.revokeObjectURL(url)
        if (ttsCtxRef.current) { ttsCtxRef.current.close(); ttsCtxRef.current = null }
        cancelAnimationFrame(ttsRafRef.current)
        setVoiceAnalysis(null)
      }
      a.onerror = () => {
        ttsAudioRef.current = null; URL.revokeObjectURL(url)
        if (ttsCtxRef.current) { ttsCtxRef.current.close(); ttsCtxRef.current = null }
        cancelAnimationFrame(ttsRafRef.current)
        setVoiceAnalysis(null)
      }
      a.play().catch(() => {})
    } catch {}
  }, [stopTtsPlayback])
  useEffect(() => { playTtsRef.current = playTts }, [playTts])

  // ---- 提交（首轮与 follow-up 共用）：全部交给 Dony Agent ----
  const handleSubmit = useCallback((text: string, _isFollowUp: boolean) => {
    if (!text.trim()) return
    stopTtsPlayback()
    sendCmdRef.current({ type: 'stop-tts' })
    setUserInput(''); setFollowUpInput('')
    // 建议"瞬间消失"：和提交放进同一次渲染 → 绝不拖住药丸向上飞入
    setSuggestions([]); suggestPickRef.current = ''
    setState('loading')
    // 键入模式的首屏输入：抬手让卡片做"缩小 + 上冲"的幂曲线形变
    //（语音模式与追问不带这个标记，保持各自原有的过渡）
    if (!voiceModeRef.current && !_isFollowUp) {
      setSubmitKick(true)
      clearTimeout(submitKickTimer.current)
      // 0.7s：上移动画本身是 0.84s，用幂曲线（指数 2.2/10）在 0.7s 时位置已走 98%、
      // 尺寸已几乎缩完 → 此刻点亮彩虹既不会"追着卡片跑"，又比动画结束早 0.2s 出现
      //（用户要求"彩虹早 0.2 秒显示"）。
      submitKickTimer.current = setTimeout(() => setSubmitKick(false), 700)
    }
    agent.submit(text.trim())
  }, [agent, stopTtsPlayback])
  useEffect(() => { submitRef.current = handleSubmit }, [handleSubmit])

  const handleFollowUpSubmit = useCallback((text: string) => {
    handleSubmit(text, true)
  }, [handleSubmit])

  // 语音追问：点「继续对话」按钮（或语音药丸）→ 停掉正在朗读的 TTS、开始收音。
  // 逻辑与原来完全一致，只是抽出来给两种形态（小药丸按钮 / 语音药丸）共用。
  const startVoiceFollowUp = useCallback(() => {
    stopTtsPlayback()
    sendCmdRef.current({ type: 'stop-tts' })
    setVoiceText(''); setVoiceListening(true); sendCmdRef.current({ type: 'start-listening' })
  }, [stopTtsPlayback])

  // ---- Alt+D ≡ 按下「继续对话」按钮（用户要求：当它显示时按 Alt+D 也继续追问、按钮消失）----
  // 判定条件与 JSX 里那颗按钮**同源**（state / voiceMode / voiceListening / voiceText）：
  // "能不能按"只由一件事决定，不会出现"快捷键开了麦、按钮却还挂着"这种自相矛盾。
  // ⚠ 用 ref 传给 IPC 回调：那个回调一次性注册、闭包会过期，所以每帧刷新一份最新值。
  const followContinueRef = useRef(false)
  const altDContinueRef = useRef<() => void>(() => {})
  followContinueRef.current = state === 'followUp' && voiceMode && !voiceListening && !voiceText
  altDContinueRef.current = startVoiceFollowUp

  // ---- 输入建议的两个回调 ----
  // 点了某条建议：把它的文字**追加**到已经输入的内容后面（不管原来有没有文字），
  // 然后由 PillInput 播"收起动画"；收完才算发出请求（见下面那个回调）。
  const handlePickSuggestion = useCallback((text: string) => {
    const merged = userInput + text
    suggestPickRef.current = merged
    setUserInput(merged)
  }, [userInput])
  // 收起动画播完 —— 这一刻才算用户"按了回车"：用当时记下的完整文本去提交
  // （用 submitRef 而不是 handleSubmit，免得这个回调的引用每次都变）
  const handleSuggestCollapseDone = useCallback(() => {
    const text = suggestPickRef.current
    suggestPickRef.current = ''
    setSuggestions([])
    if (text.trim()) submitRef.current(text.trim(), false)
  }, [])

  const handleEdgeReached = useCallback((edge: Edge) => {
    setVisibleEdges((prev) => prev.includes(edge) ? prev : [...prev, edge])
  }, [])
  const handleEdgeProgress = useCallback((p: EdgeProgress) => { edgeProgressRef.current = p }, [])
  const handleWakeComplete = useCallback(() => {
    // ⚠ 只在还处于 waking 时才收尾：键入模式的输入框现在是**和光斑同时**飞入的，
    // 用户完全可能在光斑还没散完时就打完字回车了。那时 state 已经走到后面，
    // 若这里无条件设回 ready，卡片会被从"正在处理"药丸拽回输入框。
    if (stateRef.current !== 'waking') return
    setState('ready')
    if (voiceModeRef.current) {
      setVoiceListening(true); sendCmdRef.current({ type: 'start-listening' })
    }
  }, [])
  // 语音唤醒兜底：唤醒动画正常会在结束时回报 handleWakeComplete（进入 ready 并开始收音）。
  // 万一那一帧丢了（窗口刚 show 出来时渲染被节流等），这里强制收尾，
  // 避免出现“按了 Alt+D、界面出来了却一直不听”的情况。
  useEffect(() => {
    if (state !== 'waking' || !voiceMode) return
    const t = setTimeout(() => {
      if (stateRef.current !== 'waking') return
      console.warn('[voice] 唤醒动画超时未完成，强制进入 ready 并开始收音')
      setState('ready')
      setVoiceListening(true)
      sendCmdRef.current({ type: 'start-listening' })
    }, 2500)
    return () => clearTimeout(t)
  }, [state, voiceMode])

  const handleHaloGone = useCallback(() => setEdgesOvershoot(true), [])
  // 彩排专用回调：**必须是稳定引用** —— LightSpot 的 effect 依赖这几个函数，
  // 若每次渲染都换新函数，那个 effect 会重跑（动画被反复重启）。
  const handleWarmupProgress = useCallback((p: EdgeProgress) => { warmupProgressRef.current = p }, [])
  const handleWarmupEdge = useCallback(() => {}, [])
  const handleWarmupHaloGone = useCallback(() => {}, [])
  const handleWarmupComplete = useCallback(() => {
    clearTimeout(warmupFailsafeRef.current)
    warmupProgressRef.current = { top: 0, right: 0, bottom: 0, left: 0 }
    setWarmup(false)
    window.electronAPI?.warmupDone?.()
  }, [])
  const handleKeystroke = useCallback(() => setKeystrokePulse((n) => n + 1), [])
  const handleVisualClose = useCallback(() => {
    setVisualMode(false); reset()
    if (window.electronAPI) {
      window.electronAPI.releaseMouse()
      window.electronAPI.hideOverlay()
    }
  }, [reset])

  const handleClose = useCallback(() => {
    if (stateRef.current === 'holding') {
      if (voiceModeRef.current) window.electronAPI?.cancelVoiceHold?.()
      else window.electronAPI?.cancelHold?.()
      return
    }
    if (closingRef.current) return      // 防止 Esc 与控件同时触发导致重复收起
    closingRef.current = true
    window.electronAPI?.setVisualMousePassthrough?.(false)
    window.electronAPI?.releaseMouse?.()
    agent.cancelAgent()
    // 关窗时必须**同时清掉模型上下文**：cancel 只取消当前任务，不清历史。
    // 之前只有 reset()（唤醒时）会发 reset-context，于是某些收起路径
    // （Alt+D 的 holding 分支、语音过渡、Esc）会把上一轮对话留在上下文里——
    // 下次唤醒 Dony 就“记得”上次说过的话（实测就是这样）。
    agent.resetAgent()
    if (voiceModeRef.current) {
      sendCmdRef.current({ type: 'stop-tts' }); sendCmdRef.current({ type: 'cancel' })
    }
    stopTtsPlayback()
    setDismissing(true)
    window.electronAPI?.hideOverlay()
  }, [agent, stopTtsPlayback])

  // 退出只保留 Esc（已取消点击空白区域退出）：视觉模式由 VisualOverlay 自己处理 Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stateRef.current === 'idle' || visualMode) return
      void handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose, visualMode])

  const active = state !== 'idle'
  const inVoiceTransition = isFollowUpTransition && voiceMode
  // 键入模式：输入框**和光边/光斑同时**从屏幕底部飞入 —— 所以不再排除 waking。
  // 语音首轮仍是老行为：说出第一个字时药丸随文字一同出现（demo2 行为）。
  const showMorph = !visualMode && !inVoiceTransition && active && state !== 'holding'
    && (state !== 'waking' || !voiceMode)
    && (!voiceMode || state !== 'ready' || !!voiceText)

  // 界面此刻是否真的画了东西（光斑/药丸/结果框/视觉面板）。
  // 一层“什么都没画”的全屏置顶窗口是看不见的，但它会吃掉系统里所有鼠标点击，
  // 所以此时必须让窗口放行鼠标（主进程只会在“无内容”时放行，有内容时不干预既有逻辑）。
  const hasVisibleUi = visualMode || state === 'waking' || showMorph || inVoiceTransition
  useEffect(() => { window.electronAPI?.setContentVisible?.(hasVisibleUi) }, [hasVisibleUi])

  // 亚克力底衬靠 --dcx/--dcy 反向平移钉在屏幕上：宿主（卡片/药丸）形变、位移时
  // 每帧同步一次，磨砂里的桌面才不会跟着卡片跑 —— 这是真实亚克力的物理表现。
  // （只在"有快照且界面活跃"期间跑，收起后自动停。）
  useEffect(() => {
    // 书写辅助期间 state 恒为 idle，但它的卡片同样要"钉屏磨砂"（否则磨砂里的桌面
    // 会跟着卡片跑，一眼假），所以这里要把 writingMode 也算进来。
    if (!snapshot || (state === 'idle' && !writingMode)) return
    let raf = 0
    const seen = new WeakMap<Element, string>()
    const tick = () => {
      document.querySelectorAll<HTMLElement>('[data-acrylic-host]').forEach((el) => {
        const r = el.getBoundingClientRect()
        const key = `${Math.round(r.left)},${Math.round(r.top)}`
        if (seen.get(el) === key) return
        seen.set(el, key)
        el.style.setProperty('--dcx', `${r.left}px`)
        el.style.setProperty('--dcy', `${r.top}px`)
      })
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [snapshot, state, writingMode])

  // 结果区"飞入序列"的总条目数 = 正文行数 + 结果卡片数。
  // 文字与卡片共用这条序列（卡片接在文字后面），所以两者都按同一个总数算节奏 →
  // 最后一张卡片飞完 = 最后一行飞完 = 框扩到位。
  const resultSequence = useMemo(() => ({
    lineCount: splitAnswerLines(agent.response).length,
    cardCount: agent.cards.length,
  }), [agent.response, agent.cards])

  return (
    <SnapshotContext.Provider value={snapshot}>
    <ResultSequenceContext.Provider value={resultSequence}>
    <div className="overlay-container"
      style={{
        // ⚠ 容器**不能**在 Dony 醒着时整屏接管鼠标。
        // 以前是 (active || visualMode) ? 'auto' : 'none'：只要 Dony 醒着，屏幕上任意
        // 位置 elementFromPoint 都会命中这层全屏容器 → 覆盖层全屏吃掉点击 →
        // 表现就是「Dony 的坐标点击（gui_click 移过去点下去）全部失效」，
        // 以及"桌面像卡死一样点不动"。
        // 现在只有真正的交互控件（卡片/药丸/按钮，见 .overlay-container>* 与各自的
        // pointer-events:auto）会接到点击；空处一律放行。视觉智能（整屏框选）例外。
        pointerEvents: visualMode ? 'auto' : 'none',
        ...(dismissing ? { animation: 'overlayFadeOut 0.2s ease-out forwards' } : {}),
      }}
    >
      {visualMode && (
        <VisualOverlay onClose={handleVisualClose} />
      )}

      {/* 书写辅助：**常驻挂载**，自己订阅选区事件 —— 它是被动触发的（用户在其他程序里选字），
          不走进唤醒状态机。enabled 为假时不进入：视觉智能与 Dony 会话都不该被它插一脚。 */}
      <WritingTools
        enabled={state === 'idle' && !visualMode}
        resetSignal={writingReset}
        onNeedSnapshot={captureSnapshot}
        onActiveChange={setWritingMode}
      />

      {(
        // 彩排走的是**同一段动画**：waking 一真就开跑，动画本体一行没改。
        // 区别只在回调 —— 彩排时四个回调全换成"吞掉"的版本，
        // 所以彩排期间不进状态机、不写任何界面状态。
        <LightSpot
          waking={state === 'waking' || warmup}
          onEdgeReached={warmup ? handleWarmupEdge : handleEdgeReached}
          onEdgeProgress={warmup ? handleWarmupProgress : handleEdgeProgress}
          onComplete={warmup ? handleWarmupComplete : handleWakeComplete}
          onHaloGone={warmup ? handleWarmupHaloGone : handleHaloGone}
        />
      )}
      {!visualMode && (warmup || (state !== 'idle' && state !== 'holding')) && (
        <RainbowEdges active keystrokePulse={warmup || voiceMode ? 0 : keystrokePulse}
        // ⚠ 语音模式**不再吃键盘脉冲**（本轮改）：语音时每来一条 partial/final-result 与
        //   audio-analysis 都会 bump 一次 keystrokePulse，于是光边被套上 .keystroke-pulse ——
        //   那个类的动画表会**替换**掉呼吸动画并每次重启（transform/blur 都在跳），
        //   正是"跳一下"的第二来源。语音这条路的表达权现在完全交给电平形变（10Hz + 线性）。
        // 彩排：不带任何真实状态（无键盘脉冲、无语音跳动、不做收边），
        // 只跟着光斑的真实进度延伸 —— 走的就是第一次真实唤醒的那条路径。
        // ⚠ 光边只跟**麦克风输入**跳动：以前把 voiceMode / ttsAlways 整段都接上去，
        //   于是 TTS 朗读时（麦克风把 Dony 自己的声音也分析进去了）光边一路在跳。
        //   现在只在"正在听你说"（voiceListening）时接音频分析；朗读期间一律不接。
        //   这样"始终朗读回答"（打字模式也在读）也不会再让光边跳。
        audioAnalysis={warmup ? null : (voiceListening ? voiceAnalysis : null)}
        visibleEdges={warmup ? undefined : (visibleEdges.length > 0 ? visibleEdges : undefined)}
        edgeProgress={warmup ? warmupProgressRef : edgeProgressRef} shrinkEdges={warmup ? false : edgesOvershoot} />
      )}

      {/* 彩排（补）：把**键入模式首屏那颗输入药丸**也真画一遍。
          之前彩排只演"光斑 + 光边"，而两条路的首唤醒代价并不一样（用户实测："彩排只对语音有效"）：
            · 语音：waking 期间 showMorph 为 false ⇒ 屏幕上就是光斑 + 光边 = 彩排演过的同一套 ⇒ 顺滑 ✓
            · 键入：showMorph 为 true ⇒ 还要**首次**挂 DonyMorph（输入药丸 + 亚克力 +
              左侧图标的 conic 彩虹 + blur(8px) + 混合模式 + 送信键 SVG）⇒ 这些**首次光栅化 / JIT**
              成本从没被付过 ⇒ 首唤醒时主线程被拖住 ⇒ 逐帧延伸的光边卡顿 ✗
          ⚠ 必须"真画但看不见"：窗口本身已是 opacity 0.01，这里再加 0.01 + 不接交互；
            **不能**改成 visibility/display:none —— 那样浏览器不绘制 ⇒ 白跑（光斑彩排当年就踩过这坑）。
          ⚠ 彩排能付的只有**一次性**成本（首帧光栅 / 代码首次执行 / 字体）；DonyMorph 的每次
            挂载开销不在彩排覆盖范围内，若首唤醒仍偏卡，下一步要从那儿下手。 */}
      {!visualMode && warmup && (
        <div aria-hidden
          style={{ position: 'fixed', left: '50%', top: '80%', transform: 'translateX(-50%)',
                   opacity: 0.01, pointerEvents: 'none', zIndex: 0 }}>
          <PillInput value="" onChange={noop} onSubmit={noop} prewarm />
        </div>
      )}

      {/* 语音 follow-up 过渡：旧结果框上飞 + 药丸回到首次位置 */}
      {!visualMode && inVoiceTransition && (
        <div className="stage-center" key="v-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="follow-up-stack" style={{width:420,position:'relative'}}>
            <motion.div className="card card-responding"
              initial={{opacity:1,y:0}}
              animate={{opacity:0,y:-80}}
              // 与下面新药丸的升起**同时结束**：同一时长、同一条幂曲线
              transition={{ duration: VOICE_RISE_SECONDS, ease: VOICE_RISE_EASE }}>
              <VoiceResponseBox content={agent.response} isStreaming={false} />
            </motion.div>
            <div style={{position:'absolute',top:0,left:0,right:0,height:64}}>
              <AnimatePresence>
                {!shrinking && (
                  <motion.div className="card-ready" key="pill"
                    // ⚠ 同样去掉 `.card`：它的 backdrop-filter 会把药丸的 fly-in 裁在
                    //   "最终下边缘 + 左右半圆"那条线上（首次唤醒靠 .dony-stage-input 的覆盖避开，
                    //   这里直接不套壳）。
                    style={{position:'absolute',inset:0,margin:'auto',width:'fit-content',height:'fit-content'}}
                    // 与**首次唤醒**同一套升起：从屏幕下方飞上来（与 DonyMorph 的 donyEnterRise 同值）。
                    // 药丸一开始就带着"第一个说出的文字"（过渡就是被第一个字触发的，见上面的 effect）。
                    // ⚠ 外层 y 归零：这颗药丸的"从下往上"由 **VoicePillInput 自己**负责
                    //   （enterFromY = 初始药丸高 × 3 = 156px，与首次唤醒逐值相同）。
                    //   原来这里又叠了 voiceRiseFrom()（≈ 屏幕下方 984px）⇒ 行程与首次**不一致**
                    //   （用户实测："追问的输入框飞入行程仍不统一"）。
                    // ⚠ initial={false}：**只留一条入场动作**。药丸的"从下往上飞入"由
                    //   VoicePillInput 自己负责（enterFromY = 156px + 淡入，entered 驱动）。
                    //   外层若再走一遍 PILL_FROM（浓度 + blur），两套会互相盖住 ——
                    //   外层的 blur 正好把"上飞"糊掉，观感就是"没看到飞入"（用户实测）。
                    initial={false}
                    animate={PILL_TO}
                    exit={{...PILL_EXIT, transition: PILL_FLY_OUT}}
                    transition={{ duration: VOICE_RISE_SECONDS, ease: VOICE_RISE_EASE }}>
                    {/* entering：药丸在飞入 → 文字不做逐字飞入，只"模糊 → 确认后清晰" */}
                    <VoicePillInput text={voiceText} isListening={false} isFollowUp
                      entering={voiceEntering}
                      // 形变收拢（受控）：过渡收尾时把自己的盒子缩到加载胶囊尺寸
                      collapse={pillCollapsing ? PILL_COLLAPSE : null} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}

      {/* DonyMorph：输入药丸 → 彩虹处理药丸 → 任务加载球/伸长药丸 → 打断询问方窗 → 结果框 */}
      {showMorph && (
        <div className="stage-center" onClick={(e) => e.stopPropagation()}>
          <DonyMorph
            // 键入模式在 waking 期间就已经是输入态（输入框正飞入）；
            // 若沿用原来的写法，waking 会被映射成 processing（因为 agent.stage 初值是 input）。
            stage={
              state === 'ready' || (state === 'waking' && !voiceMode)
                ? 'input'
                : agent.stage === 'input' ? 'processing' : agent.stage
            }
            submitKick={submitKick}
            fastMode={agent.mode === 'fast'}
            toolLabel={agent.toolLabel}
            ask={agent.ask}
            voiceMode={voiceMode}
            onAskAnswer={agent.answerAsk}
            inputSlot={voiceMode
              ? <VoicePillInput text={voiceText} isListening={voiceListening}
                  // 药丸本身正在飞入（首唤醒与追问共用同一个标记）→ 文字不飞入，只"模糊 → 清晰"
                  entering={voiceEntering} />
              : (
                <PillInput value={userInput} onChange={setUserInput}
                  onKeystroke={handleKeystroke} onEsc={handleClose}
                  // 输入建议：只在首屏输入这一处传（追问那颗不传 → 不会出现建议）
                  suggestions={suggestions}
                  onPickSuggestion={handlePickSuggestion}
                  onSuggestCollapseDone={handleSuggestCollapseDone}
                  onSubmit={() => userInput.trim() && handleSubmit(userInput.trim(), false)} />
              )}
            resultSlot={
              // 正文与结果卡片共用一个滚动区：卡片多时一起在框内滚。
              // （「继续输入药丸」在卡片外面，不会被滚走。）
              <div className="dony-result-stack">
                <div className="dony-result-scroll">
                  {voiceMode
                    // inMorph：告诉它"我在结果框里"，才会用与键入模式完全相同的那套
                    // 飞入（从框的最终底部起飞）。忘了传就会退化成独立语音小窗那套，
                    // 表现就是"语音模式的返回动画完全没被改过"。
                    ? <VoiceResponseBox content={agent.response} isStreaming={agent.isStreaming} inMorph />
                    : <ResponseBox content={agent.response} isStreaming={agent.isStreaming} />}
                  <ResultCards cards={agent.cards} />
                </div>
              </div>
            }
          />

          {/* 回答完成：结果框下方向上飞入继续输入药丸 */}
          {/* ⚠ 方案 A（挪门）：`AnimatePresence` 必须**常驻**，状态门要挪到它**里面**。
              原来的写法是 `{state === 'followUp' && (<AnimatePresence>…)}` —— 门在 AP 外面 ✗，
              于是提交追问时"整块连同 AP 一起被同一次提交卸载" ✗ ⇒ 药丸的 exit 与 layoutId
              投影**永远没有机会跑**（用户实测：直接消失 / 无形变）。挪进来之后 AP 常驻、
              被条件化的只是它的子节点 ⇒ 子节点移除时 AP 能播 exit，投影才有触发点。 */}
          {voiceMode ? (
            <AnimatePresence>
              {state === 'followUp' && (
                /* ⚠ 条件只能看**有没有文字**，不能看 voiceListening（这里原来写的是
                   `(!voiceListening || voiceText)`）：
                   · 没文字 → 应显示**单独设计的圆角药丸按钮**（下面那一支「继续对话」）；
                   · 有文字 → 才显示输入药丸。
                   按 listening 分会把"没在听 + 没文字"送进药丸那一支 → 药丸无文字时
                   宽度目标是 40px（Math.max(40,…)）而高度≈52px ⇒ 圆角 999px 把它渲染成
                   一颗**近圆的卵形**，里面还露出被裁切的占位符"向 Dony 提问"——
                   就是用户报的"像是圆形的输入框，标题被裁切"那颗 BUG。
                   ⚠ 这里必须是**纯 JS 块注释**，不能写成 JSX 那种花括号注释
                   —— 括号里只能有一个表达式，多一个 JSX 注释就成了两个兄弟 → 语法崩。
                   （也正因如此，注释文字里不能再出现块注释的结束符号。 ） */
                // ⚠ 这里**不能**写花括号：本层是 `{... && ( … )}` 的**表达式**位置，
                //   花括号会被解析成对象字面量（报 Property assignment expected）。
                voiceText ? (
                  <motion.div className="card-ready dony-follow-pill" key="fpill"
                    // ⚠ 刻意**不套 `.card`**（原来是 `card card-ready dony-follow-pill`）：
                    //   `.card` 自带 backdrop-filter:blur(36px) 与 overflow:hidden ——
                    //   而**非 none 的 backdrop-filter 会把全部后代裁进自己的 border-box（含圆角）**，
                    //   于是药丸从下方 156px 的飞入被裁在"最终下边缘 + 左右两个半圆"那条线上
                    //   （用户实测的那条裁切线）。首次唤醒没这问题，是因为它的卡片专门写过覆盖
                    //   （DonyMorph.css 的 .dony-stage-input：backdrop-filter:none + overflow:visible，
                    //   注释原文"药丸自己的投影要能落在卡片外，别被裁掉"）。
                    //   这里用更干净的办法：**不套那个壳**；材质由内层 .dony-acrylic 提供。
                    // ⚠ 外层的 y 必须是 **0**：这颗药丸的"从下往上飞入"由 **VoicePillInput 自己**
                    //   负责（enterFromY = 初始药丸高 × 3 = 156px，与首次唤醒同一套代码）。
                    //   原来这里又写 y: 24 → 两次位移叠加 ⇒ 起点比首次高 24px，
                    //   表现就是用户报的"追问的输入框飞入前位置没有和首次统一"。
                    // ⚠ initial={false}：**只留一条入场动作**。药丸的"从下往上飞入"由
                    //   VoicePillInput 自己负责（enterFromY = 156px + 淡入，entered 驱动）。
                    //   外层若再走一遍 PILL_FROM（浓度 + blur），两套会互相盖住 ——
                    //   外层的 blur 正好把"上飞"糊掉，观感就是"没看到飞入"（用户实测）。
                    initial={false}
                    animate={PILL_TO}
                    // 退出 = 朝"加载胶囊"收拢（状态指示类形变）。三条依据：
                    //   · **完整 transform 字符串**：framer 的 scaleX 简写走主线程 rAF，
                    //     而这条退出正好发生在框内内容重排、主线程繁忙的一刻 → 写 transform 更稳。
                    //   · **translateY(-6px)** 承担"朝上收"：加载胶囊在**上方**的框内。
                    //     （不用 style 设 transform-origin —— 其中一颗药丸本就有 style 用来定位，
                    //      再加一个 style 会造成 JSX 重复属性；方向感交给这个位移即可。）
                    //   · **blur(2px)**：两个独立子树交叉淡出/淡入时，不糊会看到"两个物体在叠"，
                    //     糊过之后眼睛只读到一次连续变形（也顺手遮掉 scaleX 对文字的横向挤压）。
                    //   时长 0.22s：UI 形变保持在 300ms 以内，退出要更快、更干脆。
                    // ⚠ layoutId 投影已撤除：它与幽灵的盒子（尺寸+圆角都不同）做插值时，
                    //   观感是"快速旋转着缩进去、然后胶囊突然出现"（用户实测原话）。
                    // ⚠ 已**撤除** layoutId 投影（曾经试过，两次都出问题：先是"快速旋转向内"，
                    //   后是"两个图形：一个飞入、一个在终点"）。根因是跨树投影要求"两个元素
                    //   恰好接力"，而实际上幽灵与药丸**必然同时存在**（同一个 layoutId 撞车）⇒
                    //   framer 会让它们互相投影，于是幻影与方向失控。现在形状改为**自成一树**的
                    //   盒子形变（见 VoicePillInput 的 collapse），这里只负责淡出。
                    exit={{ opacity: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
                    transition={PILL_FLY_IN}
                    onClick={(e) => { e.stopPropagation(); startVoiceFollowUp() }}>
                    <VoicePillInput text={voiceText} isListening={voiceListening} isFollowUp />
                  </motion.div>
                ) : !voiceListening && (
                  // ⚠ 「继续对话」按钮只在**没在听**时显示（用户："点击后消失"）：
                  //   点它会走 startVoiceFollowUp() → 立刻 setVoiceListening(true)
                  //   ⇒ 按钮随即消失，之后第一个字到达时直接换成输入药丸。
                  //   不需要额外的 "clicked" 状态，条件本身就是那个语义。
                  // 既没在听、也没识别到文字 → 不放输入框，只放一颗居中的小药丸按钮。
                  // 这一刻回答框已完全展开，它从下方一段距离向上飞入（y:92）到框的下方。
                  // 点它 = 原来那套（停朗读 → 开始收音 → 界面继续，行为未改）。
                  // 材质与其他卡片完全同款：壁纸磨砂 + 半透明色调 + 那条边缘细线
                  //（AcrylicLayer 默认就会画 ::after 那条 inset 细线，这里**保留**，不压掉）。
                  <motion.div className="dony-follow-continue" key="fcontinue"
                    data-acrylic-host=""
                    // 起飞距离 ×2：46 → 92（"框升起的距离放大为 2x"）
                    initial={{ opacity: 0, y: 92 }}
                    animate={{ opacity: 1, y: 0 }}
                    // 消失用**纯淡出**（用户："按钮消失用淡出"）：去掉原来的 y:92 下落，
                    // 只保留不透明度，并把时长放到 200ms 让"淡出"确实看得见。
                    exit={{ opacity: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
                    transition={PILL_FLY_IN}
                    onClick={(e) => { e.stopPropagation(); startVoiceFollowUp() }}>
                    <AcrylicLayer blur={ACRYLIC_BLUR.card} />
                    继续对话
                  </motion.div>
                )
              )}
            </AnimatePresence>
          ) : (
            state === 'followUp' && (
              <motion.div className="card-ready dony-follow-pill is-typing"
                // ⚠ `is-typing`：键入模式的追问框要**靠左**（左边缘 = 回答框左边缘）。
                //   同一个类也被语音模式那颗用着，而 `.dony-follow-pill` 的 `margin:auto`
                //   是为语音那颗加的（它要居中回到首次位置）⇒ 上面那条 auto 会把这里也居中
                //   （用户实测的回归："键入模式的追问框不是靠左对齐而是居中"）。
                //   .card-ready 是 width:fit-content 的壳 ⇒ auto 左右外边距真的会居中，必须分开。
                // ⚠ 同上：不套 `.card`（它的 backdrop-filter 会把键入追问药丸的飞入也裁掉）。
                initial={{...PILL_FROM, y: 24}} animate={PILL_TO}
                transition={PILL_FLY_IN}>
                <PillInput value={followUpInput} onChange={setFollowUpInput}
                  onKeystroke={handleKeystroke} onEsc={handleClose}
                  onSubmit={() => followUpInput.trim() && handleFollowUpSubmit(followUpInput.trim())}
                  placeholder="继续对话" isFollowUp />
              </motion.div>
            )
          )}
        </div>
      )}

      {/* 打字/语音进入输入阶段（ready）时也要有关闭按钮：之前只有提交之后才出现，
          用户刚唤醒、还没输入时只能按 Esc 退出 */}
      {!visualMode && (state === 'ready' || state === 'loading'
        || state === 'responding' || state === 'followUp') && (
        <button className="close-button" onClick={handleClose}
          // 执行期间整窗放行鼠标（否则会挡住 Dony 自己要点的地方），代价是连这个 X 也点不到。
          // 所以只给按钮本身开一扇小门：指针移上来时临时恢复接收鼠标，移开就还回去。
          // 作用范围只有一个按钮（约 32×32），比"整张卡片都恢复"安全得多。
          onMouseEnter={() => {
            if (stateRef.current === 'loading') window.electronAPI?.setVisualMousePassthrough?.(false)
          }}
          onMouseLeave={() => {
            if (stateRef.current === 'loading' && !agent.ask) {
              window.electronAPI?.setVisualMousePassthrough?.(true)
            }
          }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12M12 4L4 12" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {!window.electronAPI && state === 'idle' && !visualMode && (
        <button className="dev-wake-btn" onClick={doWake}>Press Space to wake | Alt+D voice | Alt+V visual</button>
      )}
    </div>
    </ResultSequenceContext.Provider>
    </SnapshotContext.Provider>
  )
}

export default App
