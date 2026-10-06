import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/auth')>('../src/auth')
  return { ...actual, verifyFirebaseToken: vi.fn(async () => ({ sub: 'body-limit-test' })) }
})
vi.mock('../src/rate-limiter', () => ({
  checkGlobalRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetMs: 60_000 })),
}))

import worker from '../src/index'
import { MAX_JSON_BODY_BYTES } from '../src/request-body'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

afterEach(() => vi.clearAllMocks())

describe('JSON body limit at the Worker entry point', () => {
  it.each([undefined, '2'])('returns 413 with a missing or understated length (%s)', async length => {
    const headers = new Headers({ Authorization: 'Bearer test-token', Origin: 'http://localhost:5173' })
    if (length !== undefined) headers.set('Content-Length', length)
    const request = new IncomingRequest('https://example.com/ocr', {
      method: 'POST', headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_JSON_BODY_BYTES + 1))
          controller.close()
        },
      }),
    })
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env as Parameters<typeof worker.fetch>[1], ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(413)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    await expect(response.json()).resolves.toEqual({ error: 'Body too large' })
  })
})
