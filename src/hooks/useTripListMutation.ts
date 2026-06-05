// src/hooks/useTripListMutation.ts
// Factory for trip-scoped list mutations. Centralises the cache-patch /
// rollback typing so a contract change is a one-file diff.
//
// What the factory hides:
//   - `useQueryClient()` + `useUid()` + `keyFactory(tripId, uid)` trinity
//   - `meta: { action, silent } satisfies MutationMeta`
//   - `onError` rollback via `rollbackListCache<T>(qc, key, ctx)`
//   - `onMutate` wrap of `patchListCache<T>(qc, key, prev => patch(prev, vars))`
//
// What stays per-mutation:
//   - The mutation work itself (`mutate: (vars, ctx) => service call`)
//   - The optimistic patch (`patch: (prev, vars) => newList`) — varies
//     per entity (insert position, default fields, etc.)
//
// `ctx` on `mutate` exposes `uid` (commonly needed for service calls)
// and `snapshot` (current cache list — schedule's create uses this to
// compute per-date `order` without an extra Firestore read).
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import { patchListCache, rollbackListCache, type PatchCacheContext } from '@/utils/queryCache'
import { addTombstones, removeTombstones } from '@/utils/listTombstones'
import type { MutationActionLabel, MutationMeta } from '@/services/queryClient'

export const AMBIGUOUS_RECONCILE_DELAY_MS = 3_000

export function isWorkerAmbiguousError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'WorkerAmbiguous'
}

/** Keep optimistic UI for genuinely ambiguous Worker writes, but still
 *  force an eventual server-truth read. If the write committed, the
 *  realtime listener usually swaps the row before this fires. If the
 *  request died before commit, invalidate/refetch removes the phantom
 *  optimistic row instead of leaving cache state permanently invented.
 *
 *  For tombstone DELETES, pass `revertTombstoneIds`: the tombstone is KEPT
 *  on the ambiguous error (no flicker on the common committed-but-response-
 *  lost case), and this reconcile decides against server truth once the
 *  refetch settles — present (or truth unestablished / refetch failed) ⇒
 *  the delete didn't confirm ⇒ revert so the row returns; absent ⇒ the
 *  delete committed and the list hook's prune already finalised it. Safe-
 *  degrades to revert so a doc can never stay permanently hidden offline. */
export function scheduleAmbiguousQueryReconcile(
  qc:   QueryClient,
  key:  QueryKey,
  opts: { revertTombstoneIds?: string[]; delayMs?: number } = {},
): void {
  const { revertTombstoneIds, delayMs = AMBIGUOUS_RECONCILE_DELAY_MS } = opts
  const timer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: key })
      .then(() => {
        if (!revertTombstoneIds?.length) return
        // Overlay never shrinks the raw cache, so getQueryData IS server
        // truth here. `undefined` means the refetch couldn't establish it
        // (treat as unconfirmed → revert). `.id` is safe: tombstones only
        // apply to id-keyed list entities.
        const fresh = qc.getQueryData<{ id: string }[]>(key)
        if (!fresh) { removeTombstones(key, revertTombstoneIds); return }
        const present = new Set(fresh.map(r => r.id))
        const stillThere = revertTombstoneIds.filter(id => present.has(id))
        if (stillThere.length) removeTombstones(key, stillThere)
      })
      .catch(() => {
        // Refetch failed (offline / auth hiccup) — never leave a row
        // permanently hidden; fall back to server-authoritative display.
        if (revertTombstoneIds?.length) removeTombstones(key, revertTombstoneIds)
      })
  }, delayMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}

export const AMBIGUOUS_RETRY_DELAY_MS = 700

/**
 * Background single retry for an AMBIGUOUS failure of an IDEMPOTENT delete.
 * Only safe when re-running the mutation can't double-apply — e.g.
 * settlement-delete, whose Worker returns `ok` on a missing doc. A transient
 * blip (5xx / dropped connection) then self-heals: the retry actually
 * completes the delete and we keep the tombstone WITHOUT needing a refetch.
 * Fire-and-forget + unref'd like the reconcile.
 *
 * ONLY retry SUCCESS short-circuits. A success is a fresh, CONFIRMED result
 * (the retry's own commit returned `ok`, or the doc was already gone →
 * idempotent), so the doc IS gone server-side and the tombstone stays.
 *
 * EVERY retry FAILURE defers to the SAME delayed server-truth reconcile; this
 * never calls removeTombstones itself. A retry error — of ANY kind, INCLUDING
 * WorkerRejected — can't finalise anything:
 *   - It can't prove the ORIGINAL ambiguous delete failed: the original may
 *     have committed with its response lost, while the retry is independently
 *     blocked by a 429 rate-limit / 401 token expiry / 403 membership change /
 *     410 trip-cascade, or dies in transit / preflight.
 *   - Even a WorkerRejected (Worker responded ⇒ network is up) does NOT mean
 *     the original commit has CONVERGED in Firestore. The ambiguous original
 *     can be a commit-response timeout: the Worker returned 5xx but Firestore
 *     may apply the delete moments later. An immediate refetch could read the
 *     doc still present, drop the tombstone, then watch the commit land and
 *     the row vanish again — reintroducing the very flicker the tombstone
 *     prevents. The delayed reconcile is the settle window that lets an
 *     in-flight commit converge before we read server truth.
 * So: success → keep; any failure → `onRetryFailed` → delayed reconcile.
 */
