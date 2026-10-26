/**
 * 冒烟脚本共用的浏览器/调试工具。
 *
 * 说明：三个冒烟脚本都要「加载解压扩展 → 开标签页 → 用 CDP 驱动 → 收尾清理」，
 * 这里集中处理，避免各脚本各写一份（尤其是进程清理与端口占用这两处容易踩坑的地方）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function findBrowser() {
  const found = CANDIDATES.find((p) => existsSync(p))
  if (!found) throw new Error('没有找到 Edge/Chrome 可执行文件')
  return found
}

/**
 * 端口必须确认空闲再启动：若上一次的浏览器没退干净，端口被占用时新实例会**静默**起不来，
 * 而脚本会连上那个残留实例（它的 profile 里带着上次测试的数据），断言就会变得莫名其妙。
 */
export async function assertPortFree(port) {
  const inUse = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then(() => true)
    .catch(() => false)
  if (inUse) {
    throw new Error(`调试端口 ${port} 已被占用：可能有上一次的浏览器残留，请先关闭它再重试`)
  }
}

/** 结束整棵进程树：Edge 会派生多个子进程，只 kill 主进程可能留下残骸 */
export function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 已退出 */
  }
}

export function launch({ extDir, port, windowSize = '420,660', headful = false, profile }) {
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    `--remote-debugging-port=${port}`,
    // 关掉一切可能把测试数据与真实账号/配置连起来的通道：
    // 同步、自动登录、首次运行导入。测试浏览器必须是一座孤岛。
    '--disable-sync',
    '--disable-features=msEdgeAutoSignIn,msImplicitSignin,msSyncPromo,msEdgeIdentityDefaultSync',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-component-update',
    `--window-size=${windowSize}`,
    'about:blank',
  ]
  if (!headful) args.unshift('--headless=new')
  return spawn(findBrowser(), args, { stdio: 'ignore' })
}

export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(`未捕获异常：${msg.params.exceptionDetails?.exception?.description || '未知'}`)
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(`console.error：${(msg.params.args || []).map((a) => a.value ?? a.description).join(' ')}`)
      }
    })
  }

  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '页面求值失败')
    }
    return r.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 已关闭 */
    }
  }
}

async function listTargets(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (resp.ok) return await resp.json()
  } catch {
    /* 还没起来 */
  }
  return []
}

/**
 * 等本扩展的后台出现。
 * ⚠ 必须用 type=service_worker + /background.js 精确匹配：浏览器自身也带一批内置扩展，
 * 它们的 background_page 同样以 chrome-extension:// 开头，按前缀抓会抓错对象。
 */
export async function waitForExtension(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets(port)
    const hit = targets.find(
      (t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url),
    )
    if (hit) return hit
    await sleep(250)
  }
  throw new Error('扩展后台没有启动（清单/background.js 可能有问题，或调试端口连不上浏览器）')
}

/** 新开一个标签页并连上它的 CDP 会话 */
export async function openTab(port) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    .then((r) => r.json())
  const cdp = new Cdp(created.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  return cdp
}

/** 起一个只返回固定 HTML 的本地静态服务（测试页用） */
export async function startStaticServer(html, port) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

/** 随机挑一个大概率可用的调试端口（随后仍会用 assertPortFree 校验） */
export function pickPort(base = 9300, span = 600) {
  return base + Math.floor(Math.random() * span)
}

// ================= 真实配置守卫 =================
//
// 血泪教训：测试浏览器**绝不能**碰到用户真实 Edge 配置里的收藏夹。
// 每次冒烟前后都对真实配置的关键文件做指纹比对，一旦变化立即报错并中止后续断言 ——
// 宁可测试失败，也不能静默改用户数据。

const REAL_PROFILE_FILES = ['Bookmarks', 'Bookmarks.bak', 'Preferences', 'Secure Preferences']

export function snapshotRealProfile() {
  const dir = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default')
  const snap = {}
  for (const name of REAL_PROFILE_FILES) {
    const file = join(dir, name)
    try {
      snap[name] = createHash('sha256').update(readFileSync(file)).digest('hex')
    } catch {
      snap[name] = ''
    }
  }
  return snap
}

