/**
 * 整理链路端到端冒烟：浮窗「整理标签页 / 整理收藏夹」→ 桥接服务 →
 * Dony Agent → edge_browser 工具读快照 / 下发扩展执行 → 结果回流到浮窗。
 *
 * 前置：本机可访问模型 API（会真实产生模型调用）。
 * 用法：node extension/scripts/smoke-organize.mjs [--headful]
 * 产物：extension/.preview/organize.png
 *
 * 脚本自起一套独立的桥接 + Agent 服务并把测试扩展指向它，因此不会打扰正在运行的
 * intelligentSTUDIO，也不会和真实浏览器争抢桥接服务的唯一接入位。
 *
 * 断言：故意制造重复标签页与重复书签，整理后必须真的被合并（写入路径生效）。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
const PAGE_PORT = 8798
const headful = process.argv.includes('--headful')

const TEST_PAGE = '<!doctype html><title>整理测试页</title><h1>整理测试页</h1><p>用于制造重复标签页。</p>'

/** 在浮窗里点开某个整理入口并提交 */
async function startOrganize(popup, entryText) {
  // 上一轮结束后浮窗停在整理面板，先退回主面板再点入口
  await popup.evaluate(`(() => {
    const back = document.querySelector('.nav-back')
    if (back) back.click()
    return true
  })()`)
  await sleep(400)
  await popup.evaluate(`(() => {
    const entry = [...document.querySelectorAll('.entry')]
      .find((e) => e.textContent.includes(${JSON.stringify(entryText)}))
    if (!entry) throw new Error('找不到入口：${entryText}')
    entry.click()
    return true
  })()`)
  await sleep(600)
  const submitted = await popup.evaluate(`(() => {
    const btn = document.querySelector('.pill-submit')
    if (!btn) return 'no-submit'
    btn.click()
    return 'ok'
  })()`)
  console.log(`已提交「${entryText}」：`, submitted)
  if (submitted !== 'ok') throw new Error('浮窗里找不到提交按钮')
}

/** 等这一轮整理出结论（结束条件：拿到回答或报错） */
async function waitForAnswer(popup, problems, maxSeconds = 120) {
  let state = null
  for (let i = 0; i < maxSeconds; i += 1) {
    await sleep(1000)
    state = JSON.parse(await popup.evaluate(`JSON.stringify({
      timeline: [...document.querySelectorAll('.timeline-row')].map((n) => n.textContent.trim()),
      answer: document.querySelector('.answer-text')?.textContent.trim() || '',
      cards: document.querySelectorAll('.result-card').length,
      error: document.querySelector('.error-text')?.textContent.trim() || '',
      asking: !!document.querySelector('.ask-box'),
    })`))
    if (state.asking) {
      // 模型反问：直接回答以便继续（整理场景一般不该问，这里作为兜底）
      await popup.evaluate(`(() => {
        const input = document.querySelector('.ask-box .pill-input')
        if (!input) return 'no-input'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '按域名分组并关闭重复项')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const btn = document.querySelector('.ask-box .pill-submit')
        if (btn) btn.click()
        return 'answered'
      })()`)
      problems.push('模型发起了反问（整理场景不应反问）')
    }
    if (state.error || (state.answer && !state.asking)) break
  }
  return state
}

