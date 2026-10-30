const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, nativeImage, shell, Menu, Tray } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')
const http = require('http')
const https = require('https')

// 后端/语音服务统一使用项目内虚拟环境 .venv（含 pyaudio/sherpa-onnx/edge-tts 等依赖）；
// 没有虚拟环境时回退到 PATH 中的 python。
const PYTHON = (() => {
  const venv = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
  return fs.existsSync(venv) ? venv : 'python'
})()

// 打包后安装环境没有 Python：改用 PyInstaller 打出的 backend.exe，按 --service 分发。
const BACKEND_EXE = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'intelligentstudio-backend.exe')
  : null
const USE_BACKEND_EXE = !!BACKEND_EXE && fs.existsSync(BACKEND_EXE)

// 打包态把模型与配置文件路径指向安装目录 resources/，供后端各服务读取
function serviceEnv() {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
  if (app.isPackaged) {
    const models = path.join(process.resourcesPath, 'models')
    env.PHOTO_MODEL_DIR = path.join(models, 'photo')
    env.SHERPA_MODEL_DIR = path.join(models, 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20')
    env.NOTIFY_MODEL_DIR = path.join(models, 'qwen2.5-0.5b-instruct-int4', 'cpu_and_mobile', 'cpu-int4-rtn-block-32')
    env.NOTIFY_CLASSIFIER_DIR = path.join(models, 'bge-small-zh-v1.5')
    env.APPX_CONFIG_FILE = path.join(process.env.APPDATA || process.env.USERPROFILE, 'IntelligentStudio', 'config.json')
    // Office 桥与图乐园：静态资源在 resources/ 下（backend 在 resources/backend，靠相对路径推断不可靠）
    env.OFFICE_STATIC_DIR = path.join(process.resourcesPath, 'office', 'dist')
    env.PLAYGROUND_ELEMENTS_DIR = path.join(process.resourcesPath, 'playground', 'Assets', 'Elements')
    env.PLAYGROUND_EXE = path.join(process.resourcesPath, 'playground', 'ImagePlayground.exe')
  }
  return env
}

// 统一启动后端服务：打包态用 backend.exe --service，开发态用 Python 脚本
function spawnService(service, pythonArgs) {
  const target = USE_BACKEND_EXE ? BACKEND_EXE : PYTHON
  const args = USE_BACKEND_EXE ? ['--service', service] : pythonArgs
  const cwd = USE_BACKEND_EXE ? path.dirname(BACKEND_EXE) : path.join(__dirname, '..')
  console.log(`[${service}] spawn =`, target, args.join(' '))

  const child = spawn(target, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: serviceEnv() })

  // 关键：spawn 失败（如 ENOENT）会以 'error' 事件抛出，不监听会变成主进程未捕获异常并弹窗
  child.on('error', (err) => {
    console.error(`[${service}] 启动失败 (${target}): ${err.message}`)
  })
  return child
}

let overlayWindow = null
let wakeHoldTimer = null
let voiceHoldTimer = null
let isAwake = false
let awakeSafetyTimer = null

/** 30s 兜底：清掉"已唤醒"标记，避免界面异常时快捷键被永久锁死。
 *  ⚠ 界面还显示着内容时**必须续期**，不能清：isAwake 被拿去判断"鼠标该不该接管"，
 *  追问阶段读着答案等超过 30s 就会突然整块穿透 —— 点哪都把界面点没了。
 *  真正收起（state=idle 且窗口不可见）之后才允许清。 */
let awakeSafetyArms = 0
function armAwakeSafetyTimer(reset = false) {
  if (reset) awakeSafetyArms = 0
  clearTimeout(awakeSafetyTimer)
  awakeSafetyTimer = setTimeout(() => {
    const stillShowing = !!overlayWindow && !overlayWindow.isDestroyed()
      && overlayWindow.isVisible() && overlayState !== 'idle'
    // 最多续期 20 次（约 10 分钟）：界面真卡死时仍能靠兜底解锁快捷键，
    // 不会因为"永远有内容"把热键永久锁住。
    if (stillShowing && awakeSafetyArms < 20) {
      awakeSafetyArms += 1
      armAwakeSafetyTimer()
      return
    }
    awakeSafetyArms = 0
    isAwake = false
  }, 30000)
}
// 视觉智能是否正在进行。它有自己的面板，**不经过渲染进程的状态机**：
// overlayState 全程停在 idle，会让 isAlreadyAwake() 的"界面无内容"规则误判为
// "不在会话中"并清掉 isAwake，导致连按 Alt+V 会重复唤醒。故单独记一个标记。
let visualModeActive = false
// 书写辅助（选区改写）是否正在进行。与 visualModeActive 平级：它同样**不走渲染进程的状态机**
// （overlayState 全程停在 idle），所以凡是"按 overlayState 判断该不该收窗 / 该不该放行鼠标"
// 的地方都必须单独放行 —— 见 overlay-state 的自动收窗、overlay-content-visible、blur-dismiss。
let writingModeActive = false
// 视觉智能期间全局捕获 Esc 的状态。见 registerVisualEscape()。
let visualEscapeRegistered = false
// 渲染进程上报的真实界面状态（idle/holding/waking/ready/loading/responding/followUp）
let overlayState = 'idle'
let idleHideTimer = null
// 是否由“界面无内容”这条规则放行了鼠标（用于之后准确恢复）
let contentForcedPassthrough = false
// 渲染进程当前是否真的画了东西（药丸/结果框/光斑/视觉面板）
let contentVisible = false
let voiceProcess = null
let voiceRestarts = 0        // 语音服务异常退出的重启次数
let quitting = false         // 正在退出：此时不要自动重启子服务

// 视觉智能（Visual Intelligence）使用的模型服务：优先用设置页配置的 OpenAI 兼容接口，
// 未配置时回退到 DeepSeek 官方 API（避免全局视觉与网页用不同的 Key 导致 401）。
function getVisionConfig() {
  let base = process.env.OPENAI_API_BASE || ''
  let key = process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || ''
  let model = ''
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    base = base || cfg.OPENAI_API_BASE || ''
    key = key || cfg.OPENAI_VISION_API_KEY || cfg.OPENAI_API_KEY || ''
    model = cfg.OPENAI_VISION_MODEL || cfg.OPENAI_MODEL || ''
  } catch { /* 配置缺失时用环境变量/默认 */ }
  const trimmed = String(base).replace(/\/+$/, '')
  const url = trimmed
    ? (trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`)
    : 'https://api.deepseek.com/v1/chat/completions'
  return { url, key, model }
}

// ---- 窗口图标：统一取自项目内的稳定目录 assets/icons ----
// （Windows 的任务栏/Alt+Tab 上，未设图标时会显示 Electron 的默认头像）
// 路径分两种：开发时在项目根的 assets/icons；打包后由 package.json 的 build.extraResources
// 复制到 resources/icons（asar 之外，所以能用文件路径读）。
// ⚠ 这里只引用稳定目录；图标原件不许再直接引用临时目录。
const ICON_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'icons')
  : path.join(__dirname, '..', 'assets', 'icons')
// ⚠ 实际文件名是 Dony.ico（不是早期文档里的 Dony对话.ico）：
//   之前指向不存在的文件，Electron 会静默忽略 → 托盘/窗口图标一直没生效。
const DONY_ICON = path.join(ICON_DIR, 'Dony.ico')
const VISUAL_ICON = path.join(ICON_DIR, '视觉智能.ico')

// 任务栏图标分组/命名的身份：不设的话 Windows 会把它当成一个匿名的 Electron 应用
try { app.setAppUserModelId('com.dony.intelligentstudio') } catch (e) { /* 忽略 */ }

// 开发态使用独立的 userData：否则 `npm run electron:dev` 与已安装版本共用同一份
// 单实例锁，dev 一启动就被打包版挡掉（日志里只有一句「已有实例在运行，本次启动直接退出」）。
if (!app.isPackaged) {
  try { app.setPath('userData', path.join(app.getPath('userData'), 'dev')) } catch (e) { /* 忽略 */ }
}

// 首次启动向导：读 .appx_config.json 的 ONBOARDING_COMPLETED，未完成则拉起 onboarding
const CONFIG_FILE = app.isPackaged
  ? path.join(process.env.APPDATA || process.env.USERPROFILE, 'IntelligentStudio', 'config.json')
  : path.join(__dirname, '..', '.appx_config.json')

function isOnboardingCompleted() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw).ONBOARDING_COMPLETED === true
  } catch {
    // 读不到配置 = 首次安装 / 已清空个人数据 → 视为未完成，弹设置向导
    return false
  }
}

/** 拉起首次启动向导，返回子进程（拿不到就返回 null）。
 *  返回值有用途：向导是个独立 exe，主进程只能靠"它退出了没有"来判断用户是不是
 *  把引导关掉了（见 waitForOnboarding）。 */
function launchOnboarding() {
  try {
    if (app.isPackaged) {
      const exe = path.join(process.resourcesPath, 'onboarding', 'Onboarding.exe')
      if (fs.existsSync(exe)) {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
        child.unref()
        return child
      }
    } else {
      const bat = path.join(__dirname, '..', 'run-onboarding.bat')
      if (fs.existsSync(bat)) {
        const child = spawn('cmd', ['/c', 'start', '""', bat], { detached: true, stdio: 'ignore' })
        child.unref()
        return child
      }
    }
  } catch { /* 拉起失败不阻断主程序 */ }
  return null
}

// 首次启动时等待用户走完 onboarding（onboarding 完成后写 ONBOARDING_COMPLETED）。
// 未完成前不初始化主界面，避免「Dony 打字界面」盖住设置向导。
function waitForOnboarding() {
  if (isOnboardingCompleted()) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    let poll = null
    const finish = (why) => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      if (why) console.log(`[onboarding] ${why} → 继续启动主界面`)
      resolve()
    }

    poll = setInterval(() => { if (isOnboardingCompleted()) finish() }, 2000)

    const child = launchOnboarding()
    // ⚠ 必须有这一条：用户把向导关掉（没走完）时配置永远不会写，原来的实现会在这里
    //   死等 10 分钟 —— 期间没有托盘、没有后端、快捷键也没注册，而单实例锁已经被
    //   占住了，再双击 exe 只会「静默退出」，表现就是「双击打不开、毫无反应」。
    //   向导进程退出后再宽限 1.5 秒（配置可能刚落盘），仍未完成就放行主程序。
    if (child && typeof child.on === 'function') {
      child.on('exit', () => {
        setTimeout(() => { if (!isOnboardingCompleted()) finish('向导已关闭但引导未完成') }, 1500)
      })
      child.on('error', () => finish('向导启动失败'))
    }
    // 最终兜底：10 分钟
    setTimeout(() => finish('等待引导超时'), 10 * 60 * 1000)
  })
}

/** 当前该用哪张窗口图标（视觉智能切成小窗时会换成视觉智能的） */
let overlayIcon = DONY_ICON

/**
 * 把覆盖层标记成 Windows 的"工具窗口"（WS_EX_TOOLWINDOW）——这才是真正、
 * 且**永久**让它不出现在任务栏的做法。
 *
 * 为什么不用 Electron 的 setSkipTaskbar：它在窗口被激活/重新显示后会被系统撤销
 * （表现为任务栏突然冒出一个图标）；而每次调用又都会让 Windows 重建任务栏按钮，
 * 那就是"鼠标移入移出视觉智能时卡一下"的元凶。原生样式设一次就够，零开销。
 *
 * 顺带清掉 WS_EX_APPWINDOW（它会把窗口强行塞回任务栏）。
 */
function applyToolWindowStyle() {
  if (process.platform !== 'win32' || !overlayWindow) return
  try {
    const buf = overlayWindow.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
    const ps = [
      "$ErrorActionPreference='Stop'",
      "$sig=@'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class W {',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
      '}',
      "'@",
      'Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue',
      `$h=[IntPtr]${hwnd}`,
      '$GWL_EXSTYLE=-20; $TOOL=0x00000080; $APP=0x00040000',
      '$ex=[int64][W]::GetWindowLongPtr($h,$GWL_EXSTYLE)',
      '$ex=($ex -bor $TOOL) -band (-bnot $APP)',
      '[void][W]::SetWindowLongPtr($h,$GWL_EXSTYLE,[IntPtr]$ex)',
      // SWP_NOSIZE|SWP_NOMOVE|SWP_NOZORDER|SWP_FRAMECHANGED = 0x27（让样式立即生效）
      '[void][W]::SetWindowPos($h,[IntPtr]::Zero,0,0,0,0,0x27)',
    ].join('\n')
    // 异步调用，且不设超时：PowerShell 冷启动 + Add-Type 现场编译 C# 首次要好几秒，
    // 之前用同步调用配 8s 超时，在启动高峰期会被打断（日志里的 ETIMEDOUT 就是它）。
    // 异步不会阻塞主进程，也就不会拖慢启动；失败只降级为"任务栏可能仍显示按钮"。
    // 用 -EncodedCommand（Base64/UTF-16LE）传脚本，免得引号与换行被命令行吃掉。
    const child = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64'),
    ], { windowsHide: true })
    let errText = ''
    child.stderr?.on('data', (d) => { errText += String(d) })
    child.on('error', (e) => console.warn('[taskbar] 启动 PowerShell 失败:', e.message))
    child.on('close', (code) => {
      if (code === 0) console.log('[taskbar] 已设为工具窗口（不出现在任务栏）')
      else console.warn('[taskbar] 设置失败，退出码', code, errText.slice(0, 300))
    })
  } catch (err) {
    console.warn('[taskbar] 原生样式设置失败（不影响使用）:', err?.message || err)
  }
}

/** 切换窗口图标。**只做图标**、只在该换的时候调（低频）：
    任务栏归属交给 applyToolWindowStyle，不要在这里碰 setSkipTaskbar。 */
function setOverlayIcon(icon) {
  if (!icon) return
  if (overlayIcon === icon) return
  overlayIcon = icon
  if (!overlayWindow) return
  try {
    overlayWindow.setIcon(icon)
  } catch (err) {
    console.warn('[taskbar] 设置图标失败（不影响使用）:', err?.message || err)
  }
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: false, show: false, fullscreenable: true,
    icon: DONY_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      // 覆盖层不聚焦，同样会被节流（动画/心跳会变慢），一起关掉
      backgroundThrottling: false,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true)
  overlayWindow.setBounds(screen.getPrimaryDisplay().bounds)
  overlayWindow.loadURL(app.isPackaged ? `file://${path.join(__dirname, '../dist/index.html')}` : `http://localhost:${process.env.VITE_DEV_PORT || '5173'}`)
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show(); overlayWindow.hide()
    // 首屏（React 挂载 + 亚克力底衬）稳定之后做一次启动彩排：
    // 真显示但不可见地跑一遍光斑 + 光边，把"首次独有"的一次性绘制成本提前付掉。
    setTimeout(beginStartupWarmup, WARMUP_DELAY_MS)
    // 兜底开闸：万一彩排压根没跑起来（窗口/时机异常、ready-to-show 没触发），
    // 快捷键闸门也必须在有限时间内打开 —— 绝不能让用户面对"怎么按都没反应"。
    setTimeout(() => {
      if (shortcutGateClosed) {
        console.warn('[warmup] 彩排兜底：强制恢复快捷键')
        shortcutGateClosed = false
      }
    }, WARMUP_DELAY_MS + WARMUP_TIMEOUT_MS + 800)
  })
  // 窗口真的隐藏了就一定不在“已唤醒”状态：避免 isAwake 残留把快捷键顶掉
  overlayWindow.on('hide', () => {
    if (isAwake) console.log('[hotkey] 窗口隐藏 → 清除已唤醒标记')
    isAwake = false; clearTimeout(awakeSafetyTimer)
  })
  // 任务栏按钮是"窗口被激活/重新显示"时被 Windows 补上的，所以这些时机都要补刀。
  // （只靠创建时的 skipTaskbar:true 不够 —— 实测鼠标一进视觉智能窗口就冒出图标。）
  // 创建后立刻标成"工具窗口"：这是唯一能可靠、永久地让它不出现在任务栏的做法。
  // （之后不需要任何"补刀"，也就不会再有卡顿。）
  applyToolWindowStyle()
  overlayWindow.on('blur', () => {
    console.log('[vis] window blur')
    // 书写辅助期间失焦是**常态**：用户正在别人的软件里选字、点菜单，我们不该抢焦点。
    // 这里下发 blur-dismiss 会让渲染进程把界面收掉，所以必须豁免。
    if (writingModeActive) return
    if (overlayWindow?.isVisible()) overlayWindow.webContents.send('blur-dismiss')
  })
  // 让可选中文本（视觉智能回答卡片等）支持右键复制
  overlayWindow.webContents.on('context-menu', (_event, params) => {
    const template = []
    if (params.isEditable) {
      template.push({ label: '剪切', role: 'cut', enabled: params.editFlags.canCut })
      template.push({ label: '复制', role: 'copy', enabled: params.editFlags.canCopy })
      template.push({ label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste })
    } else if (params.selectionText) {
      template.push({ label: '复制', role: 'copy', enabled: params.editFlags.canCopy })
    }
    if (!template.length) return
    template.push({ type: 'separator' }, { label: '全选', role: 'selectAll' })
    Menu.buildFromTemplate(template).popup({ window: overlayWindow })
  })
}

