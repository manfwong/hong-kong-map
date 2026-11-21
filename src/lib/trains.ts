import type { Network, SchedulePayload } from '../types.ts'

export type TrainMarker = {
  id: string
  lng: number
  lat: number
  color: string
  title: string
}

type Point = [number, number]
type Stop = { code: string; seq: number; lng: number; lat: number; name: string }

type Placed = { chain: number; distance: number; index: number; point: Point }

function metres(a: Point, b: Point): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180)
  return Math.hypot((a[0] - b[0]) * 111_320 * Math.cos(lat), (a[1] - b[1]) * 111_320)
}

function project(coords: Point[], lng: number, lat: number): Placed {
  let best: Placed = { chain: 0, distance: Number.POSITIVE_INFINITY, index: 0, point: coords[0] }
  let chain = 0
  for (let index = 0; index < coords.length - 1; index += 1) {
    const start = coords[index]
    const end = coords[index + 1]
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const length2 = dx * dx + dy * dy || 1e-12
    const t = Math.max(0, Math.min(1, ((lng - start[0]) * dx + (lat - start[1]) * dy) / length2))
    const point: Point = [start[0] + dx * t, start[1] + dy * t]
    const distance = metres(point, [lng, lat])
    const segment = metres(start, end)
    if (distance < best.distance) best = { chain: chain + segment * t, distance, index, point }
    chain += segment
  }
  return best
}

function pathBetween(coords: Point[], from: Placed, to: Placed): Point[] {
  const forward = from.chain <= to.chain
  const start = forward ? from : to
  const end = forward ? to : from
  const points: Point[] = [start.point]
  for (let index = start.index + 1; index <= end.index; index += 1) points.push(coords[index])
  points.push(end.point)
  if (!forward) points.reverse()
  return points
}

function pointAlong(points: Point[], fraction: number): Point {
  const lengths: number[] = []
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = metres(points[index], points[index + 1])
    lengths.push(length)
    total += length
  }
  if (total === 0) return points[points.length - 1]
  let left = total * Math.max(0, Math.min(1, fraction))
  for (let index = 0; index < lengths.length; index += 1) {
    if (left <= lengths[index]) {
      const t = lengths[index] === 0 ? 0 : left / lengths[index]
      const start = points[index]
      const end = points[index + 1]
      return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]
    }
    left -= lengths[index]
  }
  return points[points.length - 1]
}

function mainStops(stops: Stop[]): Stop[] {
  return stops.filter((stop) => stop.code !== 'RAC' && stop.seq > 0).sort((a, b) => a.seq - b.seq)
}

function approachStop(stops: Stop[], code: string, direction: 'UP' | 'DOWN', viaRacecourse: boolean): Stop | null {
  return behindStop(stops, code, direction, viaRacecourse) ?? behindStop(stops, code, direction === 'UP' ? 'DOWN' : 'UP', viaRacecourse)
}

function behindStop(stops: Stop[], code: string, direction: 'UP' | 'DOWN', viaRacecourse: boolean): Stop | null {
  const ordered = mainStops(stops)
  const index = ordered.findIndex((stop) => stop.code === code)
  if (index < 0) return null
  const next = ordered[index + (direction === 'UP' ? 1 : -1)]
  if (!next) return null
  if (
    viaRacecourse &&
    ((code === 'UNI' && next.code === 'FOT') || (code === 'FOT' && next.code === 'UNI'))
  ) {
    return stops.find((stop) => stop.code === 'RAC') ?? next
  }
  return next
}

function trackPoint(network: Network, lineCode: string, from: Stop, to: Stop, fraction: number): Point {
  let best: { coords: Point[]; from: Placed; to: Placed; span: number } | null = null
  for (const feature of network.routes.features) {
    if (feature.properties.code !== lineCode) continue
    const coords = feature.geometry.coordinates as Point[]
    if (coords.length < 2) continue
    const fromPlace = project(coords, from.lng, from.lat)
    const toPlace = project(coords, to.lng, to.lat)
    if (fromPlace.distance > 900 || toPlace.distance > 900) continue
    const span = Math.abs(fromPlace.chain - toPlace.chain)
    if (!best || span < best.span) best = { coords, from: fromPlace, to: toPlace, span }
  }
  if (!best) {
    return [from.lng + (to.lng - from.lng) * fraction, from.lat + (to.lat - from.lat) * fraction]
  }
  return pointAlong(pathBetween(best.coords, best.from, best.to), fraction)
}

function stopsFor(network: Network, lineCode: string): Stop[] {
  const stops: Stop[] = []
  for (const station of network.stations) {
    const line = station.lines.find((item) => item.code === lineCode)
    if (!line) continue
    stops.push({ code: station.code, seq: line.seq, lng: station.lng, lat: station.lat, name: station.name })
  }
  return stops
}

function textOf(value: unknown): string {
  if (value == null) return ''
  return String(value).trim()
}

export function trainMarkers(network: Network, cache: Record<string, { at: number; payload: SchedulePayload }>, now: number): TrainMarker[] {
  const markers: TrainMarker[] = []
  for (const [key, entry] of Object.entries(cache)) {
    if (now - entry.at > 3 * 60 * 1000) continue
    const block = entry.payload.data?.[key]
    if (!block) continue
    const [lineCode, stationCode] = key.split('-')
    const stops = stopsFor(network, lineCode)
    const here = stops.find((stop) => stop.code === stationCode)
    const line = network.lines.find((item) => item.code === lineCode)
    if (!here || !line) continue
    const elapsed = (now - entry.at) / 60_000
    for (const direction of ['UP', 'DOWN'] as const) {
      for (const train of block[direction] ?? []) {
        const remaining = Math.max(0, Number(textOf(train.ttnt) || 0) - elapsed)
        const via = textOf(train.route).toUpperCase() === 'RAC'
        let current = here
        let previous = approachStop(stops, current.code, direction, via)
        let minutesLeft = remaining
        let guard = 0
        while (previous && minutesLeft > 0 && guard < 6) {
          const hop = Math.max(1, metres([previous.lng, previous.lat], [current.lng, current.lat]) / 520)
          if (minutesLeft <= hop) break
          minutesLeft -= hop
          current = previous
          previous = behindStop(stops, current.code, direction, via) ?? approachStop(stops, current.code, direction, via)
          if (previous?.code === current.code) break
          guard += 1
        }
        let point: Point = [current.lng, current.lat]
        if (previous && previous.code !== current.code) {
          const hop = Math.max(1, metres([previous.lng, previous.lat], [current.lng, current.lat]) / 520)
          const spacing = (Math.max(1, Number(textOf(train.seq) || 1)) - 1) * 140
          const hopMetres = Math.max(140, metres([previous.lng, previous.lat], [current.lng, current.lat]))
          const fraction = Math.max(0.08, Math.min(0.92, 1 - minutesLeft / hop - spacing / hopMetres))
          point = trackPoint(network, lineCode, previous, current, fraction)
        }
        const destination = stops.find((stop) => stop.code === train.dest)?.name ?? textOf(train.dest)
        markers.push({
          id: `${key}-${direction}-${textOf(train.seq)}-${textOf(train.dest)}`,
          lng: point[0],
          lat: point[1],
          color: line.color,
          title: `${line.name} 往${destination}，約 ${Math.max(0, Math.round(remaining))} 分鐘後到站。位置是按到站時間估算。`,
        })
      }
    }
  }
  return markers
}
