import { cameraKeys, stations as publishedStations } from './allowlist.ts'

const SCHEDULE_TTL_MS = 60_000
const SNAPSHOT_TTL_MS = 120_000
const FAILURE_TTL_MS = 60_000
const STALE_MS = 10 * 60_000
const BUDGET_WINDOW_MS = 60_000
const SCHEDULE_BUDGET = 150
const SNAPSHOT_BUDGET = 240
const GAP_MS = 250
const TIMEOUT_MS = 8_000
const BLOCK_MS = 60_000
const MAX_JSON_BYTES = 200_000
const MAX_IMAGE_BYTES = 1_500_000
const MAX_IMAGES = 48

const SCHEDULE_HOST = 'rt.data.gov.hk'
const SNAPSHOT_HOST = 'tdcctv.data.one.gov.hk'

type Kind = 'schedule' | 'snapshot'

type MemoryRecord = {
  ok: boolean
  body: Uint8Array
  contentType: string
  storedAt: number
  freshUntil: number
  staleUntil: number
}

type Load = {
  record: MemoryRecord
  fetched: boolean
}

type UpstreamResult = {
  status: number
  body: Uint8Array
}

type Upstream = (url: string, signal: AbortSignal) => Promise<UpstreamResult>

type EdgeHit = {
  body: Uint8Array
  contentType: string
  storedAt: number
}

type EdgeCache = {
  get(url: string): Promise<EdgeHit | null>
  put(url: string, body: Uint8Array, contentType: string, ttlSeconds: number, storedAt: number): Promise<void>
}

type Options = {
  now?: () => number
  upstream?: Upstream
  edge?: EdgeCache | null
  stations?: Readonly<Record<string, readonly string[]>>
  cameras?: readonly string[]
  scheduleTtlMs?: number
  snapshotTtlMs?: number
  failureTtlMs?: number
  staleMs?: number
  gapMs?: number
  scheduleBudget?: number
  snapshotBudget?: number
  budgetWindowMs?: number
  timeoutMs?: number
  blockMs?: number
}

export type LiveCache = {
  handle(request: Request): Promise<Response>
  schedule(request: Request): Promise<Response>
  snapshot(request: Request): Promise<Response>
}