function wakeOverlay() {
  if (!overlayWindow) return
  if (wakeBlockedByWarmup('打字唤醒')) return
  // 界面已醒着时忽略重复唤醒：Alt+Space 的意义只是"开始一个新会话"，
  // 会话已在进行中就不该有任何反应（按了没反应，而不是重置当前会话）。
  if (wakeBlockedByAlreadyAwake('打字唤醒')) return
  // 渲染进程收到 wake 时会 reset()，即退出视觉模式；主进程这边同步清掉标记与全局 Esc
  // （正常路径下视觉智能期间这条唤醒会被上面拦掉，这里兜的是 30 秒兜底之后的接管）。
  leaveVisualMode(); leaveWritingMode()
  isAwake = true; armAwakeSafetyTimer(true)
  restoreOverlayTop(); overlayWindow.show(); setOverlayTakeMouse(true); overlayWindow.focus()
  overlayWindow.webContents.send('wake')
}

function voiceWakeOverlay() {
  if (!overlayWindow) return
  if (wakeBlockedByWarmup('语音唤醒')) return
  // 同 wakeOverlay：已经在会话中时，语音唤醒入口一律无反应。
  // 追问期间要继续说话走的是 startVoiceHold 的"继续追问"分支，不经过这里。
  if (wakeBlockedByAlreadyAwake('语音唤醒')) return
  // 同 wakeOverlay：渲染进程会 reset() 退出视觉模式，主进程同步清理。
  leaveVisualMode(); leaveWritingMode()
  isAwake = true; armAwakeSafetyTimer(true)
  restoreOverlayTop(); overlayWindow.show(); setOverlayTakeMouse(true); overlayWindow.focus()
  overlayWindow.webContents.send('voice-wake')
}

// ================= 启动彩排（startup warmup）=================
// 目的：把「只有第一次真正用到时才会现场建立」的一次性成本提前付掉 ——
//   绘制的管线/着色器程序编译、GPU 驱动侧的程序缓存、首次大面积填充、
//   以及光边那 12 个 filter/mask 层的首份光栅。
// 付完之后，用户第一次唤醒就不再卡（"首次卡"的根本原因就是这些一次性成本）。
//
// 做法是**真实模拟**：把窗口真的显示出来（整窗几乎全透明），让渲染进程完整跑一遍
// 光斑 + 光边。**动画本体一行不改** —— 渲染进程只是把回调整包吞掉、不落任何界面状态。
//
// ⚠ 关键点一：光栅化发生在**合成**阶段。所以窗口必须真的 visible ——
//   窗口 hide 着跑（rAF 照样会跑）只是执行了 JS，滤镜/遮罩层未必真的被光栅化，等于白跑。
// ⚠ 关键点二：彩排期间**所有唤醒入口一律忽略**（含以后新增的托盘/通知区唤醒），
//   否则会和彩排打架（窗口显隐、鼠标接管、动画重入）。见 wakeBlockedByWarmup。
// ================= 输入建议库 =================
// 「可以问 Dony 的问题」清单**固化在软件内**（用户要求："以后再也无需载入建议"）。
// ⚠ 以前是从桌面上的一个 txt 读（每次启动都会读一遍、并在命令行打一行日志）；
//   现在清单就是下面这份常量 —— **不再读任何文件**，桌面那份 txt 删掉也不影响。
//   想改内容：直接改这个数组（改完重启 Dony 生效）。
const BUILTIN_SUGGESTIONS = [
  '打开 WiFi',
  '将蓝牙关闭',
  '将音量调到 35%',
  '将屏幕亮度调到 50%',
  '启用节能模式',
  '开启移动热点',
  '读取计算机的运行状态',
  '打开记事本',
  '将浏览器窗口调到最前',
  '将当前窗口最小化',
  '关闭计算器',
  '打开系统设置蓝牙页面',
  '桌面包含哪些文件？',
  '搜索名字包含“报告”的文件',
  '于桌面新建一个文件夹',
  '将这段内容存为文稿',
  '下载文件夹内最近的文件',
  '暂停音乐',
  '切到下一首歌曲',
  '静音',
  '增大音量',
  '设定一个早上7:30的闹钟',
  '设定一个15分钟的倒计时',
  '设置每天晚上9点自动关机',
  '把微信设为开机自启动',
  '列出当前的开机启动项',
  '搜索今天的新闻',
  '查询北京明天的天气',
  '剪贴板里现有什么',
  '整理浏览器重复的标签页',
  '按网站分组整理收藏夹',
  '安全弹出 U 盘',
  '锁屏',
  '截图并保存到桌面',
]

/** 建议清单（纯内存，无 IO、无缓存、无日志 —— 每次都是同一份） */
function suggestionLibrary() {
  return BUILTIN_SUGGESTIONS
}

// ================= 启动彩排（startup warmup）=================
const WARMUP_DELAY_MS = 2200      // 等首屏（React 挂载 + 亚克力底衬）稳定后再彩排，否则测不准
const WARMUP_TIMEOUT_MS = 4200    // 兜底：渲染进程没回话也必须收尾，绝不能让热键一直失效
const WARMUP_OPACITY = 0.01       // 不能是 0：完全透明时合成器可能整帧跳过，那就白彩排了

let startupWarmupDone = false
let startupWarmupRunning = false
let startupWarmupTimer = null
/** 快捷键总闸：**从主进程就绪那一刻**就关上，直到彩排收尾才打开。
 *  用户要求："从启动到光边彩排完成前禁止任何快捷键"。
 *  ⚠ 原来只挡 `startupWarmupRunning`（真正在跑动画的那 ~4.2s），于是启动后**等待彩排开始的
 *    那 2.2s 是放行的** —— 那一下按下去会与彩排抢窗口 / 抢鼠标（show/hide、鼠标接管互相打架），
 *    正是这次要堵住的窗口。
 *  ⚠ 任何"彩排不会跑"的提前返回分支都必须把它打开；另外 ready-to-show 里还有一道兜底定时器，
 *    确保它绝不会永久关着（否则快捷键整段会话失效，且用户毫无反馈）。 */
let shortcutGateClosed = true

/** 唤醒请求的统一闸门：彩排窗口期内忽略一切唤醒 / 快捷键。
 *  ⚠ 以后**任何**新增的唤醒入口（托盘/通知区、快捷键、IPC、外部消息…）
 *    都必须先在这里问一句，否则会和彩排互相打架。 */
function wakeBlockedByWarmup(source) {
  if (!shortcutGateClosed) return false
  console.log(`[warmup] 启动彩排期间（含开始前的等待）→ 忽略：${source}`)
  return true
}

function finishStartupWarmup() {
  if (startupWarmupTimer) { clearTimeout(startupWarmupTimer); startupWarmupTimer = null }
  // ⚠ 闸门**先**开：不管这次彩排是否真的跑过（提前返回 / 超时兜底 / 渲染进程回报），
  //   走到这里就必须放行快捷键。
  shortcutGateClosed = false
  if (!startupWarmupRunning) return
  // 复现 hideOverlay 的复位纪律：不透明度、鼠标、隐藏，顺序不变
  overlayWindow?.setOpacity?.(1)
  setOverlayTakeMouse(false)
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    // ⚠ 这里必须把"正有别的流程在用这层窗"也算进去。
    //   彩排是在启动后约十秒内跑完的，用户完全可能这段时间里就划了词 —— 书写辅助
    //   刚把窗口显示出来，彩排收尾这一下就会把它藏掉：标签看着还在（渲染层仍在会话里），
    //   窗口却不可见、点击全部穿透。用户报的"有时点不动"里就有它。
    if (!isAwake && !writingModeActive && !visualModeActive) overlayWindow.hide()
  }
  startupWarmupRunning = false
  console.log('[warmup] 启动彩排结束，唤醒入口已恢复')
}

function beginStartupWarmup() {
  // ⚠ 以下每一条提前返回都意味着"这次彩排不会跑" ⇒ 必须把快捷键闸门放开（见 shortcutGateClosed）
  if (process.env.DONY_NO_WARMUP) {
    console.log('[warmup] 已被 DONY_NO_WARMUP 关闭'); shortcutGateClosed = false; return
  }
  if (startupWarmupDone || startupWarmupRunning) return
  if (!overlayWindow || overlayWindow.isDestroyed()) { shortcutGateClosed = false; return }
  if (isAwake || overlayWindow.isVisible()) { shortcutGateClosed = false; return }   // 用户已经在用了：不抢
  startupWarmupDone = true
  startupWarmupRunning = true
  console.log('[warmup] 开始启动彩排：真显示但不可见，完整跑一遍光斑 + 光边')
  // 先做"不抢焦点、不吃鼠标"的准备，再显示 —— 顺序反了会有极短一瞬间抢焦点
  setOverlayTakeMouse(false)
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.setOpacity(WARMUP_OPACITY)
  overlayWindow.showInactive()
  overlayWindow.webContents.send('warmup')
  startupWarmupTimer = setTimeout(finishStartupWarmup, WARMUP_TIMEOUT_MS)
}

// 每次唤醒都恢复"全屏置顶 + 接收鼠标"，以弥补 open-external 时的临时让位
function restoreOverlayTop() {
  if (!overlayWindow) return
  // 差量：已经置顶就不重复调用。setAlwaysOnTop 会让 Windows 重建窗口扩展样式，
  // 一方面可能把 WS_EX_TOOLWINDOW（不进任务栏）冲掉，另一方面会与我们刚设好的
  // 鼠标接管状态打架（表现是"鼠标在标签上却点不动"，且只在第一次之后出现）。
  if (!overlayWindow.isAlwaysOnTop()) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
  // 确认态用过的小窗尺寸在这里恢复成全屏：此刻窗口还藏着，改尺寸不会被看见。
  // （放在 hideOverlay 里做不行：hide() 与 setBounds() 都是异步消息，
  //   setBounds 可能先落地，于是还带着确认态界面的窗口会在左上角闪一下。）
  overlayWindow.setBounds(getFullBounds())
  raiseAlarmWindows()   // 覆盖层刚被抬到最上层，闹钟/计时器窗口要跟着再抬一次
}

/** 把闹钟/计时器窗口再抬到最上层。
    覆盖层是一整块全屏置顶的透明窗：它一旦被重新抬到最上，右下角计时器卡片就变成
    "看得见、点不到"（点击全被覆盖层吃掉）——所以每次覆盖层置顶之后都要再抬一次。 */
function raiseAlarmWindows() {
  for (const win of [timerFloatWindow, alarmTopWindow]) {
    if (!win || win.isDestroyed()) continue
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } catch (err) {
      // 窗口正在销毁时忽略
    }
  }
}

// ---------- 视觉智能确认后的窗口形态 ----------
// 确认选择后把覆盖层当成一个普通窗口：缩小到只包住输入框与回答框、取消置顶、不接管鼠标。
// 这样它可以正常获得/失去焦点、可以被其它窗口遮挡，也不会再抢焦点或压住任务栏。
const CONFIRM_PAD = 72

function getFullBounds() {
  return screen.getPrimaryDisplay().bounds
}

/** 统一切换覆盖层的可聚焦状态（执行期间不可聚焦，需要用户输入时才允许）。
    聚焦/失焦都会牵连 Windows 的焦点行为，所以集中在一处，并做差量判断。 */
function setOverlayFocusable(focusable) {
  if (!overlayWindow) return
  try {
    if (overlayWindow.isFocusable() === focusable) return
    overlayWindow.setFocusable(focusable)
    // ⚠ 这里**不要**补 setSkipTaskbar：本函数由"鼠标移入移出内容区"高频触发，
    //   改任务栏样式会让系统重建按钮 → 卡顿。补刀统一放在低频时机（见 reappearGuard）。
    if (!focusable && overlayWindow.isFocused()) overlayWindow.blur()
  } catch (err) {
    console.warn('[vis] 切换可聚焦状态失败', err)
  }
}

function applyVisualWindowMode(collapsed) {
  if (!overlayWindow) return
  if (collapsed) {
    overlayWindow.setAlwaysOnTop(false)
    // setAlwaysOnTop 会重建窗口扩展样式（可能把 TOOLWINDOW 冲掉）→ 重设一次；
    // 顺带换成视觉智能的图标（低频操作，setOverlayIcon 内部会跳过重复设置）。
    applyToolWindowStyle()
    setOverlayIcon(VISUAL_ICON)
  } else {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    applyToolWindowStyle()
    setOverlayIcon(DONY_ICON)
    // 这里不再恢复全屏：退出确认态几乎总是紧跟着 hideOverlay()，
    // 立刻 setBounds 会让还挂着确认态界面的窗口在左上角闪一下。
    // 尺寸统一由 hideOverlay() 在窗口隐藏之后恢复。
  }
}

function setVisualWindowRect(rect) {
  if (!overlayWindow || !rect) return
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  const width = Math.max(200, Math.round(rect.width))
  const height = Math.max(140, Math.round(rect.height))
  const cur = overlayWindow.getBounds()
  if (cur.x !== x || cur.y !== y || cur.width !== width || cur.height !== height) {
    console.log('[vis] setBounds', JSON.stringify({ x, y, width, height }))
    overlayWindow.setBounds({ x, y, width, height })
  }
}

function hideOverlay() {
  if (!overlayWindow) return
  console.log('[vis] hideOverlay')
  // 按住计时尚未结束时界面被隐藏：必须清掉定时器，
  // 否则 500ms 后它还会把已经关掉的界面再“唤醒”一次（幽灵唤醒），
  // 同时残留的定时器会让下一次 Alt+D 被当成“已在按住中”而直接忽略。
  if (wakeHoldTimer) { clearTimeout(wakeHoldTimer); wakeHoldTimer = null }
  if (voiceHoldTimer) { clearTimeout(voiceHoldTimer); voiceHoldTimer = null }
  if (overlayFadeTimer) { clearInterval(overlayFadeTimer); overlayFadeTimer = null }
  isAwake = false; leaveVisualMode(); leaveWritingMode()
  clearTimeout(awakeSafetyTimer); contentForcedPassthrough = false
  // 先释放焦点、让界面复位，然后隐藏窗口。
  // 尺寸恢复一律交给 restoreOverlayTop()（下次唤醒、窗口还藏着时执行），
  // 这里绝不能动 bounds：hide() 与 setBounds() 都是异步消息，setBounds 可能先落地，
  // 于是还挂着确认态界面的窗口会在屏幕左上角闪一下。
  setOverlayTakeMouse(false)
  overlayWindow.blur()
  overlayWindow.webContents.send('reset')
  // 这 250ms 是留给"界面复位"的观感。但书写辅助是**被动触发**的：
  // 用户完全可能就在这 250ms 内又划了一段字进来，那时这里的 hide() 会把
  // 刚显示出来的标签连同窗口一起藏掉。记下进入代次，之后只要进入过书写辅助就整块跳过。
  const hideGen = writingGen
  setTimeout(() => {
    if (!overlayWindow) return
    if (writingGen !== hideGen) {
      console.log('[writing] 延迟收窗已作废：期间进入了书写辅助')
      return
    }
    overlayWindow.hide()
    // 复位，免得下次显示时还停在渐显过程中的某个不透明度
    overlayWindow.setOpacity(1)
    overlayWindow.setIgnoreMouseEvents(false)
  }, 120)
}

