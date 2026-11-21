import { createLiveCache, type LiveCache } from './liveCache.ts'

type AssetFetcher = {
  fetch(input: Request): Promise<Response>
}

type StationFile = {
  stations: Array<{ code: string; lines: Array<{ code: string }> }>
}

let cache: LiveCache | null = null

async function sharedCache(request: Request, assets: AssetFetcher): Promise<LiveCache> {
  if (cache) return cache
  const origin = new URL(request.url).origin
  const [networkResponse, cameraResponse] = await Promise.all([
    assets.fetch(new Request(`${origin}/data/network.json`)),
    assets.fetch(new Request(`${origin}/data/cameras.json`)),
  ])
  if (!networkResponse.ok || !cameraResponse.ok) throw new Error('allowlist')
  const network = (await networkResponse.json()) as StationFile
  const cameras = (await cameraResponse.json()) as Array<{ key: string }>
  const stations: Record<string, string[]> = {}
  for (const station of network.stations) stations[station.code] = station.lines.map((line) => line.code)
  cache = createLiveCache({ stations, cameras: cameras.map((camera) => camera.key) })
  return cache
}

export default {
  async fetch(request: Request, env: { ASSETS: AssetFetcher }): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/api/schedule' || path === '/api/snapshot') {
      try {
        return (await sharedCache(request, env.ASSETS)).handle(request)
      } catch {
        return new Response('暫時未能讀取車站名單。', { status: 503, headers: { 'cache-control': 'no-store' } })
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('方法不支援', { status: 405 })
    return env.ASSETS.fetch(request)
  },
}