async function main() {
  if (!existsSync(join(DIST, 'background.js'))) throw new Error('缺少 dist，请先 npm run build')
  const services = await startPrivateServices({ logFile: join(tmpdir(), 'dony-smoke-services.log') })
  const health = () => fetch(`${services.bridgeBase}/health`).then((r) => r.json())

  const port = pickPort(9600, 300)
  await assertPortFree(port)
  const server = await startStaticServer(TEST_PAGE, PAGE_PORT)
  const profile = mkdtempSync(join(tmpdir(), 'dony-organize-profile-'))
  const browser = launch({ extDir: DIST, port, windowSize: '420,660', headful, profile })

  const problems = []
  let popup = null
  try {
    const worker = await waitForExtension(port)
    const extensionId = new URL(worker.url).host
    console.log('扩展已加载，ID =', extensionId)

    // 制造两个相同网址的标签页（整理后应被合并掉一个）
    for (let i = 0; i < 2; i += 1) {
      const tab = await openTab(port)
      await tab.send('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/` })
      tab.close()
    }
    await sleep(1000)

    popup = await openTab(port)
    await popup.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/index.html` })
    await sleep(1200)
    console.log('切换桥接地址：', await pointExtensionAt(popup, services.bridgeBase))

    let handshaked = false
    for (let i = 0; i < 40 && !handshaked; i += 1) {
      handshaked = !!(await health()).extension_connected
      if (!handshaked) await sleep(300)
    }
    console.log('扩展已与桥接服务握手：', handshaked)
    if (!handshaked) throw new Error('扩展没有连上桥接服务')

    // ---- 第一段：标签页 ----
    const before = await popup.evaluate('chrome.tabs.query({}).then((t) => t.length)')
    console.log('整理前标签页数：', before)
    await startOrganize(popup, '整理标签页')
    const tabsState = await waitForAnswer(popup, problems)
    console.log('阶段行：', tabsState?.timeline?.join(' / ') || '(空)')
    console.log('回答：', (tabsState?.answer || '(空)').slice(0, 220))
    console.log('结果卡片：', tabsState?.cards)
    const after = await popup.evaluate('chrome.tabs.query({}).then((t) => t.length)')
    console.log('整理后标签页数：', after)

    // ---- 第二段：收藏夹 ----
    // 先清空测试根目录，避免浏览器自带/上次测试遗留的数据干扰断言
    const seeded = await popup.evaluate(`(async () => {
      const tree = await chrome.bookmarks.getTree()
      const root = tree[0].children[0]
      for (const node of root.children) {
        // 目录要先 removeTree；浏览器自带的收藏也一并清掉，保证断言只针对本次播种的数据
        try { await chrome.bookmarks.remove(node.id) } catch { await chrome.bookmarks.removeTree(node.id) }
      }
      const items = [
        ['站点 A 首页', 'https://a.example.com/'],
        ['站点 A 文档', 'https://a.example.com/docs'],
        ['站点 A 首页（重复）', 'https://a.example.com/'],
        ['站点 B 博客', 'https://b.example.com/post'],
      ]
      for (const [title, url] of items) await chrome.bookmarks.create({ parentId: root.id, title, url })
      const fresh = await chrome.bookmarks.getTree()
      return fresh[0].children[0].children.filter((n) => n.url).length
    })()`)
    console.log('已写入测试书签，根目录散落条目：', seeded)

    await startOrganize(popup, '整理收藏夹')
    const bookmarksState = await waitForAnswer(popup, problems)
    console.log('收藏夹整理回答：', (bookmarksState?.answer || '(空)').slice(0, 220))

    const structure = JSON.parse(await popup.evaluate(`(async () => {
      const tree = await chrome.bookmarks.getTree()
      const root = tree[0].children[0]
      const out = {}
      for (const node of root.children) {
        out[node.title] = node.children ? node.children.map((c) => c.url || c.title) : node.url
      }
      return JSON.stringify(out)
    })()`))
    console.log('整理后收藏夹结构：', JSON.stringify(structure))

    mkdirSync(OUT_DIR, { recursive: true })
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' })
    const file = join(OUT_DIR, 'organize.png')
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('截图：', file)

    if (tabsState?.error) problems.push(`标签页整理报错：${tabsState.error}`)
    if (!tabsState?.answer) problems.push('标签页整理没有收到模型的回答')
    if (after >= before) problems.push(`标签页写入路径没有生效：${before} → ${after}`)

    if (bookmarksState?.error) problems.push(`收藏夹整理报错：${bookmarksState.error}`)
    if (!bookmarksState?.answer) problems.push('收藏夹整理没有收到模型的回答')
    const folder = structure['a.example.com']
    if (!Array.isArray(folder)) problems.push('收藏夹没有按域名建立文件夹')
    else if (folder.length !== 2) problems.push(`a.example.com 目录应收纳去重后的 2 条，实际 ${folder.length} 条`)
    if (!Object.values(structure).some((v) => v === 'https://b.example.com/post')) {
      problems.push('单条书签（b.example.com）被塞进了目录，应保持散落')
    }
    for (const e of popup.errors) problems.push(e)
  } finally {
    killTree(browser.pid)
    stopServices(services)
    server.close()
    popup?.close()
  }

  if (problems.length) {
    console.error('发现以下问题：')
    for (const p of problems) console.error(' -', p)
    process.exitCode = 1
  } else {
    console.log('整理链路冒烟通过')
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message)
  process.exitCode = 1
})
