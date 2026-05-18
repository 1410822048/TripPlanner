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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import { patchListCache, rollbackListCache, type PatchCacheContext } from '@/utils/queryCache'
import type { MutationActionLabel, MutationMeta } from '@/services/queryClient'

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
  /** Sentry tag + global-toast prefix when the mutation fails. Closed
   *  union from `MUTATION_ACTION` — add new labels there if needed. */
  action:     MutationActionLabel
  /** When true, the global MutationCache.onError skips its toast — modal
   *  flows surface errors via inline banner instead. See queryClient.ts. */
  silent?:    boolean
}

export function useTripListMutation<T extends { id: string }, Vars>(
  opts: UseTripListMutationOpts<T, Vars>,
) {
  const qc  = useQueryClient()
  const uid = useUid()
  const key = opts.keyFactory(opts.tripId, uid)

  return useMutation({
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
    onMutate: opts.patch
      ? vars => patchListCache<T>(qc, key, prev => opts.patch!(prev, vars))
      : undefined,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<T>(qc, key, ctx as PatchCacheContext<T> | undefined)
    },
  })
}
