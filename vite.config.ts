import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The review UI (tech design T9): built to static files served by the app; no inline scripts (CSP script-src 'self').
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
})
