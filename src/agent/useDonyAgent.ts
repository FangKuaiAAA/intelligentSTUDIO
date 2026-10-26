import { useCallback, useEffect, useRef, useState } from 'react'
import { agentSocket } from '../utils/ws'
import { DonyStage } from '../components/overlay/DonyMorph'
import { AskRequest } from '../components/overlay/AskDialog'
import { ResultCardData } from '../components/overlay/ResultCards'

interface UseDonyAgentOpts {
  isVoice: () => boolean
  /** 语音模式下朗读文本（接 voice_server TTS） */
  speak: (text: string) => void
  /** 一轮结束（进入 followUp） */
  onSettled: () => void
  onCancel: () => void
}

/**
 * Dony Agent 状态驱动：连接 WS 8767，把后端事件翻译为 DonyMorph 形变阶段。
 * 后端保留会话历史，前端每轮只发文本。
 */
export function useDonyAgent({ isVoice, speak, onSettled, onCancel }: UseDonyAgentOpts) {
  const [stage, setStage] = useState<DonyStage>('input')
  const [mode, setMode] = useState<'fast' | 'task' | null>(null)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [ask, setAsk] = useState<AskRequest | null>(null)
  const [cards, setCards] = useState<ResultCardData[]>([])
  const [response, setResponse] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [ttsEnabled, setTtsEnabled] = useState(true)
  // 「始终朗读回答」：开启后打字模式也朗读（屏幕光边会跟着语音跳动）
  const [ttsAlways, setTtsAlways] = useState(false)
  const [running, setRunning] = useState(false)
  // 朗读策略放 ref：事件回调里要读最新值，但不想为此重挂监听
  const speakPolicy = useRef({ enabled: true, always: false, voiceOnly: true })
  const stageRef = useRef<DonyStage>('input')
  const modeRef = useRef<'fast' | 'task' | null>(null)
  const responseRef = useRef('')
  const askReturnStage = useRef<DonyStage>('processing')   // 询问结束后要回到的阶段

  const gotoStage = useCallback((s: DonyStage) => {
    stageRef.current = s
    setStage(s)
  }, [])

  /** 是否朗读：总闸开启，且（「始终朗读回答」开启 或（「仅在说话时朗读」开启且当前是语音模式））。 */
  const shouldSpeak = useCallback(() => {
    const p = speakPolicy.current
    return p.enabled && (p.always || (p.voiceOnly && isVoice()))
  }, [isVoice])

  useEffect(() => {
    agentSocket.connect()
    return agentSocket.on((m) => {
      switch (m.type) {
        case 'init':
        case 'settings': {
          // 两种情况合一：连接时的 init，以及每轮开始前拉取的 settings
          const enabled = m.tts !== false
          const always = Boolean(m.tts_always)
          const voiceOnly = m.tts_voice_only !== false
          speakPolicy.current = { enabled, always, voiceOnly }
          setTtsEnabled(enabled)
          setTtsAlways(always)
          break
        }
        case 'mode': {
          modeRef.current = m.mode
          setMode(m.mode)
          if (m.mode === 'task' && (stageRef.current === 'processing')) {
            gotoStage('taskBall')
          }
          break
        }
        case 'tool-start':
          if (modeRef.current === 'task' && stageRef.current !== 'asking') {
            setToolLabel(m.label || m.name)
            gotoStage('taskPill')
          }
          break
        case 'tool-end':
          // 第一个操作开始后药丸就一直保持拉长状态：工具名留在药丸里，
          // 下一个工具名会把它向上滚出去（不再缩回球），
          // 只有整个任务结束（done）时才缩回球、再扩大成返回框。
          break
        case 'ask':
          askReturnStage.current = stageRef.current
          setAsk({ id: m.id, kind: m.kind, text: m.text })
          gotoStage('asking')
          if (shouldSpeak() && m.text) speak(m.text)
          break
        case 'ask-resolved':
          setAsk(null)
          // 回到询问前的那一步：任务中途若已经拉长成药丸，就继续保持药丸（不缩回球）
          gotoStage(askReturnStage.current === 'taskPill'
            ? 'taskPill'
            : (modeRef.current === 'task' ? 'taskBall' : 'processing'))
          break
        case 'text-chunk':
          if (stageRef.current !== 'result') gotoStage('result')
          responseRef.current += m.delta || ''
          setResponse(responseRef.current)
          setIsStreaming(true)
          break
        case 'text-reset':
          // 模型在调用工具的同一轮输出了文字：撤销已流式内容并回到处理态
          responseRef.current = ''
          setResponse('')
          setIsStreaming(false)
          if (stageRef.current === 'result') {
            gotoStage(modeRef.current === 'task' ? 'taskBall' : 'processing')
          }
          break
        case 'cards':
          setCards((prev) => {
            const next = [...prev]
            for (const c of m.cards || []) {
              if (!next.some((x) => x.id === c.id)) next.push(c)
            }
            return next
          })
          break
        case 'dismiss-dony':
          // 模型调用 exit_dony（用户只要求打开某个程序/网址时收尾）：
          // 收起的是 **Dony 界面**（隐藏覆盖层），不是退出宿主程序 intelligentSTUDIO
          window.electronAPI?.hideOverlay?.()
          break
        case 'done': {
          const text = m.text ?? responseRef.current
          responseRef.current = text
          setResponse(text)
          setIsStreaming(false)
          setRunning(false)
          if (modeRef.current === 'task' && stageRef.current === 'taskPill') {
            // 任务模式：最后一次调用结束 → 先完整缩回球（表示正在生成回答），
            // 等收缩形变落定后再扩大为返回框，文字同时逐行飞入。
            setToolLabel(null)
            gotoStage('taskBall')
            setTimeout(() => {
              if (stageRef.current === 'taskBall') gotoStage('result')
            }, 460)
          } else {
            gotoStage('result')
          }
          if (shouldSpeak() && text) speak(text)
          onSettled()
          break
        }
        case 'error': {
          const text = `抱歉，执行出错：${m.message}`
          responseRef.current = text
          setResponse(text)
          setIsStreaming(false)
          setToolLabel(null)
          gotoStage('result')
          setRunning(false)
          onSettled()
          break
        }
        case 'cancelled':
          setRunning(false)
          onCancel()
          break
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = useCallback((text: string) => {
    responseRef.current = ''
    setResponse('')
    setCards([])
    setMode(null)
    modeRef.current = null
    setToolLabel(null)
    setAsk(null)
    setIsStreaming(false)
    setRunning(true)
    gotoStage('processing')
    // 先拉一次设置：在 Dony 应用里改了朗读开关，下一轮就生效，不必重连
    agentSocket.send({ type: 'get-settings' })
    agentSocket.send({ type: 'user-message', text, voice: isVoice() })
  }, [gotoStage, isVoice])

  const answerAsk = useCallback((id: string, answer: { approved?: boolean; text?: string }) => {
    agentSocket.send({ type: 'ask-response', id, ...answer })
  }, [])

  const cancelAgent = useCallback(() => {
    agentSocket.send({ type: 'cancel' })
  }, [])

  const resetAgent = useCallback(() => {
    responseRef.current = ''
    setResponse('')
    setCards([])
    setMode(null)
    modeRef.current = null
    setToolLabel(null)
    setAsk(null)
    setIsStreaming(false)
    setRunning(false)
    gotoStage('input')
    // 一次唤醒会话（唤醒→退出）结束：让后端清空模型上下文，下次唤醒从零开始
    agentSocket.send({ type: 'reset-context' })
  }, [gotoStage])

  /** 新一轮（follow-up 提交）时回到输入/处理态 */
  const beginTurn = useCallback(() => {
    responseRef.current = ''
    setResponse('')
    setCards([])
    setMode(null)
    modeRef.current = null
    setToolLabel(null)
  }, [])

  return {
    stage, gotoStage, mode, toolLabel, ask, cards, response, isStreaming,
    ttsEnabled, ttsAlways, setTtsEnabled, running, submit, answerAsk, cancelAgent, resetAgent, beginTurn,
  }
}
