import { defineConfig } from 'vite';

// 产物直接落到 photo-app/Assets/Viewer，由 ReframePanel 的虚拟主机提供
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../../Assets/Viewer',
    emptyOutDir: true,
    target: 'chrome110',
    assetsInlineLimit: 0,
  },
});
