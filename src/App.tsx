import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type MapFocus } from './components/MapView.tsx'
import { SidePanel } from './components/SidePanel.tsx'
import { presentLine } from './lib/schedule.ts'
import { useMovingTrains } from './lib/useMovingTrains.ts'
import type { CameraSite, LineSchedule, Network, SchedulePayload, Station } from './types.ts'

type FetchedLine = {
  payload: SchedulePayload | null
  failed: boolean
}

export default function App() {
  const [network, setNetwork] = useState<Network | null>(null)
  const [cameras, setCameras] = useState<CameraSite[] | null>(null)
  const [dataError, setDataError] = useState(false)
  const [mapProblem, setMapProblem] = useState(false)
  const [showRail, setShowRail] = useState(true)
  const [showCameras, setShowCameras] = useState(true)
  const [showTrains, setShowTrains] = useState(true)
  const [stationCode, setStationCode] = useState<string | null>(null)
  const [cameraKey, setCameraKey] = useState<string | null>(null)
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [fetched, setFetched] = useState<Record<string, FetchedLine>>({})
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    Promise.all([
      fetch('/data/network.json').then((response) => {
        if (!response.ok) throw new Error('network')
        return response.json() as Promise<Network>
      }),
      fetch('/data/cameras.json').then((response) => {
        if (!response.ok) throw new Error('cameras')
        return response.json() as Promise<CameraSite[]>
      }),
    ])
      .then(([nextNetwork, nextCameras]) => {
        if (!active) return
        setNetwork(nextNetwork)
        setCameras(nextCameras)
      })
      .catch(() => {
        if (active) setDataError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const station = network?.stations.find((item) => item.code === stationCode) ?? null
  const camera = cameras?.find((item) => item.key === cameraKey) ?? null
  const names = useMemo(() => {
    const table: Record<string, string> = {}
    for (const item of network?.stations ?? []) table[item.code] = item.name
    return table
  }, [network])

  useEffect(() => {
    if (!station) return
    const controller = new AbortController()
    let active = true
    let inFlight = false
    let queued = false

    const run = async () => {
      if (!active || controller.signal.aborted || document.hidden) return
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      setLoading(true)
      const next: Record<string, FetchedLine> = {}
      try {
        await Promise.all(
          station.lines.map(async (line) => {
            const request = new AbortController()
            const timeout = window.setTimeout(() => request.abort(), 8000)
            const stop = () => request.abort()
            controller.signal.addEventListener('abort', stop)
            try {
              const response = await fetch(
                `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line.code}&sta=${station.code}&lang=TC`,
                { signal: request.signal },
              )
              if (!response.ok) throw new Error(String(response.status))
              next[line.code] = { payload: (await response.json()) as SchedulePayload, failed: false }
            } catch {
              if (controller.signal.aborted) return
              next[line.code] = { payload: null, failed: true }
            } finally {
              window.clearTimeout(timeout)
              controller.signal.removeEventListener('abort', stop)
            }
          }),
        )
        if (!active || controller.signal.aborted) return
        setFetched(next)
        setFetchedAt(Date.now())
        setLoading(false)
      } finally {
        inFlight = false
        if (queued && active && !controller.signal.aborted) {
          queued = false
          void run()
        }
      }
    }

    void run()
    const timer = window.setInterval(() => void run(), 20000)
    const onVisible = () => {
      if (!document.hidden) void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reloadToken, station])

  const schedules: LineSchedule[] = station
    ? station.lines.flatMap((line) => {
        const result = fetched[line.code]
        if (!result) return []
        return [presentLine(station.code, line, result.payload, result.failed, names)]
      })
    : []

  const stationCodeRef = useRef<string | null>(null)

  const chooseStation = useCallback((next: Station, shouldFocus: boolean) => {
    const sameStation = stationCodeRef.current === next.code
    stationCodeRef.current = next.code
    setStationCode(next.code)
    setCameraKey(null)
    if (!sameStation) {
      setFetched({})
      setFetchedAt(null)
      setLoading(true)
    }
    if (shouldFocus) {
      setFocus({ lng: next.lng, lat: next.lat, zoom: 14.5, token: Date.now() })
    }
  }, [])

  const chooseCamera = useCallback((next: CameraSite, shouldFocus: boolean) => {
    stationCodeRef.current = null
    setCameraKey(next.key)
    setStationCode(null)
    setFetched({})
    setFetchedAt(null)
    if (shouldFocus) {
      setFocus({ lng: next.lng, lat: next.lat, zoom: 16, token: Date.now() })
    }
  }, [])

  const onMapProblem = useCallback((failed: boolean) => {
    setMapProblem(failed)
  }, [])

  const trains = useMovingTrains(network, showTrains, station, fetched, fetchedAt)

  if (dataError) {
    return (
      <main className="grid h-full place-items-center px-6 text-center">
        <p className="max-w-sm text-lg">地圖資料暫時未能載入。請稍後重新整理頁面。</p>
      </main>
    )
  }

  if (!network || !cameras) {
    return (
      <main className="grid h-full place-items-center px-6">
        <p className="text-lg">正在準備香港地圖…</p>
      </main>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[#e4ddd2] bg-[#f7f4ee] px-4 py-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold leading-6">香港智慧城市地圖</h1>
          <p className="text-sm text-[#6b645c]">港鐵到站班次與運輸署交通快拍</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={showRail}
            className={`rounded-full px-3 py-1.5 text-sm ${showRail ? 'bg-[#1c1915] text-[#f7f4ee]' : 'bg-white text-[#1c1915] ring-1 ring-[#e4ddd2]'}`}
            onClick={() => setShowRail((value) => !value)}
          >
            港鐵網絡
          </button>
          <button
            type="button"
            aria-pressed={showCameras}
            className={`rounded-full px-3 py-1.5 text-sm ${showCameras ? 'bg-[#9a3412] text-white' : 'bg-white text-[#1c1915] ring-1 ring-[#e4ddd2]'}`}
            onClick={() => setShowCameras((value) => !value)}
          >
            交通快拍
          </button>
          <button
            type="button"
            aria-pressed={showTrains}
            className={`rounded-full px-3 py-1.5 text-sm ${showTrains ? 'bg-[#0f3d4c] text-white' : 'bg-white text-[#1c1915] ring-1 ring-[#e4ddd2]'}`}
            onClick={() => setShowTrains((value) => !value)}
          >
            列車
          </button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <MapView
          network={network}
          cameras={cameras}
          showRail={showRail}
          showCameras={showCameras}
          showTrains={showTrains}
          trains={trains}
          selectedStation={stationCode}
          selectedCamera={cameraKey}
          focus={focus}
          onSelectStation={(code) => {
            const next = network.stations.find((item) => item.code === code)
            if (next) chooseStation(next, false)
          }}
          onSelectCamera={(key) => {
            const next = cameras.find((item) => item.key === key)
            if (next) chooseCamera(next, false)
          }}
          onMapProblem={onMapProblem}
        />
        {mapProblem ? (
          <p className="absolute top-3 left-3 z-10 max-w-xs rounded-xl bg-[#fde8e4] px-3 py-2 text-sm shadow">
            底圖暫時未能載入。請檢查網絡後再重新整理。
          </p>
        ) : null}
        <div className="pointer-events-none absolute inset-0 p-3 md:p-4">
          <div className="pointer-events-auto absolute inset-x-3 bottom-3 h-[46vh] md:inset-y-4 md:right-4 md:left-auto md:h-auto md:w-[380px]">
            <SidePanel
              network={network}
              cameras={cameras}
              station={station}
              camera={camera}
              schedules={schedules}
              loading={loading}
              onPickStation={(item) => chooseStation(item, true)}
              onPickCamera={(item) => chooseCamera(item, true)}
              onClose={() => {
                stationCodeRef.current = null
                setStationCode(null)
                setCameraKey(null)
                setFetched({})
                setFetchedAt(null)
              }}
              onRetry={() => setReloadToken((value) => value + 1)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
