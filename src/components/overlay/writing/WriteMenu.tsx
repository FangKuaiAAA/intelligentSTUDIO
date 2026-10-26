import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AcrylicLayer, ACRYLIC_BLUR } from '../AcrylicLayer'
import hexagonUrl from './hexagon.png'
import {
  IconProofread, IconRewrite, IconFriendly, IconFormal, IconConcise,
  IconSummary, IconKeypoints, IconList, IconTable, IconPen,
} from './WritingIcons'
import type { MenuLayout } from './writingGeometry'

/** 菜单宽度：几何计算与动画都以它为准，所以导出成常量 */
export const MENU_WIDTH = 296

const BIG_ACTIONS = [
  { key: 'proofread', label: '校对', icon: <IconProofread size={22} /> },
  { key: 'rewrite', label: '改写', icon: <IconRewrite size={22} /> },
]

/** 语气类 */
const TONE_ACTIONS = [
  { key: 'friendly', label: '友好', icon: <IconFriendly /> },
  { key: 'formal', label: '正式', icon: <IconFormal /> },
  { key: 'concise', label: '简洁', icon: <IconConcise /> },
]

/** 结构类 */
const FORMAT_ACTIONS = [
  { key: 'summary', label: '摘要', icon: <IconSummary /> },
  { key: 'keypoints', label: '要点', icon: <IconKeypoints /> },
  { key: 'list', label: '列表', icon: <IconList /> },
  { key: 'table', label: '表格', icon: <IconTable /> },
]

interface WriteMenuProps {
  layout: MenuLayout
  /** 正在处理中：整卡降不透明度并停止接收点击 */
  busy: boolean
  onAction: (action: string, custom?: string) => void
  /** 输入框需要/不再需要键盘焦点（主进程据此临时恢复可聚焦） */
  onFocusRequest: (focusable: boolean) => void
  onClose: () => void
}

/**
 * 修改选择框。
 *
 * 展开动画只用 **缩放 + 淡入**（transformOrigin 取贴着文字的那一侧）：
 * "放大 + 展开"由 scale 一次完成。之前用 left+width 双动画模拟"生长"，除了
 * 中间态复杂，还有一个实打实的坑 —— width 万一停在 0，菜单就成了看不见的
 * 零宽条，命中矩形也是空的（主进程轮询会误判"指针不在元素上"）。
 * 固定尺寸 + 纯 transform 后，命中矩形从第一帧起就是完整大小。
 *
 * 材质走 Dony 那套亚克力（桌面快照 + 模糊 + 色调 + 噪点 + 极细灰线 + 收拢投影），
 * 通过 <AcrylicLayer/> 复用既有变量，不复制样式、更不动 Dony 的任何文件。
 */
