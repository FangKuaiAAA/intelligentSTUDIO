import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AcrylicLayer, ACRYLIC_BLUR } from './AcrylicLayer'
import './VoicePillInput.css'

interface VoicePillInputProps {
  text: string
  isListening: boolean
  pendingText?: string
  isFollowUp?: boolean
  /**
   * 「形变收拢」目标（自成一树，**不用**跨树 layoutId 投影）。
   * 非空时药丸把自己的**盒子宽高**动画收缩到这个尺寸并淡下去 ——
   * 观感就是"缩小成加载胶囊"（与首次唤醒那套容器宽高形变同一类）。
   * y = 收拢末位置的上移量（负值 = 向上）：让中心与 DonyMorph 加载胶囊逐像素重合
   * （推导见 answerMotion.ts 的 PILL_COLLAPSE）。
   * ⚠ 为什么用受控 prop 而不是 AnimatePresence 的 exit：
   *   exit 只能动"它挂载的那个元素"（外层 .card-ready 壳，它没有可见材质）——
   *   真正看得见的胶囊是这里的**内层容器**，所以必须由这里自己形变。
   */
  collapse?: { w: number; h: number; y: number } | null
  /**
   * 药丸自己正在从下方飞入（首次唤醒 / 语音追问过渡）。
   * 此刻文字**不做逐字飞入**，只做「模糊 → 确认后清晰」—— 整颗药丸已经在往上飞，
   * 再叠一层逐字位移就是两套位移打架（用户明确要求："不飞入，但要有模糊然后清晰"）。
   */
  entering?: boolean
}

/** 「首个文字」（随药丸飞入、或药丸刚诞生时到达的第一批文字）的字动画：
 *  **只有浓度与模糊，没有任何位移** —— 药丸自己在往上飞，文字再叠一层向上就是两套位移打架。
 *  模糊从 16px 收到 0（比浓度慢得多），所以"糊 → 清"看得清。
 *  ⚠ 起始糊度要和 CHAR_BLUR（16）保持一致，否则两套变体切换时糊度会跳。 */
const CHAR_MOTION_ENTERING = {
  hidden: { opacity: 0, filter: 'blur(7.7px)' },
  visible: {
    opacity: 1, filter: 'blur(0px)',
    // ⚠ transition 放在**组件**上（见 JSX）：framer 的 per-prop transition 会覆盖根级 delay，
    //   而"前/后两段错开"必须靠 delay，所以这里不写 transition —— 否则延迟会被吃掉。
  },
  exit: {
    opacity: 0, filter: 'blur(5px)',
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as [number, number, number, number] },
  },
}

/** 飞入起点：从药丸下沿**里面**开始（CSS 里 y 正数=向下），
    药丸 overflow:hidden 会把它裁掉 → 看起来就是“从药丸里飞出来”。
    46 ≈ 一行多的高度：飞得更远，落回的那一下才看得清（原来 30 太短）。 */
/** 飞入起点：**字心正好落在药丸的下裁切线上**（用户："从药丸下裁切线处开始向上"）。
 *  怎么算出来的：字心在静止时就等于药丸的**竖直中心**（内边距上下对称、行居中），
 *  所以"字心 → 下裁切线"的距离就是**半个药丸高**：
 *      药丸高 = 行高 + vPad(30) ≈ 22 + 30 = 52  →  52 ÷ 2 ≈ **26px**
 *  （vPad 用的是本文件 useLayoutEffect 里那个 30，与 .voice-pill-container 的
 *    纵向 padding+border 等价；若以后改了字号/内边距，这个数要跟着调。）
 *  ⚠ 与旧值 74 相比行程大幅缩短（74+4.096 → 26+4.096 ≈ 30px）：
 *    **时长 CHAR_RISE_S 没动（仍 0.319s）**，所以观感会明显变慢 —— 见下方注释的旋钮。 */
const CHAR_FROM_Y = 26

