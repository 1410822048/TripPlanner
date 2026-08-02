// src/hooks/useTripListMutation.ts
// Factory for trip-scoped list mutations. It centralises the cache patch /
// rollback typing so a contract change is a one-file diff.
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import { patchListCache, rollbackListCache, type PatchCacheContext } from '@/utils/queryCache'
import type { ListOverlayController, OverlayHandle, OverlayOpInput } from '@/hooks/listOverlay'
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

export interface OverlayMutationConfig<T extends { id: string }, Vars> {
  controller: ListOverlayController<T>
  /** Build the optimistic operation for these variables. `uid` is handed
   *  over because an op's authoritative read is scoped to the same
   *  (tripId, uid) query key the op belongs to. */
  op:         (vars: Vars, ctx: { uid: string | undefined }) => OverlayOpInput<T>
}

interface UseTripListMutationOptsBase<T, Vars> {
  tripId:     string
  keyFactory: (tripId: string, uid?: string) => readonly unknown[]
  mutate:     (vars: Vars, ctx: TripListMutateContext<T>) => Promise<unknown>
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

/** `patch` and `overlay` are mutually exclusive: both write optimistic
 *  state for the same query key, so allowing both would double-apply it
 *  during the migration off cache-patching. */
export type UseTripListMutationOpts<T extends { id: string }, Vars> =
  UseTripListMutationOptsBase<T, Vars> & (
    | { patch: (prev: T[], vars: Vars) => T[]; overlay?: never }
    | { overlay: OverlayMutationConfig<T, Vars>; patch?: never }
    | { patch?: never; overlay?: never }
  )

/** One shape for both optimism strategies so the mutation's context type
 *  doesn't depend on which one the caller configured. */
interface MutateContext<T> {
  handle?: OverlayHandle
  patch?:  PatchCacheContext<T>
}

export function useTripListMutation<T extends { id: string }, Vars>(
  opts: UseTripListMutationOpts<T, Vars>,
) {
  const qc      = useQueryClient()
  const uid     = useUid()
  const key     = opts.keyFactory(opts.tripId, uid)
  const overlay = opts.overlay

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
    onMutate: overlay
      ? (vars): MutateContext<T> => ({ handle: overlay.controller.add(key, overlay.op(vars, { uid })) })
      : opts.patch
        ? (vars): MutateContext<T> => ({
            patch: patchListCache<T>(qc, key, prev => opts.patch!(prev, vars)),
          })
        : undefined,
    onSuccess: overlay
      ? (_data, _vars, ctx) => {
          // Not dropped here: server truth may not have arrived yet. The
          // reconcile pass clears it once the list actually agrees.
          if (ctx?.handle) overlay.controller.markSucceeded(ctx.handle)
        }
      : undefined,
    onError: (err, _vars, ctx) => {
      if (overlay) {
        // A definitive failure removes only this operation, which is why a
        // sibling edit to the same row can't be stranded by it.
        if (ctx?.handle) {
          if (isWorkerAmbiguousError(err)) overlay.controller.markAmbiguous(ctx.handle)
          else overlay.controller.drop(ctx.handle)
        }
      } else if (isWorkerAmbiguousError(err)) {
        scheduleAmbiguousQueryReconcile(qc, key)
      } else {
        rollbackListCache<T>(qc, key, ctx?.patch)
      }
      opts.onError?.(err)
    },
  })
}
