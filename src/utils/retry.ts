// src/utils/retry.ts
// Exponential-backoff retry for transient Worker/R2 network failures.
// Callers provide a predicate so terminal validation and authorization errors fail fast.

interface RetryOptions {
  /** Total attempts including the first. Default 3 (initial + 2 retries). */
  attempts?: number
  /** Initial backoff in ms. Subsequent waits are doubled (capped). */
  baseMs?:   number
  /** Hard ceiling on a single wait. */
  maxMs?:    number
  /**
   * Predicate to skip retry on terminal errors. Return true to retry,
   * false to throw immediately. Default: retry on every error.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, baseMs = 500, maxMs = 5000, shouldRetry = () => true } = opts
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const isLast = i === attempts - 1
      if (isLast || !shouldRetry(e, i)) throw e
      const wait = Math.min(maxMs, baseMs * Math.pow(2, i))
      // Jitter ±25% so concurrent retries don't thunder.
      const jittered = wait * (0.75 + Math.random() * 0.5)
      await new Promise(r => setTimeout(r, jittered))
    }
  }
  throw lastErr  // unreachable; the loop's last iteration always throws
}
