import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mobile: resolve(__dirname, 'mobile.html')
      }
    }
  },
  server: {
    port: 5173,
    open: false,
    // 现场移动端页面经 Vite 同源代理访问推演网关，避免跨域
    proxy: {
      '/sims': 'http://127.0.0.1:7100',
      '/live': 'http://127.0.0.1:7100'
    }
  }
})
