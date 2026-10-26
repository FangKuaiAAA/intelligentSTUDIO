/**
 * 浮窗冒烟：把 dist 作为解压扩展加载进 Edge/Chrome，打开 popup 页面，
 * 收集控制台错误并截图，确认「加载解压缩的扩展 → 浮窗正常打开」。
 *
 * 用法：node extension/scripts/smoke-popup.mjs [--headful]
 * 产物：extension/.preview/popup.png
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortFree, killTree, launch, openTab, pickPort, sleep, waitForExtension,
} from './lib/browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
const OUT_DIR = resolve(HERE, '..', '.preview')
const headful = process.argv.includes('--headful')

async function main() {
  const port = pickPort()
  await assertPortFree(port)
  const profile = mkdtempSync(join(tmpdir(), 'dony-popup-profile-'))
  const browser = launch({ extDir: DIST, port, windowSize: '400,640', headful, profile })
  const problems = []
  let popup = null
  try {
    const worker = await waitForExtension(port)
    const extensionId = new URL(worker.url).host
    console.log('扩展已加载，ID =', extensionId, `（${worker.type}）`)

    popup = await openTab(port)
    await popup.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/index.html` })
    await sleep(1800)

    const href = await popup.evaluate('location.href')
    console.log('当前地址：', href)
    if (!String(href).startsWith('chrome-extension://')) {
      throw new Error(`浮窗页面没有加载出来：${href}`)
    }

    const probe = JSON.parse(await popup.evaluate(`JSON.stringify({
      entries: document.querySelectorAll('.entry').length,
      title: document.querySelector('.brand-name')?.textContent || '',
      statusText: document.querySelector('.status-text')?.textContent || '',
      statusBarVisible: (() => {
        const el = document.querySelector('.status-bar')
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight + 1
      })(),
      height: document.body.scrollHeight,
    })`))
    console.log('页面探针：', JSON.stringify(probe))

    if (probe.entries !== 3) problems.push(`主面板入口数量应为 3，实际 ${probe.entries}`)
    if (probe.title !== 'Visual intelligence') problems.push(`品牌名不对：${probe.title}`)
    if (!probe.statusBarVisible) problems.push('底栏不在可视区域内')

    // 入口卡悬停不应出现紫色高亮（历史上是 rgba(191, 90, 242, .55) 的描边）
    const entryBox = JSON.parse(await popup.evaluate(`(() => {
      const r = document.querySelector('.entry').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    await popup.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: entryBox.x, y: entryBox.y })
    await sleep(300)
    const hoverBorder = await popup.evaluate(`getComputedStyle(document.querySelector('.entry')).borderTopColor`)
    console.log('入口卡悬停描边：', hoverBorder)
    if (/191,\s*90,\s*242/.test(hoverBorder)) problems.push(`入口卡悬停仍是紫色高亮：${hoverBorder}`)
    await popup.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    if (!/^(已连接|未连接)$/.test(probe.statusText)) {
      problems.push(`底栏文案只能是「已连接」或「未连接」，实际「${probe.statusText}」`)
    }

    // 降级路径：桥接服务不可用时，状态条与整理入口都必须给出可读提示（不允许静默失败）
    const bridgeUp = await fetch('http://127.0.0.1:8768/health')
      .then((r) => r.json()).then((j) => !!j?.ok).catch(() => false)
    if (!bridgeUp) {
      if (probe.statusText !== '未连接') {
        problems.push(`未连接时底栏文案应为「未连接」，实际：${probe.statusText}`)
      }
      await popup.evaluate(`(() => {
        const entry = [...document.querySelectorAll('.entry')].find((e) => e.textContent.includes('整理标签页'))
        entry.click()
        return true
      })()`)
      await sleep(400)
      await popup.evaluate(`document.querySelector('.pill-submit').click()`)
      await sleep(2500)
      const error = await popup.evaluate(`document.querySelector('.error-text')?.textContent.trim() || ''`)
      console.log('离线时的整理提示：', error || '(空)')
      // 只要能让用户看懂"没连上、要去启动桌面端"就算合格，不锁死具体措辞
      if (!/未连接/.test(error) || !/启动|intelligentSTUDIO/.test(error)) {
        problems.push(`离线时整理没有给出可读提示：${error}`)
      }
      await popup.evaluate(`(() => { document.querySelector('.nav-back')?.click(); return true })()`)
      await sleep(400)
    } else {
      console.log('桥接服务在线，跳过离线降级检查')
    }

    mkdirSync(OUT_DIR, { recursive: true })
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT_DIR, 'popup.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('截图已保存：', file)

    // 视觉智能的两个入口
    await popup.evaluate(`(() => {
      const entry = [...document.querySelectorAll('.entry')].find((e) => e.textContent.includes('视觉智能'))
      if (entry) entry.click()
      return true
    })()`)
    await sleep(600)
    const visual = JSON.parse(await popup.evaluate(`JSON.stringify({
      title: document.querySelector('.nav-title')?.textContent || '',
      modes: [...document.querySelectorAll('.entry-title')].map((n) => n.textContent.trim()),
      hints: document.querySelectorAll('.hint').length,
    })`))
    console.log('视觉面板：', JSON.stringify(visual))
    if (visual.title !== '视觉智能') problems.push(`视觉面板标题不对：${visual.title}`)
    if (JSON.stringify(visual.modes) !== JSON.stringify(['框选', '整页'])) {
      problems.push(`视觉面板入口应为 框选/整页，实际 ${JSON.stringify(visual.modes)}`)
    }
    if (visual.hints !== 0) problems.push('面板里仍存在说明性文字（.hint）')
    const visualShot = await popup.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT_DIR, 'popup-visual.png'), Buffer.from(visualShot.data, 'base64'))

    // 整理面板：输入框旁只保留「选项名 + 额外要求」
    await popup.evaluate(`(() => {
      const back = document.querySelector('.nav-back')
      if (back) back.click()
      return true
    })()`)
    await sleep(400)
    await popup.evaluate(`(() => {
      const entry = [...document.querySelectorAll('.entry')].find((e) => e.textContent.includes('整理标签页'))
      if (entry) entry.click()
      return true
    })()`)
    await sleep(600)
    const organize = JSON.parse(await popup.evaluate(`JSON.stringify({
      prefix: document.querySelector('.pill-prefix')?.textContent || '',
      placeholder: document.querySelector('.pill-input')?.getAttribute('placeholder') || '',
      hints: document.querySelectorAll('.hint').length,
    })`))
    console.log('整理面板：', JSON.stringify(organize))
    if (organize.prefix !== '整理标签页') problems.push(`输入框前缀应为「整理标签页」，实际「${organize.prefix}」`)
    if (organize.placeholder !== '额外要求') problems.push(`占位文案应为「额外要求」，实际「${organize.placeholder}」`)
    if (organize.hints !== 0) problems.push('整理面板里仍存在说明性文字（.hint）')
    const organizeShot = await popup.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT_DIR, 'popup-organize.png'), Buffer.from(organizeShot.data, 'base64'))

    // 提示条必须能消失：5 秒自动消失 + 点击立即消失
    // （回归点：浮窗每 4 秒刷新一次状态，effect 依赖若用整个 bridge 对象，
    //   计时器会被反复重置，提示条就永远留着）
    await popup.evaluate(`(() => {
      const toggle = document.querySelectorAll('.topbar-actions .icon-button')[0]
      if (toggle) toggle.click()
      return true
    })()`)
    await sleep(500)
    const reconnect = await popup.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.action-pill')].find((b) => b.textContent.includes('重新连接'))
      if (!btn) return 'no-button'
      btn.click()
      return btn.textContent.trim()
    })()`)
    console.log('点击按钮：', reconnect)
    await sleep(400)
    let probe1 = JSON.parse(await popup.evaluate(
      `JSON.stringify({ notice: document.querySelector('.notice')?.textContent?.trim() || '' })`,
    ))
    console.log('提示条：', JSON.stringify(probe1))
    if (!probe1.notice) problems.push('点击后没有出现提示条')
    await sleep(7000)
    probe1 = JSON.parse(await popup.evaluate(
      `JSON.stringify({ notice: document.querySelector('.notice')?.textContent?.trim() || '' })`,
    ))
    if (probe1.notice) problems.push(`提示条没有在 5 秒后消失：${probe1.notice}`)

    // 点击提示条本身也要能立刻收起
    await popup.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.action-pill')].find((b) => b.textContent.includes('重新连接'))
      if (btn) btn.click()
      return true
    })()`)
    await sleep(500)
    await popup.evaluate(`(() => { document.querySelector('.notice')?.click(); return true })()`)
    await sleep(500)
    const probe2 = JSON.parse(await popup.evaluate(
      `JSON.stringify({ notice: document.querySelector('.notice')?.textContent?.trim() || '' })`,
    ))
    if (probe2.notice) problems.push(`点击提示条后没有立即收起：${probe2.notice}`)
    else console.log('提示条：点击即收起 ✓')

    for (const e of popup.errors) problems.push(e)
  } finally {
    killTree(browser.pid)
    popup?.close()
  }

  if (problems.length) {
    console.error('发现以下问题：')
    for (const p of problems) console.error(' -', p)
    process.exitCode = 1
  } else {
    console.log('浮窗冒烟通过')
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message)
  process.exitCode = 1
})
