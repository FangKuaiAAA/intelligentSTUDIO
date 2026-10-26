import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { health } from '../api/client'
import { IdentityBar } from '../components/IdentityBar'

interface HomeProps {
  hostLabel: string
  onPick: (mode: 'writing' | 'playground') => void
}

type Conn = 'checking' | 'ok' | 'down'

const ENTRIES = [
  {
    mode: 'writing' as const,
    name: '书写辅助',
    desc: '改写选中的文字',
    icon: './icons/80/writing.png',
  },
  {
    mode: 'playground' as const,
    name: '图乐园',
    desc: '生成图片并插入文档',
    icon: './icons/80/playground.png',
  },
]

/** 选择页：两个入口 + 本地服务连接状态 */
export function Home({ hostLabel, onPick }: HomeProps) {
  const [conn, setConn] = useState<Conn>('checking')

  const probe = (): void => {
    setConn('checking')
    health()
      .then((r) => setConn(r.ok ? 'ok' : 'down'))
      .catch((e) => {
        console.error('[studio] 健康检查失败', e)
        setConn('down')
      })
  }

  useEffect(probe, [])

  return (
    <>
      <IdentityBar
        title="intelligentSTUDIO"
        hostLabel={hostLabel}
        leading={<img src="./icons/80/studio.png" width={18} height={18} alt="" style={{ marginLeft: 2 }} />}
      />

      <div className="st-body">
        <div className="st-stack">
          {ENTRIES.map((entry, index) => (
            <motion.button
              key={entry.mode}
              type="button"
              className="st-entry"
              onClick={() => onPick(entry.mode)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: index * 0.05, ease: [0.23, 1, 0.32, 1] }}
            >
              <span className="st-entry-icon">
                <img src={entry.icon} alt="" />
              </span>
              <span className="st-entry-text">
                <span className="st-entry-name">{entry.name}</span>
                <span className="st-entry-desc">{entry.desc}</span>
              </span>
            </motion.button>
          ))}
        </div>

        <div className="st-status" style={{ marginTop: 2 }}>
          <span className="st-dot" data-tone={conn === 'ok' ? 'success' : conn === 'down' ? 'error' : ''} />
          <span>
            {conn === 'checking' && '连接中'}
            {conn === 'ok' && '已连接'}
            {conn === 'down' && '未连接'}
          </span>
          <span style={{ flex: 1 }} />
          {conn === 'down' && (
            <button type="button" className="st-btn st-btn--ghost" onClick={probe}>
              重试
            </button>
          )}
        </div>

        <div style={{ flex: 1 }} />
      </div>
    </>
  )
}
