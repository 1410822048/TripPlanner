// Tests for the client-side enqueue helper. The headline invariant
// (regression we want to lock in) is partial-failure visibility:
// when one path enqueues successfully but another rejects, the
// wrapper must surface the failure so Sentry sees the missed paths
// -- a silent "return only the successful ids" would leave the
// failed-enqueue blob orphan with no retry layer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @/services/firebase so setDoc behaviour is per-test scriptable.
const setDocMock = vi.fn()
vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:               {},
    collection:       (_db: unknown, ..._path: string[]) => ({ _kind: 'collection' }),
    doc:              (_coll: unknown) => ({ id: 'auto-id-' + Math.random().toString(36).slice(2, 8) }),
    setDoc:           setDocMock,
    serverTimestamp: () => ({ _kind: 'serverTimestamp' }),
  })),
}))

// Sentry not exercised in these tests, but the import path needs to
// be stub-able to avoid pulling the dynamic loader into the test bundle.
vi.mock('@/services/sentry', () => ({
  captureError: vi.fn(),
}))

import {
  enqueueOrphanPurges,
  safePurgeWithEnqueueFallback,
  EnqueueOrphanPurgeError,
} from './orphanPurge'
import { captureError } from './sentry'

const TRIP_ID = 'trip-1'

beforeEach(() => {
  setDocMock.mockReset()
  vi.mocked(captureError).mockReset()
})

describe('enqueueOrphanPurges partial-failure visibility', () => {
  it('all paths enqueue → returns ids, no throw', async () => {
    setDocMock.mockResolvedValue(undefined)
    const ids = await enqueueOrphanPurges({
      tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1',
      paths: ['p1', 'p2'],
      source: 'test',
    })
    expect(ids).toHaveLength(2)
    expect(setDocMock).toHaveBeenCalledTimes(2)
  })

  it('all paths fail → throws EnqueueOrphanPurgeError with all causes', async () => {
    setDocMock.mockRejectedValue(new Error('permission-denied'))
    await expect(enqueueOrphanPurges({
      tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1',
      paths: ['p1', 'p2'],
      source: 'test',
    })).rejects.toBeInstanceOf(EnqueueOrphanPurgeError)
  })

  it('partial success (1 OK + 1 fail) → throws so wrapper Sentry-captures', async () => {
    // Critical regression test: previous code returned the successful
    // ids silently when at least one path enqueued, masking the
    // permanently-orphan blob from the failed path.
    setDocMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network'))
    let thrown: unknown
    try {
      await enqueueOrphanPurges({
        tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1',
        paths: ['p-ok', 'p-fail'],
        source: 'test',
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(EnqueueOrphanPurgeError)
    const err = thrown as EnqueueOrphanPurgeError
    expect(err.totalPaths).toBe(2)
    expect(err.causes).toHaveLength(1)
    expect(err.succeededIds).toHaveLength(1)
  })

  it('safePurgeWithEnqueueFallback: partial enqueue failure routes to Sentry + returns "unrecoverable"', async () => {
    // End-to-end: purge fails → enqueue partial-succeeds → wrapper
    // sees the EnqueueOrphanPurgeError → Sentry captures with
    // appropriate context (so a future operator sees "X of Y paths
    // failed" in the issue body) AND returns 'unrecoverable' so
    // destructive callers (deleteBooking / deleteWish) can refuse
    // to delete the owning doc.
    const purgeErr = new Error('storage 503')
    const purge = vi.fn(async () => { throw purgeErr })
    setDocMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rules denied'))

    const result = await safePurgeWithEnqueueFallback({
      purge,
      enqueue: {
        tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1',
        paths: ['p-ok', 'p-fail'],
        source: 'updateExpense/purge-old-receipt',
      },
      sentry: { source: 'updateExpense/purge-old-receipt', tripId: TRIP_ID, expenseId: 'exp-1' },
    })

    expect(result).toBe('unrecoverable')
    expect(captureError).toHaveBeenCalledTimes(1)
    const call = vi.mocked(captureError).mock.calls[0]
    expect(call).toBeDefined()
    const [capturedErr, ctx] = call!
    expect(capturedErr).toBeInstanceOf(EnqueueOrphanPurgeError)
    expect(ctx).toMatchObject({
      source: 'updateExpense/purge-old-receipt',
      original: expect.stringContaining('storage 503'),
    })
  })

  it('safePurge: purge succeeds → returns "purged", no enqueue, no Sentry', async () => {
    const purge = vi.fn(async () => undefined)
    const result = await safePurgeWithEnqueueFallback({
      purge,
      enqueue: { tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1', paths: ['p'], source: 't' },
      sentry: {},
    })
    expect(result).toBe('purged')
    expect(setDocMock).not.toHaveBeenCalled()
    expect(captureError).not.toHaveBeenCalled()
  })

  it('safePurge: purge fails + enqueue fully succeeds → returns "queued", no Sentry (cron will drain)', async () => {
    setDocMock.mockResolvedValue(undefined)
    const purge = vi.fn(async () => { throw new Error('blip') })
    const result = await safePurgeWithEnqueueFallback({
      purge,
      enqueue: { tripId: TRIP_ID, collection: 'expenses', entityId: 'exp-1', paths: ['p1', 'p2'], source: 't' },
      sentry: {},
    })
    expect(result).toBe('queued')
    // Successful enqueue means cleanup is deferred to cron -- no
    // immediate alert noise.
    expect(captureError).not.toHaveBeenCalled()
    expect(setDocMock).toHaveBeenCalledTimes(2)
  })

  it('safePurge: purge fails + ALL enqueues fail → returns "unrecoverable" + Sentry fires', async () => {
    // Critical contract for deleteBooking / deleteWish strict mode:
    // when neither in-process delete nor `_purges` enqueue succeeds,
    // the wrapper MUST return 'unrecoverable' so the caller refuses
    // to delete the owning doc. Without this signal, the doc-delete
    // proceeds and the attachment.path → blob binding vanishes from
    // every future cleanup attempt.
    const purgeErr = new Error('storage 500')
    const purge = vi.fn(async () => { throw purgeErr })
    setDocMock.mockRejectedValue(new Error('rules denied'))

    const result = await safePurgeWithEnqueueFallback({
      purge,
      enqueue: { tripId: TRIP_ID, collection: 'bookings', entityId: 'b-1', paths: ['p1'], source: 'deleteBooking/attachment' },
      sentry: { source: 'deleteBooking/attachment', tripId: TRIP_ID, bookingId: 'b-1' },
    })
    expect(result).toBe('unrecoverable')
    expect(captureError).toHaveBeenCalledTimes(1)
  })
})
