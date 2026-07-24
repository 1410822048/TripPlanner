// Tests for the workerBase URL resolver. Two invariants under test:
//   1. Mutating endpoints (`requireWorkerWriteBase`) throw when env is
//      unset -- the regression we're guarding against is a preview /
//      staging deploy silently routing admin-SDK writes to the prod
//      Worker (which would mutate prod Firestore via the prod service
//      account, exactly the kind of cross-env incident that's hard to
//      unwind after the fact).
//   2. Trailing slash on either env or fallback is normalised away,
//      since CF Workers route on exact path match -- a `//endpoint`
//      double-slash 404s instead of dispatching.
//
// Module re-import per case because the URL resolution runs at module
// load, and `vi.stubEnv` only takes effect on subsequent loads.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pdfPageLimitMessageJa } from '@tripmate/pdf-page-limit'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('workerBase', () => {
  it('requireWorkerWriteBase throws when VITE_WORKER_BASE_URL unset', async () => {
    vi.stubEnv('VITE_WORKER_BASE_URL', '')
    vi.stubEnv('VITE_OCR_API_URL', '')
    const { requireWorkerWriteBase } = await import('./workerBase')
    expect(() => requireWorkerWriteBase()).toThrow(/VITE_WORKER_BASE_URL/)
  })

  it('requireWorkerWriteBase returns the env URL when set', async () => {
    vi.stubEnv('VITE_WORKER_BASE_URL', 'https://staging-worker.example.dev')
    const { requireWorkerWriteBase } = await import('./workerBase')
    expect(requireWorkerWriteBase()).toBe('https://staging-worker.example.dev')
  })

  it('strips trailing slash from env value (prevents //endpoint route mismatch)', async () => {
    vi.stubEnv('VITE_WORKER_BASE_URL', 'https://staging-worker.example.dev/')
    const { requireWorkerWriteBase, WORKER_BASE_URL } = await import('./workerBase')
    expect(requireWorkerWriteBase()).toBe('https://staging-worker.example.dev')
    expect(WORKER_BASE_URL).toBe('https://staging-worker.example.dev')
  })

  it('WORKER_BASE_URL falls back to prod when env unset (read-only OCR is safe)', async () => {
    vi.stubEnv('VITE_WORKER_BASE_URL', '')
    vi.stubEnv('VITE_OCR_API_URL', '')
    const { WORKER_BASE_URL } = await import('./workerBase')
    expect(WORKER_BASE_URL).toBe('https://tripmate-ocr.tripmate.workers.dev')
  })

  // Regression guard for the "stale preview env with legacy OCR var
  // still pointing at prod" scenario. WORKER_BASE_URL honours the
  // legacy name so existing OCR keeps working; requireWorkerWriteBase
  // does NOT, because a write-path fallback to prod would route
  // preview admin-SDK writes against production Firestore.
  it('legacy VITE_OCR_API_URL feeds OCR fallback but NOT the write gate', async () => {
    vi.stubEnv('VITE_WORKER_BASE_URL', '')
    vi.stubEnv('VITE_OCR_API_URL', 'https://legacy-prod-worker.example.dev')
    const { WORKER_BASE_URL, requireWorkerWriteBase } = await import('./workerBase')
    expect(WORKER_BASE_URL).toBe('https://legacy-prod-worker.example.dev')
    expect(() => requireWorkerWriteBase()).toThrow(/VITE_WORKER_BASE_URL/)
  })
})