/* 飞入的时长常量（统一速度版）在下方 CHAR_UP 声明之后定义 —— 它们依赖路程，必须后置。 */
const CHAR_UP = 4.096               // 过顶高度 = 最高点到落位的高度差：5.12 × 0.8（"再次 x0.8"，精确值）
/** 起始模糊：**9.6px** —— 与"上次起点 74px 时、字心刚跨过裁切线"那一刻的模糊**等值**。
 *  推导（可复核）：旧起点 74、裁切线 +26 ⇒ 到裁切线时已走完 (74-26)/78.096 ≈ 61.5% 行程
 *  ⇒ 由 quad-out 反解得 t ≈ 0.239（时间轴 23.9%）⇒ 模糊时间表（保持到 18.4% 后线性收）
 *  在 t=0.239 处约为 11 × 0.872 ≈ **9.6px**。
 *  现在起点**就在**裁切线上，所以把起始值直接取 9.6px，跨线那一刻的糊度与旧版一致。 */
/** ⚠ 再降一档：9.6 → **7.7**（= 9.6 × 0.8，用户："再次降低文字初始模糊度"）。
 *  上面那段"9.6 与旧版跨线时刻等值"的推导仍然成立，只是基准整体下调一档。
 *  ⚠ 两处必须一致：本常量 与 CHAR_MOTION_ENTERING 的 hidden。 */
const CHAR_BLUR = 7.7

/** 飞入的**统一速度**（px/s）—— 上升与下落**同速**（用户："飞入速度和下落速度统一匀速"）。
 *  ⚠ 之前的坑：两段各自都是匀速缓动，但**时长**是各自写死的（0.26s / 0.92s）→ 速度差 36 倍
 *    （上升 ≈315px/s、下落 ≈8.7px/s）→ 观感是"射上去、再慢慢爬回来"，不是匀速。
 *    现在两段的时长都由**各自的路程 ÷ 同一个速度**推出 → 全程速度恒等。
 *  取 0.8 × 原来的上升速度（315px/s）≈ 252px/s，即"飞入速度稍减慢些"。
 *  改速度只需动这一个数（越小越慢）。
 *  ⚠ 必须写在 CHAR_UP 之后：它们依赖路程，前置会触发 TDZ（tsc TS2448）。 */
const CHAR_SPEED = 252
const CHAR_UP_DIST = CHAR_FROM_Y + CHAR_UP   // 起点 → 过顶：74 + 8 = 82px
const CHAR_DOWN_DIST = CHAR_UP               // 过顶 → 落位：8px
/** 上升时长 **锚定不变** = 0.3190s（用户："做到时间和现在的不变"）。
 *  ⚠ 因此它**不再**由 `路程 ÷ 速度` 推出 —— 那写下时，改高度（CHAR_UP）会连带改时长，
 *    与"时间不变"直接冲突。现在时长是主、速度是从：上升实际平均速度 = 79.12px/0.3190s
 *    = 248px/s，quad-out 的起步速度 = 2×平均 = 496px/s（数值随高度自动跟随，无需手调）。 */
const CHAR_RISE_S = 0.3190
/** 下落时长 = **与上升完全相等**（用户要求："让飞上与下落的时间相等"）。
 *  上升的行程天然更长 —— 它多出"从地下往上飞"的那一大段（CHAR_FROM_Y = 74px），
 *  而总落程只有过顶那 8px。时间相等 ⇒ **下落速度自然慢得多**：
 *      上升 82px / 0.325s ≈ 252 px/s
 *      下落  8px / 0.325s ≈ 24.6 px/s   （≈ 上升的 1/10，正是"下落稍微调慢"）
 *  所以这里直接写成 `= CHAR_RISE_S`，两个时长永远同步，不会再各写各的而失配。
 *  ⚠ 也正因为这个写法，`RISE_FRACTION` 恰好是 0.5（过顶点正好在半程时间上）。 */
