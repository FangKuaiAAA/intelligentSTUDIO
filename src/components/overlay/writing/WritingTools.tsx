import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { agentSocket } from '../../../utils/ws'
import {
  SelectionTag, TAG_BODY, TAG_TIP, TAG_WIDTH, TAG_HEIGHT,
  TAG_HIT, TAG_BOX_W, TAG_BOX_H,
} from './SelectionTag'
import { WriteMenu, MENU_WIDTH } from './WriteMenu'
import { ActionBar, BAR_WIDTH, BAR_HEIGHT } from './ActionBar'
import { RainbowScan } from './RainbowScan'
import { SidePanel } from './SidePanel'
import {
  toDip, toDipList, unionRect, isNearPoint, layoutTag, layoutMenu, layoutBar,
} from './writingGeometry'
import type { DipRect, PhysRect } from './writingGeometry'
import './WritingTools.css'

/** 菜单高度的估值：只用于"纵向能不能塞下"的夹取（顶部对齐锚点、超出屏幕就整体上移）。
 *  真实高度由内容决定，所以这里按"内容实高 + 一点余量"取，宁可估大不估小 ——
 *  估小会让底部被屏幕裁掉一截。 */
const MENU_HEIGHT_EST = 500
/** 指针离锚点多近算"靠近"（标签只有靠近才显示） */
const NEAR_PAD = 30
/** 读到"选区消失"后，等这么久再真的收界面（给瞬时抖动一个被纠正的机会） */
const EMPTY_EXIT_GRACE_MS = 450
/** 指针离**标签自身**多近仍算"靠近"。
 *  标签贴在锚点左侧、两者之间有间距，只看锚点的话指针一移向标签它就淡出并把
 *  pointer-events 关掉 —— 于是永远点不中（用户实测"标签点不动"就是这个）。 */
const TAG_PAD = 12

type Phase = 'tag' | 'menu' | 'working' | 'result'

/** 后端广播的选区载荷（见 backend/agent/selection.py） */
interface SelectionPayload {
  seq: number
  text: string
  rects: PhysRect[]
  anchor: PhysRect | null
  hwnd: number
  ctrl: string
  multiLine: boolean
  /** 位置记录：相对文档开头的字符偏移 + 长度（写回时按它定位，不依赖当前选区/内容） */
  pos?: { start: number; length: number } | null
  /** 双击 Ctrl 手动触发：直接展开改写面板；读不到选区时后端不会发这条广播 */
  manual?: boolean
}

/** 主进程回给渲染层的屏幕信息（对应 types.ts 里的 getWritingScreen） */
type WritingScreen = {
  scaleFactor: number
  bounds: { x: number; y: number; width: number; height: number }
  cursor: { x: number; y: number }
  accent: string
}

interface WritingToolsProps {
  /** 是否允许进入书写辅助（Dony 会话或视觉智能进行中时为 false） */
  enabled: boolean
  /** 每次 reset 递增（其它唤醒方式接管、界面复位）：据此静默收起 */
  resetSignal: number
  /** 需要一份桌面快照（亚克力底衬）时通知 App 去抓 */
  onNeedSnapshot: () => void
  /** 激活状态变化：App 用它做互斥与亚克力同步器条件 */
  onActiveChange: (active: boolean) => void
}

/**
 * 书写辅助的流程容器。
 *
 * 常驻挂载、自己订阅选区事件 —— 因为它是**被动触发**的：用户在其他程序里选字，
 * 后端把选区推上来，这里才决定要不要现身。App 只负责快照与互斥。
 *
 * 状态机：tag（选区旁的小标签）→ menu（修改选择框）→ working（改写中：彩虹扫描 + 横框）
 *        → result（结果已回：保留 / 复原 / 按住预览原文）→ 退出。
 */
