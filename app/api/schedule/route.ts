import { liveCache } from '../../../src/server/instance.ts'

export function GET(request: Request): Promise<Response> {
  return liveCache.schedule(request)
}
