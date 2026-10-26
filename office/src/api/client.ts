/** 本地桥（同源 https://localhost:8769）的薄封装：token、超时、错误文案映射 */

const TOKEN_HEADER = 'x-dony-token'

let tokenPromise: Promise<string> | null = null

/** 同源取得本次会话 token；桥用 Origin 白名单保证只有本页读得到 */
export function getToken(): Promise<string> {
  if (tokenPromise) return tokenPromise
  tokenPromise = fetch('/api/session', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error(`会话接口返回 ${r.status}`)
      return r.json() as Promise<{ token: string }>
    })
    .then((data) => {
      window.__STUDIO_TOKEN__ = data.token
      return data.token
    })
    .catch((e) => {
      tokenPromise = null
      throw e
    })
  return tokenPromise
}

export interface ApiError {
  message: string
  /** 面向用户的补救建议（空状态/错误信息都要能指导下一步） */
  hint?: string
}

function mapError(status: number): ApiError {
  if (status === 401) return { message: '本地服务拒绝访问' }
  if (status === 404) return { message: '本地服务版本不匹配' }
  if (status >= 500) return { message: '本地服务处理失败' }
  return { message: '请求未完成' }
}

/**
 * ⚠ 这里**没有超时**。
 *
 * 本地部署的模型慢是常态（生图尤其），超时会把"还在算"误判成"失败"——
 * 实测就出现过：图已经在硬盘上生成完了，客户端却先断开，占位图被改成「生成未完成」。
 * 取消只走显式的取消按钮（后端 kill 子进程），不靠计时器。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken()

  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        [TOKEN_HEADER]: token,
        ...(init?.headers || {}),
      },
    })
  } catch (e) {
    console.error('[studio] 网络请求失败', e)
    throw new Error('未连接本地服务')
  }

  if (!response.ok) {
    await response.text()
    throw new Error(mapError(response.status).message)
  }
  return (await response.json()) as T
}

export interface HealthResult {
  ok: boolean
  version?: string
  writing?: boolean
  image?: boolean
  message?: string
}

export const health = (): Promise<HealthResult> => request<HealthResult>('/api/health')

export interface WritingResult {
  text: string
  note: string
  label: string
}

/** 书写辅助：一次请求一个动作，非流式（进度在界面上用不确定态表达） */
export const runWriting = (action: string, text: string, custom = ''): Promise<WritingResult> =>
  request<WritingResult>('/api/writing/run', {
    method: 'POST',
    body: JSON.stringify({ action, text, custom }),
  })

export interface ContextResult {
  prompt: string
}

/** 上下文 → 模型 → 一段可直接生图的画面描述 */
export const buildPromptFromContext = (
  text: string,
  style: string,
  elements: string[]
): Promise<ContextResult> =>
  request<ContextResult>('/api/image/context', {
    method: 'POST',
    body: JSON.stringify({ text, style, elements }),
  })

export interface GenerateRequest {
  jobId: string
  prompt: string
  style: string
  size?: number
}

export interface GenerateResult {
  ok: boolean
  file?: string
  error?: string
}

export const generateImage = (req: GenerateRequest): Promise<GenerateResult> =>
  request<GenerateResult>('/api/image/generate', {
    method: 'POST',
    body: JSON.stringify(req),
  })

export const cancelImage = (jobId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>('/api/image/cancel', {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  })

export interface ElementInfo {
  /** 元素 id（p1_01 这类），用作列表 key */
  id: string
  /** 中文名，会拼进提示词 */
  name: string
  /** 图片路径（桥静态托管，相对根） */
  file: string
}

export const listElements = (): Promise<{ elements: ElementInfo[]; styles: Array<{ key: string; name: string }> }> =>
  request('/api/image/elements')
