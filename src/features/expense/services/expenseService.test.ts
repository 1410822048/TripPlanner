// Tests for the Worker commit-ambiguity discrimination layer in
// `workerFetch` + the read-back logic in createExpense / updateExpense
// rollback paths.
//
// The regression we're locking in: a 30s timeout AFTER the Worker
// committed but BEFORE its 200 response landed used to be caught
// as a generic Error and trigger an inline blob-purge. The doc now
// referenced the new blob, so the purge left a broken receipt link.
//
// Mocking strategy: stub `getFirebase`/`getFirebaseAuth`/global.fetch
// at the boundary. We're NOT exercising firestore real I/O -- the
// focus is the catch-block decision logic.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateExpenseInput, UpdateExpenseInput } from '@/types'

// ── Mocks ──────────────────────────────────────────────────────────

const fetchMock = vi.fn()
const getDocMock = vi.fn()
const setDocMock = vi.fn()  // never used in workerFetch path; here for shape parity
const docMock     = vi.fn((_db: unknown, ..._segs: string[]) => ({ id: _segs.at(-1) ?? 'unknown', _kind: 'doc' }))
const collectionMock = vi.fn((_db: unknown, ..._segs: string[]) => ({ _kind: 'collection' }))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:              {},
    collection:      collectionMock,
    doc:             docMock,
    setDoc:          setDocMock,
    updateDoc:       vi.fn(),
    deleteField:     vi.fn(),
    getDoc:          getDocMock,
    serverTimestamp: () => ({ _kind: 'serverTimestamp' }),
  })),
  getFirebaseAuth: vi.fn(async () => ({
    auth: {
      currentUser: {
        getIdToken: vi.fn(async () => 'fake-id-token'),
      },
    },
  })),
}))

// uploadReceipt / purgeReceipt: track call counts so we can assert
// whether a rollback fired or not.
const uploadReceiptMock = vi.fn()
const purgeReceiptMock  = vi.fn()
vi.mock('./expenseStorage', () => ({
  uploadReceipt: (...args: unknown[]) => uploadReceiptMock(...args),
  purgeReceipt:  (...args: unknown[]) => purgeReceiptMock(...args),
}))

// safePurgeWithEnqueueFallback: stub so we can detect whether the
// rollback path entered it. Real impl is tested in orphanPurge.test.ts.
const safePurgeMock        = vi.fn(async (_args: unknown) => undefined)
const enqueueOrphanPurgesMock = vi.fn(async (_args: unknown) => ['queue-id'])
vi.mock('@/services/orphanPurge', () => ({
  safePurgeWithEnqueueFallback: (args: unknown) => safePurgeMock(args),
  enqueueOrphanPurges:          (args: unknown) => enqueueOrphanPurgesMock(args),
}))

// Partial mock: real workerFetch + error classes + preflightIdToken
// (the test asserts on WorkerRejected vs WorkerAmbiguous discrimination
// produced by the real workerFetch). Only override requireWorkerWriteBase
// so we don't need a VITE_WORKER_BASE_URL env stub.
vi.mock('@/services/workerBase', async () => {
  const actual = await vi.importActual<typeof import('@/services/workerBase')>('@/services/workerBase')
  return {
    ...actual,
    requireWorkerWriteBase: vi.fn(() => 'https://worker.example.dev'),
  }
})

const captureErrorMock = vi.fn()
const breadcrumbMock   = vi.fn()
vi.mock('@/services/sentry', () => ({
  captureError: captureErrorMock,
  breadcrumb:   breadcrumbMock,
}))

vi.mock('@/services/tripActivity', () => ({
  bumpTripActivity: vi.fn(),
}))

// validateUpdateOrThrow / firestoreDocFromSchema / tripScopedList:
// not exercised on the workerFetch + rollback paths but referenced
// by module-level imports. Stub.
vi.mock('@/services/validateUpdate', () => ({
  validateUpdateOrThrow: (_schema: unknown, x: unknown) => x,
}))
vi.mock('@/services/firestoreDocFromSchema', () => ({
  firestoreDocFromSchema: vi.fn(),
}))
vi.mock('@/services/tripScopedList', () => ({
  createTripScopedListServices: () => ({ fetch: vi.fn(), subscribe: vi.fn() }),
}))
vi.mock('@/utils/audit', () => ({
  auditUpdate: () => ({}),
  auditCreate: () => ({}),
}))

// Wire fetch globally.
globalThis.fetch = fetchMock as unknown as typeof fetch