// The WorkerRejected vs WorkerAmbiguous split is what useTripListMutation
// keys on to decide rollback (definitive) vs keep-optimistic (ambiguous).
// It's the client half of the tx-failure taxonomy: the Worker maps a
// DEFINITIVE retry-exhaustion to 409 (→ rollback) and an AMBIGUOUS commit
// timeout to 5xx (→ keep). These lock the status → error-class contract so
// a future tweak to DEFINITIVE_REJECT_STATUSES can't silently turn a
// rollback into a phantom-row keep (or vice versa).
describe('workerFetch — HTTP error classification', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  function stubFetchStatus(status: number, body: string) {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as typeof fetch
  }

  it('409 → WorkerRejected (definitive; caller rolls back optimistic state)', async () => {
    // 409 is what handleJsonRoute returns for TxRetryExhausted (and for a
    // stale settlement suggestion). Both are provably-not-committed → the
    // optimistic settlement row must roll back, not linger.
    stubFetchStatus(409, JSON.stringify({ error: 'stale', code: 'TX_RETRY_EXHAUSTED' }))
    const { workerFetch, WorkerRejected } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/settlement-create', {}),
    ).rejects.toBeInstanceOf(WorkerRejected)
  })

  it('preserves stable Worker code and field metadata on explicit rejections', async () => {
    stubFetchStatus(409, JSON.stringify({
      error: 'schedule constraints changed while previewing',
      code: 'PREVIEW_STALE',
      field: 'schedules',
      precommit: true,
    }))
    const { workerFetch } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/route-preview', {}),
    ).rejects.toMatchObject({
      name: 'WorkerRejected',
      status: 409,
      code: 'PREVIEW_STALE',
      field: 'schedules',
    })
  })

  it('allows a route preview to opt into a longer client timeout', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { workerFetch } = await import('./workerBase')

    await workerFetch(
      'https://w.example.dev',
      'tok',
      '/route-preview',
      {},
      { timeoutMs: 35_000 },
    )

    expect(timeoutSpy).toHaveBeenCalledWith(35_000)
  })

  it('4xx JSON error body uses the Worker error message instead of raw JSON', async () => {
    const error = pdfPageLimitMessageJa('PDF_PAGE_LIMIT_EXCEEDED')
    stubFetchStatus(413, JSON.stringify({
      error,
      code: 'PDF_PAGE_LIMIT_EXCEEDED',
    }))
    const { workerFetch } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/booking-file-create', {}),
    ).rejects.toMatchObject({
      name: 'WorkerRejected',
      status: 413,
      message: error,
    })
  })

  it('non-JSON 4xx error body keeps the endpoint/status fallback', async () => {
    stubFetchStatus(400, 'plain bad request')
    const { workerFetch } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/settlement-create', {}),
    ).rejects.toMatchObject({
      name: 'WorkerRejected',
      status: 400,
      message: '/settlement-create -> 400: plain bad request',
    })
  })

  it('500 → WorkerAmbiguous (commit may have applied; caller keeps optimistic state)', async () => {
    stubFetchStatus(500, JSON.stringify({ error: 'Internal error' }))
    const { workerFetch, WorkerAmbiguous } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/settlement-create', {}),
    ).rejects.toBeInstanceOf(WorkerAmbiguous)
  })

  it('fetch rejection (timeout / network) → WorkerAmbiguous', async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error('The operation timed out.')
      e.name = 'TimeoutError'
      throw e
    }) as typeof fetch
    const { workerFetch, WorkerAmbiguous } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/settlement-create', {}),
    ).rejects.toBeInstanceOf(WorkerAmbiguous)
  })

  it('5xx WITH precommit:true body → WorkerRejected (provably pre-commit; rolls back)', async () => {
    // FX provider 502 / read-cap 503 in a single-tx endpoint carry
    // precommit:true → definitively no write → the optimistic row must roll
    // back, not linger behind a "still confirming" toast.
    stubFetchStatus(502, JSON.stringify({ error: 'Frankfurter down', code: 'FX_PROVIDER_UNAVAILABLE', precommit: true }))
    const { workerFetch, WorkerRejected } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/settlement-create', {}),
    ).rejects.toBeInstanceOf(WorkerRejected)
  })

  it('5xx WITHOUT precommit → WorkerAmbiguous (response-loss / mid-cascade; keeps optimistic)', async () => {
    stubFetchStatus(503, JSON.stringify({ error: 'partial cascade failure' }))
    const { workerFetch, WorkerAmbiguous } = await import('./workerBase')
    await expect(
      workerFetch('https://w.example.dev', 'tok', '/cascade-trip-delete', {}),
    ).rejects.toBeInstanceOf(WorkerAmbiguous)
  })
})
