import { liveCache } from './instance.ts'

type NodeRequest = {
  method?: string
  url?: string
}

type NodeResponse = {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: Uint8Array): void
}

type Next = (error?: unknown) => void

export function attachLiveCache(middlewares: {
  use(handler: (req: NodeRequest, res: NodeResponse, next: Next) => void): unknown
}) {
  middlewares.use((req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api/schedule' && url.pathname !== '/api/snapshot') {
      next()
      return
    }
    void serve(url, req, res).catch(next)
  })
}

async function serve(url: URL, req: NodeRequest, res: NodeResponse) {
  const request = new Request(url, { method: req.method ?? 'GET' })
  const response = await liveCache.handle(request)
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  res.end(new Uint8Array(await response.arrayBuffer()))
}
