import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const resolvedAgainstThisFile = (name: string) => new URL(name, import.meta.url).pathname

const APP_ENTRY = resolvedAgainstThisFile('index.html')
const GALLERY_ENTRY_KEPT_OUT_OF_DIST = resolvedAgainstThisFile('dev.html')

const galleryIsBuiltIntoAThrowawayDist = !!process.env.ORBIT_GALLERY

const REACHABLE_FROM_PHONE_ON_THE_LAN = true
const EVERY_TAILNET_HOST = '.ts.net'

const stampServiceWorker = () => ({
  name: 'orbit-stamp-sw',
  closeBundle() {
    const file = fileURLToPath(new URL('dist/sw.js', import.meta.url))
    if (!existsSync(file)) return
    const stamp = Date.now().toString(36)
    writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD__', stamp))
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  build: galleryIsBuiltIntoAThrowawayDist
    ? { rollupOptions: { input: { app: APP_ENTRY, gallery: GALLERY_ENTRY_KEPT_OUT_OF_DIST } } }
    : {},
  server: {
    host: REACHABLE_FROM_PHONE_ON_THE_LAN,
    allowedHosts: [EVERY_TAILNET_HOST],
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:7788',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:7788',
      },
    },
  },
})