export function createLiveCache(options: Options = {}): LiveCache {
  const now = options.now ?? (() => Date.now())
  const upstream = options.upstream ?? defaultUpstream
  const edge = options.edge === undefined ? cloudflareCache() : options.edge
  const stationLines = options.stations ?? publishedStations
  const cameras = new Set(options.cameras ?? cameraKeys)
  const scheduleTtlMs = options.scheduleTtlMs ?? SCHEDULE_TTL_MS
  const snapshotTtlMs = options.snapshotTtlMs ?? SNAPSHOT_TTL_MS
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS
  const staleMs = options.staleMs ?? STALE_MS
  const gapMs = options.gapMs ?? GAP_MS
  const budgetWindowMs = options.budgetWindowMs ?? BUDGET_WINDOW_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const blockMs = options.blockMs ?? BLOCK_MS
  const budgets: Record<Kind, number> = {
    schedule: options.scheduleBudget ?? SCHEDULE_BUDGET,
    snapshot: options.snapshotBudget ?? SNAPSHOT_BUDGET,
  }
  const memory = new Map<string, MemoryRecord>()
  const inflight = new Map<string, Promise<Load>>()
  const starts: Record<Kind, number[]> = { schedule: [], snapshot: [] }
  const blockedUntil: Record<Kind, number> = { schedule: 0, snapshot: 0 }
  const chains: Record<Kind, Promise<void>> = { schedule: Promise.resolve(), snapshot: Promise.resolve() }
  const lastStart: Record<Kind, number> = { schedule: 0, snapshot: 0 }

  function fresh(key: string): MemoryRecord | null {
    const record = memory.get(key)
    if (!record || now() >= record.freshUntil) return null
    memory.delete(key)
    memory.set(key, record)
    return record
  }

  function usableStale(key: string): MemoryRecord | null {
    const record = memory.get(key)
    if (!record?.ok || now() >= record.staleUntil) return null
    return record
  }

  function remember(key: string, body: Uint8Array, contentType: string, ttlMs: number): MemoryRecord {
    const storedAt = now()
    const record: MemoryRecord = {
      ok: true,
      body,
      contentType,
      storedAt,
      freshUntil: storedAt + ttlMs,
      staleUntil: storedAt + staleMs,
    }
    memory.delete(key)
    memory.set(key, record)
    if (key.startsWith('snapshot:')) trimSnapshots()
    return record
  }

  function rememberFailure(key: string): MemoryRecord {
    const existing = usableStale(key)
    if (existing) return existing
    const storedAt = now()
    const record: MemoryRecord = {
      ok: false,
      body: new Uint8Array(),
      contentType: '',
      storedAt,
      freshUntil: storedAt + failureTtlMs,
      staleUntil: storedAt + failureTtlMs,
    }
    memory.set(key, record)
    return record
  }

  function trimSnapshots() {
    let count = 0
    for (const key of memory.keys()) if (key.startsWith('snapshot:')) count += 1
    for (const key of memory.keys()) {
      if (count <= MAX_IMAGES) break
      if (!key.startsWith('snapshot:')) continue
      memory.delete(key)
      count -= 1
    }
  }

  function take(kind: Kind): boolean {
    const current = now()
    if (current < blockedUntil[kind]) return false
    const window = starts[kind]
    while (window.length > 0 && current - window[0] >= budgetWindowMs) window.shift()
    if (window.length >= budgets[kind]) return false
    window.push(current)
    return true
  }

  function pace(kind: Kind): Promise<void> {
    const run = async () => {
      const wait = lastStart[kind] + gapMs - now()
      if (wait > 0) await sleep(wait)
      lastStart[kind] = now()
    }
    const next = chains[kind].then(run, run)
    chains[kind] = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function load(kind: Kind, key: string, url: string, ttlMs: number, accept: (body: Uint8Array) => boolean): Promise<Load> {
    const hit = fresh(key)
    if (hit) return { record: hit, fetched: false }
    const pending = inflight.get(key)
    if (pending) return pending
    const task = (async (): Promise<Load> => {
      const edged = await readEdge(edge, url, ttlMs, staleMs)
      if (edged && now() < edged.freshUntil) {
        memory.delete(key)
        memory.set(key, edged)
        return { record: edged, fetched: false }
      }
      if (!take(kind)) {
        const stale = usableStale(key)
        if (stale) return { record: stale, fetched: false }
        return { record: rememberFailure(key), fetched: false }
      }
      await pace(kind)
      if (now() < blockedUntil[kind]) return { record: coolDown(key, usableStale(key)), fetched: false }
      try {
        const result = await upstream(url, AbortSignal.timeout(timeoutMs))
        if (result.status === 429) blockedUntil[kind] = now() + blockMs
        if (result.status !== 200 || !accept(result.body)) {
          return { record: coolDown(key, usableStale(key)), fetched: true }
        }
        const contentType = kind === 'schedule' ? 'application/json' : 'image/jpeg'
        const record = remember(key, result.body, contentType, ttlMs)
        await writeEdge(edge, url, result.body, contentType, Math.round(ttlMs / 1000), record.storedAt)
        return { record, fetched: true }
      } catch {
        return { record: coolDown(key, usableStale(key)), fetched: true }
      }
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      if (inflight.get(key) === task) inflight.delete(key)
    }
  }

  function coolDown(key: string, stale: MemoryRecord | null): MemoryRecord {
    if (!stale) return rememberFailure(key)
    const updated = { ...stale, freshUntil: Math.max(stale.freshUntil, now() + failureTtlMs) }
    memory.set(key, updated)
    return updated
  }

  async function schedule(request: Request): Promise<Response> {
    if (request.method !== 'GET') return plain('方法不支援', 405, 'no-store')
    const sta = new URL(request.url).searchParams.get('sta') ?? ''
    const lines = stationLine(sta, stationLines)
    if (!lines) return plain('未知車站', 400, 'no-store')
    const loaded = await Promise.all(lines.map((line) => load('schedule', `schedule:${line}:${sta}`, scheduleUrl(line, sta), scheduleTtlMs, looksLikeJson)))
    let fetched = false
    let failed = false
    const payload: Record<string, { ok: false } | { ok: true; storedAt: number; payload: unknown }> = {}
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const item = loaded[index]
      if (item.fetched) fetched = true
      if (!item.record.ok) {
        failed = true
        payload[line] = { ok: false }
        continue
      }
      try {
        payload[line] = { ok: true, storedAt: item.record.storedAt, payload: JSON.parse(decoder.decode(item.record.body)) }
      } catch {
        failed = true
        payload[line] = { ok: false }
      }
    }
    return json({ station: sta, lines: payload }, failed ? 'public, max-age=15' : 'public, max-age=60', fetched ? 'miss' : 'hit')
  }

  async function snapshot(request: Request): Promise<Response> {
    if (request.method !== 'GET') return plain('方法不支援', 405, 'no-store')
    const key = new URL(request.url).searchParams.get('key') ?? ''
    if (!/^[A-Za-z0-9]+$/.test(key) || !cameras.has(key)) return plain('未知快拍點', 400, 'no-store')
    const item = await load('snapshot', `snapshot:${key}`, snapshotUrl(key), snapshotTtlMs, looksLikeJpeg)
    if (!item.record.ok) return plain('暫時未能取得快拍', 502, 'public, max-age=15', item.fetched ? 'miss' : 'hit')
    return new Response(copyBytes(item.record.body), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
        'x-cache': item.fetched ? 'miss' : 'hit',
      },
    })
  }

  return {
    schedule,
    snapshot,
    async handle(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      if (path === '/api/schedule') return schedule(request)
      if (path === '/api/snapshot') return snapshot(request)
      if (request.method !== 'GET') return plain('方法不支援', 405, 'no-store')
      return plain('找不到', 404, 'no-store')
    },
  }
}