/* 下落时长与"上升收尾速度"的推导见下方 EASE_FALL 之后（它们依赖那里的常量，必须后置）。 */

/** 幂律 + 线性的混合 —— **单条光滑多项式**（不分段、不截断，速度曲线处处连续）：
 *      f(t) = (1-mix)·(1-(1-t)^p) + mix·t
 *  两个端点速度都有闭式解：
 *      起步 v(0) = (1-mix)·p + mix          末端 v(1) = mix
 *  mix = 0 → 纯幂律（末端 0）；mix = 1 → 完全匀速。
 *  "**起步速度不变、整体更接近匀速**" = 固定 v(0) 去解 (p, mix)：
 *      要 v(0) = 1.5（与上一版相同），取 mix = 0.5 → p = 2
 *  → 速度曲线 1.5 → 1.0 → 0.5，是一条**直线**：匀减速，但末端不归零。
 *    （对比上一版 q=0.5：起步同为 1.5，但末端是 0，掉落感更明显。） */
const powOut = (p: number, mix: number) => (t: number): number =>
  (1 - mix) * (1 - Math.pow(1 - t, p)) + mix * t
/** **匀变速**（加速度恒定）缓动，上升/下落共用：速度随时间**线性**变化。
 *  位置必须是二次式：f(t) = A·t + (B−A)/2·t²，于是 f'(0)=A（初速）、f'(1)=B（末速），
 *  两者都是"归一化速度"（单位 = 该段的平均速度）。
 *  ⚠ 唯一约束：**A + B = 2** —— 平均速度必须是 1（归一化），否则位移走不完 1。
 *    所以钉死 B 就等于钉死 A（A = 2−B）：
 *      上升 B=0.0796（<1）→ A=1.92 > 1 → **匀减速**（越飞越慢）
 *      下落 B=4/3（>1）  → A=2/3  < 1 → **匀加速**（越落越快） */
const quadEase = (B: number): ((t: number) => number) => {
  const A = 2 - B             // 初速度（归一化）—— 由 A+B=2 唯一确定
  const k = (B - A) / 2
  return (t: number) => A * t + k * t * t
}
/** 收尾速度 ÷ 上升平均速度 = (CHAR_UP/CHAR_FALL_S) ÷ (CHAR_UP_DIST/CHAR_RISE_S)
 *  在"两段历时相等"下化简为路程比：CHAR_DOWN_DIST / CHAR_UP_DIST ≈ 0.0796 */
/** 上升收尾速度（归一化）：本轮改为 **0**（"匀减速的末速度改 0"）⇒ B=0 ⇒ A=2 = quad-out。
 *  归一化单位仍是"上升段的平均速度"——平均速度由路程/时长钉死，改缓动不会动它。 */
const CHAR_END_V = 0
const EASE_RISE = quadEase(CHAR_END_V)    // 上升：匀减速、末速 0 → quad-out（f = 2t − t²）
/** 下落：**匀加速**且**初速度改为 0**（"匀加速的初速度改 0"）⇒ A=0 ⇒ B=2 ⇒ quad-in（f = t²）。
 *  标准"从静止开始匀加速"。过顶点两边速度都是 0 → 仍然连续（表现为在最高点轻轻一停）。 */
const CHAR_FALL_B = 2
const EASE_FALL = quadEase(CHAR_FALL_B)
/** 下落时长 = 上升 × **0.63** = 0.20097s（= 上一版 0.7875 × 0.8）。
 *  ⚠ 为什么这次也要跟着 ×0.8：用户要求"**下落速度不变**"（路程同时被 ×0.8）。
 *    下落速度 = 路程 ÷ 时长 —— 路程 5.12 → 4.096（×0.8）时，若时长不动，速度必然掉到 0.8 倍 ✗。
 *    所以时长同比 ×0.8 ⇒ 平均速度与末速度**逐值不变** ✓：
 *      平均 = 4.096px / 0.20097s = 20.4px/s（与上一版完全相同 ✓）
 *      末速 = 2×平均 = 40.8px/s（同上 ✓）；初速仍恒为 0 ✓（A=0 ⇒ B=2，形状锁死）
 *  ⚠ 不要改回"路程 ÷ 平均速度"那种写法：那里要用的平均速度来自旧的初速度 20.1px/s，
 *    而初速度已为 0，那套式子会算出 Infinity。 */