beforeEach(() => {
  fetchMock.mockReset()
  getDocMock.mockReset()
  setDocMock.mockReset()
  purgeReceiptMock.mockReset()
  safePurgeMock.mockReset()
  enqueueOrphanPurgesMock.mockReset()
  enqueueOrphanPurgesMock.mockResolvedValue(['queue-id'])
  uploadReceiptMock.mockReset()
})

// ── Helpers ────────────────────────────────────────────────────────

// Phase 3.5: uploadReceipt now returns the intent-flow shape -- intentIds
// for the Worker call, paths for client-side rollback addressing. Phase
// 3.7 added `traceId` for upload-flow log-line correlation; expenseService
// reads it off the same return to thread into both the entity-write
// workerFetch opts AND the Sentry breadcrumb. Helper bakes a fixed value
// so tests that assert breadcrumb wiring can pin equality.
function mockReceipt(): { intentIds: string[]; paths: string[]; traceId: string } {
  return {
    intentIds: ['intent-full-1', 'intent-thumb-1'],
    paths:     ['trips/t1/expenses/exp-1/abc.webp', 'trips/t1/expenses/exp-1/abc.thumb.webp'],
    traceId:   'test-trace-id-aaaa',
  }
}

function mockExpenseInput() {
  return {
    title:       'Lunch',
    amountMinor: 1000,
    currency:    'JPY',
    category:    'food' as const,
    paidBy:      'editor-uid',
    splits:      [{ memberId: 'editor-uid', amountMinor: 1000 }],
    date:        '2026-05-22',
    adjustments: [],
  }
}

// ── workerFetch error discrimination ───────────────────────────────

describe('workerFetch error discrimination', () => {
  it('400 → WorkerRejected (definite, blob safe to purge)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())

    const { createExpense, WorkerRejected } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toBeInstanceOf(WorkerRejected)

    // Definite reject → rollback fired (safePurge invoked once with the new blob)
    expect(safePurgeMock).toHaveBeenCalledTimes(1)
  })

  it('429 (rate limit) → WorkerRejected → rollback fires', async () => {
    fetchMock.mockResolvedValueOnce(new Response('too many', { status: 429 }))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())

    const { createExpense, WorkerRejected } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toBeInstanceOf(WorkerRejected)
    expect(safePurgeMock).toHaveBeenCalledTimes(1)
  })

  it('500 (internal) → WorkerAmbiguous → enqueue for cron verify (no inline purge)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('crashed', { status: 500 }))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())

    const { createExpense, WorkerAmbiguous } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toBeInstanceOf(WorkerAmbiguous)
    // Ambiguous → NOT inline purge (would break doc link if Worker
    // committed). Enqueue for the cron's verify-before-delete instead.
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
    expect(enqueueOrphanPurgesMock.mock.calls[0]![0]).toMatchObject({
      collection: 'expenses',
      source:     'createExpense/ambiguous-rollback',
    })
  })

  it('fetch throws AbortError (timeout) → WorkerAmbiguous → enqueue', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'AbortError'))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())

    const { createExpense, WorkerAmbiguous } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toBeInstanceOf(WorkerAmbiguous)
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
  })
})

// ── Ambiguous rollback semantics (cron-routing path) ───────────────

