interface ProgressBarProps {
  /** 阶段文字：提交请求 / 正在生成 / 取回图像 / 写入文档 */
  text: string
}

/**
 * 2px 不确定态进度条。
 *
 * 不显示百分比：生图是一次子进程调用，拿不到真实进度，画一条会停住的假进度条比
 * 不画更糟。这里用"一段 28% 宽的彩虹高光循环滑动"表示"还在走"，配一行阶段文字
 * 说明现在到哪一步。
 */
export function ProgressBar({ text }: ProgressBarProps) {
  return (
    <div className="st-progress" role="status" aria-live="polite">
      <div className="st-progress-track">
        <span className="st-progress-bar" />
      </div>
      <div className="st-progress-text">{text}</div>
    </div>
  )
}
