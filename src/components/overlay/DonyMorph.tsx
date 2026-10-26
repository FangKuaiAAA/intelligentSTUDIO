import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RainbowGlow } from './RainbowGlow'
import { Hexagon } from './Hexagon'
import { AskDialog, AskRequest } from './AskDialog'
import { AcrylicLayer, ACRYLIC_BLUR } from './AcrylicLayer'
import { RESULT_MORPH_SECONDS } from './answerMotion'
import { ResultFrameContext } from './resultFrame'
import './DonyMorph.css'

export type DonyStage = 'input' | 'processing' | 'taskBall' | 'taskPill' | 'asking' | 'result'

interface DonyMorphProps {
  stage: DonyStage
  /** 快速模式时处理药丸显示“快速”，否则“正在处理” */
  fastMode: boolean
  /** 任务模式伸长药丸上的当前操作名 */
  toolLabel: string | null
  ask: AskRequest | null
  voiceMode: boolean
  onAskAnswer: (id: string, answer: { approved?: boolean; text?: string }) => void
  inputSlot: ReactNode
  resultSlot: ReactNode
  /** 唤醒瞬间的桌面快照（亚克力底衬）；为空时只显示色调层 */
  snapshot?: string | null
  /** 键入模式首屏输入框刚回车：卡片要走"边缩小边快速上移"的幂曲线形变 */
  submitKick?: boolean
}

/** Apple 式临界阻尼形变弹簧（完整形变、可打断、从当前值接续） */
const MORPH_SPRING = { type: 'spring', bounce: 0, duration: 0.5 } as const

/** 结果框专用的形变：时长**强制**等于文字飞入的总时长（RESULT_MORPH_SECONDS）。
 *  framer-motion 在 spring 同时给出 duration 与 bounce 时，会生成一条"正好用 duration 秒"
 *  的弹簧（而不是让物理自行决定时长），所以"框扩到位"被钉在那一时刻：
 *  与最后一行飞完、最后一张卡片飞完是同一时刻、同一帧。 */
const RESULT_MORPH_TRANSITION = { type: 'spring', bounce: 0, duration: RESULT_MORPH_SECONDS }
const CONTENT_FADE = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const

// ===== 幂曲线（"快慢速度用幂"）=====
/** 先快、末尾减速缓冲：上移/放大/缩小都用它
 *  （与 DonyAG 的"飞入必须是快速飞入 + 末尾减速缓冲"约定、WinUI 的飞入观感一致）
 *  ⚠ 首唤醒的"上移"与"放大"必须共用同一条曲线，否则两者进度会明显不同步：
 *    实测位置用 powerOut、尺寸用 powerIn（先慢后快）时，飞行 300ms 处位置已走完 87%，
 *    而尺寸只长了 12% —— 看起来就是"先飞完、再开始长大"。 */
const powerOut = (t: number) => 1 - Math.pow(1 - t, 2.2)
/** 同一条曲线的"加重版"：回车上移时的**缩小**用它。
 *  指数 10 是按用户要求反解的："前 20% 就完成 90% 的缩小" →
 *  1-(1-0.2)^p = 0.9 → p = ln0.1/ln0.8 ≈ 10.3，取 10。
 *  （曲线形状：10% 处 66%、20% 处 90%、50% 处 99.9% → 起手一甩缩掉大半，尾巴慢慢收干净） */
const powerOutStrong = (t: number) => 1 - Math.pow(1 - t, 10)

// ===== 首唤醒：输入框从屏幕底部飞入（与光边/光斑同时开始）=====
/** 飞行时长。用户要求"首次飞入再快 1.8 倍" → 0.45 / 1.8 = 0.25s。
 *  **不设延迟**：延迟会随每次重排被重置（尺寸是挂载后才量出来的），
 *  起飞时机改由"等两帧"来保证（见组件里的 flying）。
 *  ⚠ 必须与 DonyMorph.css 里 donyEnterRise 的 0.25s 保持一致。 */
