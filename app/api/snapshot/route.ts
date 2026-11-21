import { liveCache } from '../../../src/server/liveCache.ts'

export function GET(request: Request): Promise<Response> {
  return liveCache.snapshot(request)
}
