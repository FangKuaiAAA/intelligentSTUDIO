/**
 * 收藏项删除能力冒烟：两段验证。
 *
 *  A. 契约层（确定性，不经过模型）：POST /bookmarks/delete 的 dry_run 预演、按网址删除、
 *     匹配不到时的提示，以及删除后收藏夹的真实变化。
 *  B. 模型层（端到端）：在浮窗里用自然语言要求删除指定收藏项，Dony Agent 调用
 *     edge_browser(delete_bookmarks) → 弹出「允许 / 不允许」 → 允许后真正删除。
 *
 * 前置：本机可访问模型 API（会真实产生模型调用）。
 * 用法：node extension/scripts/smoke-delete.mjs [--headful]
 * 产物：extension/.preview/delete.png
 *
 * 脚本自起一套独立的桥接 + Agent 服务并把测试扩展指向它，不打扰正在运行的应用。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortFree, killTree, launch, openTab, pickPort, pointExtensionAt, sleep,
  startPrivateServices, stopServices, waitForExtension,
} from './lib/browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
const OUT_DIR = resolve(HERE, '..', '.preview')
const headful = process.argv.includes('--headful')

const SEED_ITEMS = [
  ['站点 A 首页', 'https://a.example.com/'],
  ['站点 A 文档', 'https://a.example.com/docs'],
  ['站点 B 博客', 'https://b.example.com/post'],
  ['站点 C 关于', 'https://c.example.com/about'],
]

/** 清空测试根目录后写入固定书签，返回写入后的根目录快照 */
const seedScript = (items) => `(async () => {
  const tree = await chrome.bookmarks.getTree()
  const root = tree[0].children[0]
  for (const node of root.children) {
    try { await chrome.bookmarks.remove(node.id) } catch { await chrome.bookmarks.removeTree(node.id) }
  }
  for (const [title, url] of ${JSON.stringify(items)}) {
    await chrome.bookmarks.create({ parentId: root.id, title, url })
  }
  const fresh = await chrome.bookmarks.getTree()
  const nodes = fresh[0].children[0].children.filter((n) => n.url)
  return JSON.stringify(nodes.map((n) => ({ id: n.id, title: n.title, url: n.url })))
})()`

