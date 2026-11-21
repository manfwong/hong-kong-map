import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

function liveCachePlugin(): Plugin {
  return {
    name: 'hk-live-cache',
    async configureServer(server) {
      const { attachLiveCache } = await loadAttach()
      attachLiveCache(server.middlewares)
    },
    async configurePreviewServer(server) {
      const { attachLiveCache } = await loadAttach()
      attachLiveCache(server.middlewares)
    },
  }
}

async function loadAttach(): Promise<{
  attachLiveCache: (middlewares: { use: (...args: never[]) => unknown }) => void
}> {
  const href = pathToFileURL(resolve(process.cwd(), 'src/server/attach.ts')).href
  return import(href) as Promise<{
    attachLiveCache: (middlewares: { use: (...args: never[]) => unknown }) => void
  }>
}

export default defineConfig({
  plugins: [react(), tailwindcss(), liveCachePlugin()],
  server: {
    host: '0.0.0.0',
    port: 4178,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4178,
    strictPort: true,
  },
})
