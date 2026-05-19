// Concurrency-bounded Promise.all. Workers allow at most 6 simultaneous
// open connections per invocation (subrequests waiting for response
// headers count); blowing past that just makes subsequent subrequests
// queue, so capping concurrency keeps headroom for nested calls (e.g.
// REST pagination inside listDocNames).
//
// Order-preserving (results[i] aligns with items[i]) so callers can
// rely on positional mapping.

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx], idx)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