async function main() {
  if (!existsSync(join(DIST, 'background.js'))) throw new Error('缺少 dist，请先 npm run build')
  const services = await startPrivateServices({ logFile: join(tmpdir(), 'dony-smoke-services.log') })
  const post = async (path, body) => {
    const resp = await fetch(`${services.bridgeBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return (await resp.text()).trim()
  }

  const port = pickPort(9800, 300)
  await assertPortFree(port)
  const profile = mkdtempSync(join(tmpdir(), 'dony-delete-profile-'))
  const browser = launch({ extDir: DIST, port, windowSize: '420,660', headful, profile })

  const problems = []
  let popup = null
  try {
    const worker = await waitForExtension(port)
    const extensionId = new URL(worker.url).host
    popup = await openTab(port)
    await popup.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/index.html` })
    await sleep(1200)
    console.log('切换桥接地址：', await pointExtensionAt(popup, services.bridgeBase))

    let handshaked = false
    for (let i = 0; i < 40 && !handshaked; i += 1) {
      const h = await fetch(`${services.bridgeBase}/health`).then((r) => r.json())
      handshaked = !!h.extension_connected
      if (!handshaked) await sleep(300)
    }
    console.log('扩展已与桥接服务握手：', handshaked)
    if (!handshaked) throw new Error('扩展没有连上桥接服务')

    // ---------------- A. 契约层 ----------------
    let nodes = JSON.parse(await popup.evaluate(seedScript(SEED_ITEMS)))
    await sleep(600)
    console.log('播种完成：', nodes.map((n) => n.title).join('、'))

    const preview = await post('/bookmarks/delete', { ids: [nodes[2].id], dry_run: true })
    console.log('预演结果：', preview)
    if (!preview.startsWith('删除预演：')) problems.push(`预演返回格式不对：${preview}`)
    if (!preview.includes('站点 B 博客')) problems.push('预演没有列出将被删除的条目')

    const countScript = '(async () => { const t = await chrome.bookmarks.getTree(); return String(t[0].children[0].children.filter((n) => n.url).length) })()'
    let after = Number(await popup.evaluate(countScript))
    console.log('预演后剩余条目：', after)
    if (after !== SEED_ITEMS.length) problems.push(`预演不应改动收藏夹（应有 ${SEED_ITEMS.length} 条，实际 ${after} 条）`)

    const byUrl = await post('/bookmarks/delete', { urls: ['https://b.example.com/post'] })
    console.log('按网址删除：', byUrl)
    if (!byUrl.startsWith('删除完成：')) problems.push(`按网址删除未成功：${byUrl}`)
    after = Number(await popup.evaluate(countScript))
    if (after !== SEED_ITEMS.length - 1) problems.push(`按网址删除后条目数不对：${after}`)

    const missing = await post('/bookmarks/delete', { titles: ['这个标题不存在'] })
    console.log('匹配不到时：', missing)
    if (!missing.includes('没有匹配到')) problems.push(`匹配不到时没有给出提示：${missing}`)

    nodes = JSON.parse(await popup.evaluate(seedScript(SEED_ITEMS)))
    await sleep(600)

    // ---------------- B. 模型层 ----------------
    await popup.evaluate(`(() => {
      const entry = [...document.querySelectorAll('.entry')].find((e) => e.textContent.includes('整理收藏夹'))
      entry.click()
      return true
    })()`)
    await sleep(500)
    await popup.evaluate(`(() => {
      const input = document.querySelector('.pill-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '删除所有 a.example.com 的收藏项（站点 A 首页与站点 A 文档），站点 B、站点 C 的保留')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.pill-submit').click()
      return true
    })()`)

    let state = null
    let confirmSeen = false
    for (let i = 0; i < 180; i += 1) {
      await sleep(1000)
      state = JSON.parse(await popup.evaluate(`JSON.stringify({
        timeline: [...document.querySelectorAll('.timeline-row')].map((n) => n.textContent.trim()),
        answer: document.querySelector('.answer-text')?.textContent.trim() || '',
        error: document.querySelector('.error-text')?.textContent.trim() || '',
        asking: !!document.querySelector('.ask-box'),
        askText: document.querySelector('.ask-box .ask-text')?.textContent.trim() || '',
        allow: !!document.querySelector('.ask-box .action-pill:not(.plain)'),
      })`))
      if (state.asking && state.allow) {
        confirmSeen = true
        console.log('确认弹窗：', state.askText.replace(/\s+/g, ' ').slice(0, 140))
        await popup.evaluate(`(() => {
          const btn = document.querySelector('.ask-box .action-pill:not(.plain)')
          if (btn) btn.click()
          return true
        })()`)
        await sleep(800)
        continue
      }
      if (state.asking) {
        problems.push('模型发起了追问，而不是删除确认')
        break
      }
      if (state.error || state.answer) break
    }
    console.log('阶段行：', state?.timeline?.join(' / ') || '(空)')
    console.log('回答：', (state?.answer || '(空)').slice(0, 220))

    const left = JSON.parse(await popup.evaluate(
      '(async () => { const t = await chrome.bookmarks.getTree(); return JSON.stringify(t[0].children[0].children.filter((n) => n.url).map((n) => n.url)) })()',
    ))
    console.log('删除后剩余网址：', JSON.stringify(left))

    mkdirSync(OUT_DIR, { recursive: true })
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT_DIR, 'delete.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('截图：', file)

    if (!confirmSeen) problems.push('模型没有发起删除确认（或未调用 delete_bookmarks）')
    if (left.some((u) => u.includes('a.example.com'))) problems.push(`a.example.com 的收藏项没有被删除：${left}`)
    if (!left.includes('https://b.example.com/post')) problems.push('站点 B 的书签被误删')
    if (!left.includes('https://c.example.com/about')) problems.push('站点 C 的书签被误删')
    if (state?.error) problems.push(`浮窗报错：${state.error}`)
    for (const e of popup.errors) problems.push(e)
  } finally {
    killTree(browser.pid)
    stopServices(services)
    popup?.close()
  }

  if (problems.length) {
    console.error('发现以下问题：')
    for (const p of problems) console.error(' -', p)
    process.exitCode = 1
  } else {
    console.log('收藏项删除冒烟通过')
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message)
  process.exitCode = 1
})
