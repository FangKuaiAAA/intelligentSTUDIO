/**
 * 收藏项匹配（纯函数，不依赖 chrome API，便于离线单测）。
 *
 * 为什么要单独一层：模型给的目标常常不是"逐字一致"的 ——
 *   · 网址可能少写末尾斜杠（https://www.baidu.com 与 .../baidu.com/ 是同一页）
 *   · 可能不带协议（www.baidu.com）、主机名大小写不同
 *   · 标题可能只写了关键字（"百度"而不是"百度一下"）
 * 精确匹配优先；精确没命中时再做一次**近似匹配**，由确认弹窗把结果摊给用户看，
 * 用户点「允许」才算数 —— 容错但不失控。
 */

export interface MatchTargets {
  ids?: string[]
  urls?: string[]
  titles?: string[]
}

export interface MatchItem {
  id: string
  title: string
  url: string
  path: string
}

export interface MatchResult {
  matched: MatchItem[]
  /** true 表示这些结果是近似匹配（精确匹配一条都没命中） */
  fuzzy: boolean
}

/** 网址归一化：补协议、主机小写、去掉末尾斜杠，保留查询串 */
export function normalizeUrl(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return text.toLowerCase()
  }
}

export function normalizeTitle(raw: string): string {
  return String(raw || '').trim().toLowerCase()
}

/** 近似匹配的最小长度：太短的关键字（如"网"）会把半个收藏夹都圈进来 */
const MIN_FUZZY_URL = 6
const MIN_FUZZY_TITLE = 2

export function selectBookmarkTargets(all: MatchItem[], targets: MatchTargets): MatchResult {
  const ids = new Set((targets.ids ?? []).map((v) => String(v).trim()).filter(Boolean))
  const urls = [...new Set((targets.urls ?? []).map(normalizeUrl).filter(Boolean))]
  const titles = [...new Set((targets.titles ?? []).map(normalizeTitle).filter(Boolean))]

  const matched = all.filter((item) => {
    if (ids.has(item.id)) return true
    if (item.url && urls.includes(normalizeUrl(item.url))) return true
    return titles.includes(normalizeTitle(item.title))
  })
  if (matched.length || (!urls.length && !titles.length)) {
    return { matched, fuzzy: false }
  }

  // 近似匹配只做**单向包含**（"条目里含关键字"）：双向包含会让关键词在深层路径时
  // 把上层域名/父条目也一起圈进来，删除范围会莫名其妙变大。
  const fuzzy = all.filter((item) => {
    if (!item.url) return false
    const url = normalizeUrl(item.url)
    const title = normalizeTitle(item.title)
    const urlHit = urls.some((u) => u.length >= MIN_FUZZY_URL && url.includes(u))
    const titleHit = titles.some((t) => t.length >= MIN_FUZZY_TITLE && title.includes(t))
    return urlHit || titleHit
  })
  return { matched: fuzzy, fuzzy: fuzzy.length > 0 }
}