export function WritingTools({
  enabled, resetSignal, onNeedSnapshot, onActiveChange,
}: WritingToolsProps) {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<Phase>('tag')
  const [rects, setRects] = useState<DipRect[]>([])
  const [anchor, setAnchor] = useState<DipRect | null>(null)
  const [label, setLabel] = useState('')
  const [edited, setEdited] = useState('')
  const [applied, setApplied] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [nearTag, setNearTag] = useState(false)
  /** Windows 系统主题色：标签小框的底色（主进程读注册表后下发） */
  const [accent, setAccent] = useState('#0078D4')
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth || 1, h: window.innerHeight || 1,
  }))

  // 回调只在挂载时注册一次，闭包里的值会过期 —— 一律走 ref 取最新（项目里 App.tsx 同一做法）
  const activeRef = useRef(false)
  const phaseRef = useRef<Phase>('tag')
  const enabledRef = useRef(enabled)
  const anchorRef = useRef<DipRect | null>(null)
  const hwndRef = useRef(0)
  /** 位置记录（字符偏移 + 长度）：这一轮要改的那段文字"在哪"，与内容无关 */
  const posRef = useRef<{ start: number; length: number } | null>(null)
  /** 是否处于"按住预览原文"状态 */
  const previewHoldRef = useRef(false)
  /** 按住看原文时，在选区原处盖一层原文（**不改文档**，松手即撤） */
  const [previewOriginal, setPreviewOriginal] = useState(false)
  /** 左侧竖居中面板：null=不显示；'result'=摘要/要点结果；'create'=创作需求输入 */
  const [sideMode, setSideMode] = useState<null | 'result' | 'create'>(null)
  const [sideText, setSideText] = useState('')
  const sideModeRef = useRef<null | 'result' | 'create'>(null)
  sideModeRef.current = sideMode

  // 「创作」卡一出现就要能打字 → 主动取一次焦点（只有 create 这一种；
  // 摘要/要点只是看结果，不该抢走目标程序的焦点）。
  // 写回前会用 AttachThreadInput 把焦点还给目标窗口，所以这里取焦点是安全的。
  useEffect(() => {
    if (!activeRef.current || sideMode !== 'create') return
    window.electronAPI?.setWritingFocus?.(true)
  }, [sideMode])

  // 新面板显示时把窗口恢复成"可聚焦"（里面的输入框要能打字）；收起时立刻交还焦点。
  // ⚠ 这个 effect 必须和其余 hooks 放在一起（`if (!active) return null` **之前**）：
  //   放到早退之后会违反 hooks 顺序 —— active 由 false 变 true 时 React 直接抛
  //   "Rendered more hooks than during the previous render"，整个覆盖层（含 Dony）
  //   跟着崩掉，表现就是"什么都没有、心跳中断、区域恒为 0"。
  // ⚠ 这里**不**在"面板打开"时就取焦点。
  //   取焦点会让目标窗口失焦、选区消失 —— 而那一整段文字的落点信息（位置账本）
  //   正是写回的依据；用户实测"创作之后所有文本不能被选中，横框的恢复就报错"。
  //   现在只在**真的点进输入框**时（输入框自己的 onMouseDown）才要焦点，
  //   单纯打开面板、看摘要、点替换/复制都不碰焦点。
  const textRef = useRef('')
  const editedRef = useRef('')
  const originalRef = useRef('')
  const seqRef = useRef(0)
  /** 当前会话对应的是"哪一次抬键"。同一次抬键的重复广播靠它认出来（见 writing-selection） */
  const gestureRef = useRef(0)
  /** enter 的代次：连续广播时作废更早那次还没回来的 enter（见 enter 开头） */
  const enterNoRef = useRef(0)
  /** 开新会话前的合并缓冲：一次划选常连来两条广播，只认最后一条（见 writing-selection） */
  const pendingRef = useRef<SelectionPayload | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 当前会话号（直接用后端广播的选区 seq）。
   *
   * 每一个 writing-* 请求都带上它，后端原样带回；回包对不上就丢弃。
   * 必需的理由：横框上的「复原 / 恢复」必然产生一次后端往返（取消 / 替换），
   * 而它可能晚到几百毫秒 —— 那时用户往往已经在选新文字、新一轮会话已经起来，
   * 一条迟到的 cancelled/replaced/result 会直接作用到新会话上：把新会话打死
   * （标签还在、会话已死，点上去自然"异常"），甚至把上一轮的改写结果写进新选区。
   */
  const sidRef = useRef(0)
  /** "选区消失"的去抖定时器：读空不立刻收界面，见选区事件处理里的说明 */
  const emptyExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRef = useRef(false)
  const nearRef = useRef(false)
  /** 本次 replace 的用途：应用结果 / 复原 */
  const replaceIntentRef = useRef<'apply' | 'revert'>('apply')
  /** 指针是否已经压到输入框上（"提前恢复可聚焦"只做 false→true 这一侧） */
  const focusWantedRef = useRef(false)
  /** 标签自身的矩形：靠近判定要把它一起算进去（见命中测试里的说明） */
  const tagRectRef = useRef<DipRect | null>(null)
  /** 上次向后端续期"停查"的时刻（见命中测试里的周期续期） */
  const lastPingRef = useRef(0)
  /** 覆盖层窗口原点（屏幕 DIP）。后端派发来的点击是**屏幕**坐标，得先换成窗口内坐标 */
  const screenOriginRef = useRef({ x: 0, y: 0 })
  /** 上一次"真实 DOM mousedown"的时刻：物理点击派发要避开它，免得同一次点击执行两遍 */
  const lastRealDownAt = useRef(0)

  phaseRef.current = phase
  enabledRef.current = enabled
  editedRef.current = edited

  useEffect(() => {
    const onResize = () => setViewport({
      w: window.innerWidth || 1, h: window.innerHeight || 1,
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * 指针是否落在书写元素上。
   *
   * ⚠ 鼠标**接管**不走这里了：改由主进程按"上报的矩形"轮询（见下面的 setWritingHitRects）。
   *   原来的 renderer → elementFromPoint → IPC → 主进程 这条链路实测不可靠
   *   （用户看到的是"标签明明在，点上去毫无反应"，且只有第一次能用）。
   *   这里现在只负责告诉**后端**"用户正在操作界面"，好让它这段时间停止查询选区 ——
   *   否则它会把"我们自己窗口持有焦点"误读成"选区消失"，把界面收掉。
   */
  const setHover = useCallback((over: boolean) => {
    if (hoverRef.current === over) return
    hoverRef.current = over
    agentSocket.send({ type: 'writing-user-active', active: over })
  }, [])

  /** 收起整个过程。silent = 窗口已经被别处收走（reset），不要重复下发 */
  const exit = useCallback((silent = false) => {
    if (!activeRef.current) return
    if (emptyExitTimerRef.current) {
      clearTimeout(emptyExitTimerRef.current)
      emptyExitTimerRef.current = null
    }
    // 还没起来的会话也别再起来了（见 writing-selection 里的 90ms 合并缓冲）
    pendingRef.current = null
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
    activeRef.current = false
    setActive(false)
    setRects([]); setAnchor(null); anchorRef.current = null
    textRef.current = ''; hwndRef.current = 0
    setNearTag(false); nearRef.current = false
    setBusy(false); setMessage(''); setEdited(''); setApplied(false)
    setHover(false)
    onActiveChange(false)
    // 焦点纪律：绝不把焦点留在覆盖层上（目标程序还等着接住粘贴与后续输入）
    focusWantedRef.current = false
    window.electronAPI?.setWritingFocus?.(false)
    window.electronAPI?.setWritingActive?.(false)
    // 界面收起了：后端不必再把物理点击派发过来（否则会往一个空界面里点）
    agentSocket.send({ type: 'writing-ui', active: false })
    if (!silent) window.electronAPI?.hideOverlay?.()
  }, [onActiveChange, setHover])

  /** 进入：把物理像素换算成窗口内 DIP，并让主进程把覆盖层显示出来（不抢焦点） */
  const enter = useCallback(async (payload: SelectionPayload) => {
    // 会话开头常常连着来两条广播：作废更早那次还没回来的 enter ——
    // 它的 await 可能后到，把新会话的锚点/选区覆盖成旧的（标签先跳到旧位置再跳回来）。
    const myNo = enterNoRef.current + 1
    enterNoRef.current = myNo
    // 上一轮"选区消失"的去抖定时器必须掐掉：否则它会在新会话起来之后把界面收掉
    // （这条以前由 exit() 负责，现在中途换会话不再卸载界面，要在这里补上）
    if (emptyExitTimerRef.current) {
      clearTimeout(emptyExitTimerRef.current)
      emptyExitTimerRef.current = null
    }
    // 每次都重新取：除了缩放与屏幕原点，它还给回"当前指针位置"（指针是实时量，不能缓存）
    // ⚠ 取屏幕信息这一段必须能报错、能留痕：它一旦失败，整个流程会**静默**什么都不做，
    //   用户看到的就是"选了字、什么都没出现"，而日志里连一行都没有 —— 这种无声失败
    //   是最难查的故障（本轮排查就走了这段弯路）。
    let screen: WritingScreen | null = null
    try {
      screen = (await window.electronAPI?.getWritingScreen?.()) ?? null
    } catch (e) {
      window.electronAPI?.logMain?.(`[wr] 放弃本次触发：取屏幕信息抛错 ${String(e)}`)
      return
    }
    if (!screen) {
      window.electronAPI?.logMain?.('[wr] 放弃本次触发：拿不到屏幕信息')
      return
    }
    // 取屏幕信息是异步的：这期间可能又来了更新的选区（我已被作废），别再往下写状态
    if (myNo !== enterNoRef.current) return
    const dipRects = toDipList(payload.rects || [], screen)
    // 选框偏移排查：把"物理矩形 → 缩放 → DIP"这条换算打出来。
    // 若 DIP 与物理/scale 对不上，就是换算错；若换算对但屏幕上看偏，
    // 就是目标程序自己报的矩形偏（记事本/UWP 应用的 UIA 矩形确实偏过）。
    {
      const r0 = (payload.rects || [])[0]
      const d0 = dipRects[0]
      window.electronAPI?.logMain?.(
        `[wr] 选框换算 scale=${screen.scaleFactor} `
        + `物理=${r0 ? `${Math.round(r0[0] ?? (r0 as any).x)},${Math.round(r0[1] ?? (r0 as any).y)} ` +
          `${Math.round(r0[2] ?? (r0 as any).width)}x${Math.round(r0[3] ?? (r0 as any).height)}` : '无'} `
        + `→ DIP=${d0 ? `${Math.round(d0.x)},${Math.round(d0.y)} ${Math.round(d0.w)}x${Math.round(d0.h)}` : '无'}`,
      )
    }
    if (!dipRects.length) {
      window.electronAPI?.logMain?.(
        `[wr] 放弃本次触发：换算后矩形为空（原始 ${(payload.rects || []).length} 块，`
        + `scale=${screen.scaleFactor} 原点=${screen.bounds?.x ?? 0},${screen.bounds?.y ?? 0}）`,
      )
      return
    }
    const anchorDip = toDip(payload.anchor || payload.rects[0], screen)
    setRects(dipRects)
    setAnchor(anchorDip)
    anchorRef.current = anchorDip
    textRef.current = payload.text
    hwndRef.current = payload.hwnd
    posRef.current = payload.pos ?? null
    setLabel('')
    setEdited('')
    setApplied(false)
    setMessage('')
    setBusy(false)
    setAccent(screen.accent || '#0078D4')
    screenOriginRef.current = {
      x: Number(screen.bounds?.x) || 0,
      y: Number(screen.bounds?.y) || 0,
    }
    // 划完选字那一刻指针通常还停在选区附近（反向划选时正好就在第一个字旁边），
    // 所以用一次实时指针位置决定标签的初始显隐，而不是一律先藏起来等用户动鼠标。
    const nearNow = screen.cursor
      ? isNearPoint(screen.cursor, anchorDip, NEAR_PAD)
      : false
    setNearTag(nearNow); nearRef.current = nearNow
    setPhase('tag')
    activeRef.current = true
    setActive(true)
    window.electronAPI?.logMain?.(`[wr] 进入书写辅助：锚点(${Math.round(anchorDip.x)},${Math.round(anchorDip.y)}) 首帧显示标签=${nearNow}`)
    onNeedSnapshot()
    onActiveChange(true)
    window.electronAPI?.setWritingActive?.(true)
    // 告诉后端"界面正显示着"：它据此把物理点击派发过来（见 writing-click 的处理）
    agentSocket.send({ type: 'writing-ui', active: true })

    // 指针有可能已经停在那里（不动就不会有 mousemove，命中测试也就永远不会跑）。
    // 下一帧主动做一次上报，否则会出现"标签已经显示、窗口却没接管鼠标、点上去毫无反应"。
    if (screen.cursor) {
      const { cursor } = screen
      requestAnimationFrame(() => {
        if (!activeRef.current) return
        const el = document.elementFromPoint(cursor.x, cursor.y) as HTMLElement | null
        setHover(!!(el && el.closest('[data-wt-hit]')))
      })
    }
  }, [onActiveChange, onNeedSnapshot, setHover])

  const enterRef = useRef(enter)
  const exitRef = useRef(exit)
  enterRef.current = enter
  exitRef.current = exit

  /** 请后端把选区文字换成 next；expected 必须是**当前**选区里的文字（用于校验与找回） */
  const requestReplace = useCallback((intent: 'apply' | 'revert', expected: string, next: string) => {
    replaceIntentRef.current = intent
    // 焦点先让回目标程序：留在我们这边的话，粘贴会落到错误的地方
    focusWantedRef.current = false
    window.electronAPI?.setWritingFocus?.(false)
    agentSocket.send({
      type: 'writing-replace',
      sid: sidRef.current,
      hwnd: hwndRef.current,
      expected,
      text: next,
      // 位置记录：后端据此重建区间，用户在生成期间乱点/重选都不影响写回
      pos: posRef.current,
    })
  }, [])

  // ---------- 选区与改写事件 ----------
  useEffect(() => {
    /**
     * 进入一轮会话，并在"双击 Ctrl 手动触发"时直接展开改写面板。
     *
     * enter 是异步的（要先取屏幕缩放/原点），它内部会把阶段置回 tag；
     * 所以菜单必须在 enter 的 Promise 兑现之后再设，否则会被它覆盖。
     */
    const enterAndMaybeOpenMenu = (p: SelectionPayload) => {
      void enterRef.current(p)
        .then(() => {
          if (!p.manual || !activeRef.current) return
          window.electronAPI?.logMain?.('[wr] 双击 Ctrl → 直接展开改写面板')
          setPhase('menu')
        })
        .catch((e) => {
          window.electronAPI?.logMain?.(`[wr] 进入书写辅助失败：${String(e)}`)
        })
    }
    const off = agentSocket.on((m: Record<string, any>) => {
      if (m.type === 'writing-selection') {
        const seq = Number(m.seq) || 0
        // 过期事件丢弃（快速连续选词会追上旧的）。
        // seq 重新从 1 开始 = 后端刚重启（渲染进程没重启、seqRef 还停在旧值），
        // 这时必须接受，否则后端重启后的前 N 次选字会被整段吞掉，
        // 表现就是"怎么选都没反应"。
        if (seq <= seqRef.current && seq !== 1) return
        seqRef.current = seq
        // 排查观测点：把"前端到底收没收到广播"钉死在日志里（字数不记内容）
        window.electronAPI?.logMain?.(
          `[wr] 收到选区 seq=${seq} 字数=${String(m.text || '').length}`
          + ` gesture=${Number(m.gesture) || 0} 本轮=${gestureRef.current}`
          + ` 相=${phaseRef.current} 活动=${activeRef.current}`,
        )
        if (!m.text) {
          // 横框已经立起来（working / result）时，空选区广播**不许收界面**：
          // 需求是"横框只能由保留/复原退出"，在别处点一下不该让它消失。
          if (phaseRef.current === 'working' || phaseRef.current === 'result') return
          // 选区"消失"**不能立刻信**：它有两种来源 ——
          //   ① 用户真的点了别处（该收起界面）
          //   ② 我们自己的动作造成的瞬时状态（替换粘贴后目标程序里只剩光标、
          //      焦点瞬移、UIA 在某一瞬间读到的空档…）
          // 后者会在几百毫秒内被下一次广播纠正，所以这里等一小会儿再收：
          // 期间只要来了一条新选区，就把这次"消失"当没发生过。
          // ⚠ 这一层去抖是必需的：实测"粘贴后紧接着的第二次划选"会读到 0 字，
          //   旧的"读空即收"会让新会话在起来 150ms 后就自己死掉 ——
          //   用户看到的就是"界面闪一下就没了 / 标签点不动"。
          // 选区没了：别再按刚才缓存的选区去开会话
          pendingRef.current = null
          if (pendingTimerRef.current) {
            clearTimeout(pendingTimerRef.current)
            pendingTimerRef.current = null
          }
          if (emptyExitTimerRef.current) clearTimeout(emptyExitTimerRef.current)
          emptyExitTimerRef.current = setTimeout(() => {
            emptyExitTimerRef.current = null
            // 指针还压在界面上（用户正在看菜单/横框）就别收：这时候的空选区广播
            // 多半是我们自己把光标挪动造成的误读，收掉就会"界面几秒后自己消失"。
            if (hoverRef.current) return
            exitRef.current()
          }, EMPTY_EXIT_GRACE_MS)
          return
        }
        if (emptyExitTimerRef.current) {
          clearTimeout(emptyExitTimerRef.current)
          emptyExitTimerRef.current = null
        }
        if (!enabledRef.current) return
        // 同一次抬键可能被后端读两次（查询重试、停查窗口结束后的补查）：seq 会变、
        // 内容却完全一样。那不是新动作 —— 认出来丢掉，否则会话会被重开、
        // 刚打开的菜单会在用户眼皮底下被拆掉（菜单点不中）。
        const gesture = Number(m.gesture) || 0
        if (gesture && activeRef.current && gesture === gestureRef.current) return
        if (gesture) gestureRef.current = gesture
        if (activeRef.current) {
          // 会话进行中又来了选区：**原地换一轮**。
          //
          // ⚠ 绝不能 exit() 再 enter()。exit 会把 active 置假，整个界面（标签/菜单/横框）
          //   随之卸载，enter 再把它们重新挂回来 —— 用户看到的就是"标签先闪一下、
          //   然后带着位移淡出淡入"（壳被拆了重建，观感像先向下飞出、再向上飞入），
          //   而一次会话开头往往连着来两条广播，于是闪两三次。
          //   enter() 自己就会把 rects / anchor / near / phase 全部重置成新一轮，
          //   所以只要不卸载，标签就是**原地**换到新锚点。
          //
          // ⚠ 也不要用"文字是否相同"去丢弃广播：改写结果与原文常常一字不差
          //   （校对后原文没变），那会把用户真实的新划选吞掉。
          if (phaseRef.current === 'working') {
            // 模型还在跑：先撤掉在途请求，否则它的回包会被当成新会话的结果写回去
            agentSocket.send({ type: 'writing-cancel', sid: sidRef.current })
          }
          sidRef.current = seq
          enterAndMaybeOpenMenu(m as SelectionPayload)
          return
        }
        // 一次划选常常连着来**两条**广播：UIA 树刷新前后各读一次，第一条的锚点可能
        // 还是上一次/选区末尾的位置。立刻开一轮的话，标签会先挂到那个错位置闪一下、
        // 紧接着跳到正确位置（用户："闪一下，然后右下到最终位置"）。
        // 所以先收 90ms，把同一批广播合并成一次再用**最后一条**开会话 ——
        // 标签只挂一次、直接落在最终位置。90ms 肉眼无感。
        pendingRef.current = m as SelectionPayload
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = setTimeout(() => {
          pendingTimerRef.current = null
          const p = pendingRef.current
          pendingRef.current = null
          if (!p || activeRef.current || !enabledRef.current) return
          // 一次选区广播 = 一轮新会话：换号，之后所有回包都按它核对
          sidRef.current = Number(p.seq) || seqRef.current
          enterAndMaybeOpenMenu(p)
        }, 90)
        return
      }

      // 物理点击派发（后端读按键 → 这里做命中 → 直接派发 DOM 点击）。
      // 为什么要这条路：覆盖层是透明窗，真实环境里出现过"系统确认点击落在我们窗口上、
      // Chromium 却没把它变成 DOM 事件"——渲染层一次 mousedown 都收不到，
      // 于是标签/菜单看得见却怎么点都没反应。这条路不经过 Chromium 的输入分发。
      if (m.type === 'writing-click') {
        if (!activeRef.current) return
        // 真实点击已经到过渲染层（正常机器上就是这种情况）：不要重复派发
        if (performance.now() - lastRealDownAt.current < 500) return
        const o = screenOriginRef.current
        const x = Number(m.x) - o.x
        const y = Number(m.y) - o.y
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const hitEl = el ? el.closest('[data-wt-hit]') : null
        if (!hitEl) {
          // 这一下按在了界面之外（编辑器里）：立刻让主进程把鼠标让出去。
          // 标签的热区贴着选区开头，用户从第一个字开始划选时，
          // 这一下会被我们还占着的热区整段吞掉（"记事本不能拖了"）。
          // 面板开着时，点旁边 = 关闭（新卡不再有"关闭"按钮）
          if (sideModeRef.current) {
            setSideMode(null)
            exitRef.current()
            return
          }
          window.electronAPI?.writingPointerDownOutside?.()
          return
        }
        const target = (el!.closest('button, [role="button"], input, textarea')
          || hitEl) as HTMLElement
        const tag = `${target.tagName.toLowerCase()}.${String(target.className || '').split(' ')[0]}`
        window.electronAPI?.logMain?.(
          `[wr] 物理点击派发 @${Math.round(x)},${Math.round(y)} → ${tag}`,
        )
        // 按下反馈：只有横框上的按钮做"小幅提亮"，其余元素保持移入/按下都不变。
        if (target.closest('.wt-bar, .wt-side')) {
          document.querySelectorAll('.wt-bar .is-pressed, .wt-side .is-pressed')
            .forEach((n) => n.classList.remove('is-pressed'))
          target.classList.add('is-pressed')
        }
        // 「预览原文」= 按住时把原文写进文档，松开时写回修改后的内容。
        // 它不能只靠 DOM 的 mousedown/mouseup（窗口穿透，收不到），
        // 所以按下这一下由这里驱动，抬起由下面的 writing-pointer-up 驱动。
        if (target.classList.contains('wt-bar-preview') && phaseRef.current === 'result') {
          // 「按住看原文」**不再改写文档**：写回在这个阶段经常失败（找不到文字/不支持
          // 按位置定位），而且用户要的是"原文在**原处**显示" —— 所以直接在选区位置
          // 盖一层原文。松手即撤掉，文档一个字节都不动。
          previewHoldRef.current = true
          setPreviewOriginal(true)
          window.electronAPI?.logMain?.(
            `[wr] 按住预览：选区块 ${rects.length} 个，原文 ${originalRef.current.length} 字`,
          )
          return
        }
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        // 窗口始终点击穿透，真实点击不会给输入框焦点 —— 这里直接给，
        // 并请主进程把窗口恢复成"可聚焦 + 聚焦"，否则键打不进去。
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          try { (target as HTMLInputElement).focus() } catch { /* 忽略 */ }
          window.electronAPI?.setWritingFocus?.(true)
        }
        return
      }

      // 物理抬起（后端读按键补发）：清掉按下高亮；如果在"按住预览"，把修改版写回去。
      if (m.type === 'writing-pointer-up') {
        document.querySelectorAll('.wt-bar .is-pressed, .wt-menu .is-pressed, .wt-side .is-pressed')
          .forEach((n) => n.classList.remove('is-pressed'))
        if (previewHoldRef.current) {
          previewHoldRef.current = false
          setPreviewOriginal(false)
        }
        return
      }

      // 余下都是"某一轮会话的回包"：先核对会话号，过期的一律丢弃（见 sidRef 的说明）。
      const sid = Number(m.sid) || 0
      if (sid && sid !== sidRef.current) {
        window.electronAPI?.logMain?.(
          `[wr] 丢弃过期回包 ${m.type}（sid=${sid} 当前=${sidRef.current}）`,
        )
        return
      }

      if (m.type === 'writing-stage') {
        // 打一行：只要它出现，就说明**请求确实到了后端并被受理**。
        // 后端的 stdout 有时挂在已关闭的旧控制台上（复用了孤儿进程），
        // 这条前端日志就是判断"请求到没到"的唯一可靠依据。
        window.electronAPI?.logMain?.(
          `[wr] 后端已受理 action=${m.action} 标签=${m.label}`,
        )
        if (!activeRef.current) return
        // 已有标题就不覆盖：自定义要求（在修改面板输入框回车）的标题就是那段要求本身
        setLabel((prev) => prev || String(m.label || ''))
        setMessage('')
        setBusy(true)
        setPhase('working')
        return
      }

      if (m.type === 'writing-result' && m.ok === false) {
        // 后端拒绝了这次请求（典型："没有可用于处理的选中文字"）。
        // ⚠ 以前这里没有分支 → 失败被静默吞掉，用户只看到"点了没反应"。
        if (!activeRef.current) return
        window.electronAPI?.logMain?.(`[wr] 后端拒绝：${String(m.message || '未知原因')}`)
        setBusy(false)
        setMessage(String(m.message || '处理失败'))
        setPhase('result')
        return
      }

      if (m.type === 'writing-result') {
        window.electronAPI?.logMain?.(
          `[wr] 收到结果 ok=${m.ok !== false} 原文=${String(m.original || '').length}字 `
          + `结果=${String(m.text || '').length}字`,
        )
        if (!activeRef.current) return
        setBusy(false)
        if (!m.ok) {
          setMessage(String(m.message || '处理失败'))
          setPhase('result')
          setApplied(false)
          return
        }
        // 摘要 / 要点：结果只进左侧面板，**不写回文档** —— 等用户点「替换」再写
        if (sideModeRef.current === 'result') {
          originalRef.current = String(m.original || textRef.current)
          setSideText(String(m.text || ''))
          setBusy(false)
          setPhase('result')
          return
        }
        const original = String(m.original || textRef.current)
        const next = String(m.text || '')
        originalRef.current = original
        setLabel(String(m.label || ''))
        setEdited(next)
        setPhase('result')
        // 结果一到就立刻写回选区（需求：模型返回后彩虹扫描结束并直接替换）
        // 写回时在**行首补一个回车**：模型输出常常紧贴着上一行，直接贴会与前文黏在一起。
      // 只加在 apply 这一侧 —— 「复原」必须逐字还原原文，不能带这个回车。
      requestReplace('apply', original, `\n${next}`)
        return
      }

      if (m.type === 'writing-replaced') {
        if (!activeRef.current) return
        if (m.ok) {
          // ⚠ 预览原文也是一次改回原文的替换（intent='revert'），但它**不能**收横框：
          //   否则"按住预览"松手前横框就没了（用户报的"预览点击后横框消失"）。
          if (replaceIntentRef.current === 'revert' && !previewHoldRef.current) {
            exitRef.current()
            return
          }
          setApplied(true)
          setMessage('')
          return
        }
        setApplied(false)
        setMessage(`未写入：${String(m.message || '未知原因')}`)
        return
      }

      if (m.type === 'writing-cancelled') {
        exitRef.current()
      }
    })
    return off
  }, [requestReplace])

  // ---------- 标签显隐：由主进程按真实指针位置回推 ----------
  // 主进程每 60ms 轮询系统指针位置，落在"靠近区"里就发一次，变化时才发。
  // 这条链路不依赖渲染层能否收到 mousemove（穿透/转发状态一变事件就不进来，
  // 表现是标签不出现或看得见却点不动，且日志里没有任何痕迹）。
  useEffect(() => {
    const off = window.electronAPI?.onWritingNear?.((near) => {
      if (!activeRef.current || phaseRef.current !== 'tag') return
      if (near === nearRef.current) return
      nearRef.current = near
      setNearTag(near)
      window.electronAPI?.logMain?.(`[wr] 标签显隐=${near}（主进程判定）`)
    })
    return off
  }, [])

  // 其它唤醒方式接管 / 界面复位：静默收起（窗口已经由别处处理）
  useEffect(() => {
    if (resetSignal === 0) return
    exitRef.current(true)
  }, [resetSignal])

  // ---------- 指针：命中测试（决定主进程要不要接管鼠标）+ 标签"靠近才显示" ----------
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!activeRef.current) return
      // elementFromPoint 是纯布局命中，窗口处于穿透状态时同样有效 ——
      // 这也是为什么不用元素自己的 mouseenter：穿透时那些事件根本不会派发。
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const over = !!(el && el.closest('[data-wt-hit]'))
      setHover(over)
      // 悬停期间周期性续期后端的"停查"窗口：那个窗口有超时（默认 5s），
      // 用户在菜单上停留超过它之后，下一次点击就会重新查询选区 ——
      // 而那一刻焦点多半在我们这边，查询结果并不可信。
      if (over) {
        const now = performance.now()
        if (now - lastPingRef.current > 2500) {
          lastPingRef.current = now
          agentSocket.send({ type: 'writing-user-active', active: true })
        }
      }
      // 指针一压到输入框上就先把窗口恢复成"可聚焦"。
      // 覆盖层在进入时是"不可激活"的（为了不抢走目标程序的选区），若等 click 之后再恢复，
      // 那一下点击已经过去了 —— 表现就是"点了却打不进字"。这里只做 false→true 一侧，
      // 离开时**不**撤销，免得正在打字的人被中途踢掉焦点。
      // ⚠ 这里**不再**因为"指针压到输入框上"就去取窗口焦点。
      //   覆盖层一旦拿到焦点，目标窗口就失焦：随后写回时 SetForegroundWindow 从
      //   非前台进程调用常常失败，UIA 拿到的"焦点控件"变成我们自己的窗口，
      //   于是报"找不到那段文字了"。
      //   现在只有**真正点进输入框**（物理点击派发那一路）才取焦点，其余时刻一律不取。
      // 「标签是否该显示」**不在这里判**：改由主进程按真实指针位置回推
      // （见上面的 onWritingNear 订阅）。
      // 这里原来的 mousemove 判定是整条链路里最脆的一环：一旦转发的 mousemove
      // 没进来（窗口穿透/转发状态、程序化移动指针…），标签就永远不显示、
      // 也不上报矩形，外部表现是"标签不出现/看得见却点不动"，且日志里没有任何痕迹。
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [setHover])

  // ---------- 把"需要接管鼠标的区域"报给主进程 ----------
  // 坐标直接用 getBoundingClientRect：覆盖层铺满主屏且原点在 (0,0)，所以窗口内 DIP
  // 就等于屏幕 DIP，与主进程 screen.getCursorScreenPoint() 同一套坐标。
  //
  // 为什么用 rAF 持续报：菜单与横框在展开动画里尺寸一直在变，只在"定稿后"报一次会漏掉
  // 展开途中的中间态 —— 而那恰恰是用户最可能点击的时刻。每帧只在矩形真的变化时才发 IPC。
  useEffect(() => {
    if (!active) {
      window.electronAPI?.setWritingHitRects?.([])
      return
    }
    let raf = 0
    let lastJson = ''
    let lastSentAt = 0
    const tick = () => {
      // 会话已经结束时立刻停手：exit() 是同步把 activeRef 置假的，
      // 而 effect 的清理要等下一次渲染 —— 中间这段时间若继续发心跳，
      // 主进程会把"刚刚退出的会话"又补回来（窗口被重新显示、收窗也被作废）。
      if (!activeRef.current) return
      const rects: Array<{ x: number; y: number; width: number; height: number }> = []
      // "靠近区"（锚点外扩 NEAR_PAD）**无条件上报**，主进程据此判断指针是否靠近锚点。
      // 为什么不让渲染层自己用 mousemove 判断：那条链路不可靠 —— 一旦转发的
      // mousemove 没进来（窗口的鼠标穿透/转发状态、程序化移动指针等），
      // 标签就永远不会显示、也不会把矩形报上去，外部表现正是"标签不出现/点不动"，
      // 而且日志里连一行都没有，极难定位。主进程每 60ms 轮询真实指针位置，
      // 与"能不能收到事件"无关，是唯一可靠的来源。
      // 范围取"锚点外扩 NEAR_PAD"与"标签自身外扩 TAG_PAD"的并集 ——
      // 与旧的判定条件等价：标签贴在锚点左侧、两者之间有间距，只看锚点的话，
      // 指针一移向标签就越界、标签自己淡出并关掉 pointer-events，于是永远点不中。
      let zone: { x: number; y: number; width: number; height: number } | null = null
      if (phaseRef.current === 'tag' && anchorRef.current) {
        const a = anchorRef.current
        const boxes = [
          { x: a.x - NEAR_PAD, y: a.y - NEAR_PAD, w: a.w + NEAR_PAD * 2, h: a.h + NEAR_PAD * 2 },
        ]
        if (tagRectRef.current) {
          const t = tagRectRef.current
          boxes.push({ x: t.x - TAG_PAD, y: t.y - TAG_PAD, w: t.w + TAG_PAD * 2, h: t.h + TAG_PAD * 2 })
        }
        const u = unionRect(boxes)
        zone = { x: u.x, y: u.y, width: u.w, height: u.h }
      }
      // ⚠ 三个元素一律量**真实渲染盒子**（getBoundingClientRect），不要用算出来的坐标。
      //   标签原来用的是计算出的 tagPos，而菜单/横框用渲染盒子 —— 这个不一致是个隐患：
      //   只要祖先带上任何 transform / zoom / 含变换的动画（或热区与可见图形不一致），
      //   实际渲染位置就与算出来的坐标不同，于是"指针明明在标签上、轮询却说不在"，
      //   覆盖层永远不接管鼠标，点击全部穿透（用户实测的"点不动"）。
      //   getBoundingClientRect 拿到的正是用户看到、也会点到的那块矩形。
      // 标签仍受"此刻是否可见"约束：不可见时（opacity 0）它照样有盒子，
      // 不设这道门，屏幕那一小块会被一直占着、挡掉底下的点击。
      const measured: Array<[string, boolean]> = [
        ['.wt-tag', phaseRef.current === 'tag' && nearRef.current],
        ['.wt-menu', true],
        ['.wt-bar', true],
      ]
      for (const [selector, enabled] of measured) {
        if (!enabled) continue
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) continue
        const box = el.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) {
          rects.push({ x: box.left, y: box.top, width: box.width, height: box.height })
        }
      }
      const json = JSON.stringify([rects, zone])
      // 变化时立刻发；没变化也每 500ms 重发一次（心跳）。
      // 心跳是"两边状态自愈"的兜底：主进程若因别的原因丢了书写模式标记
      // （收窗、被别的唤醒方式接管…），只要界面还在，这条心跳就能让它重新对上，
      // 否则会出现"标签明明在、鼠标却永远不接管"——且只有变化时才发的写法永远补不回来。
      const now = performance.now()
      if (json !== lastJson || now - lastSentAt > 500) {
        lastJson = json
        lastSentAt = now
        window.electronAPI?.setWritingHitRects?.({ rects, zone })
        // 单独的"存活"信标，与矩形无关：标签不可见时矩形本来就是空的，
        // 只靠矩形判断"界面还在不在"会在最关键的时刻（用户把指针移向标签）
        // 分不出"界面没了"和"界面在、只是没东西可点"。
        window.electronAPI?.setWritingAlive?.(true)
        // 同时用**屏幕坐标**把矩形发给后端。书写模式窗口现在始终点击穿透，
        // 于是点我们界面时，那一下**同时**也会落到下面的编辑器里（光标被挪走、
        // 选区被点没）。后端拿这份矩形就能判断"这次抬起是落在我们界面上"，
        // 从而跳过重读选区 —— 不跳过的话，点一下标签会话就被读空、当场结束。
        const o = screenOriginRef.current
        agentSocket.send({
          type: 'writing-ui',
          active: true,
          rects: rects.map((r) => ({
            x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height,
          })),
        })
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      window.electronAPI?.setWritingHitRects?.([])
    }
  }, [active])

  // ---------- 布局 ----------
  const tagPos = useMemo(
    () => (anchor
      ? layoutTag(anchor, { bodyW: TAG_BODY, bodyH: TAG_HEIGHT, tip: TAG_TIP }, viewport)
      : { x: 0, y: 0 }),
    [anchor, viewport],
  )

  // 标签矩形同步给"靠近"判定用。**不能用 DOM 查询**：标签隐藏时 pointer-events 是 none，
  // 命中测试查不到它，判定就会自锁在"隐藏"上。
  //
  // 注意这里用的是**热区**（按钮本体，含不可见外扩），不是可见图形的 27×21：
  // 主进程轮询拿到的就是这块矩形，热区大一点，指针在边缘抖动时也不会来回切换接管状态，
  // 点击才有落点。（用户实测：可见图形太小时"看着点了、毫无反应"。）
  useEffect(() => {
    tagRectRef.current = anchor
      ? {
        x: tagPos.x - TAG_HIT.left,
        y: tagPos.y - TAG_HIT.top,
        w: TAG_BOX_W,
        h: TAG_BOX_H,
      }
      : null
  }, [anchor, tagPos])

  // 排查观测点：把"按下到底有没有送到渲染层"钉死。
  // 与标签自身的 onClick 日志对照即可把故障夹到一半：
  //   有 mousedown、无 onClick ⇒ 按下落在元素之外（热区不够）；
  //   连 mousedown 都没有        ⇒ 窗口级鼠标接管没生效（绕过 DOM 去改）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!activeRef.current) return
      // 真实点击已经到达渲染层：记一笔，后端派发的那一路要跳过（否则会执行两遍）
      lastRealDownAt.current = performance.now()
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const where = el ? `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}` : 'null'
      window.electronAPI?.logMain?.(`[wr] mousedown @${Math.round(e.clientX)},${Math.round(e.clientY)} 命中=${where}`)
      // 按下高亮：**真实按下**也要有。新卡/横框那一小块是不穿透的，点击会以真实
      // 事件到达；而后端派发那条路只在"真实事件没到"时才跑 —— 高亮只挂在那条路上
      // 就会出现"新卡按钮按下没反应"（用户实测）。两条路都加。
      if (el && el.closest('.wt-bar, .wt-side, .wt-menu')) {
        document.querySelectorAll('.is-pressed').forEach((n) => n.classList.remove('is-pressed'))
        const btn = (el.closest('button') || el.closest('[data-wt-hit]')) as HTMLElement | null
        if (btn) btn.classList.add('is-pressed')
      }
    }
    window.addEventListener('mousedown', onDown, true)
    // 抬起就清高亮（真实点击这条路同样需要）
    const onUp = () => {
      document.querySelectorAll('.is-pressed').forEach((n) => n.classList.remove('is-pressed'))
    }
    window.addEventListener('mouseup', onUp, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp, true)
    }
  }, [])

  const union = useMemo(() => unionRect(rects), [rects])

  const menuLayout = useMemo(() => {
    if (!anchor) return { x: 0, y: 0, dir: 'left' as const }
    // layoutMenu 是"顶边对齐 anchor.y − 6"，所以要让它落在选区竖直中心，
    // 得把传进去的锚点先抬到 cy − menuH/2 + 6（用户报的"没有对齐"就是这里）。
    const cy = union.y + (union.h ?? 0) / 2
    const centered = { ...anchor, y: cy - MENU_HEIGHT_EST / 2 + 6 }
    return layoutMenu(centered, MENU_WIDTH, MENU_HEIGHT_EST, viewport)
  }, [anchor, union, viewport])

  const barLayout = useMemo(
    () => layoutBar(union, BAR_WIDTH, BAR_HEIGHT, viewport),
    [union, viewport],
  )

  // ---------- 动作 ----------
  const handleAction = useCallback((action: string, custom?: string) => {
    if (!activeRef.current) return
    // 「创作」：先弹一个需求输入气泡（左侧面板），**不**请求模型
    if (action === 'create') {
      window.electronAPI?.logMain?.('[wr] 打开创作输入')
      setSideMode('create')
      setSideText('')
      return
    }
    // 「摘要 / 要点」：不弹横框，结果进左侧面板
    const toPanel = action === 'summary' || action === 'keypoints'
    setSideMode(toPanel ? 'result' : null)
    setSideText('')
    window.electronAPI?.logMain?.(`[wr] 选择动作 ${action}${custom ? '（自定义）' : ''}`)
    setBusy(true)
    setMessage('')
    // 标题：自定义要求（在修改面板输入框里回车）直接显示那段要求本身
    setLabel(action === 'custom' ? (custom || '') : '')
    setPhase('working')
    // 交给后端之前先把焦点还回目标程序：留在我们这边的话，随后的粘贴会落到自己的输入框里
    focusWantedRef.current = false
    window.electronAPI?.setWritingFocus?.(false)
    agentSocket.send({
      type: 'writing-rewrite',
      sid: sidRef.current,
      action,
      custom: custom || '',
      // 原文随请求带上：后端那份缓存可能因为用户点过别处而失效
      text: textRef.current,
      hwnd: hwndRef.current,
      pos: posRef.current,
    })
    // 发出去之后留一行：万一"点了没反应"，可以和后端的「收到请求」对照，
    // 一眼判断是"前端没发"还是"后端没收到/没回"。
    window.electronAPI?.logMain?.(
      `[wr] → 请求 action=${action} 要求${custom ? `=${custom.length}字` : '=无'} `
      + `原文=${textRef.current.length}字 sid=${sidRef.current} pos=${posRef.current ? '有' : '无'}`,
    )
  }, [])

  const handleCancel = useCallback(() => {
    if (!activeRef.current) return
    window.electronAPI?.logMain?.('[wr] 取消本次流程')
    // 先把界面收掉（用户看到的"撤回"必须立刻发生），再让后端停掉这一次请求
    replaceIntentRef.current = 'apply'
    focusWantedRef.current = false
    agentSocket.send({ type: 'writing-cancel', sid: sidRef.current })
    exitRef.current()
  }, [])

  const handleRevert = useCallback(() => {
    if (!activeRef.current) return
    window.electronAPI?.logMain?.('[wr] 复原')
    requestReplace('revert', editedRef.current, originalRef.current)
  }, [requestReplace])

  /**
   * 标签"先稳住位置，再挂上去"。
   *
   * 一次划选的开头常常连着来两条广播（UIA 树刷新前后各读一次，锚点可能差一整行），
   * 直接把锚点渲染出来的话，标签会先出现在旧位置、随后跳到正确位置 ——
   * 这就是"框选松手后首次自动显示时异常跳"。
   * 这里等位置静止 150ms 才显示：**标签只挂一次，直接落在最终位置**。
   * 150ms 肉眼无感；它只影响"出现"，不影响之后的正常移动。
   */
  const [shownTagPos, setShownTagPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    // ⚠ 必须同时要求"锚点已就绪"：没有锚点时 tagPos 是 {0,0}，
    //   挂上去就会出现在屏幕左上角（负偏移），完全点不到。
    if (phase !== 'tag' || !anchor) {
      setShownTagPos(null)
      return
    }
    // 已经显示着就**不再跟着挪**，除非新位置离得很远（那是真的换了选区）。
    // 一次会话开头常连着来两条广播、锚点抖动几十像素；跟着挪就是"首次飞入/跳动"。
    if (shownTagPos) {
      const near = Math.abs(tagPos.x - shownTagPos.x) <= 80
        && Math.abs(tagPos.y - shownTagPos.y) <= 80
      if (near) return
    }
    const timer = setTimeout(() => setShownTagPos(tagPos), 150)
    return () => clearTimeout(timer)
  }, [tagPos, phase, anchor, shownTagPos])

  if (!active) return null

  // 左侧面板出现时，标签与修改菜单都让位（否则会叠在面板上面）
  const showTag = phase === 'tag' && !sideMode
  const showMenu = phase === 'menu' && !sideMode
  // 左侧面板显示时**不弹横框**（摘要/要点/创作输入都归面板）
  const showBar = (phase === 'working' || phase === 'result') && !sideMode

  return (
    <>
      {/* 彩虹扫描：改写请求发出后一直盖在选区上，替换完成后淡出 */}
      {/* 紫色提示在"用户确认动作、面板消失"那一刻出现一次（只在 working 起点，
          result 相不重复闪：否则预览/复原都会再闪一下） */}
      <RainbowScan rects={rects} visible={phase === 'working'} />

      {/* 左侧竖居中面板：摘要/要点结果、创作需求输入 */}
      {sideMode && (
        <SidePanel
          mode={sideMode}
          anchor={union}
          title={sideMode === 'create' ? '创作' : (label || '处理结果')}
          text={sideText}
          busy={busy}
          onCreate={(req) => handleAction('custom', req)}
          // 面板「替换」同样在行首补一个回车（与模型结果写回保持一致）
          onReplace={() => requestReplace('apply', originalRef.current, `\n${sideText}`)}
          // 关闭面板 = 结束本次（**不能**留下一根横框）：摘要/要点本来就是"只读结果"，
          // 用户关掉它就说明不要了；创作关掉同理。
          onClose={() => { setSideMode(null); exitRef.current() }}
        />
      )}

      {/* 按住「预览原文」：原文就盖在选区**原处**，松手撤掉。不碰文档，也就不会
          再出现"未写入/找不到那段文字"。 */}
      {previewOriginal && rects.length > 0 && (
        <div
          className="wt-preview-original"
          style={{ left: union.x, top: union.y, width: union.w, height: union.h }}
        >
          {originalRef.current}
        </div>
      )}

      <AnimatePresence>
        {showTag && shownTagPos && (
          <SelectionTag
            key="wt-tag"
            pos={shownTagPos}
            visible={nearTag}
            color={accent}
            onClick={() => {
              // 排查观测点：这一行没出现 = 点击根本没到达渲染层（问题在窗口级），
              // 出现了但菜单没显示 = 问题在渲染层。
              window.electronAPI?.logMain?.('[wr] 标签被点击 → 进入菜单阶段')
              setNearTag(false); nearRef.current = false
              setPhase('menu')
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showMenu && (
          <WriteMenu
            key="wt-menu"
            layout={menuLayout}
            busy={busy}
            onAction={handleAction}
            onFocusRequest={(focusable) => window.electronAPI?.setWritingFocus?.(focusable)}
            onClose={handleCancel}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showBar && (
          <ActionBar
            key="wt-bar"
            layout={barLayout}
            label={label || '改写'}
            phase={phase}
            applied={applied}
            message={message}
            original={originalRef.current}
            onKeep={() => { window.electronAPI?.logMain?.('[wr] 保留'); exitRef.current() }}
            onRevert={handleRevert}
            onCancel={handleCancel}
          />
        )}
      </AnimatePresence>
    </>
  )
}