const ENTER_SECONDS = 0.25

/** 回车那一下的上冲距离：先快后减速地"被吸上去"，最后落回该阶段原本的静止位置 */
const SUBMIT_KICK = -34
/** 回车上移 + 缩小的总时长（用户要求拉长到 2 倍：0.42 → 0.84s） */
const SUBMIT_SECONDS = 0.84

/** .stage-center 的固定顶部偏移（必须与 App.css 的 .stage-center{top:13%} 一致） */
const STAGE_TOP_RATIO = 0.13
/**
 * 键入模式首屏输入框的**落点**：屏幕下方（像底部输入条），而不是上方的药丸位。
 * 0.87 = 「原先的 0.74」与「屏幕底边 1.0」的中点（用户指定）。
 * 这样后面"回车 → 边缩小边快速上移形变为处理药丸"才是一段看得见的大幅上移。
 */
const INPUT_TOP_RATIO = 0.87

/** 结果框宽度：内容按它排版（不随卡片当前的动画宽度重排），否则高度会被量错 */
const RESULT_WIDTH = 500
/** 结果框高度上限：与 .dony-stage-result 的 max-height 对齐（正方形；超过交给框内滚动） */
const RESULT_MAX_HEIGHT = 500
/** 工具药丸的基础宽度：文字少时统一这么宽，文字多了再线性拉长 */
const PILL_WIDTH = 150

/** 各阶段的固定尺寸（input/result 由内容撑开） */
const STAGE_SIZE: Record<string, { w: number | 'auto'; h: number | 'auto'; r: number }> = {
  // 处理态药丸（带彩虹的那颗）：159×48 再按“宽度不变、高度 75%”收扁 → 159×36
  processing: { w: 159, h: 36, r: 18 },
  taskBall: { w: 64, h: 64, r: 32 },
  taskPill: { w: PILL_WIDTH, h: 64, r: 32 },
  asking: { w: 460, h: 280, r: 28 },
  result: { w: RESULT_WIDTH, h: 'auto', r: 28 },
}

