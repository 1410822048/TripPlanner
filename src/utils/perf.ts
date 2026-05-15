// src/utils/perf.ts
// Tiny boot-time instrumentation. Captures milliseconds since the page
// started for each named milestone (auth init, auth resolved, trips
// loaded, etc.) and exposes them for a debug overlay on the loading
// screen. Production builds keep the marks running — the overhead is
// a few performance.now() calls + a Map insertion. Reading is opt-in.
//
// Usage:
//   markPerf('auth-resolved')
//   getPerfMarks() → [{ label, t }] sorted by t

const marks: Array<{ label: string; t: number }> = []
const subscribers = new Set<() => void>()

/** Page load epoch — performance.now() returns time since this anchor. */
const epoch = typeof performance !== 'undefined' ? performance.timeOrigin : Date.now()

export function markPerf(label: string): void {
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now() - epoch)
  marks.push({ label, t: Math.round(t) })
  for (const fn of subscribers) fn()
}

export function getPerfMarks(): ReadonlyArray<{ label: string; t: number }> {
  return marks
}

export function subscribePerf(fn: () => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

/** Mark the document-parse moment. Importing this module first thing
 *  in main.tsx gives us a near-zero baseline for everything that
 *  follows. */
markPerf('app-start')