export const liveCache = createLiveCache()

const decoder = new TextDecoder()

function stationLine(sta: string, stationLines: Readonly<Record<string, readonly string[]>>): readonly string[] | null {
  if (!/^[A-Z0-9]{2,5}$/.test(sta)) return null
  return stationLines[sta] ?? null
}

function scheduleUrl(line: string, sta: string): string {
  const url = new URL('https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php')
  url.searchParams.set('line', line)
  url.searchParams.set('sta', sta)
  url.searchParams.set('lang', 'TC')
  if (url.host !== SCHEDULE_HOST || url.pathname !== '/v1/transport/mtr/getSchedule.php') throw new Error('bad schedule url')
  return url.toString()
}

function snapshotUrl(key: string): string {
  const url = new URL(`https://${SNAPSHOT_HOST}/${key}.JPG`)
  if (url.host !== SNAPSHOT_HOST || url.pathname !== `/${key}.JPG`) throw new Error('bad snapshot url')
  return url.toString()
}

function looksLikeJson(body: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(decoder.decode(body))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function looksLikeJpeg(body: Uint8Array): boolean {
  return body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
}

function copyBytes(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy
}

function json(body: unknown, cacheControl: string, cache: 'hit' | 'miss'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'x-cache': cache,
    },
  })
}

function plain(body: string, status: number, cacheControl: string, cache?: 'hit' | 'miss'): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  }
  if (cache) headers['x-cache'] = cache
  return new Response(body, { status, headers })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readEdge(edge: EdgeCache | null, url: string, ttlMs: number, staleMs: number): Promise<MemoryRecord | null> {
  if (!edge) return null
  try {
    const hit = await edge.get(url)
    if (!hit || hit.body.byteLength === 0) return null
    return {
      ok: true,
      body: hit.body,
      contentType: hit.contentType,
      storedAt: hit.storedAt,
      freshUntil: hit.storedAt + ttlMs,
      staleUntil: hit.storedAt + staleMs,
    }
  } catch {
    return null
  }
}

async function writeEdge(edge: EdgeCache | null, url: string, body: Uint8Array, contentType: string, ttlSeconds: number, storedAt: number) {
  if (!edge) return
  try {
    await edge.put(url, body, contentType, ttlSeconds, storedAt)
  } catch {
    // The in-memory copy still serves this process.
  }
}

function cloudflareCache(): EdgeCache | null {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches
  const cache = storage?.default
  if (!cache) return null
  return {
    async get(url: string): Promise<EdgeHit | null> {
      const hit = await cache.match(new Request(url))
      if (!hit || hit.status !== 200) return null
      const storedAt = Number(hit.headers.get('x-stored-at'))
      const body = new Uint8Array(await hit.arrayBuffer())
      if (!Number.isFinite(storedAt) || body.byteLength === 0) return null
      return { body, contentType: hit.headers.get('content-type') ?? '', storedAt }
    },
    async put(url: string, body: Uint8Array, contentType: string, ttlSeconds: number, storedAt: number) {
      await cache.put(
        new Request(url),
        new Response(copyBytes(body), {
          status: 200,
          headers: {
            'content-type': contentType,
            'cache-control': `public, max-age=${ttlSeconds}`,
            'x-stored-at': String(storedAt),
          },
        }),
      )
    },
  }
}

async function defaultUpstream(url: string, signal: AbortSignal): Promise<UpstreamResult> {
  const parsed = new URL(url)
  const schedule = parsed.host === SCHEDULE_HOST && parsed.pathname === '/v1/transport/mtr/getSchedule.php'
  const snapshot = parsed.host === SNAPSHOT_HOST && /^\/[A-Za-z0-9]+\.JPG$/.test(parsed.pathname)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (!schedule && !snapshot)) {
    return { status: 400, body: new Uint8Array() }
  }
  const response = await fetch(parsed.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      Accept: schedule ? 'application/json' : 'image/jpeg',
      'User-Agent': 'HongKongMap/1.0 (shared cache)',
    },
  })
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status, body: new Uint8Array() }
  }
  try {
    return { status: 200, body: await readLimited(response, schedule ? MAX_JSON_BYTES : MAX_IMAGE_BYTES) }
  } catch {
    return { status: 502, body: new Uint8Array() }
  }
}

async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > max) {
        await reader.cancel()
        throw new Error('too-large')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
