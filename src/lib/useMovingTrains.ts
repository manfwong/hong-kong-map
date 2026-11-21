import { useEffect, useMemo, useState } from 'react'
import type { Network, SchedulePayload, Station } from '../types.ts'
import { trainMarkers, type TrainMarker } from './trains.ts'

type FetchedLine = {
  payload: SchedulePayload | null
}

export function useMovingTrains(
  network: Network | null,
  enabled: boolean,
  station: Station | null,
  fetched: Record<string, FetchedLine>,
  fetchedAt: number | null,
): TrainMarker[] {
  const [now, setNow] = useState(() => Date.now())
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!enabled || !station || !visible) return
    const clock = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(clock)
  }, [enabled, station, visible])

  return useMemo(() => {
    if (!network || !enabled || !station || !visible || fetchedAt == null) return []
    const cache: Record<string, { at: number; payload: SchedulePayload }> = {}
    for (const line of station.lines) {
      const payload = fetched[line.code]?.payload
      if (!payload) continue
      cache[`${line.code}-${station.code}`] = { at: fetchedAt, payload }
    }
    return trainMarkers(network, cache, now)
  }, [enabled, fetched, fetchedAt, network, now, station, visible])
}
