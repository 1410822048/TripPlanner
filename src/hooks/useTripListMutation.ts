// src/hooks/useTripListMutation.ts
// Factory for trip-scoped list mutations. Optimistic state is an overlay
// replayed over server truth at read time (see hooks/listOverlay.ts); this
// wires a mutation's lifecycle to its operation so a contract change stays
// a one-file diff.
import { useMutation } from '@tanstack/react-query'
import { useUid } from '@/hooks/useAuth'
import type { ListOverlayController, OverlayHandle, OverlayOpInput } from '@/hooks/listOverlay'
import type { MutationActionLabel, MutationMeta } from '@/services/queryClient'

export function isWorkerAmbiguousError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'WorkerAmbiguous'
}

export interface TripListMutateContext {
  /** Guaranteed non-null: the factory throws before invoking `mutate` when
   *  uid is missing. */
  uid: string
}

export interface OverlayMutationConfig<T extends { id: string }, Vars> {
  controller: ListOverlayController<T>
  /** Build the optimistic operation for these variables. `uid` is handed
   *  over because an op's authoritative read is scoped to the same
   *  (tripId, uid) query key the op belongs to. */
  op:         (vars: Vars, ctx: { uid: string | undefined }) => OverlayOpInput<T>
}

export interface UseTripListMutationOpts<T extends { id: string }, Vars> {
  tripId:     string
  keyFactory: (tripId: string, uid?: string) => readonly unknown[]
  mutate:     (vars: Vars, ctx: TripListMutateContext) => Promise<unknown>
  /** Optimistic operation. Omit when no optimistic UI is wanted. */
  overlay?:   OverlayMutationConfig<T, Vars>
  /** Sentry tag + global-toast prefix when the mutation fails. */
  action:     MutationActionLabel
  /** When true, the global MutationCache.onError skips its toast. */
  silent?:    boolean
  /** Stable key for `useMutationState` discovery. */
  mutationKey?: readonly unknown[]
  /** Optional callback that runs after the factory's overlay decision. */
  onError?:   (err: unknown) => void
}

interface MutateContext {
  handle?: OverlayHandle
}

export function useTripListMutation<T extends { id: string }, Vars>(
  opts: UseTripListMutationOpts<T, Vars>,
) {
  const uid     = useUid()
  const key     = opts.keyFactory(opts.tripId, uid)
  const overlay = opts.overlay

  return useMutation({
    mutationKey: opts.mutationKey,
    mutationFn: (vars: Vars) => {
      if (!uid) {
        throw new Error(`useTripListMutation[${opts.action}]: uid is undefined`)
      }
      return opts.mutate(vars, { uid })
    },
    meta: { action: opts.action, silent: opts.silent } satisfies MutationMeta,
    onMutate: overlay
      ? (vars): MutateContext => ({ handle: overlay.controller.add(key, overlay.op(vars, { uid })) })
      : undefined,
    onSuccess: overlay
      ? (_data, _vars, ctx) => {
          // Not dropped here: server truth may not have arrived yet. The
          // reconcile pass clears it once the list actually agrees.
          if (ctx?.handle) overlay.controller.markSucceeded(ctx.handle)
        }
      : undefined,
    onError: (err, _vars, ctx) => {
      // A definitive failure removes only this operation, which is why a
      // sibling edit to the same row can't be stranded by it. An ambiguous
      // one is held until server truth can settle it.
      if (overlay && ctx?.handle) {
        if (isWorkerAmbiguousError(err)) overlay.controller.markAmbiguous(ctx.handle)
        else overlay.controller.drop(ctx.handle)
      }
      opts.onError?.(err)
    },
  })
}
