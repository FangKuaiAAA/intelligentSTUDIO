import { resolve } from 'path';
import { defineConfig } from 'vite';

// Node 推理后端：产出 CommonJS 单文件，native 模块保持外部依赖
export default defineConfig({
  build: {
    target: 'node22',
    ssr: resolve(__dirname, 'src/backend/worker.ts'),
    outDir: 'dist-backend',
    emptyOutDir: true,
    rollupOptions: {
      external: ['onnxruntime-node', 'sharp', 'exifr', 'electron'],
      output: {
        format: 'cjs',
        // package.json 声明了 type: module，必须用 .cjs 才能按 CommonJS 运行
        entryFileNames: 'worker.cjs',
      },
    },
  },
});
