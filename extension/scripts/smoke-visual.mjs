/**
 * 页面内视觉智能端到端冒烟：真实加载扩展 → 注入覆盖层 → 拖拽框选 →
 * 点击选项 → 经桥接服务问模型 → 检查回答框与提取结果。
 *
 * 前置：本机可访问模型 API（会真实产生一次模型调用）。
 * 用法：node extension/scripts/smoke-visual.mjs [--headful]
 * 产物：extension/.preview/visual-select.png、visual-answer.png
 *
 * 两点说明：
 *  · 脚本会起一套**独立**的桥接/Agent 服务，并把测试扩展指向它 —— 不打扰正在运行的
 *    intelligentSTUDIO（桥接服务同一时刻只接受一个浏览器实例）；
 *  · 测试副本把 <all_urls> 加入 host_permissions，只为在测试页获得注入与截图权限
 *    （activeTab 需要真实点击工具栏图标才会授予，captureVisibleTab 也不接受站点级 host 权限）。
 *    产品自身的 dist 不被改动。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortFree, killTree, launch, openTab, pickPort, pointExtensionAt, sleep,
  startPrivateServices, startStaticServer, stopServices, waitForExtension,
} from './lib/browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
const OUT_DIR = resolve(HERE, '..', '.preview')
const PAGE_PORT = 8799
const headful = process.argv.includes('--headful')

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>视觉智能测试页</title>
<style>
 body{margin:0;padding:48px 64px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f7f7fa;color:#1b1b1d}
 h1{font-size:30px;margin:0 0 14px}
 p{font-size:16px;line-height:1.9;max-width:640px}
 .card{margin-top:28px;padding:22px 26px;border-radius:20px;background:linear-gradient(135deg,#0a84ff,#bf5af2);color:#fff;max-width:520px;box-shadow:0 16px 40px rgba(10,132,255,.25)}
 .card h2{margin:0 0 8px;font-size:20px}
 code{background:#eceff5;border-radius:6px;padding:2px 6px;font-size:14px}
</style></head>
<body>
 <h1>intelligentSTUDIO 视觉智能测试页</h1>
 <p>这一段文字用来验证“提取文字”能力：季度目标是把端到端延迟压到 400 毫秒以内，
 同时保持界面的流畅与克制。</p>
 <div class="card"><h2>彩虹光边</h2><p style="font-size:14px;margin:0">这一段位于彩色卡片中，用于验证模型能否区分前景文字与背景渐变。</p></div>
 <p style="margin-top:26px">命令行示例：<code>npm run build:ext</code></p>
</body></html>`

/** 测试副本：附加 <all_urls> 以便脚本获得注入/截图权限 */
function prepareExtension() {
  const target = join(mkdtempSync(join(tmpdir(), 'dony-ext-visual-')), 'ext')
  cpSync(DIST, target, { recursive: true })
  const manifestPath = join(target, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.host_permissions = [...manifest.host_permissions, '<all_urls>']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return target
}

async function drag(cdp, from, to) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  })
  for (let i = 1; i <= 8; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / 8,
      y: from.y + ((to.y - from.y) * i) / 8,
      button: 'left',
      buttons: 1,
    })
    await sleep(30)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  })
}

