// src/utils/queryCache.ts
// Optimistic-update primitive used by every list mutation hook.
//
//   onMutate: patch the cache, record the inverse → return ctx
//   onError:  apply that inverse to the *current* cache
//
// Rollback is operation-scoped rather than a whole-array restore. A
// snapshot restore also reverts everything that landed while the
// mutation was in flight — realtime snapshot pushes and sibling
// optimistic mutations — so one failed write could silently drop a
// teammate's row until the next snapshot event repopulated the list.
import type { QueryClient, QueryKey } from '@tanstack/react-query'

interface RestoredRow<T> {
  index: number
  prev:  T
  /** What the patch wrote in `prev`'s place, or undefined when it removed
   *  the row. Rollback only reverts while the cache still holds exactly
   *  this object; anything else is newer truth and must be left alone. */
  patched: T | undefined
}

export interface PatchCacheContext<T> {
  /** Ids the patch introduced. Dropped again on rollback. */
  addedIds: readonly string[]
  /** Pre-patch rows the patch removed or replaced, ascending by index so
   *  a removed row can be spliced back where it was. */
  restored: readonly RestoredRow<T>[]
}

/**
 * Write a list-shaped cache entry and return the inverse of that write.
 * `fn` receives the previous list (empty array when the cache is cold).
 */
export function patchListCache<T extends { id: string }>(
  qc:  QueryClient,
  key: QueryKey,
  fn:  (prev: T[]) => T[],
): PatchCacheContext<T> {
  const prev = qc.getQueryData<T[]>(key) ?? []
  qc.setQueryData<T[]>(key, fn(prev))
  // Read back rather than reuse `fn`'s return value: structural sharing
  // rebuilds changed rows, so only the stored objects can be compared by
  // reference when the rollback decides whether a row is still ours.
  const next = qc.getQueryData<T[]>(key) ?? []

  const nextById = new Map(next.map(row => [row.id, row]))
  const prevIds  = new Set(prev.map(row => row.id))

  return {
    addedIds: next.filter(row => !prevIds.has(row.id)).map(row => row.id),
    restored: prev.flatMap((row, index) => {
      const patched = nextById.get(row.id)
      return patched === row ? [] : [{ index, prev: row, patched }]
    }),
  }
}

/**
 * Undo one patch against the current cache, leaving concurrent realtime
 * pushes and other in-flight optimistic mutations in place.
 */
export function rollbackListCache<T extends { id: string }>(
  qc:  QueryClient,
  key: QueryKey,
  ctx: PatchCacheContext<T> | undefined,
): void {
  if (!ctx) return
  const cur = qc.getQueryData<T[]>(key)
  if (cur === undefined) return

  const added  = new Set(ctx.addedIds)
  const revert = new Map(ctx.restored.map(row => [row.prev.id, row]))

  const out = cur
    .filter(row => !added.has(row.id))
    .map(row => {
      const entry = revert.get(row.id)
      return entry && row === entry.patched ? entry.prev : row
    })

  const present = new Set(out.map(row => row.id))
  // Only rows *this* patch removed come back; a row that merely changed
  // and has since disappeared was removed by someone else.
  // Ascending by construction, so each splice keeps later indices valid.
  for (const { index, prev, patched } of ctx.restored) {
    if (patched === undefined && !present.has(prev.id)) {
      out.splice(Math.min(index, out.length), 0, prev)
    }
  }

  qc.setQueryData<T[]>(key, out)
}
