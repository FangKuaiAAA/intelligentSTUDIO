/**
 * 收藏项匹配的离线单测（不启动浏览器、不接触任何真实收藏夹）。
 *
 * 做法：用 tsc 把纯函数模块 src/background/match.ts 编译到临时目录，再 import 进来跑断言。
 * 覆盖实际踩过的坑：网址末尾斜杠、缺协议、主机大小写、标题只写关键字、按 id 删除。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT = resolve(HERE, '..')

// 直接用 node 跑本地 tsc（避免 npx/shell 带来的转义与告警）
const TSC = [
  join(EXT, 'node_modules', 'typescript', 'bin', 'tsc'),
  resolve(EXT, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
].find((p) => existsSync(p))
if (!TSC) throw new Error('找不到 typescript（请在 extension 或项目根目录 npm install）')

const outDir = mkdtempSync(join(tmpdir(), 'dony-match-test-'))
execFileSync(process.execPath, [
  TSC, join(EXT, 'src', 'background', 'match.ts'),
  '--outDir', outDir, '--target', 'es2022', '--module', 'es2022',
  '--moduleResolution', 'bundler', '--skipLibCheck',
], { cwd: EXT, stdio: 'inherit' })
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }))

const { selectBookmarkTargets, normalizeUrl } = await import(pathToFileURL(join(outDir, 'match.js')).href)

const ALL = [
  { id: '11', title: '百度一下', url: 'https://www.baidu.com/', path: '其他收藏夹' },
  { id: '12', title: 'DeepSeek - 探索未至之境', url: 'https://chat.deepseek.com/', path: '其他收藏夹/chat.deepseek.com' },
  { id: '13', title: 'Safari添加个人收藏 - DeepSeek', url: 'https://chat.deepseek.com/a/chat/s/fac0f2df', path: '其他收藏夹/chat.deepseek.com' },
  { id: '14', title: 'Bing', url: 'https://cn.bing.com/', path: '其他收藏夹' },
]

const cases = [
  { name: '标题完全匹配', targets: { titles: ['百度一下'] }, expect: ['11'], fuzzy: false },
  { name: '网址末尾斜杠省略', targets: { urls: ['https://www.baidu.com'] }, expect: ['11'], fuzzy: false },
  { name: '网址缺协议', targets: { urls: ['www.baidu.com'] }, expect: ['11'], fuzzy: false },
  { name: '网址主机大小写不同', targets: { urls: ['HTTPS://WWW.BAIDU.COM/'] }, expect: ['11'], fuzzy: false },
  { name: '按 id 删除', targets: { ids: ['12'] }, expect: ['12'], fuzzy: false },
  { name: '标题只给关键字（近似）', targets: { titles: ['百度'] }, expect: ['11'], fuzzy: true },
  { name: '域名根路径精确命中', targets: { urls: ['chat.deepseek.com'] }, expect: ['12'], fuzzy: false },
  { name: '网址片段（近似）', targets: { urls: ['chat.deepseek.com/a/chat'] }, expect: ['13'], fuzzy: true },
  { name: '标题大小写不敏感', targets: { titles: ['bing'] }, expect: ['14'], fuzzy: false },
  { name: '完全不相关', targets: { titles: ['不存在的站点'] }, expect: [], fuzzy: false },
  { name: '没有给目标', targets: {}, expect: [], fuzzy: false },
]

let failed = 0
for (const c of cases) {
  const { matched, fuzzy } = selectBookmarkTargets(ALL, c.targets)
  const ids = matched.map((m) => m.id).sort()
  const ok = JSON.stringify(ids) === JSON.stringify([...c.expect].sort()) && fuzzy === c.fuzzy
  console.log(`${ok ? '✓' : '✗'} ${c.name} → ${JSON.stringify(ids)} fuzzy=${fuzzy}${ok ? '' : `（期望 ${JSON.stringify(c.expect)} fuzzy=${c.fuzzy}）`}`)
  if (!ok) failed += 1
}

if (normalizeUrl('https://WWW.Baidu.com') !== 'https://www.baidu.com') {
  console.log('✗ normalizeUrl 未按预期归一化')
  failed += 1
}

console.log(failed ? `\n匹配逻辑单测未通过：${failed} 项` : '\n匹配逻辑单测全部通过')
process.exitCode = failed ? 1 : 0
