import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { existsSync, rmSync } from 'node:fs'

const ROOT = __dirname
const OUT = resolve(ROOT, 'dist')
const SRC = resolve(ROOT, 'src')          // 扩展自身源码（同时是 ext 构建的 root）
const DONY_SRC = resolve(ROOT, '../src')  // 主项目源码：只读复用视觉智能组件
const NM = resolve(ROOT, '../node_modules')

/**
 * ⚠ 依赖解析必须全部指向**同一份** React：
 * 视觉智能组件来自 ../src，那里的 `import 'react'` 默认会向上找到主项目的
 * node_modules；扩展这份 bundle 里一旦出现两个 React 副本，hooks 必然报
 * “Invalid hook call”。所以这里显式把 react/react-dom 别名到主项目那一份
 * （扩展目录不重复安装，两处共用同一份），并对 framer-motion 做 dedupe。
 */
const alias = [
  { find: /^@dony\//, replacement: DONY_SRC + '/' },
  { find: /^react$/, replacement: resolve(NM, 'react/index.js') },
  { find: /^react\/jsx-runtime$/, replacement: resolve(NM, 'react/jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/, replacement: resolve(NM, 'react/jsx-dev-runtime.js') },
  { find: /^react-dom$/, replacement: resolve(NM, 'react-dom/index.js') },
  { find: /^react-dom\/client$/, replacement: resolve(NM, 'react-dom/client.js') },
]

/** 内容脚本把样式通过 ?inline 内联进 Shadow DOM，构建出的 style.css 是多余产物，删掉 */
const dropInlinedCss = {
  name: 'drop-inlined-css',
  closeBundle() {
    const file = resolve(OUT, 'style.css')
    try {
      if (existsSync(file)) rmSync(file)
    } catch (e) {
      console.warn('[drop-inlined-css] 删除多余样式失败：', e)
    }
  },
}

const shared = {
  plugins: [react()],
  resolve: { alias, dedupe: ['react', 'react-dom', 'framer-motion'] },
  define: { 'process.env.NODE_ENV': '"production"' },
  base: './',
}

export default defineConfig(({ mode }) => {
  // ---- 内容脚本：单文件 IIFE（MV3 的内容脚本不能是 ES 模块） ----
  if (mode === 'content') {
    return {
      ...shared,
      plugins: [...shared.plugins, dropInlinedCss],
      root: SRC,
      build: {
        outDir: OUT,
        emptyOutDir: false,          // Ext 构建已产出 popup/background，不能清空
        target: 'chrome110',
        cssCodeSplit: false,
        lib: {
          entry: resolve(SRC, 'content/visual.tsx'),
          name: 'IntelligentStudioVisual',
          formats: ['iife'],
          fileName: () => 'content.js',
        },
        rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
      },
    }
  }

  // ---- 扩展页：popup 页面 + 后台 service worker（ES 模块） ----
  return {
    ...shared,
    root: SRC,
    publicDir: resolve(ROOT, 'public'),
    build: {
      outDir: OUT,
      emptyOutDir: true,
      target: 'chrome110',
      rollupOptions: {
        input: {
          popup: resolve(SRC, 'popup/index.html'),
          background: resolve(SRC, 'background/index.ts'),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})
