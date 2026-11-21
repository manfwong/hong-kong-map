import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrainMarker } from '../lib/trains.ts'
import type { CameraSite, Network } from '../types.ts'

type Props = {
  network: Network
  cameras: CameraSite[]
  showRail: boolean
  showCameras: boolean
  showTrains: boolean
  trains: TrainMarker[]
  selectedStation: string | null
  selectedCamera: string | null
  focus: { lng: number; lat: number; zoom: number; token: number } | null
  onSelectStation: (code: string) => void
  onSelectCamera: (key: string) => void
}

type View = { lng: number; lat: number; zoom: number }
type Point = { x: number; y: number }

const MIN_ZOOM = 10
const MAX_ZOOM = 16

function worldSize(zoom: number): number {
  return 256 * 2 ** zoom
}

function mercatorY(lat: number, scale: number): number {
  const sine = Math.sin((lat * Math.PI) / 180)
  const clamped = Math.max(-0.9999, Math.min(0.9999, sine))
  return (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * scale
}

function latFromY(y: number, scale: number): number {
  const n = Math.PI - (2 * Math.PI * y) / scale
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
}

function project(lng: number, lat: number, view: View, width: number, height: number): Point {
  const scale = worldSize(view.zoom)
  const x = ((lng + 180) / 360) * scale
  const y = mercatorY(lat, scale)
  const centerX = ((view.lng + 180) / 360) * scale
  const centerY = mercatorY(view.lat, scale)
  return { x: width / 2 + (x - centerX), y: height / 2 + (y - centerY) }
}

function unproject(px: number, py: number, view: View, width: number, height: number): [number, number] {
  const scale = worldSize(view.zoom)
  const centerX = ((view.lng + 180) / 360) * scale
  const centerY = mercatorY(view.lat, scale)
  const x = centerX + (px - width / 2)
  const y = centerY + (py - height / 2)
  return [(x / scale) * 360 - 180, latFromY(y, scale)]
}

function padding(width: number, height: number) {
  if (width < 768) return { top: 28, bottom: Math.round(height * 0.46) + 28, left: 20, right: 20 }
  return { top: 28, bottom: 28, left: 28, right: 430 }
}

function fitView(network: Network, width: number, height: number): View {
  const pad = padding(width, height)
  const innerWidth = Math.max(80, width - pad.left - pad.right)
  const innerHeight = Math.max(80, height - pad.top - pad.bottom)
  let zoom = MIN_ZOOM
  for (let candidate = MAX_ZOOM; candidate >= MIN_ZOOM; candidate -= 0.25) {
    const scale = worldSize(candidate)
    const xs = network.stations.map((station) => ((station.lng + 180) / 360) * scale)
    const ys = network.stations.map((station) => mercatorY(station.lat, scale))
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanY = Math.max(...ys) - Math.min(...ys)
    if (spanX <= innerWidth && spanY <= innerHeight) {
      zoom = candidate
      const scaleAt = worldSize(zoom)
      const fittedX = network.stations.map((station) => ((station.lng + 180) / 360) * scaleAt)
      const fittedY = network.stations.map((station) => mercatorY(station.lat, scaleAt))
      const midX = (Math.min(...fittedX) + Math.max(...fittedX)) / 2 - (pad.left - pad.right) / 2
      const midY = (Math.min(...fittedY) + Math.max(...fittedY)) / 2 - (pad.top - pad.bottom) / 2
      return { lng: (midX / scaleAt) * 360 - 180, lat: latFromY(midY, scaleAt), zoom }
    }
  }
  return { lng: 114.15, lat: 22.33, zoom }
}

export function RasterMap({
  network,
  cameras,
  showRail,
  showCameras,
  showTrains,
  trains,
  selectedStation,
  selectedCamera,
  focus,
  onSelectStation,
  onSelectCamera,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ lng: 114.15, lat: 22.33, zoom: 11 })
  const fitted = useRef(false)
  const drag = useRef<{ x: number; y: number; lng: number; lat: number } | null>(null)
  const [appliedFocus, setAppliedFocus] = useState<number | null>(null)
  if (focus && focus.token !== appliedFocus && size.width > 0) {
    setAppliedFocus(focus.token)
    setView({ lng: focus.lng, lat: focus.lat, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, focus.zoom)) })
  }

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(() => {
      const next = { width: frame.clientWidth, height: frame.clientHeight }
      setSize(next)
      if (!fitted.current && next.width > 0 && next.height > 0) {
        fitted.current = true
        setView(fitView(network, next.width, next.height))
      }
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [network])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = frame.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView((current) => {
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + (event.deltaY < 0 ? 0.4 : -0.4)))
        const [lng, lat] = unproject(px, py, current, rect.width, rect.height)
        const scale = worldSize(nextZoom)
        const x = ((lng + 180) / 360) * scale
        const y = mercatorY(lat, scale)
        const centerX = x - (px - rect.width / 2)
        const centerY = y - (py - rect.height / 2)
        return { lng: (centerX / scale) * 360 - 180, lat: latFromY(centerY, scale), zoom: nextZoom }
      })
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [])

  const tiles = useMemo(() => {
    if (size.width === 0) return []
    const zoom = Math.round(view.zoom)
    const scale = worldSize(zoom)
    const centerX = ((view.lng + 180) / 360) * scale
    const centerY = mercatorY(view.lat, scale)
    const left = centerX - size.width / 2
    const top = centerY - size.height / 2
    const count = 2 ** zoom
    const result: Array<{ key: string; href: string; left: number; top: number }> = []
    const x0 = Math.floor(left / 256)
    const x1 = Math.floor((left + size.width) / 256)
    const y0 = Math.floor(top / 256)
    const y1 = Math.floor((top + size.height) / 256)
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        if (y < 0 || y >= count) continue
        const wrapped = ((x % count) + count) % count
        result.push({
          key: `${zoom}-${wrapped}-${y}`,
          href: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${zoom}/${y}/${wrapped}`,
          left: x * 256 - left,
          top: y * 256 - top,
        })
      }
    }
    return result
  }, [size.height, size.width, view.lat, view.lng, view.zoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * ratio)
    canvas.height = Math.round(size.height * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'

    if (showRail) {
      for (const feature of network.routes.features) {
        const coords = feature.geometry.coordinates
        if (coords.length < 2) continue
        context.beginPath()
        coords.forEach((coord, index) => {
          const point = project(coord[0], coord[1], view, size.width, size.height)
          if (index === 0) context.moveTo(point.x, point.y)
          else context.lineTo(point.x, point.y)
        })
        context.strokeStyle = '#ffffff'
        context.lineWidth = 6
        context.stroke()
        context.strokeStyle = feature.properties.color
        context.lineWidth = 3
        context.stroke()
      }
    }

    const drawDot = (point: Point, color: string, radius: number) => {
      context.beginPath()
      context.fillStyle = color
      context.strokeStyle = '#ffffff'
      context.lineWidth = 2
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fill()
      context.stroke()
    }

    if (showCameras && view.zoom >= 13) {
      for (const camera of cameras) {
        drawDot(project(camera.lng, camera.lat, view, size.width, size.height), '#c2410c', 4)
      }
    } else if (showCameras) {
      const cell = 52
      const groups = new Map<string, { x: number; y: number; count: number }>()
      for (const camera of cameras) {
        const point = project(camera.lng, camera.lat, view, size.width, size.height)
        const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
        const group = groups.get(key)
        if (group) {
          group.x += point.x
          group.y += point.y
          group.count += 1
        } else groups.set(key, { x: point.x, y: point.y, count: 1 })
      }
      for (const group of groups.values()) {
        const point = { x: group.x / group.count, y: group.y / group.count }
        if (group.count === 1) drawDot(point, '#c2410c', 4)
        else {
          context.beginPath()
          context.fillStyle = '#9a3412'
          context.arc(point.x, point.y, 13, 0, Math.PI * 2)
          context.fill()
          context.fillStyle = '#fff7ed'
          context.font = '12px sans-serif'
          context.textAlign = 'center'
          context.textBaseline = 'middle'
          context.fillText(String(group.count), point.x, point.y)
        }
      }
    }

    for (const station of network.stations) {
      const point = project(station.lng, station.lat, view, size.width, size.height)
      const color = station.lines.length > 1 ? '#1c1915' : (station.lines[0]?.color ?? '#1c1915')
      drawDot(point, color, view.zoom >= 13 ? 6 : 4)
      if (view.zoom >= 13) {
        context.font = '12px sans-serif'
        context.fillStyle = '#1c1915'
        context.textAlign = 'center'
        context.textBaseline = 'top'
        context.fillText(station.name, point.x, point.y + 8)
      }
      if (station.code === selectedStation) {
        context.beginPath()
        context.strokeStyle = '#1c1915'
        context.lineWidth = 2
        context.arc(point.x, point.y, 12, 0, Math.PI * 2)
        context.stroke()
      }
    }

    if (showTrains) {
      for (const train of trains) {
        drawDot(project(train.lng, train.lat, view, size.width, size.height), train.color, 6)
      }
    }

    if (selectedCamera) {
      const camera = cameras.find((item) => item.key === selectedCamera)
      if (camera) {
        const point = project(camera.lng, camera.lat, view, size.width, size.height)
        context.beginPath()
        context.strokeStyle = '#1c1915'
        context.lineWidth = 2
        context.arc(point.x, point.y, 12, 0, Math.PI * 2)
        context.stroke()
      }
    }
  }, [cameras, network, selectedCamera, selectedStation, showCameras, showRail, showTrains, size, trains, view])

  const pick = (px: number, py: number) => {
    let nearest: { kind: 'station' | 'camera'; id: string; distance: number } | null = null
    for (const station of network.stations) {
      const point = project(station.lng, station.lat, view, size.width, size.height)
      const distance = Math.hypot(point.x - px, point.y - py)
      if (distance <= 16 && (!nearest || distance < nearest.distance)) nearest = { kind: 'station', id: station.code, distance }
    }
    if (nearest?.kind === 'station') {
      onSelectStation(nearest.id)
      return
    }
    if (showCameras && view.zoom < 13) {
      const cell = 52
      const groups = new Map<string, { x: number; y: number; count: number }>()
      for (const camera of cameras) {
        const point = project(camera.lng, camera.lat, view, size.width, size.height)
        const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
        const group = groups.get(key)
        if (group) {
          group.x += point.x
          group.y += point.y
          group.count += 1
        } else groups.set(key, { x: point.x, y: point.y, count: 1 })
      }
      for (const group of groups.values()) {
        const point = { x: group.x / group.count, y: group.y / group.count }
        if (group.count > 1 && Math.hypot(point.x - px, point.y - py) <= 16) {
          const [lng, lat] = unproject(point.x, point.y, view, size.width, size.height)
          setView({ lng, lat, zoom: Math.min(MAX_ZOOM, view.zoom + 1.5) })
          return
        }
      }
    }
    if (!showCameras || view.zoom < 13) return
    for (const camera of cameras) {
      const point = project(camera.lng, camera.lat, view, size.width, size.height)
      const distance = Math.hypot(point.x - px, point.y - py)
      if (distance <= 12 && (!nearest || distance < nearest.distance)) nearest = { kind: 'camera', id: camera.key, distance }
    }
    if (nearest?.kind === 'camera') onSelectCamera(nearest.id)
  }

  return (
    <div
      ref={frameRef}
      className="relative h-full w-full overflow-hidden bg-[#d9e4d4]"
      onPointerDown={(event) => {
        frameRef.current?.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, lng: view.lng, lat: view.lat }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        const frame = frameRef.current
        if (!start || !frame) return
        const rect = frame.getBoundingClientRect()
        const [lng, lat] = unproject(rect.width / 2 - (event.clientX - start.x), rect.height / 2 - (event.clientY - start.y), { ...view, lng: start.lng, lat: start.lat }, rect.width, rect.height)
        setView((current) => ({ ...current, lng, lat }))
      }}
      onPointerUp={(event) => {
        const start = drag.current
        drag.current = null
        if (!start) return
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
        const rect = frameRef.current?.getBoundingClientRect()
        if (!rect) return
        pick(event.clientX - rect.left, event.clientY - rect.top)
      }}
    >
      {tiles.map((tile) => (
        <img key={tile.key} src={tile.href} alt="" draggable={false} className="absolute max-w-none" style={{ left: tile.left, top: tile.top, width: 256, height: 256 }} />
      ))}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="absolute top-3 left-3 flex flex-col overflow-hidden rounded-xl bg-white shadow">
        <button type="button" className="px-3 py-1 text-lg" aria-label="放大" onClick={() => setView((current) => ({ ...current, zoom: Math.min(MAX_ZOOM, current.zoom + 0.7) }))}>
          +
        </button>
        <button type="button" className="border-t border-[#e4ddd2] px-3 py-1 text-lg" aria-label="縮小" onClick={() => setView((current) => ({ ...current, zoom: Math.max(MIN_ZOOM, current.zoom - 0.7) }))}>
          −
        </button>
      </div>
      <p className="absolute bottom-2 left-2 rounded bg-white/80 px-1.5 py-0.5 text-[11px] text-[#3f3a34]">© Esri、OpenStreetMap</p>
    </div>
  )
}