// isAwake 表示“本轮已经唤醒”。它原本只由 hideOverlay() 与 30s 兜底清零：
// 一旦界面被隐藏而标记没清，快捷键就会长期“按了没反应”且没有任何反馈。
// 这里改成以“窗口是否真的可见”为准，残留标记直接按未唤醒处理并顺手修正。
function isAlreadyAwake() {
  if (!isAwake) return false
  // 视觉智能期间直接判定为"已唤醒"：它的 overlayState 恒为 idle，
  // 若走下面那条规则，每次按键都会把标记清掉，随后的一次按键就会重新唤醒。
  // ⚠ 放在 isAwake 判断之后：30 秒兜底把 isAwake 置 false 后，这里不再拦截，
  //   保持原有的"不会永久锁死快捷键"这条底线。
  if (visualModeActive) return true
  if (overlayState === 'idle' || !contentVisible) {
    // 界面其实什么也没显示（例如语音模式下还没听到任何内容）：
    // 这种情况下把按键丢掉，用户看到的就是“按了没反应”，所以按未唤醒处理。
    console.warn(`[hotkey] 已唤醒但界面无内容（state=${overlayState}），按未唤醒处理`)
    isAwake = false; clearTimeout(awakeSafetyTimer)
    return false
  }
  if (overlayWindow && !overlayWindow.isVisible()) {
    console.warn('[hotkey] 已唤醒标记残留但窗口已隐藏，按未唤醒处理')
    isAwake = false; clearTimeout(awakeSafetyTimer)
    return false
  }
  return true
}

/** 唤醒请求的第二道统一闸门：界面已经醒着时，忽略重复唤醒。
 *  这一道覆盖所有唤醒入口；按住类快捷键在各自的 start*Hold 里还保留了更早的同义判断，
 *  原因见那里的注释（必须在计时阶段就挡住，否则会先显示窗口并接管鼠标）。
 *  语音追问是唯一例外：醒着且停在追问态时，Alt+D 用于继续说话，见 startVoiceHold。 */
function wakeBlockedByAlreadyAwake(source) {
  if (!isAlreadyAwake()) return false
  console.log(`[hotkey] ${source} 忽略：界面已经醒着（${overlayState}）`)
  return true
}

function startWakeHold() {
  if (!overlayWindow) return
  // 闸门必须挂在这里，不能只挂在 wakeOverlay：按住计时一开始就会显示窗口并接管鼠标，
  // 那已经与启动预加载冲突（只是还没走到 wakeOverlay 那一步）。
  if (wakeBlockedByWarmup('Alt+Space 按住')) return
  if (wakeHoldTimer) { console.log('[hotkey] Alt+Space 忽略：本轮按住计时中'); return }
  if (wakeBlockedByAlreadyAwake('Alt+Space 按住')) return
  console.log('[hotkey] Alt+Space 按下 → 按住计时 500ms')
  restoreOverlayTop(); overlayWindow.show(); setOverlayTakeMouse(true); overlayWindow.focus()
  overlayWindow.webContents.send('wake-hold')
  wakeHoldTimer = setTimeout(() => {
    wakeHoldTimer = null; console.log('[hotkey] Alt+Space 按住达成 → 打字唤醒'); wakeOverlay()
  }, 500)
}

function cancelWakeHold() {
  if (wakeHoldTimer) { clearTimeout(wakeHoldTimer); wakeHoldTimer = null; hideOverlay() }
}

const VOICE_HOLD_MS = 300       // Alt+D 的按住时长门槛（原来 500ms，太容易差一点）

function startVoiceHold() {
  if (!overlayWindow) return
  // 同 startWakeHold：闸门要在计时阶段就挡住
  if (wakeBlockedByWarmup('Alt+D 按住')) return
  if (voiceHoldTimer) { console.log('[hotkey] Alt+D 忽略：本轮按住计时中'); return }
  // 界面已经醒着时，Alt+D 的语义是"继续追问"，等同于点按「继续对话」按钮（语音追问能力保留）。
  // 两处约定：
  //   只在 overlayState === 'followUp' 时转发；其余已唤醒状态一律无反应。
  //   此步按点按处理，不设按住门槛：该门槛用于防止误触唤醒，而"继续追问"是一次明确动作，
  //   再要求按住会表现为"按了没有反应"。
  // 是否真正开始收音由渲染进程判定（按钮未显示则忽略），主进程不承担该项判断。
  if (isAlreadyAwake()) {
    if (overlayState === 'followUp') {
      console.log('[hotkey] Alt+D（界面已醒着·追问中）→ 转发"继续追问"')
      overlayWindow.webContents.send('voice-continue')
    } else {
      console.log(`[hotkey] Alt+D 忽略：界面已经醒着（${overlayState}）`)
    }
    return
  }
  // 门槛从 500ms 降到 300ms：实测 500ms 太容易"差一点"，
  // 用户快速点按会走 cancelVoiceHold → 静默取消，表现就是"按好几次都没反应"。
  console.log(`[hotkey] Alt+D 按下 → 按住计时 ${VOICE_HOLD_MS}ms`)
  restoreOverlayTop(); overlayWindow.show(); setOverlayTakeMouse(true); overlayWindow.focus()
  overlayWindow.webContents.send('voice-hold')
  voiceHoldTimer = setTimeout(() => {
    voiceHoldTimer = null; console.log('[hotkey] Alt+D 按住达成 → 语音唤醒'); voiceWakeOverlay()
  }, VOICE_HOLD_MS)
}

function cancelVoiceHold() {
  // 提前松开也要留痕：原来这里是静默取消，出问题时日志里什么都看不到。
  if (voiceHoldTimer) {
    clearTimeout(voiceHoldTimer); voiceHoldTimer = null
    console.log('[hotkey] Alt+D 提前松开 → 取消（要按住不放）')
    hideOverlay()
  }
}

function tryRegisterShortcuts() {
  if (globalShortcut.register('Alt+Space', startWakeHold)) { console.log('[OK] Alt+Space (typing)'); return }
  if (globalShortcut.register('CommandOrControl+Shift+Space', startWakeHold)) { console.log('[OK] Ctrl+Shift+Space'); return }
  if (globalShortcut.register('CommandOrControl+Alt+Space', startWakeHold)) { console.log('[OK] Ctrl+Alt+Space'); return }
  console.error('[FATAL] No shortcut available.')
}

// Windows 的全局热键是独占的：Alt+D 被其它程序（远控/截图/输入法等）占着时注册会失败，
// 且只在启动那一刻试一次——于是这个快捷键会整段会话都“按了没反应”。
// 这里在失败后周期性重试，占用方退出后自动恢复。
const shortcutRetry = { voice: 0, visual: 0 }
// 重试节奏：开场快、之后慢。
// 原来固定 10 秒一次，实测的后果就是「主程序刚开，按好几次 Alt+D 都没反应」——
// 那一刻上一个实例（或别的程序）还占着这个组合键，而我们要等满 10 秒才再试一次。
const SHORTCUT_FAST_RETRY_MS = 600
const SHORTCUT_FAST_TRIES = 20   // 前 20 次每 0.6 秒试一次（约 12 秒内解决绝大多数抢占）
const SHORTCUT_RETRY_MS = 5000   // 之后每 5 秒一次
const SHORTCUT_MAX_RETRY = 120   // 最多重试约 10 分钟，之后只留一条提示

function scheduleShortcutRetry(which) {
  if (which === 'voice' && !globalShortcut.isRegistered('Alt+D')) {
    if (shortcutRetry.voice >= SHORTCUT_MAX_RETRY) return
    shortcutRetry.voice += 1
  } else if (which === 'visual' && !globalShortcut.isRegistered('Alt+V')) {
    if (shortcutRetry.visual >= SHORTCUT_MAX_RETRY) return
    shortcutRetry.visual += 1
  } else {
    return   // 已经拿到了
  }
  const attempts = which === 'voice' ? shortcutRetry.voice : shortcutRetry.visual
  const delay = attempts <= SHORTCUT_FAST_TRIES ? SHORTCUT_FAST_RETRY_MS : SHORTCUT_RETRY_MS
  setTimeout(() => {
    const ok = which === 'voice' ? registerVoiceShortcut() : registerVisualShortcut()
    if (!ok) scheduleShortcutRetry(which)
    else console.log(`[OK] ${which === 'voice' ? 'Alt+D' : 'Alt+V'} 重试成功`
                     + `（第 ${which === 'voice' ? shortcutRetry.voice : shortcutRetry.visual} 次，`
                     + `共等了约 ${Math.round(attempts * SHORTCUT_FAST_RETRY_MS / 100) / 10} 秒）`)
  }, delay)
}

function registerVoiceShortcut() {
  if (globalShortcut.register('Alt+D', startVoiceHold)) { console.log('[OK] Alt+D hold (voice)'); return true }
  console.warn('[WARN] Alt+D 被其它程序占用，10 秒后重试；对方退出后会自动恢复')
  scheduleShortcutRetry('voice')
  return false
}

let overlayFadeTimer = null

// 用窗口自身的不透明度做渐显。
// Windows 对一个"从隐藏变为显示"的窗口会套一层系统动画，观感就是"弹入"；
// 先把窗口以完全透明的状态显示，再由自己把不透明度推到 1，系统就不介入，
// 画面于是变成纯粹的渐显（内容是透明的，所以只有遮罩自己在变浓）。
function fadeInOverlay(ms = 220) {
  if (!overlayWindow) return
  if (overlayFadeTimer) { clearInterval(overlayFadeTimer); overlayFadeTimer = null }
  const steps = 12
  let i = 0
  overlayFadeTimer = setInterval(() => {
    if (!overlayWindow) { clearInterval(overlayFadeTimer); overlayFadeTimer = null; return }
    i += 1
    overlayWindow.setOpacity(Math.min(1, i / steps))
    if (i >= steps) { clearInterval(overlayFadeTimer); overlayFadeTimer = null }
  }, Math.max(8, Math.round(ms / steps)))
}

let visualLastWakeAt = 0
const VISUAL_DEBOUNCE_MS = 1200

// ================= 视觉智能的 Esc 退出 =================
// 渲染进程里本来就有 Esc 处理（VisualOverlay 监听 window 的 keydown），但它只在窗口
// **有键盘焦点**时才收得到按键。视觉智能按设计不抢焦点（showInactive 唤醒），确认阶段
// 光标离开面板时还会整体放行鼠标并 setOverlayFocusable(false) + blur()；而"把焦点还回来"
// 的逻辑只对 overlayState 为 followUp/asking 生效，视觉智能的状态恒为 idle，永远不会命中。
// 结果是窗口未聚焦时按 Esc 没有任何反应。这里在视觉智能期间挂一个全局 Esc，收到后转发给
// 渲染进程，与直接按 Esc 走同一条退出路径（VisualOverlay 的 onClose）。
function registerVisualEscape() {
  if (visualEscapeRegistered) return
  try {
    visualEscapeRegistered = globalShortcut.register('Escape', () => {
      if (!visualModeActive || !overlayWindow) return
      console.log('[hotkey] Esc（视觉智能）→ 退出视觉智能')
      overlayWindow.webContents.send('visual-escape')
    })
    console.log(visualEscapeRegistered ? '[OK] Escape (visual)' : '[WARN] Escape 被其它程序占用，视觉智能只能靠窗口聚焦时的 Esc')
  } catch (err) {
    visualEscapeRegistered = false
    console.warn('[WARN] 注册 Escape 失败', err)
  }
}

function unregisterVisualEscape() {
  if (!visualEscapeRegistered) return
  try { globalShortcut.unregister('Escape') } catch (_err) { /* 忽略 */ }
  visualEscapeRegistered = false
}

/** 离开视觉智能：清标记并注销 Esc。收窗、以及被别的唤醒方式接管时都要走这里。 */
function leaveVisualMode() {
  visualModeActive = false
  unregisterVisualEscape()
}

// ================= 书写辅助（选区改写）=================
// 与前两种模式并列的第三种：由后端（Python 侧的选区监听）触发，不经过快捷键。
// 它复用同一扇全屏覆盖层，但有两条硬约束：
//   · **不抢焦点** —— 一旦抢走，目标程序里那份选区连同"第一个字的位置"就没了，
//     替换阶段也无从粘贴；所以一律 showInactive + setOverlayFocusable(false)。
//   · **不接管整屏鼠标** —— 用户是在别人的软件里选字，其余位置必须照常可点。
//     所以窗口级穿透默认打开，只在指针压到书写元素上时短暂接管（渲染进程实时上报 hover）。
function enterWritingMode() {
  if (!overlayWindow) return
  // 代次 +1：作废上一轮排下的"延迟收窗"（否则收窗回调会把刚显示出来的书写界面又藏掉）
  writingGen += 1
  const wasActive = writingModeActive
  writingModeActive = true
  // 上一次会话留下的"idle 自动收窗"定时器必须掐掉，否则 1.5 秒后窗口会自己收起来
  clearTimeout(idleHideTimer); idleHideTimer = null
  restoreOverlayTop()
  // ⚠ 这里**不要**调 applyToolWindowStyle()：它是异步 PowerShell，会读改写 GWL_EXSTYLE
  //   并 SetWindowPos。若它在用户点标签前后才落地，就会把我们刚设好的
  //   "接管鼠标"（清掉 WS_EX_TRANSPARENT）又覆盖回穿透 ——
  //   表现为"鼠标明明在标签上却点不动，而且只有第一次能用"（首次脚本还没编译完）。
  //   窗口创建时已经压过一次任务栏样式，restoreOverlayTop 现在也不再重建扩展样式，
  //   所以这里不需要重压。
  overlayWindow.setOpacity(1)
  overlayWindow.showInactive()
  setOverlayFocusable(false)
  // 鼠标交给主进程自己的轮询：指针落在"书写元素矩形"里才接管，其余位置一律放行。
  // 刚进入时指针位置未知，先按不放行处理。
  overlayWantMouse = true
  overlayHovering = false
  // 书写模式自己的判定从零开始：指针位置未知，先按"不在界面上"（放行鼠标）
  writingOver = false
  writingSuppress = false
  writingFocusWanted = false
  writingNear = false
  writingPollTicks = 0
  writingAliveAt = Date.now()   // 看门狗从这个时刻开始算
  applyOverlayMouse()
  startWritingMousePoll()
  console.log(`[writing] 进入书写辅助模式（代次 ${writingGen}${wasActive ? '，重复进入' : ''}）`)
}

