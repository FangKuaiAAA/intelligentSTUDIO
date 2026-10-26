import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const ROOT = __dirname
const SRC = resolve(ROOT, 'src')
const DONY_SRC = resolve(ROOT, '../src') // 主项目源码：只读复用彩虹药丸
const NM = resolve(ROOT, '../node_modules')

/**
 * 依赖解析全部指向主项目那一份 React：`@dony/rainbow` 来自 ../src，
 * 若 bundle 里出现两份 React，hooks 会直接报 Invalid hook call（扩展子包同样处理）。
 */
const alias = [
  { find: /^@dony\//, replacement: DONY_SRC + '/' },
  { find: /^react$/, replacement: resolve(NM, 'react/index.js') },
  { find: /^react\/jsx-runtime$/, replacement: resolve(NM, 'react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/, replacement: resolve(NM, 'react/jsx-dev-runtime.js') },
  { find: /^react-dom$/, replacement: resolve(NM, 'react-dom/index.js') },
  { find: /^react-dom\/client$/, replacement: resolve(NM, 'react-dom/client.js') },
]

export default defineConfig({
  plugins: [react()],
  base: './',
  root: SRC,
  publicDir: resolve(ROOT, 'public'),
  resolve: { alias, dedupe: ['react', 'react-dom', 'framer-motion'] },
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: resolve(ROOT, 'dist'),
    emptyOutDir: true,
    target: 'chrome110',
    rollupOptions: {
      input: { taskpane: resolve(SRC, 'taskpane.html') },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
