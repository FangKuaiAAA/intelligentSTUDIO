/* 返回文字的逐行飞入。
   结果框与语音各一套：结果框是"所有行从框的最终底部统一起飞"（见 ResponseBox），
   语音自绘样式，两套不做统一 —— 两种模式的观感本来就不同。 */

export type LineEase = [number, number, number, number]

/* 曲线：快速——末尾小幅减速缓冲。
   cubic-bezier(.25,.8,.5,1)：走完 41% 时间已到 80% 行程（起步即全速），
   最后 5% 行程用剩下约 1/3 的时间轻轻收住，不是“早早停下再慢慢蹭”那种长减速。 */
export const FAST_SETTLE: LineEase = [0.25, 0.8, 0.5, 1]

/** 结果框「形变放大」的总时长（秒）——**唯一来源**。
 *
 *  【强制绑定】"返回框放大总时间" ≡ "文字飞入总时间" ≡ 这个值：
 *    · 框：DonyMorph 的 RESULT_MORPH_TRANSITION 用它当 spring 的 duration；
 *    · 文字：lineTimings() 的 last 行满足 delay + duration ≡ 本值（见该函数）；
 *    · 卡片：ResultCards 也在本值窗口内飞完。
 *  三者同时开始、同时结束。想调快/调慢只改这一个数，不要分别改。 */
export const RESULT_MORPH_SECONDS = 0.9

/** 结果框文字的起始模糊半径（px）。
 *  只有**文字**带模糊；结果卡片本身不模糊（卡片是从下方干净地飞入）。 */
export const RESULT_LINE_BLUR = 8

/** 第一行用时占总时长的比例（它飞得最远，却最快 —— "第一行极快"） */
const LINE_DURATION_FIRST_RATIO = 0.22
/** 最后一行用时占总时长的比例（它飞得最近，却最慢） */
const LINE_DURATION_LAST_RATIO = 0.6

/**
 * 结果框文字的飞入节奏（逐行算出各自的时长与延迟）。
 *
 * 前提：**所有行都从同一个位置起飞** —— 框的最终底部（见 ResponseBox）。
 * 于是第一行要飞的距离最长、最后一行最短。要的观感：
 *   · 第一行"极快"：飞得最远、用时最短（速度最快）；
 *   · 之后逐行变慢，**最后一行最慢**，而且它飞完的那一刻**正好是框扩到位那一刻**；
 *   · 逐行只是"错开一点"，不是第一行完全飞完才开始第二行（相邻行互相重叠）。
 *
 * 所以单行时长逐行**递增**（first → last），行间隔 = (总时长 − last) / (n−1)，
 * 这样最后一行满足 delay + duration = 总时长。
 */
export function lineTimings(lineCount: number, total = RESULT_MORPH_SECONDS) {
  const n = Math.max(1, lineCount)
  if (n === 1) return [{ duration: total, delay: 0 }]
  const dLast = total * LINE_DURATION_LAST_RATIO
  const dFirst = total * LINE_DURATION_FIRST_RATIO
  const stagger = (total - dLast) / (n - 1)
  return Array.from({ length: n }, (_, i) => ({
    duration: dFirst + (dLast - dFirst) * (i / (n - 1)),
    delay: i * stagger,
  }))
}

/* ===== 语音模式：自己一套（距离短、节奏稍紧，起点用固定偏移） ===== */

export interface LineMotion {
  /** 起始位置在最终位置下方多少像素（飞入距离） */
  distance: number
  /** 单行时长 */
  duration: number
  /** 行与行的间隔 */
  stagger: number
  ease: LineEase
}

export const VOICE_LINE_MOTION: LineMotion = {
  distance: 22,
  duration: 0.85,
  stagger: 0.2,
  ease: FAST_SETTLE,
}

/** 生成逐行飞入的 variants（语音用）。每行起点一致（不按行号叠加距离）。
    淡入比位移快（约 1/3 时长就到位），所以观感是“文字先到、余下的是位置缓冲”。 */
export function makeLineVariants({ distance, duration, stagger, ease }: LineMotion) {
  return {
    hidden: { opacity: 0, y: distance },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: {
        y: { duration, ease, delay: i * stagger },
        opacity: { duration: duration * 0.32, ease: 'linear' as const, delay: i * stagger },
      },
    }),
  }
}

/** 语音模式用（短距离） */
export const voiceLineVariants = makeLineVariants(VOICE_LINE_MOTION)

/* ===== 语音追问过渡：新药丸的「升起」=====
   要求是"像第一次唤醒一样从下方升起新输入框"，且与旧返回框上飞**同时结束**。
   数值与 DonyMorph 的首唤醒飞入保持一致（那边是 CSS 关键帧 donyEnterRise：
   0.62s + cubic-bezier(.33,1,.68,1)，也就是幂曲线 powerOut 的等价缓动）。 */
export const VOICE_RISE_SECONDS = 0.62
export const VOICE_RISE_EASE: LineEase = [0.33, 1, 0.68, 1]
/** 起飞点：屏幕下方（与 DonyMorph 首唤醒的起飞距离同一个算法）
 *  ⚠ 整体 ×0.8 = "飞入高度改原来的 80%"（用户要求）。
 *    下限 120 也一起按比例降为 96 —— 否则屏幕矮的时候会被下限顶回原值，80% 就失效了。 */
export function voiceRiseFrom() {
  return Math.max(96, Math.round((window.innerHeight * 0.88 - 40) * 0.8))
}

/** 语音药丸「形变收拢」的目标 —— **必须与加载胶囊逐值相同**
 *  （DonyMorph 的 STAGE_SIZE.processing = { w:159, h:36, r:18 }）。
 *  这是"自成一树"的形变：药丸把自己的**盒子宽高**动画收缩到它，观感就是"缩成加载胶囊"。
 *  ⚠ 刻意不用跨树 layoutId 投影：那个方案两次都出幻影（先是"快速旋转向内消失"，
 *    后是"两个图形：一个飞入、一个在终点"）—— 两棵树里的两个元素必然同时存在，
 *    同 id 撞车后由 framer 互相投影，形状与方向都会失控。
 *  y = 形变末位置的**上移量**（"末位置不对（没上移）"的根因就是这个缺项）：
 *      胶囊静止位 restY = -12（DonyMorph 的 stage 常量）+ 高 36/2 → 中心 = 舞台顶 +6px
 *      药丸布局位：躺在一个 64px 高的绝对定位盒里垂直居中        → 中心 = 舞台顶 +32px
 *      Δ = 6 − 32 = **-26px** ⇒ 收拢时把 y 动画到 -26，中心与胶囊逐像素重合。 */
export const PILL_COLLAPSE = { w: 159, h: 36, r: 18, y: -26 } as const

/** 按行拆分返回文本（丢弃空行），各模式共用同一套拆行规则。 */
export function splitAnswerLines(content: string): string[] {
  if (!content) return []
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}
