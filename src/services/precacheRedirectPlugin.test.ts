// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrecacheStrategy } from 'workbox-precaching'
import { precacheRedirectPlugin } from './precacheRedirectPlugin'

vi.hoisted(() => {
  vi.stubGlobal('self', { location: new URL('https://tripmate.test') })
})

class TestExtendableEvent extends Event {
  waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
}

const origin = 'https://tripmate.test'
const shellUrl = `${origin}/index.html`
const fetchMock = vi.fn<typeof fetch>()
const matchMock = vi.fn<CacheStorage['match']>()

function redirectedShell(url = `${origin}/`) {
  const response = new Response('<main>TripMate</main>', {
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-shell-version': 'test' },
  })
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: true },
  })
  return response
}

async function handleShell(withPlugin = true) {
  const strategy = new PrecacheStrategy({
    plugins: withPlugin ? [precacheRedirectPlugin] : [],
  })
  const [response, done] = strategy.handleAll({
    request: new Request(shellUrl),
    event: new TestExtendableEvent('fetch'),
  })
  const [result] = await Promise.all([response, done])
  return result
}

beforeEach(() => {
  vi.stubGlobal('self', { location: new URL(origin), __WB_DISABLE_DEV_LOGS: true })
  vi.stubGlobal('location', new URL(origin))
  vi.stubGlobal('ExtendableEvent', TestExtendableEvent)
  vi.stubGlobal('FetchEvent', class extends TestExtendableEvent {})
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('caches', { match: matchMock })
  matchMock.mockResolvedValue(undefined)
  fetchMock.mockResolvedValue(redirectedShell())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('precache network fallback', () => {
  it('reproduces the redirected fallback returned by unmodified Workbox', async () => {
    expect((await handleShell(false)).redirected).toBe(true)
  })

  it('returns a navigation-safe response when the app shell cache is missing', async () => {
    const response = await handleShell()
    expect(response.redirected).toBe(false)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('x-shell-version')).toBe('test')
    expect(await response.text()).toBe('<main>TripMate</main>')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps the cache-first offline path without fetching', async () => {
    const cached = new Response('cached app shell')
    matchMock.mockResolvedValue(cached)
    expect(await handleShell()).toBe(cached)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not copy a response that was not redirected', async () => {
    const response = new Response('direct app shell')
    fetchMock.mockResolvedValue(response)
    expect(await handleShell()).toBe(response)
  })

  it('preserves the same-origin guard for redirected responses', async () => {
    fetchMock.mockResolvedValue(redirectedShell('https://untrusted.example/'))
    await expect(handleShell()).rejects.toMatchObject({ name: 'cross-origin-copy-response' })
  })
})