export function assertRealProfileUnchanged(before, label = '测试') {
  const after = snapshotRealProfile()
  const changed = Object.keys(after).filter((name) => after[name] !== before[name])
  if (changed.length) {
    throw new Error(
      `${label}改动了真实 Edge 配置：${changed.join('、')}。已中止 —— 请先核查 ${join(
        process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default')}`,
    )
  }
  return after
}

// ================= 独立的后端服务（测试隔离） =================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * 测试专用：为一次冒烟起一套**独立**的桥接服务 + Agent 服务。
 *
 * 为什么必须隔离：用户机器上通常正跑着 intelligentSTUDIO（8768/8767 都占着），
 * 而桥接服务同一时刻只接受一个浏览器实例 —— 测试浏览器会被拒绝接入，
 * 或者更糟：测试与真实浏览器共用一个快照缓存，断言就失去意义。
 */
export function findPython() {
  const candidates = [
    resolve(ROOT, '.venv', 'Scripts', 'python.exe'),
    resolve(ROOT, '.venv', 'bin', 'python'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('没有找到项目虚拟环境 .venv 里的 python')
  return found
}

/** 取一个当前空闲的端口（比随机取端口可靠） */
export function freePort() {
  return new Promise((res, rej) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => res(port))
    })
    server.on('error', rej)
  })
}

function spawnService(mod, env, logFile) {
  const out = openSync(logFile, 'a')
  return spawn(findPython(), ['-m', mod], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env },
    stdio: ['ignore', out, out],
  })
}

export async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok) return await resp.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error(`服务没有就绪：${url}`)
}

export async function waitForSocket(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      try {
        const ws = new WebSocket(url)
        const timer = setTimeout(() => { try { ws.close() } catch { /* 忽略 */ } ; res(false) }, 1500)
        ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); res(true) })
        ws.addEventListener('error', () => { clearTimeout(timer); res(false) })
      } catch {
        res(false)
      }
    })
    if (ok) return true
    await sleep(250)
  }
  throw new Error(`WS 服务没有就绪：${url}`)
}

export async function startPrivateServices({ logFile }) {
  const bridgePort = await freePort()
  const agentPort = await freePort()
  const bridgeBase = `http://127.0.0.1:${bridgePort}`
  // 两个服务互相引用对方的端口：Agent 的工具按 EDGE_API_BASE 调桥接服务
  const agent = spawnService('backend.agent.agent_server', {
    AGENT_WS_PORT: String(agentPort), EDGE_API_BASE: bridgeBase,
  }, logFile)
  await waitForSocket(`ws://127.0.0.1:${agentPort}`, 25000)
  const bridge = spawnService('backend.edge_bridge', {
    EDGE_BRIDGE_PORT: String(bridgePort), AGENT_WS_PORT: String(agentPort),
    EDGE_API_BASE: bridgeBase,
  }, logFile)
  await waitForHttp(`${bridgeBase}/health`, 25000)
  console.log(`独立测试服务已就绪：桥接 ${bridgeBase}｜Agent ${agentPort}`)
  return { bridgePort, agentPort, bridgeBase, children: [agent, bridge] }
}

export function stopServices(services) {
  for (const child of services?.children ?? []) killTree(child.pid)
}

/** 让扩展把桥接服务地址改到测试用的端口，并立刻重连 */
export async function pointExtensionAt(cdp, base) {
  const message = await cdp.evaluate(`new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'popup' })
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      try { port.disconnect() } catch (e) { /* 已断开 */ }
      resolve(text)
    }
    port.onMessage.addListener((msg) => {
      if (msg && (msg.kind === 'ok' || msg.kind === 'error')) finish(msg.message || msg.kind)
    })
    port.postMessage({ kind: 'bridge/base', base: ${JSON.stringify(base)} })
    setTimeout(() => finish('timeout'), 5000)
  })`)
  return message
}
