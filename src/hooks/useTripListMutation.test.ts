import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

// useTripListMutation needs a signed-in uid; the integration tests below
// render the hook, so stub auth to a fixed uid.
vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

import {
  AMBIGUOUS_RECONCILE_DELAY_MS,
  AMBIGUOUS_RETRY_DELAY_MS,
  isWorkerAmbiguousError,
  scheduleAmbiguousQueryReconcile,
  scheduleAmbiguousRetry,
  useTripListMutation,
} from './useTripListMutation'
import {
  addTombstones,
  filterTombstoned,
  __resetTombstonesForTest,
} from '@/utils/listTombstones'
import { MUTATION_ACTION } from '@/services/queryClient'

const idOf = (r: { id: string }) => r.id
const KEY = ['settlements', 'trip-1'] as const

beforeEach(() => {
  __resetTombstonesForTest()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTripListMutation ambiguous reconciliation helpers', () => {
  it('classifies WorkerAmbiguous by error name only', () => {
    expect(isWorkerAmbiguousError({ name: 'WorkerAmbiguous' })).toBe(true)
    expect(isWorkerAmbiguousError({ name: 'WorkerRejected' })).toBe(false)
    expect(isWorkerAmbiguousError(new Error('network'))).toBe(false)
  })

  it('delays query invalidation so an ambiguous optimistic row converges to server truth', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const key = ['settlements', 'trip-1', 'uid-1'] as const

    scheduleAmbiguousQueryReconcile(qc, key)

    expect(invalidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key })
  })
})

// The tombstone-aware reconcile is the new verdict logic: after the refetch
// settles it decides, against SERVER TRUTH, whether an ambiguous delete
// actually took. Because the overlay never shrinks the raw cache,
// getQueryData is server truth and these cases are decidable.
describe('scheduleAmbiguousQueryReconcile — tombstone verdict', () => {
  it('doc still present after refetch → reverts the tombstone (delete did not confirm)', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    qc.setQueryData(KEY, [{ id: 'x' }, { id: 'y' }]) // server truth STILL has x
    addTombstones(KEY, ['x'])
    expect(filterTombstoned(KEY, [{ id: 'x' }], idOf)).toEqual([]) // hidden meanwhile

    scheduleAmbiguousQueryReconcile(qc, KEY, { revertTombstoneIds: ['x'] })
    await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)

    expect(filterTombstoned(KEY, [{ id: 'x' }], idOf)).toEqual([{ id: 'x' }]) // row returns
  })

  it('doc absent after refetch → leaves the tombstone (committed; prune owns it)', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    qc.setQueryData(KEY, [{ id: 'y' }]) // server truth no longer has x
    addTombstones(KEY, ['x'])

    scheduleAmbiguousQueryReconcile(qc, KEY, { revertTombstoneIds: ['x'] })
    await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)

    // Not reverted by the reconcile — the delete committed; in the real flow
    // the list hook's prune effect already cleared it.
    expect(filterTombstoned(KEY, [{ id: 'x' }], idOf)).toEqual([])
  })

  it('refetch failure → reverts the tombstone (never leave a row hidden offline)', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    vi.spyOn(qc, 'invalidateQueries').mockRejectedValue(new Error('offline'))
    addTombstones(KEY, ['x'])

    scheduleAmbiguousQueryReconcile(qc, KEY, { revertTombstoneIds: ['x'] })
    await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)

    expect(filterTombstoned(KEY, [{ id: 'x' }], idOf)).toEqual([{ id: 'x' }]) // safe-degrade
  })
})

// scheduleAmbiguousRetry — the verdict for a single background retry of an
// idempotent delete. resolve ⇒ keep (delete confirmed / idempotent no-op).
// EVERY failure ⇒ the SAME onRetryFailed (delayed server-truth reconcile);
// the callback never removes a tombstone directly. A retry error — even
// WorkerRejected — can neither prove the ORIGINAL ambiguous delete failed nor
// that an in-flight original commit has converged, so it can't finalise.
const ambiguousErr  = () => Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
const rejectedErr   = () => Object.assign(new Error('403'),  { name: 'WorkerRejected' })
// A retry that dies BEFORE reaching the Worker: preflightIdToken throws
// `Error('not signed in: ...')` on a token race, requireWorkerWriteBase throws
// on env-unset. Plain Error, neither WorkerRejected nor WorkerAmbiguous.
const plainErr      = () => new Error('not signed in: cannot perform Worker write')

