import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  // a port of its own, so it never collides with other projects on 5173
  server: { port: 5180, strictPort: true },
  build: { chunkSizeWarningLimit: 900 },
})
