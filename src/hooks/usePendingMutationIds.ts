// src/hooks/usePendingMutationIds.ts
// Derives "ids of rows currently being updated" from TanStack Query's
// mutation cache, so list pages can dim + show 保存中… pills on rows
// whose update is in-flight. CREATE rows get pending UI for free via
// the temp- id prefix; UPDATE preserves the real server id, so without
// this we'd have no way to surface the pending visual until the
// mutation resolves and the listener pushes the new doc.
//
// Why mutation cache rather than a `_pending` field on the query cache:
//   - Server cache stays clean (no UI-only fields polluting domain shape)
//   - `useMutation` already tracks `status: 'pending'` for us — we just
//     read it; no parallel state to keep in sync
//   - Hook isn't coupled to specific mutation shape — caller picks the
//     id field name via the generic + `idField` param
//
// Why centralised at the page (not per-card): a single `useMutationState`
// subscription returns the array; each card just does an O(1) Set lookup
// instead of every card running its own subscription with a filter.
import { useMutationState } from '@tanstack/react-query'

/**
 * Returns a Set of in-flight mutation ids matching the given key.
 *
 * @param mutationKey  Stable key set on the update mutation (e.g. via
 *                     `useTripListMutation`'s `mutationKey` option).
 *                     Convention: `[entity, 'update']`.
 * @param idField      Name of the entity-id field within the mutation's
 *                     `variables` object (e.g. `'expenseId'`, `'wishId'`,
 *                     `'bookingId'`). The variable shape must include
 *                     this field as a string.
 */
export function usePendingMutationIds<V extends Record<string, unknown>>(
  mutationKey: readonly unknown[],
  idField:     keyof V & string,
): Set<string> {
  // `select` narrows the generic-keyed value (`V[keyof V & string]` =
  // `unknown` after constraint widening) to `string | undefined` right
  // here, so the resulting array is plainly `(string | undefined)[]` and
  // the type guard at the bottom is a simple `id !== undefined` check.
  // `tsc -b` rejects pushing the `is string` guard further down because
  // it can't prove `string` is assignable to the open generic value type.
  const ids = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select:  (m): string | undefined => {
      const vars = m.state.variables as Record<string, unknown> | undefined
      const id   = vars?.[idField]
      return typeof id === 'string' ? id : undefined
    },
  })
  return new Set(ids.filter((id): id is string => id !== undefined))
}
