import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ signedIn: true }))
vi.mock('./firebase', () => ({
  getFirebaseAuth: vi.fn(async () => ({
    auth: { currentUser: auth.signedIn ? { getIdToken: async () => 'id-token' } : null },
  })),
}))

import { workerRead, type WorkerReadFailure } from './workerBase'

const failures: WorkerReadFailure[] = []
const toError = (f: WorkerReadFailure) => { failures.push(f); return new Error(f.kind) }

afterEach(() => {
  vi.unstubAllGlobals()
  failures.length = 0
  auth.signedIn = true
})

describe('workerRead', () => {
  it('posts JSON with the bearer token and returns the parsed body', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response('{"ok":1}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(workerRead('/x', { a: 1 }, { base: 'https://w.test', toError })).resolves.toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://w.test/x')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer id-token')
    expect(JSON.parse(init!.body as string)).toEqual({ a: 1 })
  })

  it('reports HTTP rejections with status, body and code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope","code":"X_CODE"}', { status: 409 })))
    await expect(workerRead('/x', {}, { base: 'https://w.test', toError })).rejects.toThrow('status')
    expect(failures[0]).toEqual({ kind: 'status', status: 409, detail: '{"error":"nope","code":"X_CODE"}', code: 'X_CODE' })
  })

  it('reports timeouts and network failures without a status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }))
    await expect(workerRead('/x', {}, { base: 'https://w.test', toError })).rejects.toThrow('network')
    expect(failures[0]).toMatchObject({ kind: 'network', timedOut: true })
  })

  it('never calls the network when signed out', async () => {
    auth.signedIn = false
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(workerRead('/x', {}, { base: 'https://w.test', toError })).rejects.toThrow('signed-out')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreadable success body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(workerRead('/x', {}, { base: 'https://w.test', toError })).rejects.toThrow('bad-response')
  })
})
