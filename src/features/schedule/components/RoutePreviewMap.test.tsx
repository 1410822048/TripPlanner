import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import RoutePreviewMap from './RoutePreviewMap'
import type { RoutePreview } from '../services/routeOptimizationService'

const mapboxMocks = vi.hoisted(() => ({
  created: 0,
  options: undefined as Record<string, unknown> | undefined,
  handlers: {} as Record<string, (event?: unknown) => void>,
  resize: vi.fn(),
  remove: vi.fn(),
  addLayer: vi.fn(),
  easeTo: vi.fn(),
  fitBounds: vi.fn(),
  jumpTo: vi.fn(),
  setLayoutProperty: vi.fn(),
  layerIds: new Set<string>(),
  markerOptions: [] as Array<Record<string, unknown>>,
  popupOptions: [] as Array<Record<string, unknown>>,
  popupTexts: [] as string[],
  extendedBounds: [] as unknown[],
}))

vi.mock('mapbox-gl', () => {
  class FakeMap {
    constructor(options: Record<string, unknown>) {
      mapboxMocks.created += 1
      mapboxMocks.options = options
    }
    on(event: string, handler: (event?: unknown) => void) {
      mapboxMocks.handlers[event] = handler
      return this
    }
    loaded() { return false }
    resize() { mapboxMocks.resize() }
    remove() { mapboxMocks.remove() }
    addSource() {}
    addLayer(layer: unknown, beforeId?: string) {
      const id = (layer as { id?: string }).id
      if (id) mapboxMocks.layerIds.add(id)
      mapboxMocks.addLayer(layer, beforeId)
    }
    getLayer(id: string) { return mapboxMocks.layerIds.has(id) ? {} : undefined }
    getSource(id: string) { return id === 'composite' ? {} : undefined }
    getStyle() {
      return {
        layers: [
          { id: 'road-label', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
        ],
      }
    }
    easeTo(options: unknown) { mapboxMocks.easeTo(options) }
    fitBounds(...args: unknown[]) { mapboxMocks.fitBounds(...args) }
    jumpTo(options: unknown) { mapboxMocks.jumpTo(options) }
    setLayoutProperty(...args: unknown[]) { mapboxMocks.setLayoutProperty(...args) }
  }
  class FakeMarker {
    constructor(options: Record<string, unknown>) {
      mapboxMocks.markerOptions.push(options)
    }
    setLngLat() { return this }
    setPopup() { return this }
    addTo() { return this }
    remove() {}
  }
  class FakePopup {
    constructor(options: Record<string, unknown>) {
      mapboxMocks.popupOptions.push(options)
    }
    setText(value: string) {
      mapboxMocks.popupTexts.push(value)
      return this
    }
  }
  class FakeBounds {
    extend(value: unknown) {
      mapboxMocks.extendedBounds.push(value)
      return this
    }
    isEmpty() { return false }
  }
  return {
    default: {
      accessToken: '',
      Map: FakeMap,
      Marker: FakeMarker,
      Popup: FakePopup,
      LngLatBounds: FakeBounds,
    },
  }
})

const geometry: RoutePreview['display'] = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { provider: 'ors', mode: 'walking', legIndex: 0 },
      geometry: { type: 'LineString', coordinates: [[139.7, 35.6], [139.8, 35.7]] },
    },
    {
      type: 'Feature',
      properties: { provider: 'reference', mode: 'transit-check', legIndex: 1 },
      geometry: { type: 'LineString', coordinates: [[139.8, 35.7], [139.9, 35.8]] },
    },
  ],
}

