import { useEffect, useMemo, useRef } from 'react'
import { splitAnswerLines } from './answerMotion'
import { FlyingLine, useLineFlyIn } from './flyingLines'
import './ResponseBox.css'

interface ResponseBoxProps {
  content: string
  isStreaming: boolean
  inMorph?: boolean
}

/**
 * 结果框正文：逐行飞入（时序与起点见 flyingLines.useLineFlyIn）。
 *
 * 起点是**结果框的最终底部**（所有行统一位置，不是"各自下方 N 像素"）；
 * 总时长 = 框的形变时长，且序列里还包含后面的结果卡片 → 三者同时收尾。
 */
export function ResponseBox({ content, isStreaming }: ResponseBoxProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStreaming && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [content, isStreaming])

  const paragraphs = useMemo(() => splitAnswerLines(content), [content])
  const { timings, startYs, ready, register } = useLineFlyIn(paragraphs.length)

  return (
    <div className="response-box-wrapper">
      <div className="response-box" ref={boxRef}>
        <div className="response-content">
          {paragraphs.length > 0 ? (
            paragraphs.map((para, i) => (
              <FlyingLine
                // 量到起飞距离后换 key 重新挂载一次，飞入才会播（见 FlyingLine 注释）
                key={ready ? `l${i}` : `l${i}-pending`}
                index={i}
                text={para}
                timing={timings[i]}
                startY={ready ? startYs[i] : 0}
                ready={ready}
                className="response-para"
                register={register}
              />
            ))
          ) : (
            <span className="response-placeholder">正在处理…</span>
          )}
        </div>
        {isStreaming && <div className="streaming-cursor" />}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