function leaveWritingMode() {
  if (!writingModeActive) return
  writingModeActive = false
  stopWritingMousePoll()
  console.log('[writing] 退出书写辅助模式')
  // ⚠ 视觉智能已经接手时，鼠标与焦点归它管，这里一律不动。
  // 真实场景：书写辅助开着的时候用户按了 Alt+V —— 视觉智能那边刚 setOverlayTakeMouse(true)
  // 准备框选，我们再"顺手放行鼠标"就会把它关掉，表现就是"视觉智能里框选没反应"。
  if (visualModeActive) return
  // ⚠ Dony 正醒着时，书写辅助只是"临时借用"这层窗：退出时必须把「接管鼠标 + 可聚焦」
  //   还回去。原来这里无条件关掉两者，后果是——用过一次划词之后，Dony 界面整块穿透，
  //   点不动、Esc 也关不掉（键盘焦点同样被关掉了），只有重启进程才能恢复。
  //   只有"没在 Dony 会话里"（纯划词场景）才应该把鼠标放行。
  if (inDonySession()) {
    setOverlayTakeMouse(true)
    setOverlayFocusable(overlayState !== 'loading')
    return
  }
  // 只放行鼠标、不动窗口显隐：窗口的收放由渲染进程在流程结束时自己决定
  //（它会走 hideOverlay()，那里同样会 leaveWritingMode 一次）
  setOverlayTakeMouse(false)
  setOverlayFocusable(false)
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  }
}

/** 书写界面还在，但主进程这边已经不在书写模式（或窗口被藏了）：补回来。
 *
 *  这是"两边状态自愈"的唯一入口，由两条互相独立的信号驱动：
 *    · 存活心跳（每 500ms，与有没有可交互区域无关）
 *    · 可交互区域上报（一到就来，延迟最小）
 *  任何"主进程标记丢了、渲染层却还活着"的路径都能被它兜住，不需要知道是哪条路径干的。
 */
function ensureWritingMode(reason) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // 视觉智能与 Dony 会话进行中不抢：那两种模式下鼠标与焦点归它们管。
  if (visualModeActive || isAwake) return
  // 渲染层刚显式说过"退出"：这 800ms 内不吃这两条信号 ——
  // 否则会把刚结束的会话又补回来（窗口重新显示、收窗也被作废）。
  // 渲染层退出时会在同一帧停掉心跳，所以这个窗口并不影响真正的自愈。
  if (Date.now() - writingExplicitExitAt < 800) return
  if (writingModeActive && overlayWindow.isVisible()) return
  // 日志区分两种情况：标记丢了 vs 窗口被藏了。二者以前混在一句话里，
  // 排查时极易误判成"标记丢了"（实际这次是窗口被启动彩排的收尾藏掉了）。
  const what = writingModeActive ? '窗口被藏了' : '已不在书写模式'
  console.log(`[writing] ${reason}（${what}）→ 补进书写辅助模式`)
  enterWritingMode()
}

// ---- 书写辅助的鼠标接管：由主进程自己轮询指针位置 ----
// 为什么不用"渲染层 mousemove → elementFromPoint → IPC 上报 hover"那条链路：
// 它在真实环境里太脆（用户实测"标签看得见、点上去毫无反应"，而且只有第一次能用），
// 而窗口级 ignoreMouseEvents 是**二元**的 —— 只要没接管，元素就完全点不动。
// 现在只剩一条链路：渲染层上报"需要接管的矩形" → 主进程每 60ms 看指针是否落在其中。
let writingHitRects = []
/** "靠近锚点"的判定区（渲染层无条件上报，与指针事件无关）：指针落在其中就该显示标签 */
let writingZone = null
/** 上一次回推给渲染层的"靠近"状态 */
let writingNear = false
let writingPollTimer = null
/** 指针此刻是否落在书写界面上。书写辅助期间的鼠标接管**只认它**（见 wantsMouseNow） */
let writingOver = false
/** "按下降在界面之外"时为真：暂停接管，直到渲染层上报新的接管区域（新一轮会话）。 */
let writingSuppress = false
/** 是否**有意**让覆盖层拿键盘焦点（只有"点进描述修改输入框"这一种情况）。 */
let writingFocusWanted = false
let writingPollTicks = 0
/** 进入书写辅助的代次：用来作废"上一轮排好的延迟收窗"（见 hideOverlay） */
let writingGen = 0
/** 渲染层最近一次**显式**退出书写辅助的时刻（存活信标据此忽略退出后残留的那几拍） */
let writingExplicitExitAt = 0
/** 上一次打印"状态快照"的时刻（每 2 秒一行，用于定位"点不动"到底断在哪一环） */
let writingSnapshotAt = 0
/** 上一次快照的内容：一模一样就不重复打印（排查时一屏 30 行相同内容没法看） */
let writingSnapshotLast = ''
/** 渲染层存活心跳的最近时刻 + 上次告警时刻（见 evaluateWritingHover 的看门狗） */
let writingAliveAt = 0
let writingAliveWarnAt = 0

function pointInRect(p, r) {
  return !!r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** 接管判定用的小外扩（DIP）。

    点的就是卡片边缘、或"菜单卸载 → 横框挂载"这类相位切换的一两帧缝隙里，
    指针与卡片只差几像素；不外扩的话判定会判"不在界面上"，那一下点击就穿透了。
    外扩很小（8px），不会影响到"点卡片旁边底下那个程序"的正常使用。 */
const WRITING_HIT_PAD = 2
/**
 * 已经在界面上的"迟滞"距离与宽限时间。
 *
 * 为什么必需：接管是二元的（要么接管、要么放行），而指针在卡片边缘会来回抖 ——
 * 实测日志里是 "接管=true → 一帧后 false → 标签隐藏" 这样反复翻转，
 * 用户点下去时大多落在"已放行"的那一侧，于是点击直接穿透（"首次都点不到"）。
 * 进来时用小的热区（灵敏），已经在界面上时用大的判定+宽限（不轻易放手）。
 */
const WRITING_KEEP_PAD = 6
const WRITING_KEEP_MS = 120
let writingOverUntil = 0

function pointNearWritingRects(p, pad) {
  for (const r of writingHitRects) {
    if (pointInRect(p, {
      x: r.x - pad,
      y: r.y - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    })) return true
  }
  return false
}

/** 指针是否落在书写元素上（带迟滞，见上面的说明） */
function computeWritingOver(p) {
  if (pointNearWritingRects(p, WRITING_HIT_PAD)) {
    writingOverUntil = Date.now() + WRITING_KEEP_MS
    return true
  }
  if (writingOverUntil > Date.now() && pointNearWritingRects(p, WRITING_KEEP_PAD)) {
    return true
  }
  return false
}

/** 带毫秒的时间戳：排查"点击与状态翻转谁先谁后"时，秒级精度不够用 */
function ts() {
  const d = new Date()
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 判定一次"指针是否在书写界面上"并应用鼠标状态。
    除了 60ms 的轮询，渲染层**一上报新区域就立刻叫一次**（见 writing-hit-rects）：
    用户把指针移到标签上到点下去往往只有一两百毫秒，等下一个轮询节拍会把这一段
    全部落在"还没接管"的窗口里 —— 点下去就穿透了（这一下正是"点不动"的高发时刻）。 */
function evaluateWritingHover() {
  if (!writingModeActive || !overlayWindow || overlayWindow.isDestroyed()) return
  // 渲染层上报的是**窗口内**坐标（getBoundingClientRect），指针是**屏幕**坐标，
  // 两者差一个窗口原点 —— 主屏不在虚拟桌面原点时必须补上，否则判定会整体偏移。
  const bounds = overlayWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const p = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
  const over = computeWritingOver(p)
  // 靠近判定：指针落在"锚点外扩区"里就回推"显示标签"。
  // 这是标签显隐的唯一来源 —— 不依赖渲染层能否收到 mousemove（那条链路不可靠：
  // 窗口的鼠标穿透/转发状态一变、或指针由程序移动，事件就不进来，
  // 表现是"标签不出现/看得见却点不动"，而且日志里一行都没有）。
  // over ⇒ 指针此刻就压在我们的元素上（或紧邻），那么标签**必须**还显示着：
  // 否则会出现"接管中却点了空气"（标签已因离得稍远而隐藏，pointer-events 变 none）。
  const near = over || pointInRect(p, writingZone)
  if (near !== writingNear) {
    writingNear = near
    try { overlayWindow.webContents.send('writing-near', near) } catch { /* 窗口正在销毁 */ }
    console.log(`${ts()} [writing] 指针靠近锚点=${near} → 标签${near ? '显示' : '隐藏'}`)
  }
  writingPollTicks += 1
  if (over !== writingOver) {
    writingOver = over
    writingPollTicks = 0
    applyOverlayMouse()
    console.log(`${ts()} [writing] 指针在书写元素上=${over} → 覆盖层接管鼠标=${over}（${writingHitRects.length} 块区域）`)
    return
  }
  // 已经在界面上：每 ~240ms 再推一次"接管鼠标"。
  // 必须是周期性推、不能只在变化时推：setIgnoreMouseEvents 还会被**别的**路径写
  // （收窗的延迟回调、异步 PowerShell 样式修正、系统重建扩展样式…），
  // 而那些路径不会改我们的 writingOver，于是"只在变化时推"就永远补不回来 ——
  // 表现就是点击一直失效，且触发过一次后每次都失效。
  // ⚠ 这里原来有一段"周期性重推接管"（over 时每 ~240ms 再 setIgnoreMouseEvents(false)）。
  //   书写模式现在永不接管（见 wantsMouseNow），这段必须一起去掉 ——
  //   留着它等于绕过判定把整窗又变成"吃点击"，那正是整屏点死的来源。
  // 渲染层心跳看门狗：书写模式还在，但渲染层已经 >2 秒没发心跳 ⇒ 它的 JS 卡住了。
  // 那种状态下点击不会有任何反应，日志里连 [wr] mousedown 都不会有 ——
  // 必须能和"窗口收不到点击"区分开，否则只能靠猜。
  if (writingModeActive && writingAliveAt) {
    const gap = Date.now() - writingAliveAt
    if (gap > 2000 && Date.now() - writingAliveWarnAt > 3000) {
      writingAliveWarnAt = Date.now()
      console.log(`[writing] 渲染层心跳中断 ${(gap / 1000).toFixed(1)}s → 界面 JS 可能卡死`)
    }
  }

  // 状态快照（每 ~2s 一行）。下一次出现"点不动"时，这一行就能区分到底断在哪一环：
  // 窗口被藏了 / 指针判定没进去 / 区域没上报 / 鼠标没接管。
  const nowMs = Date.now()
  if (nowMs - writingSnapshotAt > 2000) {
    writingSnapshotAt = nowMs
    const b = overlayWindow.getBounds()
    const snap = `${ts()} [writing] 状态快照 模式=${writingModeActive} 指针在界面上=${writingOver}`
      + ` 接管鼠标=${wantsMouseNow()} 区域=${writingHitRects.length}`
      + ` 窗口可见=${overlayWindow.isVisible()} 置顶=${overlayWindow.isAlwaysOnTop()}`
      + ` 不透明度=${overlayWindow.getOpacity().toFixed(2)}`
      + ` 原点=${Math.round(b.x)},${Math.round(b.y)}`
      + ` 尺寸=${Math.round(b.width)}x${Math.round(b.height)}`
      + ` 聚焦=${overlayWindow.isFocused()}`
    // 内容没变就不打（否则一次会话能刷出几十行一模一样的东西）
    if (snap !== writingSnapshotLast) {
      writingSnapshotLast = snap
      console.log(snap)
    }
  }
}

function startWritingMousePoll() {
  if (writingPollTimer) return
  // 30ms：用户从"指针移到卡片上"到"按下去"往往不到 200ms，节拍越慢越容易踩空
  writingPollTimer = setInterval(evaluateWritingHover, 30)
}

function stopWritingMousePoll() {
  if (writingPollTimer) { clearInterval(writingPollTimer); writingPollTimer = null }
  writingHitRects = []
  writingZone = null
  writingOver = false
  writingNear = false
  writingOverUntil = 0     // 迟滞的宽限不能跨会话残留
  writingPollTicks = 0
}

function visualWakeOverlay() {
  if (!overlayWindow) return
  if (wakeBlockedByWarmup('视觉智能 Alt+V')) return
  // 界面已醒着（含视觉智能正在显示）时忽略：原先只有 1.2 秒去抖，
  // 去抖窗口之外连按会重放渐显与唤醒动画（观感是闪烁）。
  if (wakeBlockedByAlreadyAwake('视觉智能 Alt+V')) return
  // 保留去抖作为第二道保护：覆盖"窗口刚收起、唤醒标记已清"的那一小段时间，
  // 避免紧接着再按立刻重新渐显。
  const now = Date.now()
  if (now - visualLastWakeAt < VISUAL_DEBOUNCE_MS) {
    console.log('[hotkey] Alt+V 忽略：刚刚已唤醒过（防重复点按）')
    return
  }
  visualLastWakeAt = now
  visualModeActive = true
  // Esc 兜底只在视觉智能期间挂着：退出即注销，避免这段时间以外抢占全系统的 Esc。
  registerVisualEscape()
  isAwake = true; armAwakeSafetyTimer(true)
  // showInactive：视觉智能唤醒时不抢系统焦点，任务栏/其它窗口的焦点不受影响
  restoreOverlayTop(); overlayWindow.setBounds(getFullBounds())
  // 先置为全透明再显示，然后自己渐显，避免系统那一下"弹入"
  overlayWindow.setOpacity(0)
  overlayWindow.showInactive(); setOverlayTakeMouse(true)
  // 视觉面板是要用户点、要打字的：这里必须**明确**把"可聚焦 + 接管鼠标"补回来。
  // 书写辅助退出时会刻意关掉这两样（它不能抢焦点，否则目标程序里的选区就没了），
  // 用户实测的症状正是"用过一次书写辅助之后，视觉智能的面板怎么点都没反应"。
  setOverlayFocusable(true)
  setMousePassthrough(overlayWindow, false)
  fadeInOverlay()
  overlayWindow.webContents.send('visual-wake')
}

function registerVisualShortcut() {
  if (globalShortcut.register('Alt+V', visualWakeOverlay)) {
    console.log('[OK] Alt+V (visual)'); return true
  }
  console.warn('[WARN] Alt+V 被其它程序占用，10 秒后重试')
  scheduleShortcutRetry('visual')
  return false
}

async function startVoiceServer() {
  if (await isPortInUse(8766)) {
    console.log('[voice-server] 8766 已有实例在运行，跳过启动')
    return
  }
  try {
    voiceProcess = spawnService('voice', [path.join(__dirname, '..', 'backend', 'voice_server.py')])
    const startedAt = Date.now()
    voiceProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
    voiceProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
    voiceProcess.on('close', (c) => {
      console.log(`[voice-server] exited ${c}`)
      voiceProcess = null
      // 稳定跑过 30 秒就把重启计数清零，避免偶发崩溃累积到上限
      if (Date.now() - startedAt > 30000) voiceRestarts = 0
      scheduleVoiceRestart(c)
    })
    console.log('[voice-server] spawned')
  } catch (e) { console.warn('[voice-server] failed:', e.message) }
}

/** 语音服务异常退出后自动重启：否则语音会静默失效（界面亮着但说话没反应）。 */
function scheduleVoiceRestart(code) {
  if (quitting) return
  if (voiceRestarts >= 5) {
    console.error('[voice-server] 连续异常退出 5 次，停止重启（请查看上方日志）')
    return
  }
  voiceRestarts += 1
  const delay = 1000 * voiceRestarts
  console.warn(`[voice-server] ${delay}ms 后自动重启（第 ${voiceRestarts} 次，退出码 ${code}）`)
  setTimeout(() => { if (!quitting) startVoiceServer() }, delay)
}

function stopVoiceServer() { if (voiceProcess) { try { voiceProcess.kill() } catch {}; voiceProcess = null } }

// ---------- Dony Agent 服务（WS 8767） ----------
let agentProcess = null
let agentRestarts = 0

// 外部 Agent 模式：由 start.bat / start.ps1 先在独立窗口里起好 Agent（8767），
// Electron 只等待并使用，**不再抢占端口** —— 否则那份会被 taskkill 掉，
// 表现为"启动几秒就自己退出"的短命窗口。
// 直接跑 `npm run electron:dev`（不经启动脚本）时不设这个变量，行为保持原样：
// 端口被占则接管，保证日志可见、代码最新。
const AGENT_EXTERNAL = process.env.DONY_AGENT_EXTERNAL === '1'

/** 轮询等待端口进入监听；timeoutMs 内没起来返回 false。 */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return await isPortInUse(port)
}

/** 端口是否已有服务在监听（避免与启动脚本各起一份导致端口冲突报错） */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const net = require('net')
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v) => { try { sock.destroy() } catch {} ; resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    setTimeout(() => done(false), 800)
  })
}