async function main() {
  if (!existsSync(join(DIST, 'content.js'))) throw new Error('缺少 dist/content.js，请先 npm run build')
  const services = await startPrivateServices({ logFile: join(tmpdir(), 'dony-smoke-services.log') })
  const port = pickPort()
  await assertPortFree(port)
  const extDir = prepareExtension()
  const server = await startStaticServer(TEST_PAGE, PAGE_PORT)
  const profile = mkdtempSync(join(tmpdir(), 'dony-visual-profile-'))
  const browser = launch({ extDir, port, windowSize: '1280,860', headful, profile })

  const problems = []
  let page = null
  let popup = null
  try {
    const worker = await waitForExtension(port)
    const extensionId = new URL(worker.url).host
    console.log('扩展已加载，ID =', extensionId)

    page = await openTab(port)
    await page.send('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/` })
    await sleep(900)
    console.log('测试页标题：', await page.evaluate('document.title'))

    // 把测试扩展指向独立桥接服务（默认 8768 上通常跑着用户的实例）
    popup = await openTab(port)
    await popup.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/index.html` })
    await sleep(1200)
    console.log('切换桥接地址：', await pointExtensionAt(popup, services.bridgeBase))
    await sleep(1500)

    // 从扩展页注入内容脚本（等价于浮窗点「视觉智能」）
    const injected = await popup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${PAGE_PORT}/*' })
      if (!tabs.length) return '找不到测试页'
      await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] })
      // 与产品路径一致：注入后立刻下发模式（内容脚本以这条消息决定挂框选还是整页）
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'visual/start', mode: 'box' })
      return 'ok'
    })()`)
    console.log('注入结果：', injected)
    if (injected !== 'ok') throw new Error(`内容脚本注入失败：${injected}`)
    await sleep(600)

    const mounted = await page.evaluate(
      `String(!!document.getElementById('intelligentstudio-visual-host')?.shadowRoot)`,
    )
    console.log('覆盖层已挂载：', mounted)
    if (mounted !== 'true') throw new Error('覆盖层没有挂载（Shadow DOM 不存在）')

    // 先把测试页切到前台：后台标签页的 rAF 会被节流，飞入动画会停在半透明状态，
    // 截图与真实观感都不对（同时也更接近用户实际"看着页面框选"的场景）
    await page.send('Page.bringToFront')
    await sleep(400)

    await drag(page, { x: 150, y: 170 }, { x: 720, y: 430 })
    await sleep(900)
    const selection = JSON.parse(await page.evaluate(`(() => {
      const root = document.getElementById('intelligentstudio-visual-host').shadowRoot
      const pills = [...root.querySelectorAll('.visual-option-pill')]
      const dim = root.querySelector('.visual-dim-layer')
      const hit = document.elementFromPoint(150, 170)
      return JSON.stringify({
        pills: pills.length,
        labels: pills.map((p) => p.textContent.trim()),
        stage: !!root.querySelector('.visual-confirm-stage'),
        cutout: !!root.querySelector('.visual-cutout'),
        dim: dim ? dim.className : '(无)',
        overlay: root.querySelector('.visual-overlay') ? '有' : '(无)',
        hitTag: hit ? hit.tagName : '(空)',
        hitId: hit ? hit.id : '',
        // 确认前的输入框图标：纯黑线描 + 彩虹光晕（描边取自渐变，不是单色）
        iconStroke: (() => {
          const ink = root.querySelector('.visual-input-icon .visual-icon-ink')
          return ink ? getComputedStyle(ink).stroke : ''
        })(),
        iconFilter: (() => {
          const glow = root.querySelector('.visual-input-icon .visual-icon-glow')
          return glow ? getComputedStyle(glow).filter : ''
        })(),
        iconGlowPaint: (() => {
          const glow = root.querySelector('.visual-input-icon .visual-icon-glow')
          return glow ? String(getComputedStyle(glow).stroke) : ''
        })(),
      })
    })()`))
    console.log('框选后状态：', JSON.stringify(selection))
    if (selection.iconStroke !== 'rgb(0, 0, 0)') {
      problems.push(`输入框图标应为纯黑线描，实际 stroke=${selection.iconStroke}`)
    }
    if (!String(selection.iconFilter).includes('blur')) {
      problems.push(`输入框图标应有模糊的彩虹光晕，实际 filter=${selection.iconFilter}`)
    }
    if (!String(selection.iconGlowPaint).includes('url(')) {
      problems.push(`图标光晕应取自彩虹渐变（而非单色），实际 stroke=${selection.iconGlowPaint}`)
    }
    if (selection.pills < 5) {
      const html = await page.evaluate(
        `String(document.getElementById('intelligentstudio-visual-host')?.shadowRoot?.innerHTML?.length || 0)`,
      )
      throw new Error(`选项胶囊没有出现（shadow 内 HTML 长度 ${html}；页面错误：${page.errors.join(' | ') || '无'}）`)
    }
    // 选项胶囊是弹性飞入的：等它们落定再截图，否则预览图会拍到半透明的飞行中状态
    await sleep(600)
    const selectShot = await page.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'visual-select.png'), Buffer.from(selectShot.data, 'base64'))

    // 点「提取文字」，走桥接服务问模型
    // ⚠ 先让测试页成为活动标签页：captureVisibleTab 只认「窗口中的活动标签页」，
    //   测试里浮窗以标签页形式打开，不切回去就会截到浮窗自己。
    await page.send('Page.bringToFront')
    await sleep(400)
    const clicked = await page.evaluate(`(() => {
      const root = document.getElementById('intelligentstudio-visual-host').shadowRoot
      const pill = root.querySelectorAll('.visual-option-pill')[2]
      if (!pill) return 'no-pill'
      pill.click()
      return pill.textContent.trim()
    })()`)
    console.log('已点击选项：', clicked)

    // 彩虹淡出：确认后由可见渐隐到 0（约 0.5s），且只影响彩虹
    const readRainbow = () => page.evaluate(`(() => {
      const root = document.getElementById('intelligentstudio-visual-host')?.shadowRoot
      const pill = root?.querySelector('.visual-request-pill')
      if (!pill) return null
      return Number(getComputedStyle(pill, '::before').opacity)
    })()`)
    let rainbowPeak = 0
    let rainbowFinal = null
    let visibleTicks = 0
    for (let i = 0; i < 30; i += 1) {
      const value = await readRainbow()
      if (value !== null) {
        rainbowPeak = Math.max(rainbowPeak, value)
        rainbowFinal = value
        if (value > 0.05) visibleTicks += 1
        if (value <= 0.02) break
      }
      await sleep(100)
    }
    console.log(`彩虹不透明度：峰值 ${rainbowPeak.toFixed(2)}，最终 ${rainbowFinal}，可见采样 ${visibleTicks} 次（每次约 100ms）`)
    if (rainbowPeak < 0.15) problems.push('确认后彩虹没有先可见再淡出（可能被直接移除）')
    if (visibleTicks < 2) problems.push(`彩虹淡出过快，不是约 0.5s 的渐隐（可见采样 ${visibleTicks} 次）`)
    if (!(rainbowFinal !== null && rainbowFinal <= 0.05)) {
      problems.push(`彩虹没有在确认后淡到不可见：${rainbowFinal}`)
    }

    let answer = null
    for (let i = 0; i < 90; i += 1) {
      await sleep(1000)
      answer = JSON.parse(await page.evaluate(`(() => {
        const root = document.getElementById('intelligentstudio-visual-host').shadowRoot
        const box = root.querySelector('.visual-answer-box')
        const texts = [...root.querySelectorAll('.visual-answer-text')].map((n) => n.textContent.trim())
        return JSON.stringify({
          box: !!box,
          texts,
          boxText: (box?.textContent || '').trim(),
          cards: root.querySelectorAll('.visual-card').length,
        })
      })()`))
      // 「正在分析...」是加载占位，等到有正文或卡片才算回答完成
      if (answer.boxText && !answer.boxText.includes('正在分析') && (answer.texts.length || answer.cards)) break
    }
    console.log('回答框：', answer.box, '｜文字：', (answer.boxText || '(空)').slice(0, 180))
    // 回答是一行行飞入的：轮询刚命中时首行可能还在 opacity 0，截图前等一下再拍
    await sleep(700)
    const answerShot = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT_DIR, 'visual-answer.png'), Buffer.from(answerShot.data, 'base64'))

    // 黑框与彩虹输入框的相对关系：左边缘对齐、右边缘多出 64px（输入框宽的 1/5）、上边缘齐平，
    // 且黑框在输入框之下；框体比例 高:宽 = √2:1；确认后输入框不透明度 93%
    const geom = JSON.parse(await page.evaluate(`(() => {
      const root = document.getElementById('intelligentstudio-visual-host').shadowRoot
      const pill = root.querySelector('.visual-request-pill')
      const box = root.querySelector('.visual-answer-box')
      if (!pill || !box) return JSON.stringify({ ok: false })
      const p = pill.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const hit = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)
      return JSON.stringify({
        ok: true,
        left: Math.round(b.left - p.left),
        right: Math.round(b.right - p.right),
        top: Math.round(b.top - p.top),
        boxW: Math.round(b.width),
        boxH: Math.round(b.height),
        ratio: Number((b.width / b.height).toFixed(3)),
        surface: getComputedStyle(pill.querySelector('.visual-request-pill-surface')).backgroundColor,
        iconStroke: getComputedStyle(pill.querySelector('.visual-request-pill-icon .visual-icon-ink')).stroke,
        iconFilter: getComputedStyle(pill.querySelector('.visual-request-pill-icon .visual-icon-glow')).filter,
        iconGlowPaint: String(getComputedStyle(pill.querySelector('.visual-request-pill-icon .visual-icon-glow')).stroke),
        iconGlowFar: getComputedStyle(pill.querySelector('.visual-request-pill-icon .visual-icon-glow-far')).filter,
        iconSize: Math.round(pill.querySelector('.visual-request-pill-icon').getBoundingClientRect().width),
        boxInside: b.left <= p.left + 1 && b.top <= p.top + 1 && b.right >= p.right - 1,
        hitInBox: !!hit && box.contains(hit),
        zBox: getComputedStyle(box).zIndex,
        zSlot: getComputedStyle(pill.parentElement).zIndex,
      })
    })()`))
    console.log('黑框与输入框：', JSON.stringify(geom))
    if (!geom.ok) problems.push('量不到黑框或输入框')
    else {
      if (geom.left !== 0) problems.push(`黑框左边缘应与输入框对齐，实际偏移 ${geom.left}px`)
      // 右侧加长量 = 输入框总长度的 1/5 = 64px
      if (geom.right !== 64) problems.push(`黑框右边缘应比输入框多出 64px（输入框宽 320 的 1/5），实际 ${geom.right}px`)
      if (geom.top !== 0) problems.push(`黑框上边缘应与输入框齐平，实际偏移 ${geom.top}px`)
      if (!geom.boxInside) problems.push('黑框没有包住输入框')
      if (geom.hitInBox) problems.push('输入框中心命中的是黑框 —— 说明黑框盖在了输入框之上')
      if (!(Number(geom.zBox) < Number(geom.zSlot))) {
        problems.push(`层叠不对：黑框 z-index=${geom.zBox}，输入框槽 z-index=${geom.zSlot}`)
      }
      // 初始框体比例：上下端（高）: 侧边（宽）= √2 : 1
      if (Math.abs(geom.ratio - 1 / Math.SQRT2) > 0.02) {
        problems.push(`黑框初始比例应为 1:√2（宽 ${geom.boxW} / 高 ${geom.boxH} = ${geom.ratio}）`)
      }
      // 确认后输入框加深到 93%（与彩虹淡出同一段时间）
      if (geom.surface !== 'rgba(255, 255, 255, 0.93)') {
        problems.push(`确认后输入框不透明度应为 93%，实际 ${geom.surface}`)
      }
      // 确认后的输入框图标同样是纯黑线描 + 彩虹渐变光晕
      if (geom.iconStroke !== 'rgb(0, 0, 0)') {
        problems.push(`确认后输入框图标应为纯黑线描，实际 stroke=${geom.iconStroke}`)
      }
      if (!String(geom.iconFilter).includes('blur')) {
        problems.push(`确认后输入框图标应有模糊的彩虹光晕，实际 filter=${geom.iconFilter}`)
      }
      if (!String(geom.iconGlowPaint).includes('url(')) {
        problems.push(`确认后图标光晕应取自彩虹渐变（而非单色），实际 stroke=${geom.iconGlowPaint}`)
      }
      if (geom.iconSize !== 18) problems.push(`图标尺寸应为 18px，实际 ${geom.iconSize}px`)
      // 光晕向外延伸：远层模糊半径必须明显大于近层（4px）
      if (!String(geom.iconGlowFar).includes('blur(10px)')) {
        problems.push(`图标光晕应有向外扩散的远层，实际 filter=${geom.iconGlowFar}`)
      }
    }

    // 放大拍一张图标：便于核对光晕是彩虹（红/橙/黄/蓝/紫）而不是单色
    const iconBox = JSON.parse(await page.evaluate(`(() => {
      const root = document.getElementById('intelligentstudio-visual-host').shadowRoot
      const r = root.querySelector('.visual-request-pill-icon').getBoundingClientRect()
      return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height })
    })()`))
    const pad = 12
    const iconShot = await page.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: iconBox.x - pad, y: iconBox.y - pad, width: iconBox.width + pad * 2, height: iconBox.height + pad * 2, scale: 6 },
    })
    writeFileSync(join(OUT_DIR, 'visual-icon.png'), Buffer.from(iconShot.data, 'base64'))
    console.log('图标放大图：', join(OUT_DIR, 'visual-icon.png'))

    if (!answer.box) problems.push('回答框没有出现（模型链路可能未打通）')
    if (!answer.boxText) problems.push('回答内容为空（模型未返回内容）')
    // 截图链路正确性：提取到的文字必须来自测试页，而不是别的标签页
    const keywords = ['端到端延迟', '彩虹光边', '彩色卡片', 'build:ext', 'intelligentSTUDIO']
    if (answer.boxText && !keywords.some((k) => answer.boxText.includes(k))) {
      problems.push(`提取结果与测试页不符，可能是截到了别的标签页：${answer.boxText.slice(0, 100)}`)
    }
    for (const e of [...page.errors, ...popup.errors]) problems.push(e)
  } finally {
    killTree(browser.pid)
    stopServices(services)
    server.close()
    page?.close()
    popup?.close()
  }

  if (problems.length) {
    console.error('发现以下问题：')
    for (const p of problems) console.error(' -', p)
    process.exitCode = 1
  } else {
    console.log('视觉智能冒烟通过')
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message)
  process.exitCode = 1
})