const CHAR_FALL_S = CHAR_RISE_S * 0.63
/** 「输入框进入动画」的总时长 = **一个字的完整飞入（上升 + 下落）**（用户指定）。
 *  与文字用的是同一个物理量 ⇒ "框飞到位"与"这批字飞完"同拍，不会一前一后。
 *  ⚠ 跟着 CHAR_RISE_S / CHAR_FALL_S 自动变化，不要写死成常数。 */
const PILL_ENTER_S = CHAR_RISE_S + CHAR_FALL_S      // ≈0.520s
/** 上冲段占整条时间轴的比例（后面几处 times 都用它，保证"模糊开始恢复"正好落在过顶点上） */
const RISE_FRACTION = CHAR_RISE_S / (CHAR_RISE_S + CHAR_FALL_S)

/** 每个字的动画：快速上冲 → 略微过顶 → 慢慢落回原位；
    飞的过程带模糊，“下落”时才慢慢变清晰。撤掉的字向下撤出。
    全部只用位移 + 模糊，不用缩放：缩放会让文字看起来在“弹”，不是形变。 */
const CHAR_MOTION = {
  hidden: { y: CHAR_FROM_Y, opacity: 0, filter: `blur(${CHAR_BLUR}px)` },
  visible: {
    // 关键帧：起点（药丸内下方）→ 过顶 → 落位
    y: [CHAR_FROM_Y, -CHAR_UP, 0],
    opacity: 1,
    // "糊 → 清"：**先保持模糊，到上飞走到一半左右才开始清**，清完正好是过顶点
    //   （用户："等上飞走到 50% 左右再开始变清晰"）。
    //   4 个关键帧 = 三段：保持 → 变清 → 保持清晰，时间点由 JSX 里的 times 指定。
    filter: [`blur(${CHAR_BLUR}px)`, `blur(${CHAR_BLUR}px)`, 'blur(0px)', 'blur(0px)'],
    // ⚠ 同 CHAR_MOTION_ENTERING：transition 全部搬到组件上，只为了 delay 能生效（分段错开）。
  },
  exit: {
    y: CHAR_FROM_Y, opacity: 0, filter: 'blur(5px)',
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as [number, number, number, number] },
  },
}

