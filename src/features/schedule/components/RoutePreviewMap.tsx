import { useEffect, useRef, useState } from 'react'
import type { RoutePreview } from '../services/routeOptimizationService'
import type { Map as MapboxMap } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

type ViewMode = '2d' | '3d'

const BUILDING_LAYER_ID = 'route-preview-3d-buildings'
const VIEW_CAMERA = {
  '2d': { pitch: 0, bearing: 0 },
  '3d': { pitch: 45, bearing: -17.6 },
} as const

interface StopMarker {
  id: string
  label: string
  order: number
  lng: number
  lat: number
}

interface Props {
  geometry: RoutePreview['display']
  stops: StopMarker[]
  /** A preview revision is immutable. Parent-only UI state changes must not
   * tear down and recreate the Mapbox instance for the same revision. */
  previewRevision?: string
}

function add3DBuildings(map: MapboxMap, visible: boolean) {
  if (map.getLayer(BUILDING_LAYER_ID) || !map.getSource('composite')) return
  const labelLayerId = map.getStyle().layers.find(layer => (
    layer.type === 'symbol' && Boolean(layer.layout?.['text-field'])
  ))?.id

  map.addLayer({
    id: BUILDING_LAYER_ID,
    source: 'composite',
    'source-layer': 'building',
    type: 'fill-extrusion',
    minzoom: 15,
    filter: ['==', ['get', 'extrude'], 'true'],
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['get', 'height'],
        0, '#dce9e7',
        80, '#9bc7c0',
        240, '#5c9f95',
      ],
      'fill-extrusion-height': [
        'interpolate', ['linear'], ['zoom'],
        15, 0,
        15.05, ['get', 'height'],
      ],
      'fill-extrusion-base': [
        'interpolate', ['linear'], ['zoom'],
        15, 0,
        15.05, ['get', 'min_height'],
      ],
      'fill-extrusion-opacity': 0.74,
      'fill-extrusion-vertical-gradient': true,
    },
  }, labelLayerId)
}

function createStopMarkerElement(stop: StopMarker) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'grid h-8 w-8 cursor-pointer place-items-center rounded-full border-2 border-white bg-teal text-[12px] font-extrabold text-white shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal'
  element.textContent = String(stop.order + 1)
  element.setAttribute('aria-label', `第 ${stop.order + 1} 站：${stop.label}`)
  element.title = stop.label
  return element
}

