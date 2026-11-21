import { liveCache } from './instance.ts'

type AssetFetcher = {
  fetch(input: Request): Promise<Response>
}

export default {
  async fetch(request: Request, env: { ASSETS: AssetFetcher }): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/api/schedule' || path === '/api/snapshot') return liveCache.handle(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('方法不支援', { status: 405 })
    return env.ASSETS.fetch(request)
  },
}
