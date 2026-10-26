import { useEffect, useState } from 'react'
import { Home } from './pages/Home'
import { Writing } from './pages/Writing'
import { Playground } from './pages/Playground'
import type { StatusMessage } from './components/StatusLine'
import { subscribe } from './bus'
import { getHost, hostLabel as labelOf } from './host'

export type Route = 'home' | 'writing' | 'playground'

const routeFromUrl = (): Route => {
  const mode = new URLSearchParams(window.location.search).get('mode')
  return mode === 'writing' || mode === 'playground' ? mode : 'home'
}

/**
 * 单窗格两级导航。
 *
 * 两个功能区入口用不同的 query（?mode=writing / ?mode=playground）指向同一个
 * TaskpaneId：能在 Office 里直接落到对应功能页；万一某个版本复用窗格时没有重新导航，
 * 也只会停在选择页，多点一次而已 —— 不会出现白屏或错误状态。
 */
export function App() {
  const [route, setRoute] = useState<Route>(routeFromUrl)
  const [status, setStatus] = useState<StatusMessage | null>(null)

  const host = getHost()

  const notify = (text: string, tone: StatusMessage['tone'] = 'info'): void => {
    setStatus({ text, tone, seq: Date.now() })
  }

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === 'notice') {
          notify(event.text, event.tone)
          return
        }
        if (event.kind === 'focus-writing') {
          setRoute('writing')
          return
        }
        if (event.kind === 'reveal-original') {
          setRoute('writing')
        }
      }),
    []
  )

  if (route === 'writing') {
    return (
      <div className="st-shell">
        <Writing
          hostLabel={labelOf(host.host)}
          onBack={() => setRoute('home')}
          notify={notify}
          status={status}
        />
      </div>
    )
  }

  if (route === 'playground') {
    return (
      <div className="st-shell">
        <Playground
          hostLabel={labelOf(host.host)}
          onBack={() => setRoute('home')}
          notify={notify}
          status={status}
        />
      </div>
    )
  }

  return (
    <div className="st-shell">
      <Home hostLabel={labelOf(host.host)} onPick={setRoute} />
    </div>
  )
}
