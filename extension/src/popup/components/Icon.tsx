/** 线条图标集：只用纯线条，避免任何表情符号（与主软件一致） */
export type IconName =
  | 'spark'
  | 'eye'
  | 'layers'
  | 'bookmark'
  | 'close'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'send'
  | 'shield'
  | 'cpu'
  | 'info'
  | 'alert'
  | 'check'
  | 'link'
  | 'crop'
  | 'page'

const PATHS: Record<IconName, string> = {
  spark: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5z',
  eye: 'M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z M12 9.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8z',
  layers: 'M4 7h16M4 12h16M4 17h10',
  bookmark: 'M7 3.8h10a1.2 1.2 0 011.2 1.2v14.6L12 16.4l-6.2 3.2V5A1.2 1.2 0 017 3.8z',
  close: 'M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6',
  // 旋转箭头：整圈圆弧 + 顶部箭镞，比旧的"带钩圆弧"更容易一眼认成"刷新"
  refresh: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  forward: 'M9.5 5.5L16 12l-6.5 6.5',
  send: 'M12 19.5V5.5M6.5 11L12 5.5 17.5 11',
  shield: 'M12 3.5l7 2.6v5.4c0 4.2-2.9 7.2-7 9-4.1-1.8-7-4.8-7-9V6.1l7-2.6z',
  cpu: 'M8 8h8v8H8V8zM4.5 9.5H2M4.5 14.5H2M22 9.5h-2.5M22 14.5h-2.5M9.5 4.5V2M14.5 4.5V2M9.5 22v-2.5M14.5 22v-2.5',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 10.5V16M12 7.6v.8',
  alert: 'M12 3.8l8.6 15H3.4l8.6-15zM12 9.6v4.2M12 16.4v.6',
  check: 'M5 12.8l4.4 4.2L19 7.4',
  link: 'M10.4 13.6a3.4 3.4 0 004.8 0l2.6-2.6a3.4 3.4 0 10-4.8-4.8l-1 1M13.6 10.4a3.4 3.4 0 00-4.8 0L6.2 13a3.4 3.4 0 104.8 4.8l1-1',
  crop: 'M6.5 3.5v14h14M3.5 6.5h14v14',
  page: 'M6.5 3.5h7.5l3.5 3.5v13.5h-11V3.5zM14 3.5V7h3.5M9 11.5h6M9 15h6',
}

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}

export function Icon({ name, size = 16, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
