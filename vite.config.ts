import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        alarm: resolve(__dirname, 'alarm.html'),
        tray: resolve(__dirname, 'tray.html'),
        notify: resolve(__dirname, 'notify.html'),
      },
    },
  },
})