describe('scheduleAmbiguousRetry — verdict', () => {
  it('does not fire before the delay', async () => {
    vi.useFakeTimers()
    const onFail = vi.fn()
    scheduleAmbiguousRetry({ delayMs: 700, retry: () => Promise.resolve({}), onRetryFailed: onFail })
    await vi.advanceTimersByTimeAsync(0)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('retry resolves → keeps the tombstone (onRetryFailed not called)', async () => {
    vi.useFakeTimers()
    const onFail = vi.fn()
    scheduleAmbiguousRetry({ delayMs: 700, retry: () => Promise.resolve({}), onRetryFailed: onFail })
    await vi.advanceTimersByTimeAsync(700)
    expect(onFail).not.toHaveBeenCalled()
  })

  // Every failure class routes to the same onRetryFailed — WorkerRejected gets
  // NO fast path (it can't prove the original's fate or that its commit has
  // converged), and plain/local errors never reached the Worker at all.
  it.each([
    ['WorkerRejected',  rejectedErr],
    ['WorkerAmbiguous', ambiguousErr],
    ['plain local',     plainErr],
  ])('retry rejects %s → onRetryFailed (defer to the delayed reconcile)', async (_label, makeErr) => {
    vi.useFakeTimers()
    const onFail = vi.fn()
    scheduleAmbiguousRetry({ delayMs: 700, retry: () => Promise.reject(makeErr()), onRetryFailed: onFail })
    await vi.advanceTimersByTimeAsync(700)
    expect(onFail).toHaveBeenCalledTimes(1)
  })
})

// Integration: the onError branch ordering.
//   ORIGINAL call: WorkerRejected/plain provably never committed (one attempt)
//     → revert NOW; ambiguous → KEEP the tombstone (hidden, no flicker).
//   RETRY (after an ambiguous original): SUCCESS keeps the tombstone (confirmed
//     gone); EVERY failure — including WorkerRejected — defers to the SAME
//     delayed server-truth reconcile, never a direct revert and never an
//     immediate refetch. The delay is the settle window: it can't prove the
//     original's fate, and even a WorkerRejected doesn't mean an in-flight
//     original commit has converged in Firestore yet.
describe('useTripListMutation — tombstone delete onError', () => {
  const KEY_WITH_UID = ['settlements', 'trip-1', 'uid-1'] as const

  function renderDeleteMutation(
    mutate: () => Promise<unknown>,
    retryAmbiguous?: () => Promise<unknown>,
    qc: QueryClient = new QueryClient(),
  ) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    return renderHook(
      () =>
        useTripListMutation<{ id: string }, Record<string, never>>({
          tripId:     'trip-1',
          keyFactory: (tripId, uid) => ['settlements', tripId, uid] as const,
          mutate,
          tombstone:  () => ['x'],
          ...(retryAmbiguous ? { retryAmbiguous } : {}),
          action:     MUTATION_ACTION.CANCEL_SETTLEMENT,
        }),
      { wrapper },
    )
  }

  it('ORIGINAL call: ambiguous KEEPS the tombstone; WorkerRejected reverts it immediately', async () => {
    vi.useFakeTimers()
    const amb = renderDeleteMutation(() => Promise.reject(ambiguousErr()))
    await act(async () => { await amb.result.current.mutateAsync({}).catch(() => {}) })
    // Kept → still hidden (the 3s reconcile timer is pending but not advanced).
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([])

    __resetTombstonesForTest()

    // A WorkerRejected on the ORIGINAL (single-attempt) call provably never
    // committed → safe to revert NOW. (This is NOT the retry path.)
    const rej = renderDeleteMutation(() => Promise.reject(rejectedErr()))
    await act(async () => { await rej.result.current.mutateAsync({}).catch(() => {}) })
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([{ id: 'x' }])
  })

  it('with retryAmbiguous: ambiguous → retry fires after the delay; a resolving retry KEEPS the tombstone', async () => {
    vi.useFakeTimers()
    const retry = vi.fn(() => Promise.resolve({})) // idempotent already-gone / completed
    const r = renderDeleteMutation(() => Promise.reject(ambiguousErr()), retry)
    await act(async () => { await r.result.current.mutateAsync({}).catch(() => {}) })
    // Tombstone kept; retry not yet fired (deferred to the background delay).
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([])
    expect(retry).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(AMBIGUOUS_RETRY_DELAY_MS) })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([]) // still hidden
  })

  it('with retryAmbiguous: a retry failure defers to the DELAYED reconcile (no immediate refetch), then reverts when server truth still has the doc', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    qc.setQueryData(KEY_WITH_UID, [{ id: 'x' }]) // server still has x → delete genuinely didn't take
    // WorkerRejected gets NO fast path — it waits for the settle window like
    // every other failure class.
    const retry = vi.fn(() => Promise.reject(rejectedErr()))
    const r = renderDeleteMutation(() => Promise.reject(ambiguousErr()), retry, qc)
    await act(async () => { await r.result.current.mutateAsync({}).catch(() => {}) })
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([]) // kept initially

    await act(async () => { await vi.advanceTimersByTimeAsync(AMBIGUOUS_RETRY_DELAY_MS) })
    expect(retry).toHaveBeenCalledTimes(1)
    // No immediate refetch — the reconcile is still pending.
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([]) // still hidden

    await act(async () => { await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS) })
    // Delayed server-truth reconcile: x still present → genuine failure → revert.
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([{ id: 'x' }])
  })

  it('with retryAmbiguous: the reconcile delay lets an in-flight original commit converge — no flicker (commit-convergence race)', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    // The ORIGINAL delete was a commit-response timeout: the Worker returned 5xx
    // but Firestore has NOT yet applied the delete, so at retry time the cache
    // still shows x. The background retry is independently blocked (429/401/403).
    qc.setQueryData(KEY_WITH_UID, [{ id: 'x' }])
    const retry = vi.fn(() => Promise.reject(rejectedErr()))
    const r = renderDeleteMutation(() => Promise.reject(ambiguousErr()), retry, qc)
    await act(async () => { await r.result.current.mutateAsync({}).catch(() => {}) })

    await act(async () => { await vi.advanceTimersByTimeAsync(AMBIGUOUS_RETRY_DELAY_MS) })
    expect(retry).toHaveBeenCalledTimes(1)
    // An immediate (delayMs:0) refetch HERE would read x-still-present and drop
    // the tombstone — then the commit lands and the row vanishes again: flicker.
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([]) // still hidden — refetch deferred

    // The original commit converges DURING the settle window → truth omits x.
    qc.setQueryData(KEY_WITH_UID, [{ id: 'other' }])

    await act(async () => { await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS) })
    // Reconcile reads the CONVERGED truth (x gone) → keeps the tombstone. No revive.
    expect(filterTombstoned(KEY_WITH_UID, [{ id: 'x' }], idOf)).toEqual([])
  })
})