/** 结束占用某端口的进程（用于"接管"上一轮遗留的后端）。 */
function killPortListener(port) {
  try {
    const { execSync } = require('child_process')
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(line)) continue
      const m = line.trim().match(/(\d+)$/)
      if (m) pids.add(m[1])
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
        console.log(`[agent-server] 接管端口 ${port}：已结束旧实例 pid=${pid}`)
      } catch { /* 忽略 */ }
    }
  } catch { /* findstr 没找到就是没占用 */ }
}

async function startAgentServer() {
  if (AGENT_EXTERNAL) {
    // 启动脚本已经在独立窗口里起了 Agent：只等它就绪，绝不杀它。
    console.log('[agent-server] 外部模式：等待启动脚本的 DonyAgent（8767）就绪…')
    if (await waitForPort(8767, 15000)) {
      console.log('[agent-server] 使用外部实例（DonyAgent 独立窗口），本进程不接管')
      return
    }
    // 等不到就退回自己拉起：宁可日志在 Electron 控制台，也不能让 Dony 没后端可用。
    console.warn('[agent-server] 外部实例 15s 内未就绪 → 改为自行启动')
  }
  if (await isPortInUse(8767)) {
    // ⚠ 以前这里是"跳过启动"，代价很隐蔽：上一轮遗留的后端进程会被继续使用，
    //   它的 stdout 挂在已经关闭的旧控制台上 —— 于是**后端日志整个消失**，
    //   而且磁盘上的新代码不会被加载（"改了不生效"的根源）。
    //   现在改为接管：结束旧实例，始终由本进程拉起一份，日志可见、代码最新。
    //   （外部模式下不会走到这里：上面的 waitForPort 成功就直接返回了。）
    console.log('[agent-server] 8767 已有实例在运行 → 接管（结束旧实例后再启动）')
    killPortListener(8767)
    await new Promise((r) => setTimeout(r, 700))
  }
  try {
    agentProcess = spawnService('agent', ['-m', 'backend.agent.agent_server'])
    agentProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
    agentProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
    const agentStartedAt = Date.now()
    agentProcess.on('close', (c) => {
      console.log(`[agent-server] exited ${c}`)
      agentProcess = null
      if (Date.now() - agentStartedAt > 30000) agentRestarts = 0
      // Agent 服务异常退出后同样自动重启，否则唤醒后会「什么都做不了」
      if (quitting) return
      if (agentRestarts >= 5) {
        console.error('[agent-server] 连续异常退出 5 次，停止重启（请查看上方日志）')
        return
      }
      agentRestarts += 1
      const delay = 1000 * agentRestarts
      console.warn(`[agent-server] ${delay}ms 后自动重启（第 ${agentRestarts} 次，退出码 ${c}）`)
      setTimeout(() => { if (!quitting) startAgentServer() }, delay)
    })
    console.log('[agent-server] spawned')
  } catch (e) { console.warn('[agent-server] failed:', e.message) }
}

function stopAgentServer() {
  if (agentProcess) { try { agentProcess.kill() } catch { /* 忽略 */ }; agentProcess = null; return }
  // 外部模式：进程不归本进程管，退出时按端口结束它 —— "退出 STUDIO"应当连同服务一起退掉。
  if (AGENT_EXTERNAL) killPortListener(8767)
}

// ---------- 通知智能服务（HTTP 8770 + 右下角重要通知卡片） ----------
const NOTIFY_PORT = Number(process.env.NOTIFY_SERVICE_PORT || 8770)
const NOTIFY_WIDTH = 400
const NOTIFY_CARD_HEIGHT = 104
const NOTIFY_PAD = 20
const NOTIFY_MAX = 1
const NOTIFY_LIFETIME = 8000

let notifyProcess = null
let notifyRestarts = 0
let notifyRequest = null
let notifyReconnectTimer = null
let notifyWindow = null
let notifyItems = []

async function startNotificationServer() {
  if (await isPortInUse(NOTIFY_PORT)) {
    // 与 Agent 服务同样的纪律：接管旧实例，保证日志可见、代码最新
    console.log(`[notify] ${NOTIFY_PORT} 已有实例在运行 → 接管`)
    killPortListener(NOTIFY_PORT)
    await new Promise((r) => setTimeout(r, 700))
  }
  try {
    notifyProcess = spawnService('notify', [path.join(__dirname, '..', 'backend', 'notification_service.py')])
    notifyProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
    notifyProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
    const startedAt = Date.now()
    notifyProcess.on('close', (code) => {
      console.log(`[notify] exited ${code}`)
      notifyProcess = null
      closeNotificationEvents()
      if (Date.now() - startedAt > 30000) notifyRestarts = 0
      if (quitting) return
      if (notifyRestarts >= 5) {
        console.error('[notify] 连续异常退出 5 次，停止重启（请查看上方日志）')
        return
      }
      notifyRestarts += 1
      const delay = 1000 * notifyRestarts
      console.warn(`[notify] ${delay}ms 后自动重启（第 ${notifyRestarts} 次，退出码 ${code}）`)
      setTimeout(() => { if (!quitting) startNotificationServer() }, delay)
    })
    // 服务是懒加载模型的：启动后稍等再连 SSE，避免首批请求打空
    setTimeout(() => { if (!quitting) subscribeNotificationEvents() }, 1200)
    console.log('[notify] spawned')
  } catch (e) { console.warn('[notify] failed:', e.message) }
}

function stopNotificationServer() {
  closeNotificationEvents()
  if (notifyProcess) { try { notifyProcess.kill() } catch { /* 忽略 */ }; notifyProcess = null }
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy()
  notifyWindow = null
  notifyItems = []
}

function closeNotificationEvents() {
  clearTimeout(notifyReconnectTimer)
  notifyReconnectTimer = null
  if (notifyRequest) { try { notifyRequest.destroy() } catch { /* 忽略 */ }; notifyRequest = null }
}

function scheduleNotificationReconnect() {
  if (quitting) return
  clearTimeout(notifyReconnectTimer)
  notifyReconnectTimer = setTimeout(() => subscribeNotificationEvents(), 1500)
}

function subscribeNotificationEvents() {
  if (quitting) return
  closeNotificationEvents()
  const req = http.get({
    host: '127.0.0.1', port: NOTIFY_PORT, path: '/api/events',
    headers: { Accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); scheduleNotificationReconnect(); return }
    console.log('[notify] events connected')
    res.setEncoding('utf8')
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = block.split('\n').find((row) => row.startsWith('data: '))
        if (!line) continue
        try { handleNotificationEvent(JSON.parse(line.slice(6))) } catch (err) {
          console.warn('[notify] bad event:', err.message)
        }
      }
    })
    res.on('end', scheduleNotificationReconnect)
    res.on('error', scheduleNotificationReconnect)
  })
  req.on('error', scheduleNotificationReconnect)
  notifyRequest = req
}

function handleNotificationEvent(payload) {
  if (!payload || typeof payload !== 'object') return
  // Python 侧时间戳是「秒」，渲染进程按毫秒格式化
  const at = payload.at ? Math.round(Number(payload.at) * 1000) : Date.now()
  if (payload.type === 'important') {
    pushNotificationCard({
      kind: 'important', id: payload.id, app: payload.app || '通知',
      title: payload.title || '', body: payload.body || '', at,
    })
  } else if (payload.type === 'summary' && payload.toast_ok === false) {
    // 系统 Toast 发不出去时退回自绘卡片，避免摘要静默丢失
    pushNotificationCard({
      kind: 'summary', id: `summary-${payload.group || ''}-${payload.at || Date.now()}`,
      app: payload.app || '通知', title: '通知摘要',
      body: payload.title || payload.body || '', at,
    })
  }
}

function pushNotificationCard(card) {
  // 单条展示：新卡片直接顶替旧的，渲染层负责旧卡片淡出、新卡片飞入
  notifyItems = notifyItems.filter((item) => String(item.id) !== String(card.id))
  notifyItems.push(card)
  if (notifyItems.length > NOTIFY_MAX) notifyItems = notifyItems.slice(-NOTIFY_MAX)
  showNotificationCards()
}

function notifyPageUrl() {
  return app.isPackaged
    ? `file://${path.join(__dirname, '../dist/notify.html')}`
    : `http://localhost:${process.env.VITE_DEV_PORT || '5173'}/notify.html`
}

