// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// 隔離 UI 依賴，保留實際 App 模組的啟動邏輯。
vi.mock('@/routes', () => ({ router: {} }))
vi.mock('@/services/queryClient', () => ({ queryClient: {} }))
vi.mock('@/components/PwaUpdateProvider', () => ({ PwaUpdateProvider: () => null }))
vi.mock('@/components/AppCompatibilityGate', () => ({ default: () => null }))
vi.mock('@/components/ui/PerfStrip', () => ({ default: () => null }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('App session bootstrap', () => {
  it.each(['getItem', 'setItem'] as const)('survives blocked sessionStorage.%s and retains the current route', async method => {
    vi.resetModules()
    window.history.replaceState(null, '', '/account')
    const blocked = () => { throw new DOMException('Storage blocked', 'SecurityError') }
    vi.stubGlobal('sessionStorage', {
      getItem: method === 'getItem' ? blocked : () => null,
      setItem: blocked,
    })
    await expect(import('./App')).resolves.toHaveProperty('default')
    expect(window.location.pathname).toBe('/account')
  })

  it('still starts a new ordinary session at /schedule', async () => {
    vi.resetModules()
    window.history.replaceState(null, '', '/account')
    await import('./App')
    expect(window.location.pathname).toBe('/schedule')
  })

  it('preserves invite deep links', async () => {
    vi.resetModules()
    window.history.replaceState(null, '', '/invite/trip-1#secret')
    await import('./App')
    expect(window.location.pathname + window.location.hash).toBe('/invite/trip-1#secret')
  })
})
