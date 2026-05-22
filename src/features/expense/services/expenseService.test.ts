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
vi.mock('@/services/sentry', () => ({
  captureError: captureErrorMock,
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

function mockReceipt() {
  return {
    url:  'https://storage.example/receipt.webp',
    path: 'trips/t1/expenses/exp-1/abc.webp',
    type: 'image/webp',
  }
}

function mockExpenseInput() {
  return {
    title:    'Lunch',
    amount:   1000,
    currency: 'JPY',
    category: 'food' as const,
    paidBy:   'editor-uid',
    splits:   [{ memberId: 'editor-uid', amount: 1000 }],
    date:     '2026-05-22',
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
})
