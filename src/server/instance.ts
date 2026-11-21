import { cameraKeys, stations } from './allowlist.ts'
import { createLiveCache } from './liveCache.ts'

export const liveCache = createLiveCache({ stations, cameras: cameraKeys })
