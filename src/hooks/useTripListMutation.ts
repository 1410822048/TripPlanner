// src/hooks/useTripListMutation.ts
// Factory for trip-scoped list mutations. It centralises the cache patch /
// rollback typing so a contract change is a one-file diff.
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import { patchListCache, rollbackListCache, type PatchCacheContext } from '@/utils/queryCache'
import type { MutationActionLabel, MutationMeta } from '@/services/queryClient'

export const AMBIGUOUS_RECONCILE_DELAY_MS = 3_000

export function isWorkerAmbiguousError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'WorkerAmbiguous'
}

/** Keep optimistic UI for genuinely ambiguous Worker writes, but still force
 *  an eventual server-truth read. If the write committed, the realtime
 *  listener usually swaps the row before this fires. If the request died
 *  before commit, invalidate/refetch removes the phantom optimistic state. */
export function scheduleAmbiguousQueryReconcile(
  qc:      QueryClient,
  key:     QueryKey,
  delayMs = AMBIGUOUS_RECONCILE_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: key })
  }, delayMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}

export interface TripListMutateContext<T> {
  /** Guaranteed non-null: the factory throws before invoking `mutate` when
   *  uid is missing. */
  uid:      string
  /** Current list cache for this key, empty array on cold cache. Used when a
   *  mutation needs sibling rows at mutate time. */
  snapshot: T[]
}

export interface UseTripListMutationOpts<T, Vars> {
  tripId:     string
  keyFactory: (tripId: string, uid?: string) => readonly unknown[]
  mutate:     (vars: Vars, ctx: TripListMutateContext<T>) => Promise<unknown>
  /** Optimistic patch. Omit when no optimistic UI is desired. */
  patch?:     (prev: T[], vars: Vars) => T[]
  /** Sentry tag + global-toast prefix when the mutation fails. */
  action:     MutationActionLabel
  /** When true, the global MutationCache.onError skips its toast. */
  silent?:    boolean
  /** Stable key for `useMutationState` discovery. */
  mutationKey?: readonly unknown[]
  /** Optional callback that runs after the factory's rollback / reconcile
   *  decision. */
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
    onError: (err, _vars, ctx) => {
      if (isWorkerAmbiguousError(err)) {
        scheduleAmbiguousQueryReconcile(qc, key)
      } else {
        rollbackListCache<T>(qc, key, ctx as PatchCacheContext<T> | undefined)
      }
      opts.onError?.(err)
    },
  })
}
