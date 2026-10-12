// Infrastructure failures in the entry gates (JWKS fetch, rate limiters)
// must come back as a CORS-carrying precommit 503 -- never as a 401 that
// reads as "signed out", and never as an uncaught Cloudflare 1101 that the
// browser can only see as a network error.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errors } from 'jose'

const { JOSEError, JWKSTimeout, JWTExpired, JWKSNoMatchingKey } = errors

const mocks = vi.hoisted(() => ({
  verify:     vi.fn(async (): Promise<{ sub: string }> => ({ sub: 'gate-test' })),
  checkGlobal: vi.fn(async () => ({ allowed: true, count: 1, resetMs: 0 })),
  capture:    vi.fn(async () => undefined),
}))

vi.mock('../src/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/auth')>('../src/auth')
  return { ...actual, verifyFirebaseToken: mocks.verify }
})
vi.mock('../src/rate-limiter', () => ({ checkGlobalRateLimit: mocks.checkGlobal }))
vi.mock('../src/sentry', async () => {
  const actual = await vi.importActual<typeof import('../src/sentry')>('../src/sentry')
  return { ...actual, captureMessage: mocks.capture }
})

import worker from '../src/index'
import { isJwksUnavailable, JwksUnavailableError } from '../src/auth'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>
const ORIGIN = 'http://localhost:5173'

async function post(path: string, testEnv: object = env): Promise<Response> {
  const req = new IncomingRequest(`https://example.com${path}`, {
    method:  'POST',
    headers: { Authorization: 'Bearer t', Origin: ORIGIN, 'Content-Type': 'application/json' },
    body:    '{}',
  })
  const ctx = createExecutionContext()
  const res = await worker.fetch(req, testEnv as Parameters<typeof worker.fetch>[1], ctx)
  await waitOnExecutionContext(ctx)
  return res
}

afterEach(() => vi.clearAllMocks())

describe('isJwksUnavailable', () => {
  it('separates key-set fetch failures from token defects', () => {
    expect(isJwksUnavailable(new JWKSTimeout())).toBe(true)
    expect(isJwksUnavailable(new JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'))).toBe(true)
    expect(isJwksUnavailable(new JwksUnavailableError(new TypeError('Network connection lost')))).toBe(true)
    expect(isJwksUnavailable(new JWTExpired('"exp" claim timestamp check failed', {}))).toBe(false)
    expect(isJwksUnavailable(new JWKSNoMatchingKey())).toBe(false)
    expect(isJwksUnavailable(new Error('Token missing sub claim'))).toBe(false)
  })
})

describe('entry gate infrastructure failures', () => {
  it('JWKS fetch failure → 503 precommit with CORS, not 401', async () => {
    mocks.verify.mockRejectedValueOnce(new JWKSTimeout())
    const res = await post('/fx-rate')
    expect(res.status).toBe(503)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    await expect(res.json()).resolves.toEqual({ error: 'Auth temporarily unavailable', precommit: true })
  })

  it('a bad token still → 401', async () => {
    mocks.verify.mockRejectedValueOnce(new JWTExpired('"exp" claim timestamp check failed', {}))
    const res = await post('/fx-rate')
    expect(res.status).toBe(401)
  })

  it('L1 limiter throw → 503 precommit with CORS + reported', async () => {
    const res = await post('/fx-rate', {
      ...env,
      FX_PREVIEW_RATE_LIMITER: { limit: async () => { throw new Error('binding down') } },
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    await expect(res.json()).resolves.toEqual({ error: 'Rate limiter unavailable', precommit: true })
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('binding down'), 'error',
      expect.objectContaining({ endpoint: '/fx-rate' }), expect.anything(),
    )
    expect(mocks.checkGlobal).not.toHaveBeenCalled()
  })

  it('L2 Durable Object throw → 503 precommit with CORS + reported', async () => {
    mocks.checkGlobal.mockRejectedValueOnce(new Error('DO overloaded'))
    const res = await post('/fx-rate')
    expect(res.status).toBe(503)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    await expect(res.json()).resolves.toMatchObject({ precommit: true })
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('DO overloaded'), 'error',
      expect.anything(), expect.anything(),
    )
  })
})