describe('ambiguous → enqueueOrphanPurges routing', () => {
  it('createExpense AMBIGUOUS: defers to cron verify regardless of doc state', async () => {
    // The whole point of routing through the cron: client doesn't
    // need to read back doc state to disambiguate. The cron's
    // verify-before-delete (entityRef lookup → path comparison) does
    // exactly that, just deferred. No getDoc on this path.
    fetchMock.mockResolvedValueOnce(new Response('crashed', { status: 500 }))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toThrow()

    expect(getDocMock).not.toHaveBeenCalled()  // no client-side read-back
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
    expect(safePurgeMock).not.toHaveBeenCalled()
  })

  it('AMBIGUOUS + enqueue ITSELF fails → captureError fires, original error still thrown', async () => {
    // Enqueue is best-effort: if it fails (rules denied, network),
    // we want the original WorkerAmbiguous to bubble for mutation
    // onError, AND Sentry to receive the compound failure so ops
    // can see the genuinely-stranded blob.
    fetchMock.mockResolvedValueOnce(new Response('crashed', { status: 500 }))
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())
    enqueueOrphanPurgesMock.mockRejectedValueOnce(new Error('rules denied'))
    captureErrorMock.mockClear()

    const { createExpense, WorkerAmbiguous } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toBeInstanceOf(WorkerAmbiguous)

    expect(captureErrorMock).toHaveBeenCalledTimes(1)
    expect(captureErrorMock.mock.calls[0]![1]).toMatchObject({
      source: 'createExpense/ambiguous-rollback-enqueue-failed',
    })
  })

  it('updateExpense AMBIGUOUS: enqueue with updateExpense source tag (no inline read-back)', async () => {
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'AbortError'))

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid', attachment: new File([], 'r.jpg'),
    })).rejects.toThrow()

    expect(getDocMock).not.toHaveBeenCalled()
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
    expect(enqueueOrphanPurgesMock.mock.calls[0]![0]).toMatchObject({
      collection: 'expenses',
      entityId:   'exp-1',
      source:     'updateExpense/ambiguous-rollback',
    })
  })

  it('REJECTED (400) → inline rollback via safePurge (existing fast path)', async () => {
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }))

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid', attachment: new File([], 'r.jpg'),
    })).rejects.toThrow()

    expect(safePurgeMock).toHaveBeenCalledTimes(1)
    expect(enqueueOrphanPurgesMock).not.toHaveBeenCalled()
  })

  // ── Auth preflight (P2: fail-closed before upload) ────────────

  it('P2: currentUser === null → throws BEFORE uploadReceipt, no Storage side effect', async () => {
    // Headline: this used to fail INSIDE workerFetch (after upload),
    // surfacing as a plain Error that the catch treated as ambiguous
    // → routed to _purges enqueue → rules rejected (now-stale auth)
    // → blob orphan. Hoisting the auth check makes the failure
    // fire BEFORE any Storage write.
    const firebaseMod = await import('@/services/firebase')
    vi.mocked(firebaseMod.getFirebaseAuth).mockResolvedValueOnce({
      auth: { currentUser: null },
    } as Awaited<ReturnType<typeof firebaseMod.getFirebaseAuth>>)

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toThrow(/not signed in/i)

    expect(uploadReceiptMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).not.toHaveBeenCalled()
  })

  it('P2: getIdToken() rejects → throws BEFORE uploadReceipt, no Storage side effect', async () => {
    // Same shape as above but failure point is the token refresh
    // itself (network blip during getIdToken). Still fail-closed.
    const firebaseMod = await import('@/services/firebase')
    vi.mocked(firebaseMod.getFirebaseAuth).mockResolvedValueOnce({
      auth: {
        currentUser: {
          getIdToken: vi.fn().mockRejectedValueOnce(new Error('token refresh failed')),
        },
      },
    } as unknown as Awaited<ReturnType<typeof firebaseMod.getFirebaseAuth>>)

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid', attachment: new File([], 'r.jpg'),
    })).rejects.toThrow(/token refresh failed/)

    expect(uploadReceiptMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).not.toHaveBeenCalled()
  })

  it('P2: signed-in + token resolves → upload + workerFetch proceed normally', async () => {
    // Honest path: preflight token resolves, upload happens, Worker
    // is called with the pre-fetched token in the Authorization
    // header. No regression in the happy case.
    uploadReceiptMock.mockResolvedValueOnce(mockReceipt())
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true,"expenseId":"e1"}', { status: 200 }))

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .resolves.toBeDefined()

    expect(uploadReceiptMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Token reached the wire as Bearer header.
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer /)
  })

  // ── Old-paths cleanup in ambiguous branch ─────────────────────
  // Regression: updateExpense's ambiguous catch used to only
  // enqueue the NEW blob, leaving the OLD blob stranded if Worker
  // committed after timeout (success path's purge never ran).

  it('updateExpense FILE replace + AMBIGUOUS → enqueue BOTH new and old paths', async () => {
    const newBlob = mockReceipt()
    uploadReceiptMock.mockResolvedValueOnce(newBlob)
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'AbortError'))

    const oldPaths = {
      path:      'trips/t1/expenses/exp-1/OLD.webp',
      thumbPath: 'trips/t1/expenses/exp-1/OLD.thumb.webp',
    }

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid',
      attachment: new File([], 'r.jpg'),
      existingPaths: oldPaths,
    })).rejects.toThrow()

    expect(safePurgeMock).not.toHaveBeenCalled()
    // Two enqueue calls: one for new blob, one for old blob.
    // Cron's verify-before-delete keeps whichever the doc references.
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(2)
    const sources = enqueueOrphanPurgesMock.mock.calls.map(c => (c[0] as { source: string }).source)
    expect(sources).toContain('updateExpense/ambiguous-rollback')
    expect(sources).toContain('updateExpense/ambiguous-old-receipt')
  })

  it('updateExpense CLEAR receipt (attachment=null) + AMBIGUOUS → enqueue OLD only', async () => {
    // No upload happens for null attachment; only the old blob is
    // potentially orphan (depending on whether Worker committed the
    // field-delete). Without this enqueue the old blob would leak
    // when Worker committed but response timed out.
    fetchMock.mockResolvedValueOnce(new Response('crashed', { status: 500 }))

    const oldPaths = {
      path:      'trips/t1/expenses/exp-1/OLD.webp',
      thumbPath: 'trips/t1/expenses/exp-1/OLD.thumb.webp',
    }

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid',
      attachment: null,
      existingPaths: oldPaths,
    })).rejects.toThrow()

    expect(uploadReceiptMock).not.toHaveBeenCalled()
    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
    expect(enqueueOrphanPurgesMock.mock.calls[0]![0]).toMatchObject({
      source: 'updateExpense/ambiguous-old-receipt',
    })
  })

  it('updateExpense FILE replace + REJECTED → only NEW blob cleaned, OLD untouched', async () => {
    // Definite reject: doc still references the old blob, must NOT
    // enqueue it (would be a no-op via cron's verify, but spammy).
    const newBlob = mockReceipt()
    uploadReceiptMock.mockResolvedValueOnce(newBlob)
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }))

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', { title: 'Edit' }, {
      uid: 'editor-uid',
      attachment: new File([], 'r.jpg'),
      existingPaths: { path: 'trips/t1/expenses/exp-1/OLD.webp' },
    })).rejects.toThrow()

    expect(safePurgeMock).toHaveBeenCalledTimes(1)  // new blob inline purge
    expect(enqueueOrphanPurgesMock).not.toHaveBeenCalled()  // old blob NOT enqueued
  })

  // ── Phase 3.5 contract: rollback addresses paths from uploadReceipt's
  // return, not from a synthesized "receipt object". With intent flow,
  // Worker builds the receipt server-side -- client never sees the
  // ExpenseReceipt shape pre-commit. The `paths` array from
  // uploadReceipt IS the canonical source for rollback addressing.

  it('createExpense REJECTED → enqueue uses paths from uploadReceipt return verbatim', async () => {
    // Pins the contract: when Worker rejects, we MUST enqueue (and
    // purge) exactly the paths uploadReceipt returned. Any drift
    // here would orphan the blobs against an arbitrary path string.
    const upload = {
      intentIds: ['intent-full-X', 'intent-thumb-X'],
      paths:     ['trips/t1/expenses/exp-Y/p-full.webp', 'trips/t1/expenses/exp-Y/p-thumb.webp'],
    }
    uploadReceiptMock.mockResolvedValueOnce(upload)
    fetchMock.mockResolvedValueOnce(new Response('rejected', { status: 400 }))

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toThrow()

    expect(safePurgeMock).toHaveBeenCalledTimes(1)
    const safePurgeArgs = safePurgeMock.mock.calls[0]![0] as { enqueue: { paths: string[] } }
    expect(safePurgeArgs.enqueue.paths).toEqual(upload.paths)
  })

  it('createExpense AMBIGUOUS → enqueueOrphanPurges uses paths from uploadReceipt return verbatim', async () => {
    const upload = {
      intentIds: ['intent-full-Y'],
      paths:     ['trips/t1/expenses/exp-Z/just-full.webp'],
    }
    uploadReceiptMock.mockResolvedValueOnce(upload)
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'AbortError'))

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg')))
      .rejects.toThrow()

    expect(safePurgeMock).not.toHaveBeenCalled()
    expect(enqueueOrphanPurgesMock).toHaveBeenCalledTimes(1)
    const enqueueArgs = enqueueOrphanPurgesMock.mock.calls[0]![0] as { paths: string[] }
    expect(enqueueArgs.paths).toEqual(upload.paths)
  })

  it('createExpense success → no Worker `expense.receipt` in request body, only intentIds', async () => {
    // Pins the Phase 3.5 contract: client does NOT send receipt
    // client-side; Worker builds it from intentIds in the same tx
    // as the doc create. Sending receipt+intentIds together would
    // 400 (mutual-exclusion) -- this test catches a regression where
    // someone accidentally re-adds expense.receipt to the request.
    const upload = {
      intentIds: ['intent-full-A', 'intent-thumb-A'],
      paths:     ['trips/t1/expenses/exp-1/A.webp', 'trips/t1/expenses/exp-1/A.thumb.webp'],
    }
    uploadReceiptMock.mockResolvedValueOnce(upload)
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const { createExpense } = await import('./expenseService')
    await createExpense('t1', mockExpenseInput(), 'editor-uid', new File([], 'r.jpg'))

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      expense: { receipt?: unknown; mode?: string }
      intentIds?: string[]
    }
    expect(body.expense.receipt).toBeUndefined()
    expect(body.expense.mode).toBe('TRIP_CURRENCY')
    expect(body.intentIds).toEqual(upload.intentIds)
  })

  it('createExpense foreign payload strips trip-currency preview before Worker call', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const foreignInput = {
      ...mockExpenseInput(),
      amountMinor: 1570,
      currency:    'JPY',
      splits:      [{ memberId: 'editor-uid', amountMinor: 1570 }],
      items:       [{ id: 'item-1', name: 'Coffee', amountMinor: 1570, assignees: ['editor-uid'] }],
      sourceCurrency:    'USD',
      sourceAmountMinor: 1000,
      sourceItems:       [{ id: 'item-1', name: 'Coffee', sourceAmountMinor: 1000, assignees: ['editor-uid'] }],
      sourceAdjustments: [],
    } satisfies CreateExpenseInput

    const { createExpense } = await import('./expenseService')
    await createExpense('t1', foreignInput, 'editor-uid')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      expense: Record<string, unknown>
    }
    expect(body.expense.sourceCurrency).toBe('USD')
    expect(body.expense.mode).toBe('FOREIGN_CURRENCY')
    expect(body.expense.sourceAmountMinor).toBe(1000)
    expect(body.expense.sourceItems).toEqual(foreignInput.sourceItems)
    expect(body.expense.amountMinor).toBeUndefined()
    expect(body.expense.currency).toBeUndefined()
    expect(body.expense.splits).toBeUndefined()
    expect(body.expense.items).toBeUndefined()
    expect(body.expense.adjustments).toBeUndefined()
  })

  it('createExpense foreign manual-total payload sends sourceSplits without visible sourceItems', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const foreignInput = {
      ...mockExpenseInput(),
      amountMinor: 1500,
      currency:    'JPY',
      splits:      [{ memberId: 'editor-uid', amountMinor: 1500 }],
      items:       [],
      adjustments: [],
      sourceCurrency:    'USD',
      sourceAmountMinor: 1000,
      sourceSplits:      [{ memberId: 'editor-uid', sourceAmountMinor: 1000 }],
    } satisfies CreateExpenseInput

    const { createExpense } = await import('./expenseService')
    await createExpense('t1', foreignInput, 'editor-uid')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      expense: Record<string, unknown>
    }
    expect(body.expense.mode).toBe('FOREIGN_CURRENCY')
    expect(body.expense.sourceCurrency).toBe('USD')
    expect(body.expense.sourceAmountMinor).toBe(1000)
    expect(body.expense.sourceSplits).toEqual(foreignInput.sourceSplits)
    expect(body.expense.sourceItems).toBeUndefined()
    expect(body.expense.sourceAdjustments).toBeUndefined()
    expect(body.expense.amountMinor).toBeUndefined()
    expect(body.expense.items).toBeUndefined()
    expect(body.expense.splits).toBeUndefined()
  })

  it('createExpense rejects partial foreign payload before uploading receipt', async () => {
    const partialForeignInput = {
      ...mockExpenseInput(),
      sourceCurrency: null,
    } as unknown as CreateExpenseInput

    const { createExpense } = await import('./expenseService')
    await expect(createExpense('t1', partialForeignInput, 'editor-uid', new File([], 'r.jpg')))
      .rejects.toThrow(/foreign expense payload requires sourceCurrency/)

    expect(uploadReceiptMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('updateExpense rejects partial foreign payload before uploading replacement receipt', async () => {
    const partialForeignPatch = {
      sourceAmountMinor: 1000,
    } as unknown as UpdateExpenseInput

    const { updateExpense } = await import('./expenseService')
    await expect(updateExpense('t1', 'exp-1', partialForeignPatch, {
      uid: 'editor-uid',
      attachment: new File([], 'r.jpg'),
    })).rejects.toThrow(/foreign expense payload requires sourceCurrency/)

    expect(uploadReceiptMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
