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