function ensureNotifyWindow() {
  if (notifyWindow && !notifyWindow.isDestroyed()) return notifyWindow
  notifyWindow = new BrowserWindow({
    width: NOTIFY_WIDTH, height: 160, show: false,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  notifyWindow.setAlwaysOnTop(true, 'screen-saver')
  notifyWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notifyWindow.loadURL(notifyPageUrl())
  notifyWindow.on('closed', () => { notifyWindow = null })
  return notifyWindow
}

function layoutNotifyWindow(count) {
  if (!notifyWindow || notifyWindow.isDestroyed()) return
  // 窗口始终为「1 张卡片 + 四周留白」：留白让彩虹光晕渐变收尾，不被窗口边缘硬裁切
  const height = NOTIFY_PAD * 2 + NOTIFY_CARD_HEIGHT
  const area = screen.getPrimaryDisplay().workArea
  const x = Math.round(area.x + area.width - NOTIFY_WIDTH - 24)
  const y = Math.round(area.y + area.height - height - 24)
  notifyWindow.setBounds({ x, y, width: NOTIFY_WIDTH, height })
}

function showNotificationCards() {
  const win = ensureNotifyWindow()
  const send = () => {
    if (!notifyWindow || notifyWindow.isDestroyed()) return
    layoutNotifyWindow(notifyItems.length)
    notifyWindow.webContents.send('notify-items', {
      items: notifyItems, lifetime: NOTIFY_LIFETIME,
    })
    notifyWindow.showInactive()
    notifyWindow.moveTop()
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

ipcMain.on('notify-dismiss', (_event, id) => {
  notifyItems = notifyItems.filter((item) => String(item.id) !== String(id))
  if (!notifyWindow || notifyWindow.isDestroyed()) return
  if (notifyItems.length === 0) {
    notifyWindow.hide()
    return
  }
  layoutNotifyWindow(notifyItems.length)
  notifyWindow.webContents.send('notify-items', { items: notifyItems, lifetime: NOTIFY_LIFETIME })
})

// ---------- Edge 扩展桥接服务（HTTP+WS 8768） ----------
// 契约与端口见 backend/edge_bridge.py 与 backend/agent/config.py 的 EDGE_API_BASE：
// 它同时为 Dony 的 edge_browser 工具、扩展浮窗（视觉代理 / 整理中继）提供服务。
// 与语音/Agent 服务同样的纪律：端口已占用就跳过、异常退出按退避自动重启。
const EDGE_BRIDGE_PORT = Number(process.env.EDGE_BRIDGE_PORT || 8768)
let edgeBridgeProcess = null
let edgeBridgeRestarts = 0

async function startEdgeBridge() {
  if (await isPortInUse(EDGE_BRIDGE_PORT)) {
    console.log(`[edge-bridge] ${EDGE_BRIDGE_PORT} 已有实例在运行，跳过启动`)
    return
  }
  try {
    edgeBridgeProcess = spawnService('edge', ['-m', 'backend.edge_bridge'])
    edgeBridgeProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
    edgeBridgeProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
    const startedAt = Date.now()
    edgeBridgeProcess.on('close', (c) => {
      console.log(`[edge-bridge] exited ${c}`)
      edgeBridgeProcess = null
      if (Date.now() - startedAt > 30000) edgeBridgeRestarts = 0
      if (quitting) return
      if (edgeBridgeRestarts >= 5) {
        console.error('[edge-bridge] 连续异常退出 5 次，停止重启（请查看上方日志）')
        return
      }
      edgeBridgeRestarts += 1
      const delay = 1000 * edgeBridgeRestarts
      console.warn(`[edge-bridge] ${delay}ms 后自动重启（第 ${edgeBridgeRestarts} 次，退出码 ${c}）`)
      setTimeout(() => { if (!quitting) startEdgeBridge() }, delay)
    })
    console.log('[edge-bridge] spawned')
  } catch (e) { console.warn('[edge-bridge] failed:', e.message) }
}

function stopEdgeBridge() { if (edgeBridgeProcess) { try { edgeBridgeProcess.kill() } catch {}; edgeBridgeProcess = null } }

// ---------- 闹钟/计时器独立窗口 ----------
let alarmTopWindow = null
let timerFloatWindow = null

function alarmWindowUrl(fragment) {
  return app.isPackaged
    ? `file://${path.join(__dirname, '../dist/alarm.html')}#${fragment}`
    : `http://localhost:${process.env.VITE_DEV_PORT || '5173'}/alarm.html#${fragment}`
}

function createAlarmWindows() {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize
  const base = {
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: false, show: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      // 这两个窗口永远不聚焦（focusable:false），Chromium 默认会给后台窗口节流定时器：
      // 表现就是「Dony 开着时倒计时不跳秒，关掉 Dony 反而正常」。这里关掉节流。
      backgroundThrottling: false,
    },
  }
  alarmTopWindow = new BrowserWindow({
    ...base, width: 540, height: 110,
    x: Math.round((width - 540) / 2), y: 16,
  })
  alarmTopWindow.setAlwaysOnTop(true, 'screen-saver')
  alarmTopWindow.setIgnoreMouseEvents(true, { forward: true })
  alarmTopWindow.loadURL(alarmWindowUrl('top'))
  alarmTopWindow.once('ready-to-show', () => alarmTopWindow.showInactive())

  timerFloatWindow = new BrowserWindow({
    ...base, width: 296, height: 76,
    x: width - 296 - 24, y: height - 76 - 24,
  })
  timerFloatWindow.setAlwaysOnTop(true, 'screen-saver')
  timerFloatWindow.setIgnoreMouseEvents(true, { forward: true })
  timerFloatWindow.loadURL(alarmWindowUrl('float'))
  timerFloatWindow.once('ready-to-show', () => timerFloatWindow.showInactive())
}

// ---------- 通知区（托盘）图标：计时器 / 闹钟各一个，独立于 Dony 主图标 ----------
// 只在对应项存在时出现；闹钟图标点击不打开（按需求），计时器图标点击重新打开右下角卡片。
// 右键只提供与它自己相关的动作（取消闹钟 / 停止计时器）。
let timerTray = null
let alarmTray = null

// 闹钟/计时器卡片要不要接鼠标（各窗口自己上报的可见性）
const alarmVisible = { float: false, top: false }
// 覆盖层"该不该接管鼠标"（由界面状态决定）与"指针是否停在内容上"（由渲染进程实时上报）
let overlayWantMouse = false
let overlayHovering = true
// 接管鼠标后的"重放"定时器（见 applyOverlayMouse）
let mouseReplayTimer = null

/** 此刻到底要不要接管鼠标。
    书写辅助期间**只认它自己的判定**（writingOver），不看上面那两个变量：
    那两个属于 Dony / 视觉智能的规则，只要有任何一条路径把它们改掉
    （收窗、release-mouse、内容可见性上报、闹钟让位…），书写界面的点击就会永远失效，
    而且因为触发过一次就一直如此 —— 这正是"唤醒一次 Dony 后标签就点不动"的成因。 */
/** 是否处于「Dony 会话进行中」（界面还显示着内容）。
 *  ⚠ 不能只看 isAwake：30s 兜底会把它清掉，而追问卡片还在屏幕上。
 *  只要窗口可见且状态不是 idle，就仍算会话进行中，鼠标/焦点规则必须按这个判定走。 */
function inDonySession() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false
  if (writingModeActive || visualModeActive) return false
  return (isAwake || overlayWindow.isVisible()) && overlayState !== 'idle'
}

function wantsMouseNow() {
  // 书写辅助期间**整窗始终点击穿透**（用户明确要求："还是点击穿透吧"）。
  //
  // 之前按"指针落在可点矩形上才接管"做过一轮，实测两件事：
  //   · 接管常常没真正生效（点击照样穿透），于是"真实点击"和"后端派发"两条路
  //     时有时无 —— 预览、按下高亮因此时好时坏；
  //   · 偶尔接管又收不回来，把整屏点死。
  // 现在只保留一条路：后端读物理按键 → 前端做命中 → 派发 DOM 点击。
  // 窗口永远穿透 ⇒ 不会吞系统点击，也不会再有"接管/释放"的状态残留。
  // 卡片（横框/修改面板）要**接点击**：否则点它们的同时也会点到下面的窗口。
  // 只按渲染层上报的矩形接管，指针一离开立即放行；另有每秒看门狗兜底。
  if (writingModeActive) return writingOver && !writingSuppress
  return overlayWantMouse && overlayHovering
}

/** 决定覆盖层是否接管鼠标。
    指针不在内容上就放行——否则覆盖层会把底下的计时器/闹钟卡片点击全吃掉；
    指针在内容上就接管——否则 Dony 自己的卡片、开关、输入框都点不动。 */
function applyOverlayMouse() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // 自愈：Dony 醒着、且不在书写/视觉模式时，"该接管鼠标"必然为 true。
  // 任何一条路径把它误置为 false（书写辅助退出、暖场收尾、release-mouse…）都会让
  // Dony 整块穿透且无法再恢复；这里每次判定前拉回来，保证"指针在内容上就能点"。
  // contentForcedPassthrough 例外：那是"界面确实没内容、必须放行鼠标"的既有规则。
  if (inDonySession() && !contentForcedPassthrough) {
    overlayWantMouse = true
  }
  const passthrough = !wantsMouseNow()
  setMousePassthrough(overlayWindow, passthrough)
  // 接管之后再补一次。原因：窗口扩展样式有可能被稍后落地的路径又改回穿透
  // （异步的 PowerShell 样式修正、系统重建扩展样式…），而那时 hover 值没变、
  // 不会再次触发本函数 —— 表现就是"鼠标明明在元素上却点不动，且只在进入过一次后出现"。
  // 重放是幂等的，不会与既有逻辑打架。
  if (passthrough || mouseReplayTimer) return
  mouseReplayTimer = setTimeout(() => {
    mouseReplayTimer = null
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    if (wantsMouseNow()) setMousePassthrough(overlayWindow, false)
  }, 260)
}

/** 保留旧入口名（唤醒/内容变化等路径用它） */
function setOverlayTakeMouse(take) {
  // 只在 true→false 时留痕：这条转换一旦在会话中途发生，界面就会整块穿透。
  // 带上调用点，下次再出现"点一下就消失"能直接看到是谁关的。
  if (!take && overlayWantMouse) {
    const at = (new Error().stack || '').split('\n').slice(2, 4).join(' ← ')
    console.log('[mouse] 接管鼠标 true→false', at.trim())
  }
  overlayWantMouse = !!take
  if (take) overlayHovering = true      // 刚唤起时指针位置未知：先按"在内容上"处理
  applyOverlayMouse()
}

/** 统一设置"鼠标穿透"。
    ⚠ 必须分两种写法：要穿透时用 (true, {forward:true})（这样窗口还能收到"移动"事件，
    所以悬停仍然有效）；**恢复时必须只传 false**——实测传 (false, {forward:true})
    窗口会继续穿透：表现就是"鼠标移过去按钮有悬停反应、点击却直接穿过去"，
    也就是计时器卡片按钮一直点不动的原因。 */
function setMousePassthrough(win, passthrough) {
  if (!win || win.isDestroyed()) return
  if (passthrough) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
  // 刚变成"接管"时（点击必须立刻有效的时刻）核对一次原生样式：
  // 实测出现过"日志说已接管、用户点 60 秒却一次 mousedown 都没有"，
  // 那是 setIgnoreMouseEvents(false) 没真正生效，必须用原生方式确认并纠正。
  if (win === overlayWindow) {
    if (!passthrough && lastPassthrough !== false) forceAcceptMouse()
    lastPassthrough = passthrough
  }
}

/**
 * 原生核对一次"窗口到底还穿不穿透"：读 GWL_EXSTYLE，若 WS_EX_TRANSPARENT 还在就清掉。
 *
 * 判读方式（日志 `[mouse] 原生透明确认：…`）：
 *   · "之前=有 → 已清除" ⇒ 真凶就是这个标志位没被清掉；
 *   · "之前=无"         ⇒ 与它无关，问题在别处（结合同一时刻的 [writing] 快照看）。
 */
let lastPassthrough = null
let mouseFixAt = 0
function forceAcceptMouse() {
  if (process.platform !== 'win32' || !overlayWindow || overlayWindow.isDestroyed()) return
  const now = Date.now()
  if (now - mouseFixAt < 3000) return     // 节流：起 PowerShell 进程不便宜
  mouseFixAt = now
  try {
    const buf = overlayWindow.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
    const ps = [
      "$ErrorActionPreference='Stop'",
      // ⚠ 这里的输出**只用 ASCII**：PowerShell 的 stdout 是 ANSI 代码页，
      //   node 按 UTF-8 读会变成乱码（日志里那行 "֮ǰ=��" 就是中文被这样毁掉的）。
      "$sig=@'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class M {',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);',
      '  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
      '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
      '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);',
      '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
      '}',
      "'@",
      'Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue',
      `$h=[IntPtr]${hwnd}`,
      '$GWL_EXSTYLE=-20; $TRANS=0x20',
      '$ex=[int64][M]::GetWindowLongPtr($h,$GWL_EXSTYLE)',
      // WS_DISABLED 在 **GWL_STYLE** 里（0x08000000）：被禁用的窗口会吃掉点击、
      // 又不把事件传给下面 —— 与"点不动"的症状一致，所以单独读出来一起打。
      '$st=[int64][M]::GetWindowLongPtr($h,-16)',
      'Write-Output ("ex=0x{0:X8} TRANS={1} LAYERED={2} NOACTIVE={3} TOOL={4} DISABLED={5} VISIBLE={6}" -f $ex,' +
      ' [int](($ex -band 0x20) -ne 0), [int](($ex -band 0x80000) -ne 0),' +
      ' [int](($ex -band 0x08000000) -ne 0), [int](($ex -band 0x80) -ne 0),' +
      ' [int](($st -band 0x08000000) -ne 0), [int](($st -band 0x10000000) -ne 0))',
      'if (($ex -band $TRANS) -ne 0) {',
      '  [void][M]::SetWindowLongPtr($h,$GWL_EXSTYLE,[IntPtr](($ex -band (-bnot $TRANS))))',
      '  [void][M]::SetWindowPos($h,[IntPtr]::Zero,0,0,0,0,0x27)',
      '  Write-Output "trans=was-set-cleared"',
      '} else { Write-Output "trans=clear" }',
      // 关键一条：问系统"指针下这个点到底归谁"。
      // WindowFromPoint 可能返回子窗口，所以要和**根窗口**比。
      // 不一致 ⇒ 有别的窗口盖在上面，点击被它接走了；这里顺手把自己重新置顶一次。
      '$pt = New-Object M+POINT',
      '[void][M]::GetCursorPos([ref]$pt)',
      '$under = [M]::WindowFromPoint($pt)',
      '$root = [M]::GetAncestor($under, 2)',
      '$self = [M]::GetAncestor($h, 2)',
      'if ($under -ne $h -and $root -ne $self) {',
      '  [void][M]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x0013)',
      '  $u2 = [M]::WindowFromPoint($pt)',
      '  Write-Output ("under=OTHER before=$($under.ToInt64()) after=$($u2.ToInt64()) self=$($self.ToInt64()) reTopmost=1")',
      '} else {',
      '  Write-Output ("under=SELF by=$($under.ToInt64()) self=$($self.ToInt64())")',
      '}',
    ].join('\n')
    const child = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64'),
    ], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.on('close', () => {
      console.log(`${ts()} [mouse] 接管核对：${out.trim().replace(/\s+/g, ' ') || '（无输出）'}`)
    })
  } catch (err) {
    console.warn('[mouse] 原生核对失败:', err?.message || err)
  }
}

/** 闹钟/计时器卡片状态变了：不再强行让覆盖层让出鼠标，
    改由"指针在不在内容上"统一决定（applyOverlayMouse）。 */
function applyOverlayMouseForAlarms() {
  applyOverlayMouse()
}

function sendTrayCommand(cmd) {
  for (const win of [timerFloatWindow, alarmTopWindow]) {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('tray-command', { cmd })
    } catch (err) {
      console.warn('[tray] 发送命令失败', err)
    }
  }
}

function createAlarmTray(kind) {
  const isTimer = kind === 'timer'
  const iconPath = path.join(__dirname, 'assets', isTimer ? 'tray-timer.png' : 'tray-alarm.png')
  if (!fs.existsSync(iconPath)) return null
  const tray = new Tray(iconPath)
  tray.setToolTip(isTimer ? '计时器' : '闹钟')
  if (isTimer) {
    // 计时器：点一下就把右下角卡片打开（最小化之后靠它回来）
    tray.on('click', () => sendTrayCommand('restore-timer'))
  }
  // 闹钟：点击不打开，只留右键菜单
  tray.setContextMenu(Menu.buildFromTemplate([
    isTimer
      ? { label: '停止计时器', click: () => sendTrayCommand('stop-timer') }
      : { label: '取消闹钟', click: () => sendTrayCommand('cancel-alarm') },
  ]))
  return tray
}

function syncTrays(state) {
  const wantTimer = !!(state && state.timer)
  const wantAlarm = !!(state && state.alarm)
  if (wantTimer && !timerTray) timerTray = createAlarmTray('timer')
  else if (!wantTimer && timerTray) { timerTray.destroy(); timerTray = null }
  if (wantAlarm && !alarmTray) alarmTray = createAlarmTray('alarm')
  else if (!wantAlarm && alarmTray) { alarmTray.destroy(); alarmTray = null }
}

ipcMain.on('tray-sync', (event, state) => {
  syncTrays(state)
  // 鼠标接管规则**只作用于上报的那扇窗**。
  // 之前两个闹钟窗口（顶部提醒 / 计时器卡片）共用一条判断，都去改"计时器窗口"的
  // 忽略鼠标状态：后到的顶部提醒把计时器窗口又按回「忽略鼠标」，
  // 于是表现为"鼠标移过去按钮有悬停反应、点击却穿透"——
  // 因为 ignoreMouseEvents(true,{forward:true}) 只转发移动事件，点击是不过来的。
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const isFloat = win === timerFloatWindow
  const visible = isFloat
    ? !!(state && (state.floatVisible !== undefined ? state.floatVisible : state.timer))
    : !!(state && (state.topVisible !== undefined ? state.topVisible : state.alarm))
  setMousePassthrough(win, !visible)
  alarmVisible[isFloat ? 'float' : 'top'] = visible
  applyOverlayMouseForAlarms()
  console.log(`[tray] ${isFloat ? '计时器卡片' : '顶部提醒'} 可见=${visible}` +
              ` → 鼠标接管=${visible}（覆盖层让鼠标=${alarmVisible.float || alarmVisible.top}）`)
  if (visible) {
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } catch (err) {
      // 忽略
    }
  }
})

// ================= 主托盘（Dony）=================
// 需求：图标用 Dony 的图标；菜单只有三项（键入 / 说话 / 视觉智能），
// Dony 两项在上、视觉智能在下，中间一条分隔线；菜单内不放图标。
// 原生菜单无法定制外观，所以这里用无边框小窗做 WinUI 风格菜单：
// 圆角、半透明底、细边框、悬停高亮，在托盘图标上方弹出，失焦即收起。
// 窗口比菜单本体大：四周各留 18px 透明边，避免 CSS 阴影被窗口边界裁切
// （菜单本体 212×140，见 tray.html 的 #menu inset）。
const TRAY_MENU_WIDTH = 248
const TRAY_MENU_HEIGHT = 176
// 右键菜单会多一条分隔线 + 一项「退出STUDIO」（13 + 34），窗口随之加高
const TRAY_MENU_HEIGHT_WITH_QUIT = TRAY_MENU_HEIGHT + 47
const TRAY_MENU_GAP = 6

let donyTray = null
let trayMenuWindow = null
// 当前菜单来自哪个键：'left' = 三项；'right' = 三项 + 退出STUDIO
let trayMenuMode = 'left'
// 刚收起的时间戳：点托盘图标关闭菜单时，Windows 的 blur 会先触发收起，
// 紧接着的 click 又会把菜单重新打开。用一个短窗口把这次 click 吃掉，才是"点一下关掉"。
let trayMenuHiddenAt = 0
// 刚弹出的时间戳：防止同一次点按被重复处理（重复 show 会重新播动画，看起来也是"跳"）
let trayMenuShownAt = 0

function trayMenuUrl() {
  return app.isPackaged
    ? `file://${path.join(__dirname, '../dist/tray.html')}`
    : `http://localhost:${process.env.VITE_DEV_PORT || '5173'}/tray.html`
}

function createTrayMenuWindow() {
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_WIDTH, height: TRAY_MENU_HEIGHT,
    frame: false, transparent: true, resizable: false, movable: false,
    hasShadow: false, show: false, skipTaskbar: true, alwaysOnTop: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      // 菜单窗口很小，别让后台节流把入场动画卡掉
      backgroundThrottling: false,
    },
  })
  // 与覆盖层同为 screen-saver 级：菜单后显示，压在覆盖层之上（pop-up-menu 会低于它）
  trayMenuWindow.setAlwaysOnTop(true, 'screen-saver')
  trayMenuWindow.setVisibleOnAllWorkspaces(true)
  trayMenuWindow.loadURL(trayMenuUrl())
  // 点到别处 / 切走 → 收起（WinUI 菜单同样是这个行为）
  trayMenuWindow.on('blur', () => hideTrayMenu())
  trayMenuWindow.on('closed', () => { trayMenuWindow = null })
}

function hideTrayMenu() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
  if (!trayMenuWindow.isVisible()) return
  trayMenuHiddenAt = Date.now()
  // 先让页面回到「透明待播」状态再隐藏：否则下一次 show() 的第一帧仍是上一次的
  // 完全不透明，随后收到入场通知才闪回 0 再淡入 —— 肉眼就是"弹出来跳一下"。
  trayMenuWindow.webContents.send('tray-menu-hidden')
  trayMenuWindow.hide()
}

/** 在托盘图标正上方弹出；上方放不下（任务栏在顶部）就放到下方，并夹在工作区内。
 *  mode：'left' 三项；'right' 三项 + 「退出STUDIO」。 */