describe('RoutePreviewMap', () => {
  let resizeCallback: (() => void) | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    mapboxMocks.created = 0
    mapboxMocks.options = undefined
    mapboxMocks.handlers = {}
    mapboxMocks.resize.mockClear()
    mapboxMocks.remove.mockClear()
    mapboxMocks.addLayer.mockReset()
    mapboxMocks.easeTo.mockClear()
    mapboxMocks.fitBounds.mockClear()
    mapboxMocks.jumpTo.mockClear()
    mapboxMocks.setLayoutProperty.mockClear()
    mapboxMocks.layerIds = new Set()
    mapboxMocks.markerOptions = []
    mapboxMocks.popupOptions = []
    mapboxMocks.popupTexts = []
    mapboxMocks.extendedBounds = []
    observe.mockClear()
    disconnect.mockClear()
    resizeCallback = undefined
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'test-mapbox-token')
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallback = callback }
      observe = observe
      disconnect = disconnect
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('disables Mapbox performance telemetry for a preview-only map', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    expect(mapboxMocks.options?.performanceMetricsCollection).toBe(false)
  })

  test('does not rebuild the map when a parent rerender recreates equivalent route props', async () => {
    const stops = [
      { id: 'a', label: '淺草寺', order: 0, lng: 139.7, lat: 35.6 },
      { id: 'b', label: '東京鐵塔', order: 1, lng: 139.8, lat: 35.7 },
    ]
    const { rerender } = render(<RoutePreviewMap geometry={geometry} stops={stops} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))

    await act(async () => {
      rerender(<RoutePreviewMap geometry={{ ...geometry }} stops={stops.map(stop => ({ ...stop }))} />)
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(mapboxMocks.created).toBe(1)
    expect(mapboxMocks.remove).not.toHaveBeenCalled()
  })

  test('starts with a pitched 3D camera and antialiasing enabled', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    expect(mapboxMocks.options).toMatchObject({ pitch: 45, bearing: -17.6, antialias: true })
  })

  test('defaults Mapbox vector labels to Traditional Chinese', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    expect(mapboxMocks.options?.language).toBe('zh-Hant')
    expect(mapboxMocks.options?.locale).toMatchObject({
      'AttributionControl.ToggleAttribution': '切換地圖資訊',
      'LogoControl.Title': 'Mapbox 首頁',
      'Map.Title': '路線地圖預覽',
    })
  })

  test('restores the selected 3D camera after fitBounds', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    expect(mapboxMocks.fitBounds).toHaveBeenCalledTimes(1)
    expect(mapboxMocks.jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 45, bearing: -17.6 }))
    const fitBoundsOrder = mapboxMocks.fitBounds.mock.invocationCallOrder[0]
    const jumpToOrder = mapboxMocks.jumpTo.mock.invocationCallOrder[0]
    if (fitBoundsOrder === undefined || jumpToOrder === undefined) throw new Error('missing camera call order')
    expect(fitBoundsOrder).toBeLessThan(jumpToOrder)
  })

  test('does not let the scrolling flex column collapse the map height', () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    const mapFrame = screen.getByLabelText('路線地圖預覽').parentElement
    expect(mapFrame?.className).toContain('min-h-60')
    expect(mapFrame?.className).toContain('shrink-0')
  })

  test('keeps the Mapbox container in normal flow with an inherited size', () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    const mapContainer = screen.getByLabelText('路線地圖預覽')
    expect(mapContainer.className).toContain('h-full')
    expect(mapContainer.className).toContain('w-full')
    expect(mapContainer.className).not.toContain('absolute')
  })

  test('renders walking and reference routes in separate style-valid layers', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    const layers = mapboxMocks.addLayer.mock.calls.map(call => call[0] as Record<string, unknown>)
    const walking = layers.find(candidate => candidate.id === 'route-preview-line-walking')
    const reference = layers.find(candidate => candidate.id === 'route-preview-line-reference')
    expect(walking).toBeTruthy()
    expect(JSON.stringify(walking)).not.toContain('reference')
    expect(JSON.stringify(walking)).not.toContain('line-dasharray')
    expect(reference).toMatchObject({ paint: { 'line-dasharray': [2, 2] } })
    expect(JSON.stringify(reference)).toContain('reference')
    expect(JSON.stringify(reference)).not.toContain('google')
  })

  test('adds 3D building extrusions and data-driven route styling', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    const layers = mapboxMocks.addLayer.mock.calls.map(call => call[0] as Record<string, unknown>)
    const buildings = layers.find(layer => layer.id === 'route-preview-3d-buildings')
    const walkingRoute = layers.find(layer => layer.id === 'route-preview-line-walking')
    const referenceRoute = layers.find(layer => layer.id === 'route-preview-line-reference')
    expect(buildings).toMatchObject({
      type: 'fill-extrusion',
      source: 'composite',
      'source-layer': 'building',
      minzoom: 15,
    })
    expect(JSON.stringify(buildings)).toContain('fill-extrusion-height')
    expect(JSON.stringify(walkingRoute)).toContain('walking')
    expect(JSON.stringify(referenceRoute)).toContain('transit-check')
  })

  test('offers an accessible 2D and 3D camera toggle', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    const twoDimensional = screen.getByRole('button', { name: '2D' })
    const threeDimensional = screen.getByRole('button', { name: '3D' })
    expect(threeDimensional.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(twoDimensional)
    expect(twoDimensional.getAttribute('aria-pressed')).toBe('true')
    expect(mapboxMocks.setLayoutProperty).toHaveBeenLastCalledWith('route-preview-3d-buildings', 'visibility', 'none')
    expect(mapboxMocks.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0, bearing: 0 }))

    fireEvent.click(threeDimensional)
    expect(mapboxMocks.setLayoutProperty).toHaveBeenLastCalledWith('route-preview-3d-buildings', 'visibility', 'visible')
    expect(mapboxMocks.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 45, bearing: -17.6 }))
  })

  test('uses visible numbered marker elements for stop order', async () => {
    render(
      <RoutePreviewMap
        geometry={geometry}
        stops={[
          { id: 'a', label: '淺草寺', order: 0, lng: 139.7, lat: 35.6 },
          { id: 'b', label: '東京鐵塔', order: 1, lng: 139.8, lat: 35.7 },
        ]}
      />,
    )

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    const markerElements = mapboxMocks.markerOptions.map(options => options.element as HTMLElement)
    expect(markerElements.map(element => element.textContent)).toEqual(['1', '2'])
    expect(markerElements.map(element => element.getAttribute('aria-label'))).toEqual(['第 1 站：淺草寺', '第 2 站：東京鐵塔'])
    expect(markerElements.map(element => element.title)).toEqual(['淺草寺', '東京鐵塔'])
    expect(mapboxMocks.popupTexts).toEqual(['1. 淺草寺', '2. 東京鐵塔'])
    expect(mapboxMocks.popupOptions).toEqual([
      expect.objectContaining({ closeButton: false }),
      expect.objectContaining({ closeButton: false }),
    ])
  })

  test('includes stop coordinates in fit bounds even when geometry is degraded', async () => {
    render(
      <RoutePreviewMap
        geometry={{ type: 'FeatureCollection', features: [] }}
        stops={[
          { id: 'a', label: '淺草寺', order: 0, lng: 139.7, lat: 35.6 },
          { id: 'b', label: '東京鐵塔', order: 1, lng: 139.8, lat: 35.7 },
        ]}
      />,
    )

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    expect(mapboxMocks.extendedBounds).toContainEqual([139.7, 35.6])
    expect(mapboxMocks.extendedBounds).toContainEqual([139.8, 35.7])
    expect(mapboxMocks.fitBounds).toHaveBeenCalledTimes(1)
  })

  test('surfaces a critical route-layer setup failure after the base style loaded', async () => {
    mapboxMocks.addLayer.mockImplementation((layer: { id?: string }) => {
      if (layer.id === 'route-preview-line-walking') throw new Error('invalid layer')
    })
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())

    expect(screen.getByText('路線圖層載入失敗；仍可使用路線清單')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '3D' })).toBeNull()
  })

  test('surfaces an asynchronous initial style error instead of a blank map', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    expect(mapboxMocks.handlers.error).toBeTypeOf('function')
    act(() => mapboxMocks.handlers.error?.())

    expect(screen.getByText('地圖載入失敗；仍可使用路線清單')).toBeTruthy()
  })

  test('does not replace a loaded map for a later nonfatal tile error', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    act(() => mapboxMocks.handlers.load?.())
    act(() => mapboxMocks.handlers.error?.())

    expect(screen.queryByText('地圖載入失敗；仍可使用路線清單')).toBeNull()
    expect(screen.getByRole('button', { name: '3D' })).toBeTruthy()
  })

  test('times out when the initial Mapbox load event never arrives', async () => {
    vi.useFakeTimers()
    try {
      render(<RoutePreviewMap geometry={geometry} stops={[]} />)
      await act(async () => { await Promise.resolve() })
      expect(mapboxMocks.created).toBe(1)

      act(() => vi.advanceTimersByTime(10_000))

      expect(screen.getByText('地圖載入逾時；仍可使用路線清單')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('resizes Mapbox when its bottom-sheet container changes size', async () => {
    render(<RoutePreviewMap geometry={geometry} stops={[]} />)

    await waitFor(() => expect(mapboxMocks.created).toBe(1))
    expect(observe).toHaveBeenCalledTimes(1)
    act(() => resizeCallback?.())

    expect(mapboxMocks.resize).toHaveBeenCalledTimes(1)
  })
})