export default function RoutePreviewMap({ geometry, stops, previewRevision }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapboxMap | null>(null)
  const viewModeRef = useRef<ViewMode>('3d')
  const [error, setError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('3d')
  // Production previews provide the immutable Worker revision. The content
  // fallback keeps this component safe in isolated tests and future callers.
  const routeDataKey = previewRevision ?? JSON.stringify([geometry, stops])
  const routeDataRef = useRef({ key: routeDataKey, geometry, stops })
  useEffect(() => {
    routeDataRef.current = { key: routeDataKey, geometry, stops }
  }, [routeDataKey, geometry, stops])

  function changeViewMode(next: ViewMode) {
    const map = mapRef.current
    if (!map || next === viewModeRef.current) return
    viewModeRef.current = next
    setViewMode(next)
    if (map.getLayer(BUILDING_LAYER_ID)) {
      map.setLayoutProperty(BUILDING_LAYER_ID, 'visibility', next === '3d' ? 'visible' : 'none')
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    map.easeTo({
      ...VIEW_CAMERA[next],
      duration: reducedMotion ? 0 : 450,
      essential: false,
    })
  }

  useEffect(() => {
    const routeData = routeDataRef.current
    let disposed = false
    let map: MapboxMap | null = null
    let resizeObserver: ResizeObserver | null = null
    let initialLoadTimer: ReturnType<typeof setTimeout> | null = null
    let initialStyleLoaded = false
    let routeLayersReady = false
    const markers: Array<{ remove: () => void }> = []

    async function mount() {
      if (!containerRef.current) return
      const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
      if (!token) {
        setError('尚未設定 Mapbox token；仍可使用路線清單')
        return
      }
      try {
        const mapbox = await import('mapbox-gl')
        if (disposed || !containerRef.current) return
        mapbox.default.accessToken = token
        const initialCamera = VIEW_CAMERA[viewModeRef.current]
        const mapInstance = new mapbox.default.Map({
          container: containerRef.current,
          style: 'mapbox://styles/mapbox/streets-v12',
          language: 'zh-Hant',
          locale: {
            'AttributionControl.ToggleAttribution': '切換地圖資訊',
            'LogoControl.Title': 'Mapbox 首頁',
            'Map.Title': '路線地圖預覽',
          },
          center: routeData.stops[0] ? [routeData.stops[0].lng, routeData.stops[0].lat] : [0, 0],
          zoom: 11,
          ...initialCamera,
          antialias: true,
          performanceMetricsCollection: false,
        })
        map = mapInstance
        mapRef.current = mapInstance
        mapInstance.on('error', () => {
          if (!disposed && (!initialStyleLoaded || !routeLayersReady)) {
            if (initialLoadTimer) clearTimeout(initialLoadTimer)
            initialLoadTimer = null
            setError('地圖載入失敗；仍可使用路線清單')
          }
        })
        initialLoadTimer = setTimeout(() => {
          if (!disposed && !initialStyleLoaded) setError('地圖載入逾時；仍可使用路線清單')
        }, 10_000)
        resizeObserver = new ResizeObserver(() => {
          if (!disposed) mapInstance.resize()
        })
        resizeObserver.observe(containerRef.current)
        mapInstance.on('load', () => {
          if (disposed) return
          initialStyleLoaded = true
          if (initialLoadTimer) clearTimeout(initialLoadTimer)
          initialLoadTimer = null
          setError(null)
          try {
            mapInstance.addSource('route-preview', { type: 'geojson', data: routeData.geometry })
            // 3D buildings are decorative. A style without a compatible
            // building source must not prevent the actual route from loading.
            try { add3DBuildings(mapInstance, viewModeRef.current === '3d') } catch { /* optional layer */ }
            mapInstance.addLayer({
              id: 'route-preview-casing',
              type: 'line',
              source: 'route-preview',
              filter: [
                'all',
                ['==', ['get', 'provider'], 'ors'],
                ['==', ['get', 'mode'], 'walking'],
              ],
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': '#ffffff',
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 6, 15, 10],
                'line-opacity': 0.82,
              },
            })
            mapInstance.addLayer({
              id: 'route-preview-line-walking',
              type: 'line',
              source: 'route-preview',
              filter: [
                'all',
                ['==', ['get', 'provider'], 'ors'],
                ['==', ['get', 'mode'], 'walking'],
              ],
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 15, 7],
                'line-opacity': 0.92,
                'line-color': '#0d9488',
              },
            })
            mapInstance.addLayer({
              id: 'route-preview-line-reference',
              type: 'line',
              source: 'route-preview',
              filter: [
                'all',
                ['==', ['get', 'provider'], 'reference'],
                ['==', ['get', 'mode'], 'transit-check'],
              ],
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                // Reference connectors are deliberately dashed and neutral;
                // they never represent an actual transit path.
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 5],
                'line-opacity': 0.9,
                'line-color': '#475569',
                'line-dasharray': [2, 2],
              },
            })
            const bounds = new mapbox.default.LngLatBounds()
            for (const feature of routeData.geometry.features) {
              for (const coordinate of feature.geometry.coordinates) bounds.extend(coordinate)
            }
            for (const stop of routeData.stops) bounds.extend([stop.lng, stop.lat])
            if (!bounds.isEmpty()) {
              mapInstance.fitBounds(bounds, { padding: 28, maxZoom: 15.5, duration: 0 })
              mapInstance.jumpTo(VIEW_CAMERA[viewModeRef.current])
            }
            for (const stop of routeData.stops) {
              const marker = new mapbox.default.Marker({ element: createStopMarkerElement(stop) })
                .setLngLat([stop.lng, stop.lat])
                .setPopup(new mapbox.default.Popup({ offset: 12, closeButton: false }).setText(`${stop.order + 1}. ${stop.label}`))
                .addTo(mapInstance)
              markers.push(marker)
            }
            routeLayersReady = true
            setMapReady(true)
          } catch {
            routeLayersReady = false
            setMapReady(false)
            setError('路線圖層載入失敗；仍可使用路線清單')
          }
        })
      } catch {
        setError('地圖載入失敗；仍可使用路線清單')
      }
    }
    void mount()
    return () => {
      disposed = true
      if (initialLoadTimer) clearTimeout(initialLoadTimer)
      resizeObserver?.disconnect()
      for (const marker of markers) marker.remove()
      if (mapRef.current === map) mapRef.current = null
      map?.remove()
    }
  }, [routeDataKey])

  return (
    <div className="relative h-60 min-h-60 shrink-0 overflow-hidden rounded-[16px] border border-border bg-app">
      <div ref={containerRef} className="h-full w-full" aria-label="路線地圖預覽" />
      {mapReady && !error && (
        <div role="group" aria-label="地圖視角" className="absolute right-2 top-2 z-10 flex rounded-xl border border-white/80 bg-surface/95 p-1 shadow-md backdrop-blur-sm">
          <button
            type="button"
            aria-pressed={viewMode === '2d'}
            onClick={() => changeViewMode('2d')}
            className={`h-9 min-w-10 rounded-lg px-2 text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal ${viewMode === '2d' ? 'bg-teal text-white' : 'text-muted hover:bg-app'}`}
          >
            2D
          </button>
          <button
            type="button"
            aria-pressed={viewMode === '3d'}
            onClick={() => changeViewMode('3d')}
            className={`h-9 min-w-10 rounded-lg px-2 text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal ${viewMode === '3d' ? 'bg-teal text-white' : 'text-muted hover:bg-app'}`}
          >
            3D
          </button>
        </div>
      )}
      {error && <div role="status" className="absolute inset-x-3 bottom-3 rounded-lg bg-surface/95 px-3 py-2 text-[11px] text-muted shadow-sm">{error}</div>}
      {geometry.features.length === 0 && !error && <div className="absolute inset-0 grid place-items-center text-[12px] text-muted">沒有可顯示的路線</div>}
    </div>
  )
}