function showTrayMenu(mode = 'left') {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
  const withQuit = mode === 'right'
  // 菜单开着时再点托盘：blur 已经把它收起了，这里的 click 属于同一次点按，忽略
  if (Date.now() - trayMenuHiddenAt < 250) return
  // 同一瞬间重复触发（例如左右键事件叠加）时不要重播动画
  if (Date.now() - trayMenuShownAt < 300) return
  if (trayMenuWindow.isVisible()) {
    // 同一个键再按 = 收起；换成另一个键 = 就地换内容（不收起）
    if (trayMenuMode === mode) { hideTrayMenu(); return }
  }

  let anchor = null
  try { if (donyTray) anchor = donyTray.getBounds() } catch (_err) { anchor = null }
  if (!anchor || (!anchor.width && !anchor.height)) {
    const p = screen.getCursorScreenPoint()
    anchor = { x: p.x, y: p.y, width: 0, height: 0 }
  }
  const centerX = anchor.x + Math.round((anchor.width || 0) / 2)
  const centerY = anchor.y + Math.round((anchor.height || 0) / 2)
  const area = screen.getDisplayNearestPoint({ x: centerX, y: centerY }).workArea

  const height = withQuit ? TRAY_MENU_HEIGHT_WITH_QUIT : TRAY_MENU_HEIGHT
  let x = centerX - Math.round(TRAY_MENU_WIDTH / 2)
  let y = anchor.y - height - TRAY_MENU_GAP
  if (y < area.y) y = anchor.y + (anchor.height || 0) + TRAY_MENU_GAP
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - TRAY_MENU_WIDTH - 4))
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - height - 4))

  trayMenuMode = mode
  trayMenuShownAt = Date.now()
  // 尺寸与位置一次设好（setBounds），避免先按旧尺寸显示再改大小
  trayMenuWindow.setBounds({
    x: Math.round(x), y: Math.round(y),
    width: TRAY_MENU_WIDTH, height,
  })
  // 先通知页面（切换条目 + 从头播淡入），再显示：显示出来的第一帧就是低透明度，不会先亮一下
  trayMenuWindow.webContents.send('tray-menu-show', { withQuit })
  trayMenuWindow.show()
  trayMenuWindow.focus()
}

function createDonyTray() {
  if (donyTray) return
  if (!fs.existsSync(DONY_ICON)) {
    console.warn('[tray] 找不到 Dony 图标，跳过托盘：', DONY_ICON)
    return
  }
  donyTray = new Tray(DONY_ICON)
  donyTray.setToolTip('Dony')
  // 左键：三项菜单；右键：再多一项「退出STUDIO」
  donyTray.on('click', () => showTrayMenu('left'))
  donyTray.on('right-click', () => showTrayMenu('right'))
}

ipcMain.on('tray-menu-hide', () => hideTrayMenu())

ipcMain.on('tray-action', (_event, cmd) => {
  hideTrayMenu()
  // 三个入口与全局快捷键走完全相同的函数，守卫（彩排/已唤醒）也一致
  if (cmd === 'wake') wakeOverlay()
  else if (cmd === 'voice') voiceWakeOverlay()
  else if (cmd === 'visual') visualWakeOverlay()
  else if (cmd === 'quit') app.quit()   // 退出整个 STUDIO（will-quit 会一并收掉子服务）
})

ipcMain.on('overlay-hover', (_event, over) => {
  // 渲染进程实时上报"指针是不是停在内容上"：停上才接管鼠标
  overlayHovering = !!over
  applyOverlayMouse()
  console.log(`[hover] 指针在内容上=${overlayHovering} → 覆盖层接管鼠标=${overlayWantMouse && overlayHovering}`)
})

ipcMain.on('renderer-log', (_event, msg) => {
  // 渲染层的排查日志也带时间戳：判断"点击"与"接管翻转"的先后全靠它
  console.log(`${ts()} ${String(msg).slice(0, 200)}`)
})

ipcMain.on('quit-app', () => {
  // Dony 自己退出（用户只要求打开某个 app 时由模型调用；也用于点开网址卡片后收尾）
  app.quit()
})

app.on('will-quit', () => {
  for (const t of [timerTray, alarmTray, donyTray]) {
    try { t && t.destroy() } catch (err) { /* 退出时忽略 */ }
  }
  timerTray = null
  alarmTray = null
  donyTray = null
})

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()
}

function extractLinkPreview(html, baseUrl) {
  if (!html) return null
  const pick = (patterns) => {
    for (const re of patterns) {
      const m = html.match(re)
      if (m && m[1]) return m[1].trim()
    }
    return ''
  }
  const rawImage = pick([
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ])
  const rawTitle = pick([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([^<]*)<\/title>/i,
  ])
  let image = ''
  if (rawImage) {
    try { image = new URL(rawImage, baseUrl).toString() } catch { image = '' }
  }
  return { title: decodeEntities(rawTitle), image }
}

