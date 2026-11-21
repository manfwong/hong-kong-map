import { createLiveCache } from './liveCache.ts'

const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function sameStationSharesOneFetch() {
  let calls = 0
  let release: (value?: void) => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const cache = createLiveCache({
    now: () => 1_000,
    gapMs: 0,
    edge: null,
    stations: { CEN: ['TWL'] },
    cameras: [],
    upstream: async (url) => {
      const parsed = new URL(url)
      assert(parsed.host === 'rt.data.gov.hk', parsed.host)
      assert(parsed.searchParams.get('line') === 'TWL', 'line')
      assert(parsed.searchParams.get('sta') === 'CEN', 'sta')
      assert(parsed.searchParams.get('lang') === 'TC', 'lang')
      calls += 1
      await gate
      return { status: 200, body: jsonBytes({ status: 1 }) }
    },
  })
  const request = new Request('http://127.0.0.1/api/schedule?sta=CEN&extra=1')
  const pending = Promise.all([cache.schedule(request), cache.schedule(request)])
  release()
  const [first, second] = await pending
  assert(calls === 1, `expected 1 upstream call, got ${calls}`)
  assert(first.headers.get('x-cache') === 'miss', 'first')
  assert(second.headers.get('x-cache') === 'miss', 'joined')
  const again = await cache.schedule(request)
  assert(calls === 1, 'fresh cache should not fetch')
  assert(again.headers.get('x-cache') === 'hit', 'hit')
  const body = (await again.json()) as { lines: { TWL: { ok: boolean; storedAt: number } } }
  assert(body.lines.TWL.ok && body.lines.TWL.storedAt === 1_000, 'storedAt')
}

async function rejectsUnknownAndDoesNotFollowVisitorUrl() {
  let calls = 0
  const cache = createLiveCache({
    edge: null,
    gapMs: 0,
    stations: { CEN: ['TWL'] },
    cameras: ['H429F'],
    upstream: async (url) => {
      calls += 1
      assert(url === 'https://tdcctv.data.one.gov.hk/H429F.JPG', url)
      return { status: 200, body: jpeg }
    },
  })
  const unknown = await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=https://evil.test'))
  assert(unknown.status === 400, 'bad station')
  const photo = await cache.snapshot(new Request('http://127.0.0.1/api/snapshot?key=H429F&url=https://evil.test/a.JPG'))
  assert(photo.status === 200, 'photo')
  const traversal = await cache.snapshot(new Request('http://127.0.0.1/api/snapshot?key=../H429F'))
  assert(traversal.status === 400, 'traversal')
  assert(calls === 1, `unexpected calls ${calls}`)
}

async function budgetStopsASecondStation() {
  let calls = 0
  const cache = createLiveCache({
    now: () => 10_000,
    gapMs: 0,
    edge: null,
    scheduleBudget: 1,
    stations: { CEN: ['TWL'], ADM: ['ISL'] },
    cameras: [],
    upstream: async () => {
      calls += 1
      return { status: 200, body: jsonBytes({ status: 1 }) }
    },
  })
  await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  const blocked = await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=ADM'))
  const body = (await blocked.json()) as { lines: { ISL: { ok: boolean } } }
  assert(body.lines.ISL.ok === false, 'budget')
  assert(calls === 1, 'budget must not fetch')
}

async function upstreamFailureKeepsThePreviousCopy() {
  let now = 10_000
  let calls = 0
  const cache = createLiveCache({
    now: () => now,
    gapMs: 0,
    edge: null,
    scheduleTtlMs: 1_000,
    failureTtlMs: 5_000,
    staleMs: 10_000,
    stations: { CEN: ['TWL'] },
    cameras: [],
    upstream: async () => {
      calls += 1
      if (calls === 1) return { status: 200, body: jsonBytes({ status: 1 }) }
      return { status: 429, body: new Uint8Array() }
    },
  })
  await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  now = 12_000
  const stale = await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  const staleBody = (await stale.json()) as { lines: { TWL: { ok: boolean; storedAt: number } } }
  assert(staleBody.lines.TWL.ok && staleBody.lines.TWL.storedAt === 10_000, 'stale')
  const held = await cache.schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  assert(held.headers.get('x-cache') === 'hit', 'cooldown')
  assert(calls === 2, 'a rejection must not be retried immediately')
}

async function edgeCacheIsShared() {
  const saved = new Map<string, { body: Uint8Array; contentType: string; storedAt: number }>()
  const edge = {
    async get(url: string) {
      return saved.get(url) ?? null
    },
    async put(url: string, body: Uint8Array, contentType: string, _ttl: number, storedAt: number) {
      saved.set(url, { body, contentType, storedAt })
    },
  }
  let calls = 0
  const options = {
    now: () => 5_000,
    gapMs: 0,
    edge,
    stations: { CEN: ['TWL'] },
    cameras: [],
    upstream: async () => {
      calls += 1
      return { status: 200, body: jsonBytes({ status: 1 }) }
    },
  }
  await createLiveCache(options).schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  const second = await createLiveCache(options).schedule(new Request('http://127.0.0.1/api/schedule?sta=CEN'))
  assert(calls === 1, 'edge should satisfy the second process')
  assert(second.headers.get('x-cache') === 'hit', 'edge hit')
}

async function rejectsNonJpeg() {
  let calls = 0
  const cache = createLiveCache({
    gapMs: 0,
    edge: null,
    stations: {},
    cameras: ['H429F'],
    upstream: async () => {
      calls += 1
      return { status: 200, body: Uint8Array.of(1, 2, 3, 4) }
    },
  })
  const first = await cache.snapshot(new Request('http://127.0.0.1/api/snapshot?key=H429F'))
  const second = await cache.snapshot(new Request('http://127.0.0.1/api/snapshot?key=H429F'))
  assert(first.status === 502 && second.status === 502, 'not a photo')
  assert(calls === 1, 'failed photo is not fetched again immediately')
}

await sameStationSharesOneFetch()
await rejectsUnknownAndDoesNotFollowVisitorUrl()
await budgetStopsASecondStation()
await upstreamFailureKeepsThePreviousCopy()
await edgeCacheIsShared()
await rejectsNonJpeg()
console.log('live cache ok')