export function scheduleAmbiguousRetry(opts: {
  retry:         () => Promise<unknown>
  /** Any retry failure → defer to the delayed server-truth reconcile. */
  onRetryFailed: () => void
  delayMs?:      number
}): void {
  const { retry, onRetryFailed, delayMs = AMBIGUOUS_RETRY_DELAY_MS } = opts
  const timer = setTimeout(() => {
    void Promise.resolve()
      .then(() => retry())
      .then(() => { /* confirmed (or idempotent no-op) — keep the tombstone */ })
      .catch(() => { onRetryFailed() })
  }, delayMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}

export interface TripListMutateContext<T> {
  /** Guaranteed non-null — the factory throws before invoking `mutate`
   *  when uid is missing. Callers can use it directly without the `!`
   *  non-null assertion. Pages gate demo / pre-auth flows upstream;
   *  if this throws, the gate is what's broken, not the mutation. */
  uid:      string
  /** Current list cache for this key, empty array on cold cache. Used
   *  when a mutation needs sibling rows at mutate time (e.g.
   *  schedule's `nextOrder = max(snapshot.order) + 1`). */
  snapshot: T[]
}

export interface UseTripListMutationOpts<T, Vars> {
  tripId:     string
  keyFactory: (tripId: string, uid?: string) => readonly unknown[]
  mutate:     (vars: Vars, ctx: TripListMutateContext<T>) => Promise<unknown>
  /** Optimistic patch — receives prev list + vars, returns new list.
   *  Omit when no optimistic UI is desired (rare; usually you want one). */
  patch?:     (prev: T[], vars: Vars) => T[]
  /** Optimistic-DELETE overlay — returns the doc ids this mutation removes.
   *  Use INSTEAD OF `patch` for Worker-authoritative deletes: rather than
   *  shrinking the raw cache (which a lagging snapshot would overwrite,
   *  flickering the row back), the ids are tombstoned and hidden at
   *  read-time by the matching `createRealtimeListHook({ tombstoneIdOf })`.
   *  Lifecycle: onMutate adds the tombstones; the list hook prunes them once
   *  the server snapshot confirms the delete; on a DEFINITIVE error onError
   *  removes them so the row returns; on an AMBIGUOUS error the tombstone is
   *  kept (no flicker on the committed-but-response-lost case) and the
   *  reconcile reverts only if the refetch proves the doc still exists. */
  tombstone?: (vars: Vars) => string[]
  /** Opt-in single background retry for AMBIGUOUS failures, paired with
   *  `tombstone`. ONLY for mutations the Worker treats IDEMPOTENTLY (e.g.
   *  settlement-delete returns `ok` on a missing doc) — NEVER create/update,
   *  which would double-apply. On an ambiguous error the tombstone is kept
   *  and this runs once: resolve → delete confirmed (keep); ANY failure →
   *  defer to a server-truth reconcile (a retry error — even WorkerRejected —
   *  can't prove the ORIGINAL ambiguous delete didn't commit, so it never
   *  removes the tombstone itself; see scheduleAmbiguousRetry). Absent →
   *  straight to reconcile. */
  retryAmbiguous?:        (vars: Vars, ctx: TripListMutateContext<T>) => Promise<unknown>
  /** Delay before the ambiguous retry fires. Defaults to AMBIGUOUS_RETRY_DELAY_MS. */
  retryAmbiguousDelayMs?: number
  /** Sentry tag + global-toast prefix when the mutation fails. Closed
   *  union from `MUTATION_ACTION` — add new labels there if needed. */
  action:     MutationActionLabel
  /** When true, the global MutationCache.onError skips its toast — modal
   *  flows surface errors via inline banner instead. See queryClient.ts. */
  silent?:    boolean
  /** Stable key for `useMutationState` discovery. Update mutations set
   *  this so list pages can query in-flight mutations and surface a
   *  「保存中」 pill on the row that's being updated (CREATE detects
   *  pending via the temp-id prefix; UPDATE preserves the real id and
   *  needs this signal instead). Convention: `[entity, operation]`,
   *  e.g. `['expenses', 'update']`. */
  mutationKey?: readonly unknown[]
  /** Optional callback that runs AFTER the factory's rollback. Use
   *  when a typed error needs to trigger extra side effects -- e.g.
   *  invalidating queries on a partial-failure signal so the cache
   *  reconciles from a fresh fetch instead of trusting the optimistic
   *  rollback alone. */
  onError?:   (err: unknown) => void
}

export function useTripListMutation<T extends { id: string }, Vars>(
  opts: UseTripListMutationOpts<T, Vars>,
) {
  const qc  = useQueryClient()
  const uid = useUid()
  const key = opts.keyFactory(opts.tripId, uid)

  return useMutation({
    mutationKey: opts.mutationKey,
    mutationFn: (vars: Vars) => {
      if (!uid) {
        // Hard failure rather than a silent no-op: upstream pages gate
        // demo / signed-out flows before reaching the mutation. Hitting
        // this branch means the gate is broken; loud error helps catch
        // it during dev / surfaces in Sentry in prod.
        throw new Error(`useTripListMutation[${opts.action}]: uid is undefined`)
      }
      return opts.mutate(vars, {
        uid,
        snapshot: qc.getQueryData<T[]>(key) ?? [],
      })
    },
    meta: { action: opts.action, silent: opts.silent } satisfies MutationMeta,
    onMutate: (opts.patch || opts.tombstone)
      ? vars => {
          // Tombstone deletes are a READ-TIME overlay — they must NOT
          // shrink the raw cache (that's the whole point: a lagging
          // snapshot can't overwrite what we never removed). The list
          // hook's `select` hides the ids; the prune effect clears them
          // on server-confirmed delete. patchListCache stays for the
          // create/insert flavour of optimism.
          if (opts.tombstone) addTombstones(key, opts.tombstone(vars))
          return opts.patch
            ? patchListCache<T>(qc, key, prev => opts.patch!(prev, vars))
            : undefined
        }
      : undefined,
    onError: (err, vars, ctx) => {
      const tombstoneIds = opts.tombstone?.(vars) ?? []
      const isAmbiguous  = isWorkerAmbiguousError(err)

      // Definitive failure (WorkerRejected / validation / hard network): the
      // write provably never committed, so revert the optimistic state NOW.
      // For a tombstone delete that means dropping the tombstone so the row
      // returns immediately; for a patch insert that means rollbackListCache.
      // Ambiguous failures do NEITHER here — they keep the optimistic state
      // (tombstone stays hidden / patched row stays) and defer to the
      // reconcile, which the realtime listener usually beats anyway. Keeping
      // a tombstone on ambiguous is what makes the common committed-but-
      // response-lost case flicker-free; the reconcile reverts only if the
      // refetch proves the doc still exists. Symmetric with ambiguous CREATE.
      if (!isAmbiguous) {
        if (tombstoneIds.length) removeTombstones(key, tombstoneIds)
        rollbackListCache<T>(qc, key, ctx as PatchCacheContext<T> | undefined)
      } else if (tombstoneIds.length && opts.retryAmbiguous) {
        // Idempotent delete → try once in the background before the reconcile.
        // A transient blip self-heals (retry completes the delete → keep the
        // tombstone with no refetch). A retry FAILURE never removes the
        // tombstone — it hands off to the delayed server-truth reconcile, the
        // SAME path the no-retry branch below uses. The retry's outcome can't
        // finalise anything: it can't prove the ORIGINAL ambiguous delete's
        // fate, and even a WorkerRejected (network up) doesn't mean the
        // original commit has converged in Firestore yet — an immediate
        // refetch could read it still present and flicker. The reconcile's
        // delay is the settle window. Reconstruct the same ctx shape `mutate`
        // gets; uid is set (a missing-uid error is not ambiguous, so we never
        // reach here without it).
        const retryCtx: TripListMutateContext<T> = { uid: uid as string, snapshot: qc.getQueryData<T[]>(key) ?? [] }
        scheduleAmbiguousRetry({
          delayMs:       opts.retryAmbiguousDelayMs,
          retry:         () => opts.retryAmbiguous!(vars, retryCtx),
          onRetryFailed: () => scheduleAmbiguousQueryReconcile(qc, key, { revertTombstoneIds: tombstoneIds }),
        })
      } else {
        scheduleAmbiguousQueryReconcile(qc, key, { revertTombstoneIds: tombstoneIds })
      }
      opts.onError?.(err)
    },
  })
}