export function DonyMorph({
  stage, fastMode, toolLabel, ask, voiceMode, onAskAnswer, inputSlot, resultSlot, snapshot,
  submitKick = false,
}: DonyMorphProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const inputContentRef = useRef<HTMLDivElement>(null)
  const labelMeasureRef = useRef<HTMLSpanElement>(null)
  const prevStageRef = useRef<DonyStage>(stage)
  // 是否是"挂载后的首帧"：追问交接时胶囊是**全新挂载**的，盒体一上来就在最终位置与尺寸，
  // 所以处理文案不需要那个 0.12s 延迟（那是留给"药丸原地长成处理态"的等待）——
  // 白等一段就是"加载胶囊显示迟了"（用户实测）。首帧之后恢复正常节奏。
  const firstPaintRef = useRef(true)
  useEffect(() => { firstPaintRef.current = false }, [])
  const [inputSize, setInputSize] = useState<{ w: number; h: number }>({ w: 220, h: 56 })
  const [pillWidth, setPillWidth] = useState(PILL_WIDTH)
  /** 键入模式首屏（挂载即输入态，且不是语音）：落在屏幕下方 + 从底部放大飞入 */
  const entry = useRef(stage === 'input' && !voiceMode).current
  // 飞入分两段：先停在屏幕底部不动（等浏览器真的开始画），再放大飞入。
  const [flying, setFlying] = useState(false)
  const [enterDone, setEnterDone] = useState(!entry)
  useEffect(() => {
    if (!entry) return
    // ⚠ 必须"等两帧"再起飞，不能一挂载就飞。
    // 唤醒那一下浏览器要干很多重活（光斑画布、React 挂载整棵树、主进程截图 IPC…），
    // 第一帧会被推迟几百毫秒；而动画是按"已经过去多久"算值的，于是第一帧一跑就
    // **一次性追帧**：实测 44~326ms 卡在 y=695（屏幕底部），366ms 那一帧直接变成
    // y=292 —— 一帧跳了 403px。观感就是"药丸根本没从底部升起来，直接出现在上半屏"。
    // 等两帧 = 保证动画从"浏览器正在画"的那一刻起算，全程可见、不跳帧。
    let r1 = 0, r2 = 0, t: ReturnType<typeof setTimeout>
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        setFlying(true)
        t = setTimeout(() => setEnterDone(true), ENTER_SECONDS * 1000 + 80)
      })
    })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(t) }
  }, [entry])
  const entering = entry && !enterDone
  /** 首屏输入框的落点：相对 .stage-center(top:13%) 的 y 偏移 → 把卡片推到屏幕下方 */
  const inputRestY = useMemo(
    () => Math.round(window.innerHeight * (INPUT_TOP_RATIO - STAGE_TOP_RATIO)), [])
  // 起飞点：卡片顶边起始于**屏幕底边之外**，再向上飞进落点（"从屏幕底部钻出来"）。
  // 这是相对落点的位移量，交给锚点的 CSS 动画插值（合成器线程，见 DonyMorph.css）。
  const enterFrom = useMemo(
    () => (entry ? Math.round(window.innerHeight * (1 - INPUT_TOP_RATIO)) : 0),
    [entry])
  // 起飞点：**只有浓度和落点**，没有尺寸 —— 首屏飞入不做放大（用户要求）：
  // 药丸一起飞就是最终大小，飞的只有"上移"这一件事。
  // 上移由锚点的 CSS 动画负责（合成器线程，见 DonyMorph.css 的 donyEnterRise）；
  // 卡片自身的 y 全程保持落点值，两者不打架。
  const enterStart = { opacity: 0, y: inputRestY }
  const resultContentRef = useRef<HTMLDivElement>(null)
  /** 结果框高度：由 JS 实测内容得到（见下方 useLayoutEffect），交给动画当数值用 */
  const [resultHeight, setResultHeight] = useState<number | null>(null)

  // 药丸宽度：文字放得下就用统一标准宽度，放不下再按文字实际宽度线性拉长
  useLayoutEffect(() => {
    if (stage !== 'taskPill') return
    const el = labelMeasureRef.current
    if (!el) return
    const sync = () => {
      const need = 64 + el.offsetWidth + 22 + 6   // 左端六边形 + 右侧留白 + 余量
      setPillWidth(need > PILL_WIDTH ? Math.min(need, 520) : PILL_WIDTH)
    }
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [stage, toolLabel])

  // 阶段切换后记录一下：用来区分「药丸内文字变长」与「阶段形变」
  const prevStage = prevStageRef.current
  const withinPill = stage === 'taskPill' && prevStage === 'taskPill'
  useEffect(() => {
    prevStageRef.current = stage
    if (stage !== 'taskPill') setPillWidth(PILL_WIDTH)
  }, [stage])

  // input 阶段：跟踪内容（药丸随文字增长）的实时尺寸，让卡片完整包裹并连续形变
  useLayoutEffect(() => {
    if (stage !== 'input') return
    const el = inputContentRef.current
    if (!el) return
    const sync = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (w && h) setInputSize((p) => (p.w === w && p.h === h ? p : { w, h }))
    }
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [stage])

  // 结果框高度必须"提前量好"：内容（正文 + 结果卡片）是绝对定位的，卡片高度只能由
  // JS 给。若交给 framer-motion 的 height:'auto'，它会在内容挂载前后各量一次 ——
  // 表现就是"先放大过头、再闪一下缩回来"。这里在 layout 阶段量好、用数值驱动动画：
  // useLayoutEffect 在 paint 之前跑，所以第一次形变的起点仍是当前尺寸、终点是准确高度，
  // 中间态一帧都不会被看见。
  useLayoutEffect(() => {
    if (stage !== 'result') {
      setResultHeight(null)
      return
    }
    const el = resultContentRef.current
    if (!el) return
    // 量的是**真正那个滚动区**（overflow-y:auto 的 .dony-result-scroll）的 scrollHeight：
    //   · offsetHeight/clientHeight 只能告诉我们"卡片现在多高"（起步时只有一行）；
    //   · 而 overflow:visible 的元素 scrollHeight 等于 clientHeight，同样量不到溢出内容。
    // 只有带 overflow 的那个元素，scrollHeight 才是完整内容高度。
    // 再加上它外面的上下内边距（.dony-result-stack 的 padding），就是卡片应有的高度。
    const measure = () => {
      const scroller = el.querySelector<HTMLElement>('.dony-result-scroll')
      if (!scroller) return 0
      const stack = scroller.parentElement
      const pad = stack
        ? (parseFloat(getComputedStyle(stack).paddingTop) || 0)
          + (parseFloat(getComputedStyle(stack).paddingBottom) || 0)
        : 0
      return scroller.scrollHeight + pad
    }
    // 夹到与 .dony-stage-result 相同的上限（正方形 / 82vh）：再长的内容改成框内滚动，
    // 否则卡片会一路长到屏幕外（max-height 只限制内部区域，不限制卡片自身）。
    const sync = () => {
      const h = measure()
      if (h > 0) setResultHeight(
        Math.min(h, RESULT_MAX_HEIGHT, Math.round(window.innerHeight * 0.82)))
    }
    sync()
    // 内容后续变化（流式补字、结果卡片增删）时跟着调整
    const mo = new MutationObserver(sync)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => { mo.disconnect(); ro.disconnect() }
  }, [stage])

  const fixed = STAGE_SIZE[stage]
  // 结果框高度是量出来的。量到之前**连宽度也不动**（保持处理药丸的尺寸）：
  // 否则第一帧会拿 fallback 高度去配 580 的宽度 → 卡片先变成一个扁长条、再把高度
  // 拉长，看起来就是"先变长方形、再向下拉长"。
  const resultHeightPending = stage === 'result' && resultHeight === null
  const width = stage === 'input' ? inputSize.w
    : stage === 'taskPill' ? pillWidth
      : resultHeightPending ? STAGE_SIZE.processing.w
        : fixed!.w
  const height = stage === 'input' ? inputSize.h
    : stage === 'result' ? (resultHeight ?? STAGE_SIZE.processing.h)   // 量到之前沿用处理药丸的高度
      : fixed!.h
  const radius = stage === 'input' ? inputSize.h / 2 : fixed!.r
  /** 首屏输入框落在**屏幕下方**；其余阶段保持原本的静止位（处理/任务药丸 -12，其余 0） */
  const lowInput = stage === 'input' && !voiceMode
  const restY = lowInput ? inputRestY
    : stage === 'processing' || stage === 'taskBall' || stage === 'taskPill' ? -12
      : 0
  // 回车那一下：从下方**大幅快速上移**到处理药丸位，同时缩小（幂曲线：先快后减速缓冲）。
  // 只在飞入已经结束、且还在首屏输入态时用 —— 否则会与飞入的 y 打架。
  const kick = submitKick && enterDone && stage === 'processing'
  // 首帧 = 输入框当前所在的下方落点；中段冲到处理位再往上一截；末段落回静止位
  const y: number | number[] = kick ? [inputRestY, restY + SUBMIT_KICK, restY] : restY
  // 彩虹底衬必须**等卡片完全到位**才亮：回车上移/缩小期间它每帧都要重算几何
  //（renderEdge 会整条重写 @keyframes = 全文档样式重算），而且会"追着缩小的卡片跑"。
  // 所以 kick 期间一律不亮（kick 由 App 的 submitKick 标记驱动，覆盖整段动画）。
  const rainbowOn = stage === 'processing' && !kick
  // 亚克力：面板越大模糊越强（与原生亚克力一致）。
  // input 阶段的卡片是透明底（材质由药丸自绘），所以不铺亚克力层。
  const acrylicBlur = stage === 'result' ? ACRYLIC_BLUR.result
    : stage === 'asking' ? ACRYLIC_BLUR.asking
      : stage === 'taskBall' ? ACRYLIC_BLUR.ball
        : ACRYLIC_BLUR.pill
  const withAcrylic = stage !== 'input'
  // 结果框扩到位之前不显示滚动条（见 App.css：.dony-stage-result:not(.is-settled)）：
  // 扩大过程中内容是"溢出"一个正在长大的框，本来无需滚动也会闪出一条、还一路跳。
  // 用形变动画**真正结束**的信号来判定，不靠猜时间（猜偏了就会又闪一下）。
  const [resultSettled, setResultSettled] = useState(false)
  // ⚠ 这里加了两道闸，专治"滚动条在框还在扩大时就冒出来"这个老 BUG：
  //   onAnimationComplete 在某些时序下会在**动画还没真正跑**（目标高度还没量出来）时
  //   就被触发一次 → is-settled 提前加上 → 滚动条提前出现。
  //   ① 时间闸：早于动画时长 80% 就来的"完成"回调一律不认（那一定是假信号）；
  //   ② 兜底定时器：保证最终一定会 settled，否则滚动条永远不出现。
  const resultStartRef = useRef(0)
  useEffect(() => {
    if (stage !== 'result') { setResultSettled(false); return }
    // ⚠ 这里**每次高度变化都要重新上闸**（依赖里带 resultHeight）：
    //   长回答在 settled **之后**还会因为换行/补字再长一次（MutationObserver 重测高度
    //   → 又触发一段形变），那一刻 is-settled 已经为真 ⇒ 抑制已解除 ⇒
    //   正在长的那一帧内容比框高 ⇒ 闪出一条滚动条（用户实测：
    //   "单行内容非常多（自动换行跨好几行）时会在返回框扩大期间触发显示滚动条，
    //     实际扩大完无需"）。
    //   每段形变都重新上闸，结束（动画完成 / 兜底定时器）再解除 —— 与首次进入 result 完全同一套。
    setResultSettled(false)
    resultStartRef.current = performance.now()
    const t = setTimeout(() => setResultSettled(true), RESULT_MORPH_SECONDS * 1000 + 120)
    return () => clearTimeout(t)
  }, [stage, resultHeight])
  // 药丸里只是文字变长（阶段没变）：宽度线性拉长，其它形变仍走同一条临界阻尼弹簧
  // 结果框的形变时长 = 文字飞入的总时长（同一个常量，强制相等）：两边同时开始、同时结束。
  const morphTransition = stage === 'result'
    ? RESULT_MORPH_TRANSITION
    // 起飞前（等"浏览器在画"的那两帧）：尺寸/位置一律**瞬时到位**，不做任何放大。
    // 尺寸是挂载后才量出来的（首帧还是 220×56 的占位值），若这里走弹簧，
    // 药丸起飞时还在慢慢长大 —— 那又变成"边飞边放大"了。
    : entry && !flying
      ? { duration: 0 }
      // 首唤醒：只有浓度淡入 + 上移（上移在锚点的 CSS 动画上，见 DonyMorph.css）。
      // ⚠ 必须带 `entering && stage === 'input'`：flying 一旦置 true 就不会再回 false，
      //   少了这个闸门，首次唤醒之后的**每一次**形变（比如追问回车把返回框缩回处理药丸）
      //   都会被套上这套飞入过渡，表现就是"缩小慢得异常"。
      : flying && entering && stage === 'input'
        ? {
          y: { duration: ENTER_SECONDS, ease: powerOut },
          opacity: { duration: 0.22, ease: 'linear' as const },
        }
        // 回车：**大幅上移 + 缩小**。缩小用加重版幂曲线（指数 3.4），
        // "先快后慢"更突出（起手就缩掉大半，尾巴慢慢收干净）。
        : kick
          ? {
            y: { duration: SUBMIT_SECONDS, times: [0, 0.44, 1], ease: [powerOut, powerOut] },
            width: { duration: SUBMIT_SECONDS, ease: powerOutStrong },
            height: { duration: SUBMIT_SECONDS, ease: powerOutStrong },
            borderRadius: { duration: SUBMIT_SECONDS, ease: powerOutStrong },
          }
          : withinPill
            ? { ...MORPH_SPRING, width: { duration: 0.32, ease: 'linear' as const } }
            : MORPH_SPRING
  // 结果框的目标尺寸下发给框内的文字飞入（起点 = 框的最终底部）
  const frameInfo = useMemo(() => ({ height: resultHeight, cardRef }), [resultHeight])
  // 起飞前：**尺寸已经是最终值**（不做放大），只是完全透明 + 停在屏幕底边之外。
  const cardInitial = entry ? enterStart : false
  const cardAnimate = entry && !flying
    ? { width, height, borderRadius: radius, y: inputRestY, opacity: 0 }
    : { width, height, borderRadius: radius, y, opacity: 1 }
  // 锚点：起飞前先静态停在屏幕底部；起飞瞬间换成 CSS 动画（值一样，不会跳）。
  const anchorStyle = {
    '--dony-enter-from': `${enterFrom}px`,
    ...(entry && !flying ? { transform: `translateY(${enterFrom}px)` } : null),
  } as CSSProperties

  return (
    <ResultFrameContext.Provider value={frameInfo}>
    <div className={`dony-morph-anchor${flying && entering ? ' is-entering' : ''}`} style={anchorStyle}>
      <RainbowGlow targetRef={cardRef} active={rainbowOn} />
      <motion.div
        ref={cardRef}
        className={`dony-morph-card dony-stage-${stage}${entering ? ' is-entering' : ''}${resultSettled ? ' is-settled' : ''}`}
        data-acrylic-host=""
        initial={cardInitial}
        animate={cardAnimate}
        transition={morphTransition}
        // ⚠ 必须加 resultHeight !== null 这个闸门：进 result 的第一帧高度还没量到，
        // 目标值仍是旧高度 → 这次动画"原地不动"→ onAnimationComplete 会**立刻**触发，
        // 于是滚动条在框还没长大时就被放行了（表现为"还是会闪"）。
        onAnimationComplete={
          stage === 'result' && resultHeight !== null
            ? () => {
              // 时间闸：动画真正跑够时长之前，任何"完成"回调都不认
              if (performance.now() - resultStartRef.current < RESULT_MORPH_SECONDS * 800) return
              setResultSettled(true)
            }
            : undefined
        }
        // 亚克力层的圆角由它驱动：卡片带 transform，overflow+border-radius 在这组合下
        // 圆角裁剪会失效（直角硬切 / 深色圆角白线），所以亚克力层改用 clip-path 裁。
        // 形变期间把亚克力的模糊临时降到 35%（filter 是它唯一的成本大头，
        // 而宿主形变时每帧都要重做一次模糊光栅），落定后回到 100%；filter 带过渡不会闪。
        // 覆盖三段会持续改变尺寸的形变：首屏飞入、回车上移/缩小、结果框长大。
        // 卡片上的变量会继承给卡片内部的药丸（首屏那颗药丸就在卡片里）。
        style={{
          '--dony-radius': `${radius}px`,
          '--dony-blur-scale':
            (flying && entering && stage === 'input') || kick || (stage === 'result' && !resultSettled)
              ? 0.35 : 1,
        } as CSSProperties}
      >
        {withAcrylic && <AcrylicLayer snapshot={snapshot} blur={acrylicBlur} />}
        <AnimatePresence initial={false}>
          {stage === 'input' && (
            <motion.div key="input" className="dony-content"
              // 内容入场只做浓度 + 模糊（不用 scale）：药丸本身的形状变化由外层宽高形变负责，
              // 内容再叠一层缩放就会显得"在抽"。
              initial={{ opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)', transition: { duration: 0.26, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, filter: 'blur(3px)', transition: CONTENT_FADE }}>
              <div ref={inputContentRef} className="dony-input-measure">{inputSlot}</div>
            </motion.div>
          )}

          {stage === 'processing' && (
            <motion.div key="processing" className="dony-content dony-center"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)', transition: { ...CONTENT_FADE, delay: firstPaintRef.current ? 0 : 0.12 } }}
              exit={{ opacity: 0, filter: 'blur(3px)', transition: CONTENT_FADE }}>
              {/* 两句话之间渐变过渡（模式判定到达时会从「正在处理」换成「仍在处理」） */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={fastMode ? 'fast' : 'normal'} className="dony-processing-text"
                  initial={{ opacity: 0, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)', transition: { duration: 0.28, ease: [0.23, 1, 0.32, 1] } }}
                  exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.16, ease: 'easeIn' } }}>
                  {fastMode ? '仍在处理' : '正在处理'}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          )}

          {(stage === 'taskBall' || stage === 'taskPill') && (
            <motion.div key="taskload" className="dony-content"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)', transition: CONTENT_FADE }}
              exit={{ opacity: 0, filter: 'blur(3px)', transition: CONTENT_FADE }}>
              <div className="dony-task-hex"><Hexagon size={64} /></div>
              {/* 隐藏测量用：拿到工具名的实际宽度（卡片 overflow:hidden 会裁掉，不可见） */}
              <span ref={labelMeasureRef} className="dony-tool-label-measure" aria-hidden>
                {toolLabel || ''}
              </span>
              <AnimatePresence mode="popLayout" initial={false}>
                {stage === 'taskPill' && toolLabel && (
                  // 工具名上下滚动：旧的快速缩小模糊向上飞出，新的由模糊快速清晰放大向上飞入。
                  // 都发生在卡片内部（卡片 overflow:hidden），不会露到卡片外。
                  <motion.span key={toolLabel} className="dony-tool-label"
                    // 工具名滚动同样只用位移 + 浓度 + 模糊（去掉 scale）
                    initial={{ y: 16, opacity: 0, filter: 'blur(4px)' }}
                    animate={{
                      y: 0, opacity: 1, filter: 'blur(0px)',
                      transition: { duration: 0.22, ease: [0.23, 1, 0.32, 1] },
                    }}
                    exit={{
                      y: -16, opacity: 0, filter: 'blur(4px)',
                      transition: { duration: 0.16, ease: 'easeIn' },
                    }}>
                    <span className="dony-tool-label-text">{toolLabel}</span>
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {stage === 'asking' && ask && (
            <motion.div key={`ask-${ask.id}`} className="dony-content"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)', transition: { ...CONTENT_FADE, delay: 0.15 } }}
              exit={{ opacity: 0, filter: 'blur(3px)', transition: { duration: 0.12 } }}>
              <AskDialog ask={ask} voiceMode={voiceMode} onAnswer={onAskAnswer} />
            </motion.div>
          )}

          {stage === 'result' && (
            // 内容按结果框的最终宽度排版：卡片宽度是动画中的，如果跟着它排版，
            // 高度会先按窄宽度量出一个很大的值、再被纠正（表现为“先暴涨再闪回”）。
            <motion.div key="result" ref={resultContentRef} className="dony-content dony-result-content"
              style={{ width: RESULT_WIDTH }}
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              // 回答结束：**形变放大与文字飞入同时开始**（不再延后）
              animate={{ opacity: 1, filter: 'blur(0px)', transition: CONTENT_FADE }}
              exit={{ opacity: 0, filter: 'blur(3px)', transition: CONTENT_FADE }}>
              {resultSlot}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
    </ResultFrameContext.Provider>
  )
}
