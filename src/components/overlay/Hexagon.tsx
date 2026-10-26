/** 彩虹渐变六边形（旋转），供任务模式加载球/伸长药丸使用。 */
export function Hexagon({ size = 40, spinning = true }: { size?: number; spinning?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="hexagon-svg" aria-hidden>
      <defs>
        <linearGradient id="hexGradMorph" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF6B9D" />
          <stop offset="25%" stopColor="#C44DFF" />
          <stop offset="50%" stopColor="#4D8AFF" />
          <stop offset="75%" stopColor="#4DFFD9" />
          <stop offset="100%" stopColor="#FFD84D" />
        </linearGradient>
      </defs>
      <g style={spinning ? { animation: 'hexSpin 6s linear infinite', transformOrigin: '32px 32px' } : undefined}>
        <polygon points="32,12 49,22 49,42 32,52 15,42 15,22" fill="url(#hexGradMorph)" opacity="0.88" />
      </g>
    </svg>
  )
}