export function WriteMenu({ layout, busy, onAction, onFocusRequest, onClose }: WriteMenuProps) {
  const [custom, setCustom] = useState('')

  // 挂载留痕：用于把"标签点击后菜单到底有没有挂载"钉死在日志里（排查用）
  useEffect(() => {
    window.electronAPI?.logMain?.('[wr] 菜单已挂载')
  }, [])

  const submit = (allowEmpty = false) => {
    if (busy) return
    const text = custom.trim()
    if (!text && !allowEmpty) return
    if (text) setCustom('')
    onAction('custom', text)
  }

  return (
    <motion.div
      className={`wt-menu${busy ? ' is-busy' : ''}`}
      data-wt-hit="1"
      data-dir={layout.dir}
      style={{
        left: layout.x,
        top: layout.y,
        width: MENU_WIDTH,
        // 从贴着文字的那一侧放大出来（尾巴在右，故原点取右中）
        transformOrigin: layout.dir === 'left' ? 'right center' : 'left center',
      }}
      initial={{ opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
      transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
    >
      {/* 尾巴：与卡片同一套材质（同底色/同透明度）与同一道细线，且细线**只画外侧两条边**
          —— 与卡片相接的那侧不画，否则会看到一条把三角形和面板割开的竖线。
          用 SVG 而不是 clip-path 三角形：clip-path 会把描边一起裁掉，做不出"只在外侧有线"，
          也磨不出圆角尖端。整块压在卡片之下，左端那截被卡片盖住。 */}
      {/* 尾巴：材质与卡片**同源** —— 里面也铺一层 AcrylicLayer，所以底色、透明度、
          噪点、边缘质感自动一致（之前是纯色块，必然有色差）。
          形状用 clip-path 裁三角形，细线单独画在未裁剪的一层上，**只画外侧两条边**；
          整体压进卡片 3px，把卡片右缘那道细线盖住 —— 于是轮廓从卡片连到尖端是一条线，
          相接处没有横线。 */}
      <div className="wt-menu-tail" aria-hidden="true">
        {/* ⚠ 必须标 data-acrylic-host：AcrylicLayer 靠宿主的 --dcx/--dcy 让底图
            "在屏幕上保持不动"，宿主不标这两个变量就是 0 —— 贴上来的壁纸会错位，
            看起来就像"三角形没有壁纸模糊"。 */}
        <div className="wt-menu-tail-fill" data-acrylic-host>
          <AcrylicLayer blur={ACRYLIC_BLUR.asking} />
        </div>
        <svg className="wt-menu-tail-line" viewBox="0 0 13 28" preserveAspectRatio="none">
          <path
            d="M0.6 1.4 L11.3 14 L0.6 26.6"
            fill="none"
            stroke="var(--dony-acrylic-edge)"
            strokeWidth="1"
            strokeLinejoin="round"
            /* ⚠ 端点不能圆头：圆头会在三角形内侧（底边两端）各留一个圆点，
               看起来就是"三角形内侧还有细线"。用平头并且两端缩进底边内侧。 */
            strokeLinecap="butt"
          />
        </svg>
      </div>
      <div className="wt-menu-card" data-acrylic-host>
        <AcrylicLayer blur={ACRYLIC_BLUR.asking} />
        <motion.div
          className="wt-menu-inner"
          style={{ width: MENU_WIDTH }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // 内容比盒子晚一点出现：生长过程中被裁掉的内容闪现会显得很脏
          transition={{ duration: 0.18, delay: 0.05, ease: 'easeOut' }}
        >
          <div className="wt-input rb-pill rb-rainbow-on">
            <span className="rb-pill-surface" />
            <span className="wt-input-icon">
              {/* 与标签同一枚图案；它在浅色模式下会被 CSS 反成黑色（标签里那枚始终白色） */}
              <img src={hexagonUrl} alt="" draggable={false} />
            </span>
            <input
              className="wt-input-field"
              // 命中测试据此在"指针压到输入框上"时就提前恢复窗口可聚焦 ——
              // 等 click 之后再恢复会晚一步，表现就是"点了却打不进字"。
              data-wt-focus="1"
              type="text"
              value={custom}
              placeholder="描述修改"
              spellCheck={false}
              // 键盘输入必须让**窗口**先可聚焦：不可聚焦的窗口无法把焦点交给内部的
              // input（连 onFocus 都不会触发）。所以在"按下的那一刻"就要，而不是等
              // focus —— 两条点击路径（真实点击 / 后端派发）都会先走 mousedown。
              onMouseDown={() => window.electronAPI?.setWritingFocus?.(true)}
              onBlur={() => window.electronAPI?.setWritingFocus?.(false)}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit() }
                if (e.key === 'Escape') { e.preventDefault(); onClose() }
              }}
              // ⚠ 这里**不要**在 onBlur 里撤销可聚焦：blur → 窗口设为不可激活 → 又 blur，
              //   会与"恢复可聚焦"来回抖动（用户实测"点进去打不了字"就是它）。
              //   焦点只在选动作 / 提交 / 取消 / 退出这些明确时机交还。
              onFocus={() => onFocusRequest(true)}
            />
          </div>

          <div className="wt-big-row">
            {BIG_ACTIONS.map((a) => (
              <button key={a.key} type="button" className="wt-big" data-wt-hit="1"
                disabled={busy} onClick={() => onAction(a.key)}>
                <span className="wt-big-icon">{a.icon}</span>
                <span className="wt-big-label">{a.label}</span>
              </button>
            ))}
          </div>

          <div className="wt-menu-sep" />
          {TONE_ACTIONS.map((a) => (
            <button key={a.key} type="button" className="wt-item" data-wt-hit="1"
              disabled={busy} onClick={() => onAction(a.key)}>
              <span className="wt-item-icon">{a.icon}</span>
              <span className="wt-item-label">{a.label}</span>
            </button>
          ))}

          <div className="wt-menu-sep" />
          {FORMAT_ACTIONS.map((a) => (
            <button key={a.key} type="button" className="wt-item" data-wt-hit="1"
              disabled={busy} onClick={() => onAction(a.key)}>
              <span className="wt-item-icon">{a.icon}</span>
              <span className="wt-item-label">{a.label}</span>
            </button>
          ))}

          <div className="wt-menu-sep" />
          {/* 创作：不再用菜单里的输入框，而是弹一个独立的"需求输入"气泡 */}
          <button type="button" className="wt-item" data-wt-hit="1"
            disabled={busy} onClick={() => onAction('create')}>
            <span className="wt-item-icon"><IconPen /></span>
            <span className="wt-item-label">创作…</span>
          </button>
        </motion.div>
      </div>
    </motion.div>
  )
}
