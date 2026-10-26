import { motion } from 'framer-motion'
import { HexagonOutline } from './HexagonOutline'

/**
 * 可见尺寸（DIP）。比例全部来自参考图的像素实测（原图标签 44×36）：
 *   · 本体比高略窄（实测 30/35 ≈ 0.86×高）—— 做成正方形会显得扁
 *   · 凸点外伸约 0.43×高（15/35），基部宽约 0.86×高（30/35）
 *   · 圆角约 0.17×高（6/35）
 *
 * ⚠ 注意"外伸 : 基部 = 1 : 2"这个比值 —— 它是 45° 旋转方块的几何特征
 * （旋转方块压在本体右缘上时，外伸量 = 半对角线 = 基部的一半）。参考图实测正是 15:30，
 * 说明那张图里的标签本身就是这么做的，所以这里用同一种做法可以完全对上。
 */
export const TAG_HEIGHT = 21
/** 本体宽（不含凸点） */
export const TAG_BODY = 18
/** 凸点外伸长度 */
export const TAG_TIP = 9
export const TAG_WIDTH = TAG_BODY + TAG_TIP
/** 本体圆角。
 *  参考图实测约 0.17×高（≈3.6），但 4px 在 18px 宽的本体上实测观感几乎看不出圆角
 *  （用户："圆角没了"）。取 5px：既有明确的圆角轮廓，又不超过参考图那种"方中带圆"的比例。 */
export const TAG_RADIUS = 5
/**
 * 凸点 = 同色旋转方块（见 WritingTools.css 的 ::after）。
 *
 * 边长必须让"钻石最宽处 = 本体侧边"：方块转 45° 后水平中心处的竖直跨度 = 边长 × √2，
 * 令它等于本体高 21 ⇒ 边长 ≈ 15。**取小了就会出现"方块旁边挂个小三角"**（接缝差一截），
 * 取大了三角形会从本体上下角探出去。所以这里按 height 反算，不写死数字。
 */
export const TAG_TAIL_BOX = Math.round(TAG_HEIGHT / Math.SQRT2)

/**
 * 不可见的点击热区外扩。
 *
 * 可见图形只有 26×21：指针贴着边缘点、或 60ms 轮询周期里指针在边缘抖动，
 * 点击就会落在图形之外 —— 表现是"看着点了、毫无反应"（用户实测）。
 * 所以把按钮本体做大（四周外扩），可见的气泡单独画在里面；热区右侧只外扩 4px，
 * 因为标签右边紧挨着正文第一个字，外扩多了会抢走点正文的点击。
 */
export const TAG_HIT = { left: 8, top: 8, right: 4, bottom: 8 } as const
export const TAG_BOX_W = TAG_WIDTH + TAG_HIT.left + TAG_HIT.right
export const TAG_BOX_H = TAG_HEIGHT + TAG_HIT.top + TAG_HIT.bottom

interface SelectionTagProps {
  /** 已算好的窗口内位置（左上角，指可见气泡本体） */
  pos: { x: number; y: number }
  /** 指针是否靠近锚点或标签本身 —— 只有靠近才显示，这是用户明确要求的 */
  visible: boolean
  /** 主题色（主进程读取 Windows 个性化色后下发） */
  color: string
  onClick: () => void
}

/**
 * 选区开头的标签小框：**圆角本体 + 右中凸点**（凸点指向选区里的第一个字）。
 *
 * 形状用 CSS 做，不用 SVG 多边形，也不用 clip-path：
 *   · SVG 多边形要做出"圆角凸点"只能靠"同色粗描边 + strokeLinejoin:round"，
 *     而粗描边会把凸点一起磨掉 —— 上一版就是这样退化成一个纯圆角矩形的（用户实测形状错误）。
 *   · clip-path 能做准形状，但会连抗锯齿边缘一起切，且圆角尖角要手写 path。
 *   · 正统写法是"圆角矩形本体 + ::after 的同色旋转方块"：接缝天然消失，
 *     方块给一点圆角就是圆钝尖角，和参考图一致（见 WritingTools.css 的 .wt-tag-bubble）。
 *
 * 图案是线描六边形，白色（参考图里那枚图案就是白色）。
 */
export function SelectionTag({ pos, visible, color, onClick }: SelectionTagProps) {
  return (
    <motion.button
      type="button"
      className="wt-tag"
      aria-label="书写辅助"
      data-wt-hit="1"
      style={{
        // 按钮本体 = 可见气泡 + 不可见热区；可见的气泡偏移到热区内的正确位置
        left: pos.x - TAG_HIT.left,
        top: pos.y - TAG_HIT.top,
        width: TAG_BOX_W,
        height: TAG_BOX_H,
        // 隐藏时必须放行鼠标：否则屏幕这一小块会一直吃掉点击
        pointerEvents: visible ? 'auto' : 'none',
      }}
      // initial 取 0（而不是 false）：需求要求"淡入"，不能一挂上就是全量显示。
      // 淡入 0.4s（需求）；淡出仍走短时长 —— 消失得快一点更干净。
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      exit={{ opacity: 0, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onClick={onClick}
    >
      {/* 不可见"接点击"层：把整个热区画上 alpha≈1/255 的底色。
          ⚠ 这一层是必需的，不是装饰。窗口是 WS_EX_LAYERED 的透明窗，
          Windows 对它的命中测试是**按像素 alpha**做的：完全透明的地方点击直接穿透。
          于是只画可见气泡（18×21）时，外面那圈热区虽然被主进程判为"指针在界面上"，
          系统却照旧把点击送给下面的程序 —— 用户瞄着气泡点、手一偏就落空，
          而且点击会穿到下面的编辑器里（把选区点没）。
          0.4% 的白在肉眼上不可辨，却让这一整块对系统"有像素"。 */}
      <span className="wt-tag-hit" aria-hidden />
      <span
        className="wt-tag-bubble"
        style={{
          left: TAG_HIT.left,
          top: TAG_HIT.top,
          width: TAG_BODY,
          height: TAG_HEIGHT,
          // 主题色与几何都从组件传进 CSS，样式表里不再写死数值
          ['--wt-tag-bg' as string]: color,
          ['--wt-tag-radius' as string]: `${TAG_RADIUS}px`,
          ['--wt-tag-tail-box' as string]: `${TAG_TAIL_BOX}px`,
        }}
      >
        {/* 图案要明显大于本体宽（22 in 18）：六边形在它自己的 32 单位视口里只占
            65%×75%，按 size 直接给"塞满"会偏小。描边同理 —— strokeWidth 是
            **视口单位**，渲染出来的实际线宽 = strokeWidth × size/32，
            1.6 在 size 19 时只有 0.95px，看起来发虚、像画坏了（用户实测"图标异常"）。 */}
        <HexagonOutline size={22} strokeWidth={2.3} rainbow={false} />
      </span>
    </motion.button>
  )
}
