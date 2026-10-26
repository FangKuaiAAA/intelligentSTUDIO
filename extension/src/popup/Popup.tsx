import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { BridgeKind } from '../bridge/protocol'
import { Icon } from './components/Icon'
import { StatusBar } from './components/StatusBar'
import { HomePanel } from './panels/HomePanel'
import { OrganizePanel } from './panels/OrganizePanel'
import { StatusPanel } from './panels/StatusPanel'
import { VisualPanel } from './panels/VisualPanel'
import { useBridge } from './useBridge'

type View =
  | { name: 'home' }
  | { name: 'visual' }
  | { name: 'organize'; target: BridgeKind }
  | { name: 'status' }

export function Popup() {
  const bridge = useBridge()
  const [view, setView] = useState<View>({ name: 'home' })
  const [visualPending, setVisualPending] = useState(false)
  const { notice, status, organize, dismissNotice, refreshStatus } = bridge

  // ⚠ 依赖必须是**稳定引用**的回调，不能是整个 bridge 对象：
  //   useBridge 每次渲染都返回新对象，用它做依赖会让这两个 effect 每渲染一次就重建 ——
  //   提示条于是被反复重置计时器，永远等不到自动消失（浮窗每 4 秒刷新状态，必然触发）。
  useEffect(() => {
    const timer = setInterval(refreshStatus, 4000)
    return () => clearInterval(timer)
  }, [refreshStatus])

  // 提示条 5 秒后自动消失（错误提示保留更久一点，便于阅读）
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissNotice, notice.tone === 'error' ? 8000 : 5000)
    return () => clearTimeout(timer)
  }, [notice, dismissNotice])

  // 视觉智能已启动 → 关闭浮窗，把视线让给页面里的覆盖层
  useEffect(() => {
    if (!visualPending || !notice) return
    if (notice.tone === 'error') {
      setVisualPending(false)
      return
    }
    if (/视觉智能/.test(notice.text)) {
      setVisualPending(false)
      window.close()
    }
  }, [visualPending, notice])

  const startVisual = (mode: 'box' | 'page') => {
    setVisualPending(true)
    bridge.startVisual(mode)
  }

  const body = useMemo(() => {
    if (view.name === 'visual') {
      return (
        <VisualPanel
          key="visual"
          onBack={() => setView({ name: 'home' })}
          onStart={startVisual}
        />
      )
    }
    if (view.name === 'organize') {
      return (
        <OrganizePanel
          key={`organize-${view.target}`}
          target={view.target}
          state={organize}
          onBack={() => {
            bridge.resetOrganize()
            setView({ name: 'home' })
          }}
          onStart={(requirement) => bridge.startOrganize(view.target, requirement)}
          onAnswer={(id, answer) => bridge.answerAsk(id, answer)}
          onCancel={() => bridge.cancelOrganize()}
        />
      )
    }
    if (view.name === 'status') {
      return (
        <StatusPanel
          key="status"
          status={status}
          logs={bridge.logs}
          onRefresh={() => bridge.refreshStatus()}
          onReconnect={() => bridge.reconnect()}
        />
      )
    }
    return (
      <HomePanel
        key="home"
        onVisual={() => setView({ name: 'visual' })}
        onOrganize={(target) => {
          bridge.resetOrganize()
          setView({ name: 'organize', target })
        }}
      />
    )
  }, [view, organize, status, bridge])

  return (
    <div className="shell">
      <header className="shell-topbar">
        {/* 品牌标直接用扩展图标（Logo 文件夹的「视觉智能.ico」转出的 PNG），保证与 Edge 工具栏一致 */}
        <span className="brand-mark">
          <img src="../icons/icon128.png" alt="" width={30} height={30} draggable={false} />
        </span>
        <span className="brand-text">
          <span className="brand-name">Visual intelligence</span>
        </span>
        <span className="topbar-actions">
          <button
            type="button"
            className="icon-button"
            title="状态"
            onClick={() => setView(view.name === 'status' ? { name: 'home' } : { name: 'status' })}
          >
            <Icon name={view.name === 'status' ? 'back' : 'info'} size={15} />
          </button>
          <button type="button" className="icon-button" title="关闭" onClick={() => window.close()}>
            <Icon name="close" size={15} />
          </button>
        </span>
      </header>

      <div className="shell-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${view.name}-${view.name === 'organize' ? view.target : ''}`}
            className="view-enter"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
          >
            <AnimatePresence initial={false}>
              {notice ? (
                <motion.div
                  key={notice.text}
                  className={`notice ${notice.tone === 'error' ? 'error-text' : 'answer-text'}`}
                  style={{ marginTop: 0, marginBottom: 12 }}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
                  onClick={dismissNotice}
                  title="关闭提示"
                >
                  {notice.text}
                </motion.div>
              ) : null}
            </AnimatePresence>
            {body}
          </motion.div>
        </AnimatePresence>
      </div>

      <StatusBar
        status={status}
        onRefresh={() => bridge.refreshStatus()}
        onOpenStatus={() => setView({ name: 'status' })}
      />
    </div>
  )
}
