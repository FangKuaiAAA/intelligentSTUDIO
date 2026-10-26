/**
 * 「整页」视觉智能冒烟：注入覆盖层（mode=page）→ 滚动拼接整页截图 →
 * 经桥接服务问模型 → 分点归纳落入回答框。
 *
 * 前置：本机可访问模型 API（会真实产生一次模型调用）。
 * 用法：node extension/scripts/smoke-page.mjs [--headful]
 * 产物：extension/.preview/page.png
 *
 * 安全：脚本自起独立的桥接/Agent 服务、用临时配置启动浏览器，并在运行前后
 * 校验真实 Edge 配置的指纹 —— 一旦有变化立即报错（见 lib/browser.mjs 的守卫）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPortFree, assertRealProfileUnchanged, killTree, launch, openTab, pickPort,
  pointExtensionAt, sleep, snapshotRealProfile, startPrivateServices, startStaticServer,
  stopServices, waitForExtension,
} from './lib/browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
const OUT_DIR = resolve(HERE, '..', '.preview')
const PAGE_PORT = 8797
const headful = process.argv.includes('--headful')

const SECTION = (index) => `
  <section>
    <h2>第 ${index} 节 · ${['季度目标', '交付节奏', '协作方式', '质量红线', '复盘机制', '工具链', '风险清单', '下一步'][index - 1] || '章节'}</h2>
    <p>这是第 ${index} 节的正文内容，用于验证整页归纳能否覆盖到页面下方的段落。
       关键词标记 PAGE-MARK-${index}：段落里还会重复一些说明性文字，让页面高度足够需要滚动多次。</p>
    <p>补充段落 ${index}A：为了保证拼接过程需要滚动多屏，这里再写一段较长的文字。内容本身没有特殊含义，只用于撑高页面。</p>
    <p>补充段落 ${index}B：整页归纳应当忽略广告、推广与页脚，只抓主要内容。</p>
  </section>`

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>整页归纳测试页</title>
<style>
 body{margin:0;padding:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f7f7fa;color:#1b1b1d}
 header{position:fixed;top:0;left:0;right:0;height:64px;background:#fff;border-bottom:1px solid #e2e2e8;display:flex;align-items:center;padding:0 24px;font-weight:600}
 main{padding:96px 64px 48px;max-width:760px}
 h1{font-size:30px;margin:0 0 18px}
 section{margin:0 0 46px}
 h2{font-size:19px;margin:0 0 10px}
 p{font-size:15px;line-height:1.9;margin:0 0 12px}
 .promo{margin:36px 0;padding:26px;border-radius:16px;background:linear-gradient(135deg,#ff9d00,#ff3b30);color:#fff}
 footer{margin-top:60px;padding:32px 64px;background:#e9e9ef;color:#666;font-size:13px}
</style></head>
<body>
<header>固定页头 · 测试站</header>
<main>
  <h1>整页归纳测试页</h1>
  <p>本页用于验证「整页」模式：截图整页后交给模型分点归纳，忽略广告。</p>
  ${[1, 2, 3, 4, 5, 6, 7, 8].map(SECTION).join('\n')}
  <div class="promo"><strong>限时促销广告</strong><p style="margin:6px 0 0">这里是推广内容，归纳时应被忽略。</p></div>
  ${[9, 10].map(SECTION).join('\n')}
</main>
<footer>页脚导航 · 关于本站 · 联系方式 · 归纳时应被忽略</footer>
</body></html>`

/** 测试副本：附加 <all_urls> 以获得注入与截图权限 */
function prepareExtension() {
  const target = join(mkdtempSync(join(tmpdir(), 'dony-ext-page-')), 'ext')
  cpSync(DIST, target, { recursive: true })
  const manifestPath = join(target, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.host_permissions = [...manifest.host_permissions, '<all_urls>']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return target
}

async function main() {
  if (!existsSync(join(DIST, 'content.js'))) throw new Error('缺少 dist/content.js，请先 npm run build')
  const profileGuard = snapshotRealProfile()
  const services = await startPrivateServices({ logFile: join(tmpdir(), 'dony-smoke-services.log') })
  const port = pickPort(9500, 300)
  await assertPortFree(port)
  const extDir = prepareExtension()
  const server = await startStaticServer(TEST_PAGE, PAGE_PORT)
  const profile = mkdtempSync(join(tmpdir(), 'dony-page-profile-'))
  const browser = launch({ extDir, port, windowSize: '1000,760', headful, profile })

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
    const height = await page.evaluate('document.documentElement.scrollHeight')
    const viewport = await page.evaluate('window.innerHeight')
    console.log(`测试页高度 ${height}px，视口 ${viewport}px（需 ${Math.ceil(height / viewport)} 屏）`)

    popup = await openTab(port)
    await popup.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup/index.html` })
    await sleep(1200)
    console.log('切换桥接地址：', await pointExtensionAt(popup, services.bridgeBase))
    await sleep(1200)

    // ⚠ captureVisibleTab 取的是「窗口中的活动标签页」：测试页必须先成为活动页，
    //   否则截到的是浮窗自己
    await page.send('Page.bringToFront')
    await sleep(300)

    const injected = await popup.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${PAGE_PORT}/*' })
      if (!tabs.length) return '找不到测试页'
      const tabId = tabs[0].id
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      await chrome.tabs.sendMessage(tabId, { type: 'visual/start', mode: 'page' })
      return 'ok'
    })()`)
    console.log('注入并下发整页模式：', injected)
    if (injected !== 'ok') throw new Error(`注入失败：${injected}`)

    let state = null
    for (let i = 0; i < 120; i += 1) {
      await sleep(1000)
      state = JSON.parse(await page.evaluate(`(() => {
        const root = document.getElementById('intelligentstudio-visual-host')?.shadowRoot
        if (!root) return JSON.stringify({ mounted: false })
        const box = root.querySelector('.visual-answer-box')
        const pill = root.querySelector('.visual-request-pill')
        const lines = [...root.querySelectorAll('.visual-answer-text')].map((n) => n.textContent.trim())
        const pr = pill?.getBoundingClientRect()
        const br = box?.getBoundingClientRect()
        return JSON.stringify({
          mounted: true,
          pill: !!pill,
          pillText: root.querySelector('.visual-request-pill-text')?.textContent?.trim() || '',
          // 整页模式：彩虹整条去掉（::before 内容为 none）
          pillRainbow: pill ? String(getComputedStyle(pill, '::before').content) : '',
          box: !!box,
          boxBelow: pr && br ? Math.round(br.top - pr.bottom) : null,
          boxCenterDelta: pr && br ? Math.round((br.left + br.right) / 2 - (pr.left + pr.right) / 2) : null,
          boxW: br ? Math.round(br.width) : null,
          lines,
          scrollY: window.scrollY,
        })
      })()`))
      if (state.box && state.lines.length) break
    }
    console.log('覆盖层状态：', JSON.stringify({ ...state, lines: undefined }))
    console.log('归纳结果：')
    for (const line of state?.lines ?? []) console.log('   ', line.slice(0, 90))

    mkdirSync(OUT_DIR, { recursive: true })
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT_DIR, 'page.png'), Buffer.from(shot.data, 'base64'))

    if (!state?.mounted) problems.push('整页覆盖层没有挂载')
    if (state?.pillText !== '整页') problems.push(`胶囊文案应为「整页」，实际「${state?.pillText}」`)
    // 整页模式：黑框回到「包裹输入框之前」的形态（落在输入框下方、比输入框窄 48px、居中）
    if (state?.pillRainbow !== 'none') {
      problems.push(`整页模式的输入框应完全去掉彩虹，实际 ::before content=${state?.pillRainbow}`)
    }
    if (!(state?.boxBelow > 0)) problems.push(`整页模式黑框应落在输入框下方，实际间距 ${state?.boxBelow}`)
    if (state?.boxW !== 272) problems.push(`整页模式黑框宽度应为 272（320 − 48），实际 ${state?.boxW}`)
    if (Math.abs(state?.boxCenterDelta ?? 99) > 1) {
      problems.push(`整页模式黑框应与输入框居中对齐，实际偏移 ${state?.boxCenterDelta}`)
    }
    if (!state?.box) problems.push('回答框没有出现')
    if (!state?.lines?.length) problems.push('没有归纳结果')
    if ((state?.lines?.length ?? 0) < 3) problems.push(`归纳要点过少：${state?.lines?.length} 行`)
    const joined = (state?.lines ?? []).join(' ')
    if (joined && !/PAGE-MARK|季度目标|交付节奏|协作方式|质量红线|复盘机制|工具链|风险清单|下一步|章节/.test(joined)) {
      problems.push(`归纳内容与页面不符：${joined.slice(0, 120)}`)
    }
    if (joined && /促销|推广/.test(joined) && !/忽略/.test(joined)) {
      problems.push(`归纳没有忽略广告内容：${joined.slice(0, 120)}`)
    }
    if ((state?.scrollY ?? 0) !== 0) problems.push(`拼接后没有回到原滚动位置：${state?.scrollY}`)
    for (const e of [...page.errors, ...popup.errors]) problems.push(e)
  } finally {
    killTree(browser.pid)
    stopServices(services)
    server.close()
    page?.close()
    popup?.close()
  }

  // 真实配置守卫：任何来自测试浏览器的写入都会在这里暴露
  try {
    assertRealProfileUnchanged(profileGuard, '整页冒烟')
    console.log('真实 Edge 配置未被触碰 ✓')
  } catch (e) {
    problems.push(e.message)
  }

  if (problems.length) {
    console.error('发现以下问题：')
    for (const p of problems) console.error(' -', p)
    process.exitCode = 1
  } else {
    console.log('整页归纳冒烟通过')
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message)
  process.exitCode = 1
})
