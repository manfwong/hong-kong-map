import { useEffect, useMemo, useRef, useState } from 'react'
import type { Network, SchedulePayload } from '../types.ts'
import { trainMarkers, type TrainMarker } from './trains.ts'

type CacheEntry = { at: number; payload: SchedulePayload }

export function useMovingTrains(network: Network, enabled: boolean, preferredStation: string | null): TrainMarker[] {
  const cacheRef = useRef<Record<string, CacheEntry>>({})
  const preferredRef = useRef(preferredStation)
  const [cache, setCache] = useState<Record<string, CacheEntry>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    preferredRef.current = preferredStation
  }, [preferredStation])

  useEffect(() => {
    if (!enabled) return
    let stop = false
    let timer = 0
    const pairs = network.stations.flatMap((station) => station.lines.map((line) => ({ line: line.code, sta: station.code })))
    if (pairs.length === 0) return
    let index = 0

    const step = async () => {
      if (stop) return
      if (document.hidden) {
        timer = window.setTimeout(() => void step(), 1000)
        return
      }
      const preferred = preferredRef.current
      const preferredPair = preferred
        ? pairs.find((pair) => pair.sta === preferred && nowAge(cacheRef.current[`${pair.line}-${pair.sta}`]) > 20_000)
        : undefined
      const pair = preferredPair ?? pairs[index % pairs.length]
      if (!preferredPair) index += 1
      const key = `${pair.line}-${pair.sta}`
      try {
        const response = await fetch(
          `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${pair.line}&sta=${pair.sta}&lang=TC`,
        )
        if (stop) return
        if (response.status === 429) {
          timer = window.setTimeout(() => void step(), 12_000)
          return
        }
        if (response.ok) {
          const entry = { at: Date.now(), payload: (await response.json()) as SchedulePayload }
          const next = { ...cacheRef.current, [key]: entry }
          cacheRef.current = next
          setCache(next)
        }
      } catch {
        // Keep the last estimate and continue with the next station.
      }
      if (!stop) timer = window.setTimeout(() => void step(), 500)
    }

    void step()
    const clock = window.setInterval(() => setNow(Date.now()), 250)
    return () => {
      stop = true
      window.clearTimeout(timer)
      window.clearInterval(clock)
    }
  }, [enabled, network])

  return useMemo(() => (enabled ? trainMarkers(network, cache, now) : []), [cache, enabled, network, now])
}

function nowAge(entry: CacheEntry | undefined): number {
  return entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY
}
