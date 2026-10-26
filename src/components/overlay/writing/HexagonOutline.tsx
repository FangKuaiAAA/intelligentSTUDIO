/**
 * 完整的线描六边形（只有闭合轮廓，没有填充）。
 *
 * 与 `Hexagon.tsx` 的彩色填充版是两件不同的东西，刻意分开：
 * 那个是任务模式加载球在用的（旋转的实心渐变六边形），本组件是书写辅助标签上与
 * 菜单里的静态线描图标，两者不能互相顶替，也不该为了共用去改那个文件。
 */
export function HexagonOutline({
  size = 20, strokeWidth = 1.7, spin = false, gradientId = 'wtHexGrad', rainbow = true,
}: {
  size?: number
  strokeWidth?: number
  /** 缓慢自转（只用在"正在处理"状态上，静止态不转） */
  spin?: boolean
  /** 渐变 id 必须每个实例唯一，否则同页多个六边形会互相抢同一个 defs */
  gradientId?: string
  /** false 时改用 currentColor 单色描边 */
  rainbow?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={spin ? { animation: 'wtHexSpin 6s linear infinite' } : undefined}
    >
      {rainbow && (
        <defs>
          <linearGradient id={gradientId} x1="15%" y1="5%" x2="85%" y2="95%">
            <stop offset="0%" stopColor="#FF6B9D" />
            <stop offset="30%" stopColor="#C44DFF" />
            <stop offset="60%" stopColor="#4D8AFF" />
            <stop offset="100%" stopColor="#4DFFD9" />
          </linearGradient>
        </defs>
      )}
      <polygon
        points="16,4 26.4,10 26.4,22 16,28 5.6,22 5.6,10"
        fill="none"
        stroke={rainbow ? `url(#${gradientId})` : 'currentColor'}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
