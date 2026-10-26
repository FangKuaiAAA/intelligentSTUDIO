/**
 * 打包前清除记忆：Dony 的长期记忆属于使用者本人，绝不能随程序分发。
 * 记忆文件位于 %APPDATA%\Dony\memory.json（不在项目里），electron:build 会先跑这里。
 * 手动清除：npm run clean:memory
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const targets = [
  path.join(appData, 'Dony', 'memory.json'),
  // 万一有人把记忆复制进了项目，也一并清掉，避免被打进安装包
  path.join(__dirname, '..', 'backend', 'agent', 'memory.json'),
]

let removed = 0
for (const file of targets) {
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      console.log(`[clean-memory] 已删除：${file}`)
      removed++
    }
  } catch (err) {
    console.error(`[clean-memory] 删除失败 ${file}：${err.message}`)
    process.exitCode = 1
  }
}
console.log(removed ? `[clean-memory] 共清除 ${removed} 个记忆文件` : '[clean-memory] 没有需要清除的记忆')
