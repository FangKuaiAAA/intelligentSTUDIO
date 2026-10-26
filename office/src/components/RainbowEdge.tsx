import { useEffect, useRef } from 'react'
import { computeGeometry, disposeEdge, renderEdge } from '@dony/components/overlay/rainbow/rainbowPill'

interface RainbowEdgeProps {
  active: boolean
  /** 光边相对宿主边缘的外扩（px）：动作格子空间小，取 5 */
  inset?: number
  /** 宿主圆角 */
  radius?: number
}

/**
 * 任意小卡片的"沿边旋转光边"（skill 里的 .rb-edge）。
 *
 * 尺寸不自己猜：读宿主的真实盒模型，减去两侧外扩，得到卡片本身的宽高再算几何 ——
 * dash 数值是按真实路径长度生成的，尺寸差 1px 就会看到光带端点对不齐。
 */
export function RainbowEdge({ active, inset = 5, radius = 10 }: RainbowEdgeProps) {
  const edgeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const edge = edgeRef.current
    const host = edge?.parentElement
    if (!edge || !host) return

    const render = (): void => {
      const rect = host.getBoundingClientRect()
      const width = rect.width - 2 * inset
      const height = rect.height - 2 * inset
      if (width < 12 || height < 12) return
      renderEdge(edge, computeGeometry({ width, height, radius, room: inset }))
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(host)
    return () => {
      observer.disconnect()
      disposeEdge(edge)
    }
  }, [inset, radius])

  return (
    <div
      ref={edgeRef}
      className={`rb-edge${active ? ' is-active' : ''}`}
      style={{ inset: -inset, zIndex: 0, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}
