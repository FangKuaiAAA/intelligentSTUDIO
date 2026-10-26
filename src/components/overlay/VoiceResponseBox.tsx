import { useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { splitAnswerLines, voiceLineVariants } from './answerMotion'
import { FlyingLine, useLineFlyIn } from './flyingLines'
import './VoiceResponseBox.css'

interface VoiceResponseBoxProps {
  content: string
  isStreaming: boolean
  inMorph?: boolean
}

/**
 * 语音模式的返回文字。
 *
 * · 在结果框里（inMorph）：与键入模式**完全同一套**飞入 —— 从框的最终底部统一起飞、
 *   总时长等于框的形变时长、序列里还要数上结果卡片（见 flyingLines）。
 * · 独立语音小窗（!inMorph）：那里没有结果框可依附（没有目标高度与框底），
 *   所以保留短距离的固定偏移版本。
 */
export function VoiceResponseBox({ content, isStreaming, inMorph }: VoiceResponseBoxProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStreaming && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [content, isStreaming])

  const lines = useMemo(() => splitAnswerLines(content), [content])
  // 只有"在结果框里"才需要按框的最终底部算起点
  const { timings, startYs, ready, register } = useLineFlyIn(lines.length, !!inMorph)

  if (inMorph) {
    return (
      <div className="voice-response-morph" ref={boxRef}>
        <div className="voice-response-stream">
          {lines.length > 0 ? lines.map((line, i) => (
            <FlyingLine
              key={ready ? `l${i}` : `l${i}-pending`}
              index={i}
              text={line}
              timing={timings[i]}
              startY={ready ? startYs[i] : 0}
              ready={ready}
              className="voice-response-line"
              register={register}
            />
          )) : <span className="voice-response-placeholder">正在处理…</span>}
          {isStreaming && <span className="voice-streaming-cursor" />}
          <div ref={bottomRef} />
        </div>
      </div>
    )
  }

  return (
    <div className="voice-response-wrapper">
      <div className="voice-response-box" ref={boxRef}>
        <div className="voice-response-content">
          {lines.length > 0 ? lines.map((line, i) => (
            <motion.p key={i} className="voice-response-para" custom={i}
              variants={voiceLineVariants} initial="hidden" animate="visible">
              {line}
            </motion.p>
          )) : <span className="voice-response-placeholder">正在处理…</span>}
        </div>
        {isStreaming && <span className="voice-streaming-cursor" />}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
