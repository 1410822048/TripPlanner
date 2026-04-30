// src/utils/retry.ts
// Exponential-backoff retry for transient network failures. Used to wrap
// Storage uploads which routinely fail on flaky travel-Wi-Fi connections
// — the user typically just clicks save once, and we'd rather absorb a
// 1-2 second retry window than surface a "try again" toast for what's
// almost always a transient blip.
//
// Failures that retry CAN'T fix (4xx errors, validation rejection, file
// too large) propagate out unchanged because Storage SDK throws those
// with stable error codes the caller can detect.

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

/**
 * Predicate: retry only on transient failures. Storage SDK uses error
 * codes prefixed with `storage/`. Permanent errors (unauthorized, quota
 * exceeded, invalid argument) shouldn't be retried — they'll fail the
 * same way regardless of how many times we try.
 */
export function isTransientStorageError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  if (!code) return true  // unknown error shape → retry once just in case
  // Permanent / user-error codes — bail out fast.
  const permanent = [
    'storage/unauthorized',
    'storage/canceled',
    'storage/invalid-argument',
    'storage/invalid-checksum',
    'storage/quota-exceeded',
    'storage/object-not-found',
    'storage/unauthenticated',
  ]
  return !permanent.includes(code)
}
