// src/utils/queryCache.ts
// Optimistic-update primitive used by every list mutation hook.
//
// The pattern, repeated across schedule / booking / wish / planning /
// expense / member mutations:
//
//   onMutate: snapshot prev list → patch into cache → return { prev }
//   onError:  rollback to ctx.prev → toast
//
// Before this helper, each feature defined its own `patchCache(qc,
// tripId, fn)` with the same body — five copies that only differed in
// the inferred T and the queryKey factory call. Lifting it to a single
// generic, queryKey-shaped helper eliminates that duplication; callers
// pass `keys.all(tripId)` directly so the helper stays decoupled from
// the per-feature key conventions.
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export interface PatchCacheContext<T> {
  /** The list value as it was before the mutation, or undefined if
   *  the cache was empty. Pass back to setQueryData on rollback. */
  prev: T[] | undefined
}

/**
 * Snapshot + write a list-shaped cache entry, returning the previous
 * value for rollback. `fn` receives the previous list (defaulting to
 * an empty array when the cache is cold) and returns the patched list.
 */
export function patchListCache<T>(
  qc:  QueryClient,
  key: QueryKey,
  fn:  (prev: T[]) => T[],
): PatchCacheContext<T> {
  const prev = qc.getQueryData<T[]>(key)
  qc.setQueryData<T[]>(key, fn(prev ?? []))
  return { prev }
}

/**
 * Restore a list-shaped cache entry from a saved context. No-op when
 * `ctx.prev` is undefined (mutation ran while uid was unknown).
 */
export function rollbackListCache<T>(
  qc:  QueryClient,
  key: QueryKey,
  ctx: PatchCacheContext<T> | undefined,
): void {
  if (ctx?.prev !== undefined) qc.setQueryData<T[]>(key, ctx.prev)
}
