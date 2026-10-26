import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  FAST_SETTLE, RESULT_LINE_BLUR, RESULT_MORPH_SECONDS, lineTimings,
} from './answerMotion'
import { ResultFrameContext, ResultSequenceContext } from './resultFrame'

/** 一行的飞入时序 */
export interface LineTiming {
  duration: number
  delay: number
}

/**
 * 结果框内"逐行飞入"的时序与起点测量 —— **正文与语音共用这一套**。
 *
 * 起点规则：所有行都从**结果框的最终底部**起飞（同一条线），框高用提前算好的目标高度，
 * 所以开始飞入时框还在扩大也没关系；超出框范围的行不参与动画。
 * 节奏：总数 = 正文行数 + 结果卡片数（卡片接在正文后面飞），总时长 = 框的形变时长。
 *
 * enabled=false（独立语音小窗那类没有结果框的地方）时不测量，由调用方退化处理。
 */
export function useLineFlyIn(lineCount: number, enabled = true) {
  const { height: frameHeight, cardRef } = useContext(ResultFrameContext)
  const { cardCount } = useContext(ResultSequenceContext)
  const lineRefs = useRef<(HTMLElement | null)[]>([])
  const [startYs, setStartYs] = useState<number[]>([])

  const timings = useMemo(
    () => lineTimings(lineCount + cardCount, RESULT_MORPH_SECONDS),
    [lineCount, cardCount],
  )

  useLayoutEffect(() => {
    if (!enabled) {
      setStartYs([])
      return
    }
    const card = cardRef?.current
    if (!frameHeight || !card || lineCount === 0) {
      setStartYs([])
      return
    }
    const frameBottom = card.getBoundingClientRect().top + frameHeight
    const next = Array.from({ length: lineCount }, (_, i) => {
      const el = lineRefs.current[i]
      return el ? Math.max(0, frameBottom - el.getBoundingClientRect().top) : 0
    })
    setStartYs((prev) => (
      prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
    ))
  }, [enabled, lineCount, frameHeight, cardRef])

  /** 起点是否已量好（量好之前行先不显示，layout 阶段就会补上，用户看不到那一帧） */
  const ready = enabled ? startYs.length === lineCount : false

  const register = (i: number, el: HTMLElement | null) => { lineRefs.current[i] = el }

  return { timings, startYs, ready, register }
}

interface FlyingLineProps {
  index: number
  /** 纯文本行；需要自定义内容时用 children */
  text: string
  timing: LineTiming
  /** 起飞距离（由 useLineFlyIn 算好）：0 表示不参与飞入 */
  startY: number
  ready: boolean
  className: string
  register: (i: number, el: HTMLElement | null) => void
  children?: ReactNode
}

/**
 * 一行文字：统一从框的最终底部起飞，带起点模糊（模糊消退比位移快一倍）。
 *
 * ⚠ 调用方要用 `key={ready ? ... : ...}` 让它在拿到起飞距离后重新挂载一次 ——
 * framer-motion 的 initial 只在挂载时生效，不重新挂载飞入不会播。
 */
export function FlyingLine({
  index, text, timing, startY, ready, className, register, children,
}: FlyingLineProps) {
  const fly = ready && startY > 0
  return (
    <motion.p
      className={className}
      ref={(el) => register(index, el as HTMLElement | null)}
      style={ready ? undefined : { opacity: 0 }}
      initial={fly ? { y: startY, opacity: 0, filter: `blur(${RESULT_LINE_BLUR}px)` } : false}
      animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
      transition={fly
        ? {
          y: { duration: timing.duration, ease: FAST_SETTLE, delay: timing.delay },
          filter: { duration: timing.duration * 0.5, ease: FAST_SETTLE, delay: timing.delay },
          opacity: { duration: timing.duration * 0.32, ease: 'linear' as const, delay: timing.delay },
        }
        : { duration: 0 }}
    >
      {children ?? text}
    </motion.p>
  )
}
