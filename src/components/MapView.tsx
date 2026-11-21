import { GeoJSONSource, LngLatBounds, Map, NavigationControl, setWorkerUrl, type PaddingOptions } from 'maplibre-gl'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TrainMarker } from '../lib/trains.ts'
import type { CameraSite, Network } from '../types.ts'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { RasterMap } from './RasterMap.tsx'

setWorkerUrl(workerUrl)

const STYLE = 'https://tiles.openfreemap.org/styles/liberty'

export type MapFocus = {
  lng: number
  lat: number
  zoom: number
  token: number
}

type Props = {
  network: Network
  cameras: CameraSite[]
  showRail: boolean
  showCameras: boolean
  showTrains: boolean
  trains: TrainMarker[]
  selectedStation: string | null
  selectedCamera: string | null
  focus: MapFocus | null
  onSelectStation: (code: string) => void
  onSelectCamera: (key: string) => void
  onMapProblem: (failed: boolean) => void
  onFallback: () => void
}

const RAIL_LAYERS = ['rail-casing', 'rail-lines', 'station-hits', 'station-points', 'station-labels']
const CAMERA_LAYERS = ['camera-clusters', 'camera-counts', 'camera-points']

function viewPadding(): PaddingOptions {
  if (window.innerWidth < 768) {
    return { top: 28, bottom: Math.round(window.innerHeight * 0.46) + 28, left: 20, right: 20 }
  }
  return { top: 28, bottom: 28, left: 28, right: 430 }
}

function applyVisibility(map: Map, showRail: boolean, showCameras: boolean) {
  const rail = showRail ? 'visible' : 'none'
  const camera = showCameras ? 'visible' : 'none'
  for (const layer of RAIL_LAYERS) map.setLayoutProperty(layer, 'visibility', rail)
  for (const layer of CAMERA_LAYERS) map.setLayoutProperty(layer, 'visibility', camera)
}

export function MapView(props: Omit<Props, 'onFallback'>) {
  const [engine, setEngine] = useState<'gl' | 'raster'>('gl')
  const report = props.onMapProblem
  const useRaster = useCallback(() => {
    report(false)
    setEngine('raster')
  }, [report])
  if (engine === 'raster') return <RasterMap {...props} />
  return <GlMap {...props} onFallback={useRaster} />
}