export function VoicePillInput({ text, isListening, isFollowUp = false, entering = false, collapse = null }: VoicePillInputProps) {
  const chars = useMemo(() => text.split(''), [text])
  const charsRowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  // ---- 「首个文字」的边界 ----
  // 定义：这颗药丸**第一次拿到文字时的那一批**（下标 0 .. firstBatchEnd-1）。
  //   它们只做"模糊 → 清晰"，绝不向上飞（药丸在飞的时候，文字再叠位移就是两套位移打架）。
  // ⚠ 为什么用"冻结边界"而不是"上一个字"这类动态判据：
  //   变体一旦切换，framer 会重新解析 visible（CHAR_MOTION 的 y 是 [92,-18,0] 关键帧数组），
  //   已经显示的字会被从当前位置重新跑一遍关键帧 → 视觉上"抽一下、又往上飞"。
  //   冻结后每个字用哪套变体在它一生里都不变。
  // ⚠ 这里是渲染期写 ref，但它是**幂等**的：只看 chars.length，StrictMode 双渲染结果相同。
  const firstBatchLenRef = useRef(0)
  // ① 「首个文字」= 药丸诞生后到达的**第一批**（那正是药丸自己在飞的时刻 → 只模糊、不向上）。
  if (firstBatchLenRef.current === 0 && chars.length > 0) firstBatchLenRef.current = chars.length
  // ⚠ 不要再按 entering 去扩大边界：entering 要持续 VOICE_RISE_SECONDS+60 ≈ 680ms，
  //   那期间到达的第 2、3 个字会被一并算成"首个文字" → 它们也变成"只模糊、没有飞入"
  //   （用户实测："2~3 次出现的文字也是模糊进入没有飞入"）。
  // 边界只在**第一批**确定一次，且只增不减 —— 于是每个字从诞生起就定死变体：
  //   既不会"第 2 个字换变体后再飞一遍"，也不会"2~3 个字不飞"。
  // （entering 仍保留在 props 上：语义是"药丸自己在飞"，但不再参与边界判定。）
  const firstBatchEnd = firstBatchLenRef.current   // 单调，且只在第一批增长
  // 单批文字 > 4 个字 → 前后两段**分开飞**：第二段整体延迟 CHAR_SEG_GAP 起飞。
  //   Math.ceil 天然满足"奇数则前段多取 1"（5 → 3 + 2、7 → 4 + 3）。
  //   ≤ 4 个字不拆：frontLen = 全长 → 延迟恒为 0（行为与之前完全一致）。
  const CHAR_SEG_GAP = 0.22
  const frontLen = chars.length > 4 ? Math.ceil(chars.length / 2) : chars.length
  const [size, setSize] = useState({ w: 48, h: 52 })
  // ---- 「单次拉长长度降低」----
  // 一次到达多个字（或换行重排）时，若宽度目标一步跳到底，"单次拉长的长度"就很长。
  // 这里把**宽度**的改变分批推进：每帧最多 MAX_W_STEP px，剩下的由 rAF 泵继续追
  // （所以只是把一次大拉长拆成几次小拉长，绝不会停在半路）。
  // ⚠ 高度**不参与**分批：换行是离散事件，必须立刻让开，否则内容会被压缩。
  // 泵由量测回调按需启动、追平即自行停止 —— 不常驻 rAF，空闲时零开销。
  const MAX_W_STEP = 14
  const widthTargetRef = useRef(size.w)
  const sizeRef = useRef(size)
  const pumpRafRef = useRef(0)
  // 输入框**进入动画**的起点：框初始高度 ×2（用户指定）。
  // ⚠ 必须用 ref 固定住挂载那一刻的值：size 随后还会被量测改写，
  //   若直接用 size.h 参与 initial，飞入距离会在中途变化（起点"跟着跳"）。
  const enterFromY = useRef(size.h * 3)   // size 初值 h=52 → 156px（"3× 初始药丸高度"）
  // ⚠ 为什么不用 `initial` 驱动进入动画：
  //   祖先里只要有一个 <AnimatePresence initial={false}>（本项目多处都有），
  //   framer 会让**首帧挂载的子元素直接落在 animate 目标上** —— `initial` 整段被吞掉，
  //   表现就是"完全没有飞入，只剩外层的淡入"（用户实测原话）。
  //   所以改成：先让 animate 目标是"起点"，**下一帧**再翻成"终点"。
  //   动画由 animate **目标变化**触发 ⇒ 与 initial={false} 无关，一定跑得起来。
  //   用双 rAF：单帧有时会和首帧合并，导致起点与终点同帧、等于没动。
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setEntered(true)) })
    return () => { cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2) }
  }, [])
  // 只有真的超宽才换行（见 CSS 里 .wrapped 的说明）
  const [wrapped, setWrapped] = useState(false)

  // 药丸尺寸：先按“不换行的自然宽度”量一次——
  //   放得下 → 单行，宽度就是这个自然宽（文字多长药丸就多长，没有左右边界）；
  //   放不下 → 限定到安全宽度，让文字换行、药丸向下长高。
  // 高度由行的真实高度决定（ResizeObserver 盯着，换行/增删都会自动跟上）。
  useLayoutEffect(() => {
    const cap = Math.min(window.innerWidth - 160, 900)
    // 药丸整体放大到 120%：只放大外框（内边距/最小宽度），**字号不动**
    const hPad = 44
    const vPad = 30
    const el = measureRef.current
    if (el) el.textContent = text || ''
    // 量尺寸一律用 offsetWidth/offsetHeight（**布局**尺寸），
    // 不能用 getBoundingClientRect：后者把字符正在做的 y 位移也算进去，
    // 字符一飞入行就"变高"→ 药丸跟着向下拉伸（实测就是这个）。
    const natural = el ? Math.ceil(el.offsetWidth) + hPad : 40
    setWrapped(natural > cap)

    const apply = (w: number) => {
      const row = charsRowRef.current
      const h = row ? row.offsetHeight + vPad : 44
      widthTargetRef.current = w
      // 高度立刻跟随（见上面注释）；宽度交给泵分批推进
      if (sizeRef.current.h !== h) {
        sizeRef.current = { ...sizeRef.current, h }
        setSize(sizeRef.current)
      }
      if (pumpRafRef.current) return
      const pump = () => {
        pumpRafRef.current = 0
        const target = widthTargetRef.current
        const cur = sizeRef.current.w
        const dw = target - cur
        if (Math.abs(dw) <= 0.5) {          // 已到位：泵自停
          if (cur !== target) {
            sizeRef.current = { ...sizeRef.current, w: target }
            setSize(sizeRef.current)
          }
          return
        }
        sizeRef.current = {
          ...sizeRef.current,
          w: cur + Math.max(-MAX_W_STEP, Math.min(MAX_W_STEP, dw)),
        }
        setSize(sizeRef.current)
        pumpRafRef.current = requestAnimationFrame(pump)
      }
      pumpRafRef.current = requestAnimationFrame(pump)
    }
    apply(Math.max(40, Math.min(natural, cap)))
    if (!charsRowRef.current) return
    // ⚠ 回调里必须**重新量一次**：它可能在"新文字已到、本 effect 还没重跑"的那一帧触发，
    //   沿用闭包里的旧 natural 会把刚长出来的宽度又按回去
    //   （表现就是用户报的"新文字飞入时输入框没有伸长"）。
    const ro = new ResizeObserver(() => {
      const m = measureRef.current
      if (m) apply(Math.max(40, Math.min(Math.ceil(m.offsetWidth) + hPad, cap)))
    })
    ro.observe(charsRowRef.current)
    return () => {
      ro.disconnect()
      if (pumpRafRef.current) { cancelAnimationFrame(pumpRafRef.current); pumpRafRef.current = 0 }
    }
  }, [text, isFollowUp, isListening])

  return (
    <div className={`voice-pill-wrapper ${isFollowUp ? 'follow-up' : ''}`}>
      <motion.div className="voice-pill-container" data-acrylic-host=""
        // 进入动画：从下方「框初始高度 × 2」处飞入 + 同时淡入（用户指定）。
        //   · 行程：size 的初值 h = 52 ⇒ 52 × **3** = **156px**（用 ref 固定住初值，
        //     否则后面量到真实高度时会把"起点"也一起改掉，飞入距离会中途变）。
        //   · 时长：PILL_ENTER_S = 一个字上升+下落 ≈ 0.520s（与文字飞完同拍）。
        //   · y 与 opacity **同一个时长** ⇒ 同时起飞、同时到位。
        // ⚠ 淡入起点是 **0.8**（用户："淡入起始完成 80%"）：动画一开始就已经八成可见，
        //    最后两成在这段时长里补完 —— 不会再从"完全看不见"起步。
        // ⚠ 不用 initial：它会被祖先的 <AnimatePresence initial={false}> 吞掉
        //   （首帧挂载的子元素直接落在 animate 目标上 → 完全没有飞入，只剩淡入）。
        //   改为由 entered 翻转 animate 目标来驱动 ⇒ 与 initial={false} 无关，必然生效。
        animate={{
          // 收拢时 y 也一起上移到胶囊中心（-26，推导见 PILL_COLLAPSE）：
          // 没有 this 项时药丸只原地缩小，中心停在 +32 → 与胶囊中心(+6)差 26px = "没上移"。
          y: collapse ? collapse.y : (entered ? 0 : enterFromY.current),
          // ⚠ 收拢期间**绝不淡出**（用户实测：一边上升一边透明 = 被读成"向上飞出+淡出"）。
          //   药丸全程保持可见地缩到加载胶囊的位置与尺寸，然后在 340ms 那一帧与胶囊
          //   **硬交接**（同帧卸载/挂载、中心已逐像素对齐，见 PILL_COLLAPSE.y）。
          //   交接后胶囊自己的文字带 CONTENT_FADE 淡入 —— 连续感由它负责，不靠药丸变透明。
          opacity: entered ? 1 : 0.3,
          width: collapse ? collapse.w : size.w,
          height: collapse ? collapse.h : size.h,
        }}
        // 药丸只做形变，**绝不回弹**（回弹会让宽度看起来在抽）。
        // ⚠ 这里曾经是 `duration: 0.06, ease: 'linear'`（宽高共用）——"不够顺滑"的两个根源：
        //   ① 与文字让位（layout 0.26s）**差 4.3 倍**：盒子"啪"一下到位、字还在慢慢滑 → 脱节；
        //   ② 线性缓动**首尾加速度突变**（起步瞬间满速、到位瞬间急停）→ 生硬。
        // 现在按"**宽度要快但不要硬；高度可以慢，因为它不会造成右边缘切口**"拆开：
        //   · **宽度 0.2s + 强 easeOut([0.16,1,0.3,1])**（用户："拉长需要变慢，大约 0.2s 到位"）。
        //     保留强 easeOut 是有意的：它前 ~30% 时间就走完 ~80% 宽度，
        //     所以"新字已就位、盒子还没跟上"的那段**切口窗口被压到最短**，
        //     同时尾巴是软的（不再急停）——慢速拉长与"不裁字"两者靠这条曲线共存。
        //   · 高度 0.2s + 同款 easeOut；文字让位也是 0.2s（见每颗字的 layout）
        //     → **宽、高、让位同一条 0.2s 节奏**，整体是一次呼吸而不是各走各的。
        // 为什么高度可以放心慢：切口只发生在**水平**方向，纵向拉长不裁任何东西。
        transition={{
          // 药丸自身的**进入动画**（从下往上飞入 + 同时淡入），时长 = 一个字的完整飞入。
          // 用与文字同族的强 easeOut，起步快、收尾软 —— 不要弹簧（会回弹）。
          // 收拢（collapse）时 y 与宽高同用 0.3s：三者同起同止，一次连续形变。
          y: collapse
            ? { duration: 0.3, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
            : { duration: PILL_ENTER_S, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
          // 浓度只服务进入动画（收拢期间浓度不变，见上面 animate.opacity 的说明）
          opacity: { duration: PILL_ENTER_S, ease: 'easeOut' as const },
          width: collapse
            ? { duration: 0.3, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
            // 拉长行程 **1s**、**不加延迟**（用户："更慢（1s），不加延迟了"）。
            //   靠"时长本身慢"而不是"先停 0.1s 再走"来拉长右弧裁切的可见窗口 ——
            //   起步延迟会让框显得反应迟钝（上一次的 0.1s 已撤掉）。
            : { duration: 1, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
          height: collapse
            ? { duration: 0.3, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
            // ⚠ 高度不跟着变慢：它是换行重排，慢下来会把内容挤压。
            : { duration: 0.2, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
        }}>
        <AcrylicLayer blur={ACRYLIC_BLUR.card} />
        <div className="voice-text-area">
          <div ref={charsRowRef} className={`voice-chars-row${wrapped ? ' wrapped' : ''}`}>
            {chars.length === 0 && isFollowUp && !isListening && (
              <span className="voice-placeholder-text">向 Dony 提问</span>
            )}
            {/* popLayout：撤掉的字立刻脱离排版（不影响其它字），自己在原位向下撤出 */}
            {/* ⚠ 这里**不要**再传 initial={false}：它会让首批文字跳过 initial 状态，
                于是"框带上来的第一个文字"直接是清晰的（用户实测原话）。
                放开 initial 后，每个新字都会真的走一遍 "模糊 → 清晰"。 */}
            <AnimatePresence mode="popLayout">
              {chars.map((ch, i) => (
                <motion.span key={i} className="voice-char"
                  // 「首个文字」只做浓度 + 模糊（**不向上**）；之后的字才做
                  // "上冲 → 过顶 → 慢慢落回"。用冻结边界 firstBatchEnd 保证不变体切换。
                  layout variants={i < firstBatchEnd ? CHAR_MOTION_ENTERING : CHAR_MOTION}
                  initial="hidden" animate="visible" exit="exit"
                  // ⚠ delay 必须写进**每个属性**里：framer 的 per-prop transition 会覆盖根级 delay。
                  //   前段（i < frontLen）delay=0；后段整体晚 CHAR_SEG_GAP 起飞 → "前后两段分开"。
                  transition={i < firstBatchEnd
                    ? {
                        // 首个文字：只有浓度 + 模糊（无位移）
                        opacity: { duration: 0.12, ease: 'easeOut' as const, delay: i >= frontLen ? CHAR_SEG_GAP : 0 },
                        filter: { duration: 0.55, ease: 'easeOut' as const, delay: i >= frontLen ? CHAR_SEG_GAP : 0 },
                        // 让位按"同拍"方案（用户："文字让位按你的"）：与框的**宽度**同一条
                        // **1s** + 同一个 easeOut ⇒ 文字滑动与盒子拉长是一个动作，不再是两套节奏。
                        layout: { duration: 1, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
                      }
                    : {
                        y: { duration: CHAR_RISE_S + CHAR_FALL_S, times: [0, RISE_FRACTION, 1], ease: [EASE_RISE, EASE_FALL], delay: i >= frontLen ? CHAR_SEG_GAP : 0 },
                        opacity: { duration: 0.1, ease: 'easeOut' as const, delay: i >= frontLen ? CHAR_SEG_GAP : 0 },
                        // 模糊时间表（关键帧 [11, 11, 0, 0]）：
                        //   times[1] = 上升 30%（RISE_FRACTION × 0.3）→ 起清（不变）
                        //   times[2] = RISE_FRACTION = **上升 100%（过顶点）→ 完全清晰**
                        //     （上一版曾放到"下落 50%"，用户改回：还是以上升走完为准。）
                        //   ⇒ 模糊在上飞的后 70% 里逐渐收干净，越过顶点起全程清晰。
                        //   ⚠ ease 必须是 linear：用 EASE_RISE（quad-out）会让它在起步瞬间就被清掉
                        //     （用户实测："模糊看不见了"）—— 起段速度是平均的 2 倍，模糊前 10% 就没了。
                        filter: { duration: CHAR_RISE_S + CHAR_FALL_S, times: [0, RISE_FRACTION * 0.3, RISE_FRACTION, 1], ease: 'linear' as const, delay: i >= frontLen ? CHAR_SEG_GAP : 0 },
                        // 让位按"同拍"方案（用户："文字让位按你的"）：与框的**宽度**同一条
                        // **1s** + 同一个 easeOut ⇒ 文字滑动与盒子拉长是一个动作，不再是两套节奏。
                        layout: { duration: 1, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
                      }}>
                  {ch === ' ' ? '\u00A0' : ch}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
      {/* 只用来量“单行自然宽度”的隐藏刻度：与真实文字同字体同字号 */}
      <span ref={measureRef} className="voice-measure" aria-hidden="true" />
    </div>
  )
}
