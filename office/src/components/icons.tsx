/** 线条图标：统一 1.5px 描边、圆头，尺寸由 size 决定（默认 16） */
import type { JSX } from 'react'

interface IconProps {
  size?: number
}

const svg = (size: number, children: JSX.Element): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const IconProofread = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M4 6h9M4 11h6M4 16h5" />
      <path d="M13.5 16.5l2.3 2.3L21 13.5" />
    </>
  )

export const IconRewrite = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M20 11a8 8 0 1 0-2.6 6" />
      <path d="M20 5v6h-6" />
    </>
  )

export const IconFriendly = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14.2c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
      <path d="M9 9.6h.01M15 9.6h.01" />
    </>
  )

export const IconFormal = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M9 4h6l-1.6 4.2L12 10l-1.4-1.8L9 4z" />
      <path d="M12 10v10" />
      <path d="M9 4l3 6 3-6" />
    </>
  )

export const IconConcise = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M4 7h16" />
      <path d="M4 12h10" />
      <path d="M4 17h6" />
    </>
  )

export const IconList = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  )

export const IconTable = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M9.5 9.5v10M15 9.5v10" />
    </>
  )

export const IconUndo = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M4 10a8 8 0 1 1 2.6 6" />
      <path d="M4 4v6h6" />
    </>
  )

export const IconEye = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  )

export const IconBack = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </>
  )

export const IconWand = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M4 20l9.5-9.5" />
      <path d="M14.5 4.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4z" />
    </>
  )

export const IconDownload = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M12 4v10" />
      <path d="M8 10.5l4 4 4-4" />
      <path d="M4.5 19.5h15" />
    </>
  )

export const IconClose = ({ size = 16 }: IconProps) =>
  svg(
    size,
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  )

/** 六边形：与桌面端输入框左侧那枚同一形状 */
export const IconHexagon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3.2l7 4v9.6l-7 4-7-4V7.2l7-4z"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
  </svg>
)
