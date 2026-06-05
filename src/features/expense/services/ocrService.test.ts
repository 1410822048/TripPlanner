// Tests for the re-OCR-existing-receipt client service:
//   - ocrResultStillApplicable: the race guard (receipt swapped / expense
//     edited mid-flight → discard). Pure fn, so directly unit-testable
//     without component infra.
//   - ocrExistingExpenseReceipt: POST shape + status → OcrError mapping.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getIdToken = vi.fn(async () => 'id-token')
vi.mock('@/services/firebase', () => ({
  getFirebaseAuth: vi.fn(async () => ({ auth: { currentUser: { getIdToken } } })),
}))
// Privileged base for /expense-receipt-ocr (no prod fallback). A vi.fn so a
// single test can make it throw (env unset) and prove we do NOT fetch prod.
// vi.hoisted so it's initialised before the hoisted vi.mock factory runs.
const { requireWorkerWriteBaseMock } = vi.hoisted(() => ({
  requireWorkerWriteBaseMock: vi.fn(() => 'https://worker.example.dev'),
}))
vi.mock('@/services/workerBase', () => ({
  WORKER_BASE_URL: 'https://worker.example.dev',
  requireWorkerWriteBase: requireWorkerWriteBaseMock,
}))

import {
  ocrResultStillApplicable,
  ocrExistingExpenseReceipt,
  OcrError,
} from './ocrService'

describe('ocrResultStillApplicable — re-OCR race guard', () => {
  const captured = { receiptPath: 'trips/t/expenses/e/receipt.webp', updatedAtMillis: 1_700_000_000_000 }

  it('applies when receipt path + updatedAt both match', () => {
    expect(ocrResultStillApplicable(captured, {
      sourceReceiptPath: captured.receiptPath,
      expenseUpdatedAt:  new Date(captured.updatedAtMillis).toISOString(),
    })).toBe(true)
  })

  it('DISCARDS when the receipt was replaced (path changed) mid-flight', () => {
    expect(ocrResultStillApplicable(captured, {
      sourceReceiptPath: 'trips/t/expenses/e/receipt-v2.webp',
      expenseUpdatedAt:  new Date(captured.updatedAtMillis).toISOString(),
    })).toBe(false)
  })

  it('DISCARDS when the expense was edited mid-flight (same path, updatedAt mismatch)', () => {
    expect(ocrResultStillApplicable(captured, {
      sourceReceiptPath: captured.receiptPath,
      expenseUpdatedAt:  new Date(captured.updatedAtMillis + 5_000).toISOString(),
    })).toBe(false)
  })

  it('falls back to path-only when the RESPONSE has no updatedAt', () => {
    expect(ocrResultStillApplicable(captured, { sourceReceiptPath: captured.receiptPath })).toBe(true)
  })

  it('falls back to path-only when the CAPTURED snapshot has no updatedAt', () => {
    expect(ocrResultStillApplicable(
      { receiptPath: captured.receiptPath },
      { sourceReceiptPath: captured.receiptPath, expenseUpdatedAt: new Date().toISOString() },
    )).toBe(true)
  })
})

describe('ocrExistingExpenseReceipt', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  beforeEach(() => {
    getIdToken.mockClear()
    requireWorkerWriteBaseMock.mockClear()
    requireWorkerWriteBaseMock.mockReturnValue('https://worker.example.dev')
  })

  function stubFetch(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  }

  it('200 → returns the envelope; posts ONLY identifiers (never path/url)', async () => {
    // Typed params (like fetch) so mock.calls is [input, init?] — an
    // untyped `vi.fn(async () => …)` infers an empty-arg tuple and the
    // call-args assertion below won't type-check under noUncheckedIndexedAccess.
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(
        JSON.stringify({ result: { items: [], adjustments: [], ignoredLines: [], totalText: '0' }, sourceReceiptPath: 'p' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const out = await ocrExistingExpenseReceipt('trip-1', 'exp-1', 'JPY')
    expect(out.sourceReceiptPath).toBe('p')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe('https://worker.example.dev/expense-receipt-ocr')
    const sent = JSON.parse(call[1]!.body as string)
    expect(sent).toEqual({ tripId: 'trip-1', expenseId: 'exp-1', currencyHint: 'JPY' })
    expect(sent).not.toHaveProperty('path')
    expect(sent).not.toHaveProperty('url')
  })

  it('maps statuses → OcrError kinds (401 auth / 403 forbidden / 429 rate-limit / 409 stale / 422·415 parse)', async () => {
    stubFetch(401, { error: 'x' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'auth' })
    // 403 = permission lost mid-edit (role downgrade, or settled-mid-OCR for
    // a non-owner) — a typed kind, NOT the raw-status 'unknown' bucket.
    stubFetch(403, { error: 'expense is settlement-locked' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'forbidden' })
    stubFetch(429, { error: 'x' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'rate-limit' })
    // 409 = Worker post-OCR revalidation found a mid-OCR change.
    stubFetch(409, { error: 'expense changed during OCR' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'stale' })
    stubFetch(422, { error: 'x' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'parse' })
    stubFetch(415, { error: 'x' })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('maps retryable upstream 5xx to unavailable for re-OCR', async () => {
    for (const status of [502, 503, 504]) {
      stubFetch(status, { error: 'Gemini high demand' })
      await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toMatchObject({ kind: 'unavailable' })
    }
  })

  it('throws OcrError(auth) when signed out', async () => {
    const { getFirebaseAuth } = await import('@/services/firebase')
    vi.mocked(getFirebaseAuth).mockResolvedValueOnce({ auth: { currentUser: null } } as never)
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toBeInstanceOf(OcrError)
  })

  it('does NOT fetch when the privileged base is unset (no prod fallback)', async () => {
    // This route reads Firestore + downloads the receipt with the admin
    // service-account, so an unconfigured preview/local build must FAIL,
    // never silently hit the prod Worker. requireWorkerWriteBase() throws.
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    requireWorkerWriteBaseMock.mockImplementationOnce(() => {
      throw new Error('VITE_WORKER_BASE_URL is not set')
    })
    await expect(ocrExistingExpenseReceipt('t', 'e')).rejects.toThrow(/VITE_WORKER_BASE_URL/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
