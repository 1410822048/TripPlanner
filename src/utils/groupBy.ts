// src/utils/groupBy.ts
// Generic "split a flat list into buckets keyed by some derived string."
// Extracted because two feature files (`features/expense/components/
// ExpenseDateGroups.tsx` for the date-fold and `features/schedule/utils.ts`
// for the day timeline) reproduced the same shape — at three+ callers it
// would creep into more pages, so a typed primitive avoids the drift.

export function groupBy<T, K extends string>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out: Partial<Record<K, T[]>> = {}
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item)
  }
  return out as Record<K, T[]>
}
