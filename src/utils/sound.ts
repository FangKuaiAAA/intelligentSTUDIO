let audio: HTMLAudioElement | null = null
let loadedSrc = ''

/** 把后端给的音频路径转成浏览器能播的 URL。
    · 内置默认是 "/MUS.mp3"（相对路径，直接用）；
    · 设置里选的是 Windows 绝对路径（D:\x\y.mp3），要转成 file:///D:/x/y.mp3。 */
function toSrc(path: string): string {
  const p = (path || '').trim()
  if (!p) return 'MUS.mp3'
  if (/^(https?|file):/i.test(p)) return p
  // Windows 绝对路径（D:\x.mp3 / D:/x.mp3）→ file:///D:/x.mp3
  if (/^[a-zA-Z]:[\\/]/.test(p)) return 'file:///' + p.replace(/\\/g, '/')
  // 其余按相对路径处理（如 MUS.mp3）：在 file:// 下相对 dist 解析，勿加前导 /
  return p
}

/** 播一次响铃（闹钟/计时器通用）。src 由后端在 fire 事件里带过来（设置里可改）。 */
export function playRingtone(src?: string) {
  const url = toSrc(src || '')
  try {
    if (!audio || loadedSrc !== url) {
      audio = new Audio(url)
      loadedSrc = url
    }
    audio.currentTime = 0
    audio.play().catch(() => {})
  } catch {
    // Audio not available, silently ignore
  }
}

/** 兼容旧名字（唤醒音等还在用） */
export function playPianoChord() {
  playRingtone('MUS.mp3')
}