function fetchLinkPreview(targetUrl, redirects = 0) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`)
    } catch { return resolve(null) }
    const client = url.protocol === 'http:' ? http : https
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 6000,
    }, (res) => {
      const location = res.headers.location
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && redirects < 3) {
        res.resume()
        try {
          return fetchLinkPreview(new URL(location, url).toString(), redirects + 1).then(done)
        } catch { return done(null) }
      }
      if (res.statusCode !== 200) { res.resume(); return done(null) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 500000) { res.destroy(); done(extractLinkPreview(body, url)) }
      })
      res.on('end', () => done(extractLinkPreview(body, url)))
      res.on('close', () => done(extractLinkPreview(body, url)))
    })
    req.on('timeout', () => { req.destroy(); done(null) })
    req.on('error', () => done(null))
  })
}

// ================= 单实例守卫 =================
// 双击第二次启动时直接退出，避免两份覆盖层 / 两个托盘图标 / 两套全局快捷键互相打架
// （第二份抢不到 Alt+Space 时会静默失败，用户只看到"点了没反应"）。
// 已有实例收到 second-instance 时把界面带到前台，而不是再开一份。
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  console.log('[single-instance] 已有实例在运行，本次启动直接退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    console.log('[single-instance] 检测到第二次启动 → 唤醒已有实例')
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        restoreOverlayTop(); overlayWindow.show(); setOverlayTakeMouse(true); overlayWindow.focus()
        if (!isAwake) wakeOverlay()
        return
      }
      // 还处在首次引导阶段（overlayWindow 尚未创建）：这时必须有**可见反馈**，
      // 否则第二次双击看起来完全没反应（用户实测的「双击打不开」就是这一步）。
      // 向导是本进程 spawn 出去的独立 exe，先把已存在的窗口带到前台；
      // 没有窗口（用户已经把它关掉）就重新拉起一份。
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      if (wins.length) {
        const w = wins[0]
        if (w.isMinimized()) w.restore()
        w.show(); w.focus()
        return
      }
      if (!isOnboardingCompleted()) launchOnboarding()
    } catch (err) { /* 忽略 */ }
  })
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  // 首次启动：未完成引导时先启动 onboarding，等完成后（写 ONBOARDING_COMPLETED）再初始化主界面
  await waitForOnboarding()
  createOverlayWindow(); tryRegisterShortcuts(); registerVoiceShortcut(); registerVisualShortcut(); startVoiceServer(); startAgentServer(); startEdgeBridge(); startNotificationServer(); startDonyAppApi(); startPhotoService(); startOfficeBridge(); createAlarmWindows()
  // 主托盘（Dony）+ WinUI 风格菜单小窗
  createTrayMenuWindow()
  createDonyTray()
  ipcMain.on('hide-overlay', hideOverlay); ipcMain.on('cancel-hold', cancelWakeHold); ipcMain.on('cancel-voice-hold', cancelVoiceHold)
  // 启动彩排跑完（或渲染进程兜底超时）→ 收窗并恢复唤醒入口
  ipcMain.on('warmup-done', finishStartupWarmup)
  // 输入建议库：渲染进程要一次（首次键入对话时随机抽 3 条）
  // ⚠ 清单已固化在软件内（见 BUILTIN_SUGGESTIONS）——这里**不再读任何文件**。
  ipcMain.handle('suggestions', () => suggestionLibrary())
  // 渲染进程上报界面状态：回到 idle 就说明这一轮结束，顺手清掉“已唤醒”标记
  ipcMain.on('overlay-state', (_event, s) => {
    overlayState = typeof s === 'string' && s ? s : 'idle'
    // 执行期间让覆盖层彻底不抢焦点：这段时间用户可能打开新程序、或弹出 UAC，
    // 焦点应该归它们，而不是被这层全屏置顶窗口占着。
    // 需要用户输入的状态（ready / followUp / asking）再恢复可聚焦。
    if (overlayWindow && overlayWindow.isVisible()) {
      // 「需不需要用户操作」这件事由 setVisualMousePassthrough 那条规则实时接管，
      // 这里只在回到需要输入的状态时恢复可聚焦（询问/追问期间不动它，免得把输入框又关掉）。
      if (overlayState !== 'loading') setOverlayFocusable(true)
      // 需要用户输入的状态要**真的把焦点拿回来**：只恢复"可聚焦"是不够的——
      // 实测一轮跑完回到追问时焦点已经跑到别的窗口，输入框敲不进字，得手动再点一下。
      if (overlayState === 'followUp' || overlayState === 'asking') {
        if (!overlayWindow.isFocused()) overlayWindow.focus()
      }
    }
    if (overlayState !== 'idle') { clearTimeout(idleHideTimer); idleHideTimer = null; return }
    isAwake = false; clearTimeout(awakeSafetyTimer)
    // 界面已经复位却还留着窗口：延迟收起（期间又变成非 idle 就取消）。
    // 否则会残留一层“看不见、却挡着整个系统鼠标”的全屏置顶窗口。
    clearTimeout(idleHideTimer)
    idleHideTimer = setTimeout(() => {
      idleHideTimer = null
      // 彩排期间窗口是我们自己故意显示出来的（整窗近乎全透明），
      // 不能按"idle 却还可见 = 残留窗口"这条规则把它收掉，否则彩排白跑。
      if (startupWarmupRunning) return
      // 视觉智能同样不走状态机（overlayState 恒为 idle），不能按"idle 却可见"把它的窗口收掉。
      if (visualModeActive) return
      // 书写辅助同理：它全程 overlayState=idle，界面却要一直挂在那里等用户操作。
      if (writingModeActive) return
      if (overlayState === 'idle' && overlayWindow?.isVisible()) {
        console.warn('[hotkey] 界面已 idle 但窗口仍可见，自动收起以免挡住鼠标')
        hideOverlay()
      }
    }, 1500)
  })
  // 覆盖层当前“什么都没画”时必须放行鼠标：全屏置顶窗口哪怕全透明，
  // 只要它接管鼠标就会吃掉系统里所有点击（表现为“鼠标点击全失效”）。
  // 只在自己的放行生效时负责恢复，避免与既有鼠标逻辑（执行中放行等）互相打架。
  ipcMain.on('overlay-content-visible', (_event, visible) => {
    contentVisible = Boolean(visible)
    if (!overlayWindow) return
    // 书写辅助期间鼠标由"指针是否在书写元素上"接管（见 enterWritingMode）。
    // 不能走下面这条"界面无内容 → 强制放行"：它会直接改窗口的鼠标穿透状态、
    // 绕过 hover 规则，后果是小标签和小菜单全都点不动。
    if (writingModeActive) return
    if (!visible) {
      if (overlayWindow.isVisible()) {
        contentForcedPassthrough = true
        console.log('[hotkey] 界面无内容 → 放行鼠标')
        overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      }
      return
    }
    if (contentForcedPassthrough) {
      contentForcedPassthrough = false
      // 有内容了：恢复接管鼠标；执行中（loading）仍按既有规则放行
      if (overlayState !== 'loading') setOverlayTakeMouse(true)
    }
  })
  ipcMain.on('alarm-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setMousePassthrough(win, !interactive)
    if (interactive) {
      // 需要用户点它了：确保它在覆盖层之上，否则全屏透明覆盖层会把点击全部吃掉
      try {
        win.setAlwaysOnTop(true, 'screen-saver')
        win.moveTop()
      } catch (err) {
        // 忽略
      }
    }
  })
  ipcMain.on('release-mouse', () => { if (overlayWindow) { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); overlayWindow.blur() } })
  // 视觉智能：确认选择后切成普通小窗，位置与尺寸由渲染进程按内容上报
  ipcMain.on('visual-window-mode', (_event, collapsed) => { applyVisualWindowMode(Boolean(collapsed)) })
  ipcMain.on('visual-window-rect', (_event, rect) => { setVisualWindowRect(rect) })
  // 验证开关用：窗口保持全屏置顶时整体放行鼠标，桌面照常可点
  ipcMain.on('visual-mouse-passthrough', (_event, passthrough) => {
    if (!overlayWindow) return
    contentForcedPassthrough = false   // 鼠标状态改由这条规则接管
    if (passthrough) {
      setOverlayTakeMouse(false)
      // 放行鼠标 = 此刻不需要用户操作这层窗：同步取消可聚焦，
      // 免得全屏置顶窗继续占着焦点（新应用/UAC 弹出时焦点该归它们）。
      setOverlayFocusable(false)
    } else {
      // 接管鼠标必须走闸门：闹钟/计时器卡片在的时候一律不接（否则卡片点不动）
      setOverlayTakeMouse(true)
      // 需要用户操作这层窗（典型就是「打断询问」要打字）：
      // 必须恢复可聚焦并主动聚焦，否则输入框收不到键盘——
      // 上一版把执行期间一律设为不可聚焦，询问框就变成只能看不能输入了。
      setOverlayFocusable(true)
      if (!overlayWindow.isFocused()) overlayWindow.focus()
    }
  })
  // 书写辅助：进入/退出 / 临时取键盘焦点 / 主屏换算信息
  ipcMain.on('writing-active', (_event, active) => {
    if (active) {
      enterWritingMode()
    } else {
      // 记下"显式退出"的时刻：心跳信标要据此忽略退出之后残留的那一两拍，
      // 否则会把刚刚结束的会话又补回来（窗口重新显示、收窗也被作废）。
      writingExplicitExitAt = Date.now()
      leaveWritingMode()
    }
  })
  // 书写辅助：存活信标（渲染层每 500ms 一次）。
  // 它与"有没有可交互区域"无关 —— 标签不可见时区域本来就是空的，只看区域分不出
  // "界面没了"和"界面在、只是没东西可点"。只要这条信标还在，界面就还在，
  // 于是任何"把主进程标记清掉、渲染层却还活着"的路径都能在半个心跳内自愈。
  ipcMain.on('writing-alive', (_event, alive) => {
    if (!alive) return
    writingAliveAt = Date.now()
    ensureWritingMode('收到存活心跳但已不在书写模式')
  })
  // 物理按下降在书写界面之外（渲染层发现这一下没在它的任何元素上）。
  // 用户是在编辑器里按下的（多半要开始划选）。此刻覆盖层可能还占着那一小块鼠标
  // （标签的热区贴着选区开头），不让出去的话，这次划选会被整段吞掉 ——
  // 表现就是"记事本不能拖了"。压制到渲染层下一次上报接管区域为止（新一轮会话）。
  ipcMain.on('writing-pointer-down-outside', () => {
    if (!writingModeActive || !overlayWindow || overlayWindow.isDestroyed()) return
    writingSuppress = true
    writingOver = false
    writingOverUntil = 0
    setMousePassthrough(overlayWindow, true)
    console.log(`${ts()} [writing] 按下落在界面之外 → 让出鼠标（直到下一次选区上报）`)
  })
  // 兜底看门狗：覆盖层"可见却接管着鼠标"是最致命的状态 —— 整屏都点不了。
  // 接管状态由太多路径写（唤醒/收窗/三种模式/异步样式修正…），任何一条漏了放行，
  // 用户面对的就是"整个桌面都点不动"。这里每秒核对一次：没有任何会话却还接管着，
  // 就强制放行并留下日志 —— 宁可让它自愈，也不能让用户去重启。
  setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    if (!overlayWindow.isVisible()) return
    if (writingModeActive || visualModeActive || isAwake) return
    if (!wantsMouseNow()) return
    console.log('[mouse] 看门狗：覆盖层无会话却接管着鼠标 → 强制放行')
    overlayWantMouse = false
    overlayHovering = false
    setMousePassthrough(overlayWindow, true)
  }, 1000)
  // 书写辅助：渲染层上报"需要接管鼠标的区域"（屏幕 DIP 矩形）
  // 载荷两种形态都认：数组（旧）或 { rects, zone }（新，zone 是锚点外的"靠近区"）
  ipcMain.on('writing-hit-rects', (_event, payload) => {
    const list = Array.isArray(payload) ? payload : (payload && payload.rects) || []
    writingZone = (!Array.isArray(payload) && payload && payload.zone && Number.isFinite(payload.zone.x))
      ? payload.zone
      : null
    // 渲染层又上报了接管区域 = 新一轮会话的界面出来了：解除"按下降在界面之外"的压制
    writingSuppress = false
    const prev = writingHitRects
    writingHitRects = Array.isArray(list)
      ? list
        .filter((r) => r && Number.isFinite(r.x) && Number.isFinite(r.y)
          && Number.isFinite(r.width) && Number.isFinite(r.height))
        .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
      : []
    // 排查观测点：渲染层只在矩形变化时发，这里打印每次变化 ——
    // 看得见"标签矩形 → 菜单矩形"的交接有没有发生。
    const fmt = (rs) => rs.map((r) =>
      `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`).join(' | ')
    if (fmt(prev) !== fmt(writingHitRects)) {
      console.log(`[writing] 接管区域 ${writingHitRects.length} 块：${fmt(writingHitRects) || '（空）'}`)
      // 有可交互区域 ⇒ 界面确实还在（这是比心跳更早、更确定的信号）：标记丢了就补回来
      if (writingHitRects.length) ensureWritingMode('收到可交互区域但已不在书写模式')
    }
    // 无论区域有没有变，都要立刻按最新区域与靠近区判定一次（不等下一个 60ms 节拍）：
    // 标签的显隐与"该不该接管鼠标"都由这里驱动（见 evaluateWritingHover）。
    evaluateWritingHover()
  })
  // ⚠ 这里原来挂了一个"拿到焦点就立刻 blur"的保险，已**移除**：
  //   WS_EX_NOACTIVATE 窗口在点击时会被系统反复送焦点，于是形成
  //   focus → blur → focus … 的自激循环，主进程被拖住、渲染层心跳中断
  //   （日志表现为"渲染层心跳中断 N 秒 → 界面 JS 可能卡死"、区域恒为 0、标签不出）。
  //   不抢焦点由窗口本身保证：showInactive + setFocusable(false) 就够了，
  //   不需要在焦点事件里再动手。
  ipcMain.on('writing-focus', (_event, focusable) => {
    if (!overlayWindow || !writingModeActive) return
    writingFocusWanted = Boolean(focusable)
    // 「描述修改」这类输入框要打字，必须真的拿到键盘焦点；
    // 失焦时目标程序的选区只是变灰、并不消失，回车后把焦点交还即可继续替换。
    setOverlayFocusable(Boolean(focusable))
    if (focusable) {
      if (!overlayWindow.isFocused()) overlayWindow.focus()
    } else if (overlayWindow.isFocused()) {
      overlayWindow.blur()
    }
  })
  // 后端给的选区是**屏幕物理像素**，渲染进程要换算成窗口内 DIP 才能定位。
  // 缩放比与屏幕原点都由主进程给，渲染层不要自己拿 devicePixelRatio 猜（多屏混合 DPI 会错）。
  /** Windows 个性色（DWM\AccentColor 以 ABGR 存储）—— 标签小框用它做底色 */
  function readAccentColor() {
    try {
      const out = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\DWM', '/v', 'AccentColor',
      ], { encoding: 'utf8', windowsHide: true })
      const m = /AccentColor\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out)
      if (m) {
        const abgr = parseInt(m[1], 16)
        const r = abgr & 0xff, g = (abgr >> 8) & 0xff, b = (abgr >> 16) & 0xff
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
      }
    } catch (e) { /* 读不到（键不存在/被策略禁用）就用系统默认蓝 */ }
    return '#0078D4'
  }

  ipcMain.handle('writing-screen', () => {
    const display = screen.getPrimaryDisplay()
    // 顺带把指针位置给出去：标签"只在鼠标靠近时显示"，刚划完选字那一刻指针往往已经
    // 在选区附近，有这个初始值就不必等用户先动一下鼠标才看得到标签。
    return {
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      cursor: screen.getCursorScreenPoint(),
      accent: readAccentColor(),
    }
  })
  ipcMain.on('open-external', (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    // 确认后覆盖层已是普通窗口，浏览器会自然显示在其上，直接交给系统打开即可
    shell.openExternal(url).catch(() => {})
  })
  ipcMain.handle('fetch-link-preview', async (_event, url) => {
    if (typeof url !== 'string' || !url.trim()) return null
    try { return await fetchLinkPreview(url) } catch { return null }
  })
  ipcMain.on('chat-request', (event, { messages, model }) => {
    const sender = event.sender
    const vision = getVisionConfig()
    const useModel = vision.model || model
    // thinking: disabled —— deepseek-flash 是推理模型，默认先输出一大段 reasoning_content
    // 再给正文。视觉问答完全是"看图说话"，不需要长思考；实测同一请求：
    //   开思考 2.6s（含 reasoning_content）；关思考 0.8s（直接给正文）。
    // 大图 + 长思考正是"首字节迟迟不来、90s 超时"的主要来源。
    // ⚠ 渲染层只读 delta.content：开思考时那段推理不会显示，用户会以为卡住。
    const postData = JSON.stringify({ model: useModel, messages, stream: true, thinking: { type: 'disabled' } })
    // 请求体积排查用：图片过大是"首字节迟迟不来"的另一个常见原因
    console.log(`[chat-request] model=${useModel} payload=${Math.round(Buffer.byteLength(postData) / 1024)}KB`)
    const u = new URL(vision.url)
    const isHttps = u.protocol === 'https:'
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${vision.key}`, 'Content-Length': Buffer.byteLength(postData) },
    }
    const client = isHttps ? https : http

    // 刚唤醒/刚启动时的**首个** HTTPS 请求偶发 DNS 或 TLS 抖动（ENOTFOUND / ECONNRESET /
    // socket hang up），表现为"第一次就报 AI 服务不可用，再点一次又正常"。
    // 规则：**还没吐出任何字节之前**可以重试一次；已经开始流式输出就不能重试，
    // 否则会把已经显示的文字再重复一遍。
    const attempt = (retriesLeft) => {
      let streamed = false
      const req = client.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { errBody += chunk })
          res.on('end', () => {
            let message = `HTTP ${res.statusCode}`
            try {
              const parsed = JSON.parse(errBody)
              if (parsed && parsed.error && parsed.error.message) message = parsed.error.message
            } catch {}
            console.error('[chat-request] failed:', message)
            sender.send('chat-error', message)
          })
          return
        }
        res.setEncoding('utf8')
        let buffer = ''
        res.on('data', (chunk) => {
          streamed = true
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (t.startsWith('data: ')) {
              const d = t.slice(6)
              if (d === '[DONE]') { sender.send('chat-end'); return }
              sender.send('chat-chunk', d)
            }
          }
        })
        res.on('end', () => { sender.send('chat-end') })
      })
      // 没有任何超时的话，网络卡住时界面会永远停在"正在处理"。
      req.setTimeout(90000, () => {
        req.destroy(Object.assign(new Error('AI 响应超时（90s，服务繁忙或图片过大）'), { code: 'ETIMEDOUT' }))
      })
      req.on('error', (err) => {
        // 超时不重试：再等 90s 只会让用户干等更久，不如直接把原因抛回去。
        const retryable = !streamed && retriesLeft > 0 && err.code !== 'ETIMEDOUT'
        if (retryable) {
          console.warn('[chat-request] 首轮失败，400ms 后重试一次：', err.message)
          setTimeout(() => attempt(retriesLeft - 1), 400)
          return
        }
        console.error('[chat-request] failed:', err.message)
        sender.send('chat-error', err.message)
      })
      req.write(postData)
      req.end()
    }
    attempt(1)
  })
  // ---- 深浅色：跟随「Windows 模式」（系统外观），不是「应用模式」----
  // 注册表里是两个独立开关：
  //   SystemUsesLightTheme —— 「Windows 模式」：任务栏、窗口边框等系统外观
  //   AppsUseLightTheme    —— 「应用模式」：CSS 的 prefers-color-scheme 跟的是这个
  // 用户要的是前者，所以直接读注册表（两者可以不一致，这是很常见的组合）。
  function readSystemTheme() {
    try {
      const out = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v', 'SystemUsesLightTheme',
      ], { encoding: 'utf8', windowsHide: true })
      if (/SystemUsesLightTheme\s+REG_DWORD\s+0x0\b/i.test(out)) return 'dark'
      if (/SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/i.test(out)) return 'light'
    } catch (e) { /* 读不到就让渲染进程回退 */ }
    return ''
  }

  ipcMain.handle('system-theme', () => readSystemTheme())

  // ---- 桌面底衬：优先用 Windows 自己缓存的壁纸文件 ----
  // Themes\CachedFiles 存的就是"当前实际显示"的那张壁纸（已按填充方式裁到屏幕比例）：
  // 它**不含任何窗口**（也没有 Dony 自己的半透明残影），而且永远不过期 ——
  // 正是亚克力底衬想要的东西。找不到（纯色壁纸/幻灯片/被清理过）时才回退实时截屏。
  function desktopWallpaperFile() {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes')
    const target = screen.getPrimaryDisplay().size
    const want = target.width / target.height
    const cands = []
    try {
      const cachedDir = path.join(dir, 'CachedFiles')
      for (const f of fs.readdirSync(cachedDir)) {
        if (!/\.(jpe?g|png|bmp)$/i.test(f)) continue
        const p = path.join(cachedDir, f)
        try {
          const s = nativeImage.createFromPath(p).getSize()
          if (!s.width || !s.height) continue
          // 多显示器（竖屏/超宽屏）时壁纸可能按屏各缓存一份：
          // 选长宽比与主屏最接近的那张，保证底衬与视口等比、不会被拉伸。
          cands.push({ p, d: Math.abs(s.width / s.height - want) / want, t: fs.statSync(p).mtimeMs })
        } catch (e) { /* 跳过读不出来的文件 */ }
      }
    } catch (e) { /* 没有缓存目录 */ }
    cands.sort((a, b) => (a.d - b.d) || (b.t - a.t))
    if (cands.length) return cands[0].p
    const tw = path.join(dir, 'TranscodedWallpaper')
    try { if (fs.existsSync(tw)) return tw } catch (e) { /* 忽略 */ }
    return ''
  }

  /** 真正抓一块屏的实时画面（覆盖层所在那块）。
      按 display_id 匹配主屏：多显示器（竖屏/超宽屏/不同分辨率）下 sources[0]
      不保证是主屏，抓错屏会让画面长宽比与视口不符。 */
  async function captureScreenNow() {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    // ⚠ desktopCapturer 在 Windows 上偶发返回空列表（首次调用、刚唤醒、显示模式刚切换时最常见）。
    //   直接抛错会表现为"视觉智能第一次就报 AI 服务不可用（No screen source）"。
    //   这里短重试几次，正常一两百毫秒内就能拿到。
    let sources = []
    for (let attempt = 0; attempt < 3; attempt++) {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      })
      if (sources.length) break
      await new Promise((r) => setTimeout(r, 120))
    }
    if (sources.length === 0) throw new Error('No screen source')
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    return src.thumbnail.toDataURL()
  }

  /** 亚克力底衬专用：优先桌面壁纸（纯桌面、不含任何窗口、永不过期），拿不到再回退实时截屏。 */
  async function captureDesktopBackdrop() {
    // ⚠ 底衬只用来当"被模糊 28~60px 的背景"，所以先缩到 1280 宽再发：
    //   原图动辄 4.6MB（base64 后 6.5MB），光是 IPC 传输 + 渲染进程解码
    //   就要几十毫秒，而且正好压在唤醒动画上 —— 缩放后只剩约 100~200KB。
    // ⚠ 必须用 createFromBuffer 而不是 createFromPath：壁纸文件名是
    //   TranscodedWallpaper（**没有扩展名**），createFromPath 会读成空图，
    //   toJPEG 于是产出空 buffer —— 最后发出去一个空的 data URL，
    //   渲染端拿到的是"无效图片"→ 只剩色调层，看起来就是"磨砂没了"，而且不报错。
    const shrink = (img) => {
      try {
        if (img && !img.isEmpty()) {
          const s = img.getSize()
          const small = s.width > 1280 ? img.resize({ width: 1280 }) : img
          const buf = small.toJPEG(82)
          if (buf && buf.length) {
            console.log(`[capture-desktop] ${s.width}x${s.height} → ${small.getSize().width}x${small.getSize().height}，${Math.round(buf.length / 1024)}KB`)
            return `data:image/jpeg;base64,${buf.toString('base64')}`
          }
        }
      } catch (e) {
        console.error('[capture-desktop] 缩放失败:', e.message)
      }
      return ''
    }
    try {
      const wp = desktopWallpaperFile()
      if (wp) {
        const raw = fs.readFileSync(wp)
        const shrunk = shrink(nativeImage.createFromBuffer(raw))
        if (shrunk) return shrunk
        // 缩放这条路失败也绝不能丢底图：直接用原文件字节（一定有效）
        console.warn('[capture-desktop] 缩放不可用，改为直接发送原图字节')
        const mime = /\.png$/i.test(wp) ? 'image/png' : 'image/jpeg'
        return `data:${mime};base64,${raw.toString('base64')}`
      }
    } catch (e) {
      console.error('[capture-desktop] 壁纸读取失败，改用截屏:', e.message)
    }
    return shrink(nativeImage.createFromDataURL(await captureScreenNow()))
  }

  // 真实截屏 —— **视觉智能用这个**（它必须看清屏幕上的窗口内容）。
  // ⚠ 这里绝不能返回壁纸：曾经为了亚克力底衬在这个 handler 里加了"壁纸优先"，
  //   结果视觉智能只截到背景、看不到任何窗口内容。底衬请走下面的 capture-desktop。
  ipcMain.handle('capture-screen', async () => {
    try {
      return await captureScreenNow()
    } catch (e) {
      console.error('[capture-screen] failed:', e.message)
      throw e
    }
  })

  // 桌面底衬（亚克力专用）：壁纸优先，拿不到才回退实时截屏
  ipcMain.handle('capture-desktop', async () => {
    try {
      return await captureDesktopBackdrop()
    } catch (e) {
      console.error('[capture-desktop] failed:', e.message)
      throw e
    }
  })

})
// ---------- Dony App API（历史/语音/文件，8769） ----------
let appApiProcess = null
async function startDonyAppApi() {
  if (await isPortInUse(8769)) { console.log('[appapi] 8769 已有实例，跳过启动'); return }
  appApiProcess = spawnService('appapi', [path.join(__dirname, '..', 'backend', 'dony_app_api.py')])
  appApiProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
  appApiProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
}
function stopDonyAppApi() { if (appApiProcess) { try { appApiProcess.kill() } catch {}; appApiProcess = null } }

// ---------- 照片推理服务（SAM / Moebius / SHARP，8772） ----------
let photoProcess = null
async function startPhotoService() {
  if (await isPortInUse(8772)) { console.log('[photo] 8772 已有实例，跳过启动'); return }
  photoProcess = spawnService('photo', [path.join(__dirname, '..', 'backend', 'photo_service.py')])
  photoProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
  photoProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
}
function stopPhotoService() { if (photoProcess) { try { photoProcess.kill() } catch {}; photoProcess = null } }

// ---------- Office 加载项桥（8771，Office 插件任务窗格所连） ----------
let officeProcess = null
async function startOfficeBridge() {
  if (await isPortInUse(8771)) { console.log('[office] 8771 已有实例，跳过启动'); return }
  officeProcess = spawnService('office', [path.join(__dirname, '..', 'backend', 'office_bridge.py')])
  officeProcess.stdout.on('data', (d) => console.log(d.toString().trim()))
  officeProcess.stderr.on('data', (d) => console.error(d.toString().trim()))
}
function stopOfficeBridge() { if (officeProcess) { try { officeProcess.kill() } catch {}; officeProcess = null } }

app.on('will-quit', () => { quitting = true; globalShortcut.unregisterAll(); stopVoiceServer(); stopAgentServer(); stopEdgeBridge(); stopNotificationServer(); stopDonyAppApi(); stopPhotoService(); stopOfficeBridge() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
