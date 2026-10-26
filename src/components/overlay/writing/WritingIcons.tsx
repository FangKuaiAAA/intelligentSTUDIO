import type { ReactNode } from 'react'

/**
 * 书写辅助的线描图标集。
 *
 * 统一 24×24 视图框、`currentColor` 描边（颜色完全交给 CSS 变量，明暗两套自动跟随），
 * 不引第三方图标库 —— 项目现有图标（cardIcons.tsx）也是自绘的，保持一致。
 */
function Svg({ size = 18, strokeWidth = 1.6, children }: {
  size?: number
  strokeWidth?: number
  children: ReactNode
}) {
  return (
    <svg
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
      {children}
    </svg>
  )
}

export function IconProofread(props: { size?: number }) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6.2" />
      <path d="M15.2 15.2 19.8 19.8" />
      <path d="M8 10.7l1.7 1.7 3.3-3.6" />
    </Svg>
  )
}

export function IconRewrite(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M20 11.5a8 8 0 1 1-3.2-6.4" />
      <path d="M20 4v5h-5" />
    </Svg>
  )
}

export function IconFriendly(props: { size?: number }) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.4 14.2a4.6 4.6 0 0 0 7.2 0" />
      <circle cx="9.3" cy="9.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="9.8" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconFormal(props: { size?: number }) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="7.4" width="17.6" height="11.4" rx="2.6" />
      <path d="M9 7.4V6.1a2.1 2.1 0 0 1 2.1-2.1h1.8A2.1 2.1 0 0 1 15 6.1v1.3" />
      <path d="M3.2 12.4h17.6" />
    </Svg>
  )
}

export function IconConcise(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h11" />
      <path d="M4 17h7" />
    </Svg>
  )
}

export function IconSummary(props: { size?: number }) {
  return (
    <Svg {...props}>
      <rect x="4.4" y="3.6" width="15.2" height="16.8" rx="2.6" />
      <path d="M8.2 9h7.6" />
      <path d="M8.2 13h7.6" />
      <path d="M8.2 17h4.6" />
    </Svg>
  )
}

export function IconKeypoints(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M9.4 6.6h10.4" />
      <path d="M9.4 12h10.4" />
      <path d="M9.4 17.4h10.4" />
      <circle cx="4.9" cy="6.6" r="1.35" />
      <circle cx="4.9" cy="12" r="1.35" />
      <circle cx="4.9" cy="17.4" r="1.35" />
    </Svg>
  )
}

export function IconList(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M4.4 6.6h1.4" />
      <path d="M4.4 12h1.4" />
      <path d="M4.4 17.4h1.4" />
      <path d="M9.6 6.6h10.2" />
      <path d="M9.6 12h10.2" />
      <path d="M9.6 17.4h10.2" />
    </Svg>
  )
}

export function IconTable(props: { size?: number }) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.2" />
      <path d="M3.4 10.4h17.2" />
      <path d="M9.6 5.4v13.2" />
    </Svg>
  )
}

export function IconPen(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M4 20.2l.7-3.6L15.4 5.9a2.2 2.2 0 0 1 3.1 3.1L7.6 19.5 4 20.2z" />
      <path d="M14.2 7.1l3.1 3.1" />
    </Svg>
  )
}

export function IconUndo(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M9 5 4.8 9.2 9 13.4" />
      <path d="M4.8 9.2h9.4a5 5 0 0 1 0 10H9.6" />
    </Svg>
  )
}

export function IconEye(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M2.6 12S6.2 6.2 12 6.2 21.4 12 21.4 12 17.8 17.8 12 17.8 2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.7" />
    </Svg>
  )
}

export function IconClose(props: { size?: number }) {
  return (
    <Svg {...props}>
      <path d="M6.5 6.5 17.5 17.5" />
      <path d="M17.5 6.5 6.5 17.5" />
    </Svg>
  )
}