function GlMap({
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
  onMapProblem,
  onFallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const handlersRef = useRef({ onSelectStation, onSelectCamera })
  const visibilityRef = useRef({ showRail, showCameras })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    handlersRef.current = { onSelectStation, onSelectCamera }
  }, [onSelectCamera, onSelectStation])

  useEffect(() => {
    visibilityRef.current = { showRail, showCameras }
  }, [showCameras, showRail])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let alive = true
    let map: Map
    const options = {
      container,
      style: STYLE,
      center: [114.15, 22.35] as [number, number],
      zoom: 10.4,
      attributionControl: { compact: window.innerWidth < 768 },
      locale: {
        'NavigationControl.ZoomIn': '放大',
        'NavigationControl.ZoomOut': '縮小',
        'NavigationControl.ResetBearing': '重設方向',
      },
      canvasContextAttributes: {
        antialias: false,
        powerPreference: 'low-power' as const,
        failIfMajorPerformanceCaveat: false,
        preserveDrawingBuffer: false,
        desynchronized: false,
      },
    }
    try {
      map = new Map(options)
    } catch {
      container.replaceChildren()
      try {
        map = new Map({ ...options, canvasContextAttributes: undefined })
      } catch {
        if (alive) onFallback()
        return
      }
    }

    map.addControl(new NavigationControl({ showCompass: false }), 'top-left')
    mapRef.current = map

    const failedTimer = window.setTimeout(() => {
      if (alive && !map.isStyleLoaded()) onFallback()
    }, 10000)

    map.on('load', () => {
      if (!alive) return
      window.clearTimeout(failedTimer)
      onMapProblem(false)

      map.addSource('routes', { type: 'geojson', data: network.routes })
      map.addSource('stations', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: network.stations.map((station) => ({
            type: 'Feature' as const,
            id: station.code,
            properties: {
              code: station.code,
              name: station.name,
              color: station.lines[0]?.color ?? '#1c1915',
              interchange: station.lines.length > 1,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [station.lng, station.lat],
            },
          })),
        },
      })
      map.addSource('cameras', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: cameras.map((camera) => ({
            type: 'Feature' as const,
            properties: { key: camera.key, name: camera.description },
            geometry: { type: 'Point' as const, coordinates: [camera.lng, camera.lat] },
          })),
        },
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 14,
      })
      map.addSource('selection', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: 'rail-casing',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 12, 7, 15, 10],
          'line-opacity': 0.92,
        },
      })
      map.addLayer({
        id: 'rail-lines',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 12, 3.5, 15, 5.5],
        },
      })
      map.addLayer({
        id: 'camera-clusters',
        type: 'circle',
        source: 'cameras',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#9a3412',
          'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 24],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff7ed',
        },
      })
      map.addLayer({
        id: 'camera-counts',
        type: 'symbol',
        source: 'cameras',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 12,
        },
        paint: { 'text-color': '#fff7ed' },
      })
      map.addLayer({
        id: 'camera-points',
        type: 'circle',
        source: 'cameras',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#c2410c',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 6],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff7ed',
        },
      })
      map.addLayer({
        id: 'station-hits',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 14, 13, 16, 16, 18],
        },
      })
      map.addLayer({
        id: 'station-points',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-color': ['case', ['get', 'interchange'], '#1c1915', ['get', 'color']],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 13, 5.5, 16, 7],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      map.addLayer({
        id: 'station-labels',
        type: 'symbol',
        source: 'stations',
        minzoom: 12,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 12,
          'text-offset': [0, 0.95],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#1c1915',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      })
      map.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'train-dots',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 6,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      map.addLayer({
        id: 'selection-ring',
        type: 'circle',
        source: 'selection',
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-radius': 14,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#1c1915',
        },
      })

      applyVisibility(map, visibilityRef.current.showRail, visibilityRef.current.showCameras)

      const bounds = new LngLatBounds()
      for (const station of network.stations) bounds.extend([station.lng, station.lat])
      map.fitBounds(bounds, {
        padding: viewPadding(),
        maxZoom: 11.3,
        duration: 0,
      })

      for (const layer of ['station-hits', 'station-points', 'camera-points', 'camera-clusters']) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
      }

      map.on('click', (event) => {
        const stationHit = map.queryRenderedFeatures(event.point, {
          layers: ['station-points', 'station-hits'],
        })[0]
        const stationCode = stationHit?.properties?.code
        if (typeof stationCode === 'string') {
          handlersRef.current.onSelectStation(stationCode)
          return
        }

        const cameraHit = map.queryRenderedFeatures(event.point, { layers: ['camera-points'] })[0]
        const cameraKey = cameraHit?.properties?.key
        if (typeof cameraKey === 'string') {
          handlersRef.current.onSelectCamera(cameraKey)
          return
        }

        const cluster = map.queryRenderedFeatures(event.point, { layers: ['camera-clusters'] })[0]
        const clusterId = cluster?.properties?.cluster_id
        const geometry = cluster?.geometry
        if (typeof clusterId !== 'number' || geometry?.type !== 'Point') return
        const source = map.getSource('cameras')
        if (!(source instanceof GeoJSONSource)) return
        const [lng, lat] = geometry.coordinates
        void source.getClusterExpansionZoom(clusterId).then((zoom) => {
          map.easeTo({ center: [Number(lng), Number(lat)], zoom })
        })
      })

      if (alive) setReady(true)
    })

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container)

    return () => {
      alive = false
      window.clearTimeout(failedTimer)
      observer.disconnect()
      setReady(false)
      map.remove()
      mapRef.current = null
    }
  }, [cameras, network, onFallback, onMapProblem])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    applyVisibility(map, showRail, showCameras)
  }, [ready, showCameras, showRail])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const station = network.stations.find((item) => item.code === selectedStation)
    const camera = cameras.find((item) => item.key === selectedCamera)
    const chosen = station ?? camera
    const source = map.getSource('selection')
    if (!(source instanceof GeoJSONSource)) return
    source.setData({
      type: 'FeatureCollection',
      features: chosen
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'Point',
                coordinates: [chosen.lng, chosen.lat],
              },
            },
          ]
        : [],
    })
  }, [cameras, network.stations, ready, selectedCamera, selectedStation])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('train-dots')) return
    const source = map.getSource('trains')
    if (source instanceof GeoJSONSource) {
      source.setData({
        type: 'FeatureCollection',
        features: trains.map((train) => ({
          type: 'Feature' as const,
          properties: { color: train.color, title: train.title },
          geometry: { type: 'Point' as const, coordinates: [train.lng, train.lat] },
        })),
      })
    }
    map.setLayoutProperty('train-dots', 'visibility', showTrains ? 'visible' : 'none')
  }, [ready, showTrains, trains])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !focus) return
    map.flyTo({
      center: [focus.lng, focus.lat],
      zoom: Math.max(map.getZoom(), focus.zoom),
      padding: viewPadding(),
      essential: true,
    })
  }, [focus, ready])

  return <div ref={containerRef} className="h-full w-full" />
}
