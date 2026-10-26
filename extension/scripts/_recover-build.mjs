/**
 * 一次性救援工具：把可恢复的收藏夹内容汇总成「合并清单 + 可导入的 HTML 文件 + 源文件副本」。
 * 只读原文件；产物写到 %TEMP%\dony-bookmark-recovery\，不触碰 Edge 配置。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data')
const OUT = join(tmpdir(), 'dony-bookmark-recovery')
const SRC = join(OUT, 'sources')

const TEST_RE = /example\.com|站点 A|站点 B|站点 C/
const isTest = (title, url) => TEST_RE.test(`${title} ${url}`)

function readBookmarks(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const items = []
  const walk = (nodes, folderPath) => {
    for (const n of nodes || []) {
      if (n.type === 'url') items.push({ folder: folderPath, title: n.name, url: n.url, dateAdded: n.date_added })
      else walk(n.children, [...folderPath, n.name])
    }
  }
  for (const [key, node] of Object.entries(data.roots || {})) {
    if (!node) continue
    walk(node.children, [node.name || key])
  }
  return items
}

mkdirSync(SRC, { recursive: true })

// ---- 1) 源文件副本（原样保存，便于日后核对） ----
const sources = []
const bak = join(EDGE, 'Default', 'Bookmarks.bak')
if (existsSync(bak)) {
  const dest = join(SRC, 'Default-Bookmarks.bak')
  copyFileSync(bak, dest)
  sources.push({ label: 'Default Bookmarks.bak（12:08 的本机备份）', file: dest })
}
const cur = join(EDGE, 'Default', 'Bookmarks')
if (existsSync(cur)) {
  const dest = join(SRC, 'Default-Bookmarks.current')
  copyFileSync(cur, dest)
  sources.push({ label: 'Default Bookmarks（当前，含测试残留）', file: dest })
}
const tmp = tmpdir()
for (const dir of readdirSync(tmp)) {
  if (!/^dony-/.test(dir)) continue
  const p = join(tmp, dir, 'Default', 'Bookmarks')
  if (!existsSync(p)) continue
  const dest = join(SRC, `${dir}.Bookmarks`)
  copyFileSync(p, dest)
  sources.push({ label: `测试配置副本 ${dir}`, file: dest })
}

// ---- 2) 合并可恢复条目（每个网址只留一条，剔除测试数据） ----
const merged = new Map()
const provenance = new Map()
const testFound = new Set()
for (const s of sources) {
  let items = []
  try {
    items = readBookmarks(s.file)
  } catch (e) {
    console.log('跳过无法解析的来源：', s.file, e.message)
    continue
  }
  for (const it of items) {
    if (isTest(it.title, it.url)) {
      testFound.add(`${it.title} — ${it.url}`)
      continue
    }
    if (!it.url || it.url === 'javascript:void(0)') continue
    const key = `${it.folder.join('/')}|${it.url}`
    if (!merged.has(key)) {
      merged.set(key, it)
      provenance.set(key, s.label)
    }
  }
}

const items = [...merged.values()].sort((a, b) => a.folder.join('/').localeCompare(b.folder.join('/')))
console.log(`可恢复条目 ${items.length} 条：`)
for (const it of items) {
  console.log(`  · [${it.folder.join('/')}] ${it.title} — ${it.url}   ← ${provenance.get(`${it.folder.join('/')}|${it.url}`)}`)
}
console.log(`\n已剔除的测试条目（不属于你）：${[...testFound].join(' | ') || '（无）'}`)

// ---- 3) 产物：JSON 清单 + 可导入的 HTML ----
writeFileSync(join(OUT, 'bookmarks-recovery.json'),
  JSON.stringify({ generatedAt: new Date().toLocaleString('zh-CN'), items }, null, 2), 'utf8')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const linkRow = (it, indent) => `${indent}<DT><A HREF="${esc(it.url)}" ADD_DATE="${it.dateAdded || 0}">${esc(it.title)}</A>`
// 顶层直接是条目（导入后会落进收藏夹栏），子目录还原成文件夹
const bars = items.filter((it) => it.folder.length === 1)
const folders = new Map()
for (const it of items.filter((i) => i.folder.length > 1)) {
  const name = it.folder[it.folder.length - 1]
  if (!folders.has(name)) folders.set(name, [])
  folders.get(name).push(it)
}
const body = [
  ...bars.map((it) => linkRow(it, '    ')),
  ...[...folders.entries()].map(([name, list]) => [
    `    <DT><H3>${esc(name)}</H3>`,
    '    <DL><p>',
    ...list.map((it) => linkRow(it, '        ')),
    '    </DL><p>',
  ].join('\n')),
].join('\n')
const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}
</DL><p>
`
writeFileSync(join(OUT, 'bookmarks-recovery.html'), html, 'utf8')

// ---- 4) 待批准才执行的恢复脚本（默认不运行） ----
const restoreScript = `# 把恢复清单写回 Edge 的 Default 配置。**必须先完全退出 Edge**。
$ErrorActionPreference = 'Stop'
$edge = Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data'
$bookmarks = Join-Path $edge 'Default\\Bookmarks'
if (Get-Process msedge -ErrorAction SilentlyContinue) { throw '请先完全退出 Edge（含后台进程）再运行本脚本' }
$json = Get-Content -Raw -Encoding UTF8 '${join(OUT, 'bookmarks-recovery.json')}' | ConvertFrom-Json
$data = Get-Content -Raw -Encoding UTF8 $bookmarks | ConvertFrom-Json
Copy-Item $bookmarks "$bookmarks.pre-restore-$(Get-Date -Format yyyyMMdd-HHmmss)"
# 只重建「收藏夹栏」：先清空，再按清单写入
$bar = $data.roots.bookmark_bar
$bar.children = @()
foreach ($it in $json.items | Where-Object { $_.folder -like '*收藏夹栏*' }) {
  $bar.children += [pscustomobject]@{ date_added = "$([int64](Get-Date -UFormat %s) * 1000000)"; guid = [guid]::NewGuid().ToString(); id = "$((Get-Random -Minimum 1000 -Maximum 99999))"; name = $it.title; type = 'url'; url = $it.url }
}
$data.roots.bookmark_bar = $bar
($data | ConvertTo-Json -Depth 32) | Set-Content -Encoding UTF8 $bookmarks
Write-Host '已写回' $bookmarks '，请启动 Edge 检查。'
`
writeFileSync(join(OUT, 'restore-profile.ps1'), restoreScript, 'utf8')

console.log(`\n产物目录：${OUT}`)
console.log('  bookmarks-recovery.json   合并清单')
console.log('  bookmarks-recovery.html   可在 Edge「导入收藏夹 → 从 HTML 文件」直接导入')
console.log('  restore-profile.ps1       直接写回配置（需先退出 Edge；默认不执行）')
console.log(`  sources/                  原始文件副本 ${sources.length} 份`)
