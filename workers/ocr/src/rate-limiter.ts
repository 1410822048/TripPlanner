// Cross-PoP rate limiter backed by Durable Objects.
//
// Why DO and not the existing `ratelimit` binding: the platform
// binding counts per-Cloudflare-location (officially documented as
// "local to the Cloudflare location ... eventually consistent").
// A coordinated botnet across N PoPs can multiply effective abuse
// by N. DO instances pinned by uid converge globally on one
// strongly-consistent counter, so a single user's rate is bounded
// regardless of which PoP each request hits.
//
// Design:
//   - One DO per uid (idFromName(uid)). Cold-instantiated on first
//     hit; idle instances cost nothing.
//   - Sliding window via timestamp array. Cheaper than fixed buckets
//     (no clock-edge bursts) and trivial to expire -- drop entries
//     older than `windowMs`.
//   - SQLite storage (`state.storage.put`) is durable; in-memory cache
//     handled automatically by the DO runtime.
//   - Cap layered ABOVE the local per-PoP limit:
//     * Local 30/min catches per-PoP burst cheaply (~0ms)
//     * Global 60/min catches cross-PoP multiplication (~10-50ms)
//   - 60 > 30 deliberately: legit user roaming between sessions could
//     hit two PoPs briefly; the global cap is the cluster ceiling,
//     not a duplicate of the local one.

interface RateLimitOutcome {
  allowed: boolean
  count:   number
  resetMs: number  // ms until oldest tracked timestamp falls out of the window
}

export class GlobalRateLimiter implements DurableObject {
  private storage: DurableObjectStorage
  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }

  async fetch(req: Request): Promise<Response> {
    const url      = new URL(req.url)
    const limit    = Number(url.searchParams.get('limit')    ?? '60')
    const windowMs = Number(url.searchParams.get('windowMs') ?? '60000')
    const now      = Date.now()

    const stored = (await this.storage.get<number[]>('timestamps')) ?? []
    const fresh  = stored.filter(t => now - t < windowMs)

    let outcome: RateLimitOutcome
    if (fresh.length >= limit) {
      outcome = {
        allowed: false,
        count:   fresh.length,
        resetMs: Math.max(0, windowMs - (now - fresh[0])),
      }
    } else {
      fresh.push(now)
      outcome = {
        allowed: true,
        count:   fresh.length,
        resetMs: 0,
      }
    }

    // Write back only when the window actually changed (we trimmed
    // expired entries or appended a new one). Skip on full-reject
    // when nothing was trimmed -- saves a write per blocked request.
    if (outcome.allowed || fresh.length !== stored.length) {
      await this.storage.put('timestamps', fresh)
    }

    return new Response(JSON.stringify(outcome), {
      headers: { 'content-type': 'application/json' },
    })
  }
}

/** Check the global rate limit for a (scope, uid) pair against the
 *  given DO binding. Returns the outcome -- caller decides what to do
 *  on `allowed: false`.
 *
 *  `scope` is mandatory and partitions counters across endpoints so
 *  high-frequency `/ocr` traffic doesn't crowd out a user's `/cascade-
 *  member` budget. Each (scope, uid) pair gets its own DO instance --
 *  idle ones cost nothing. */
export async function checkGlobalRateLimit(
  namespace: DurableObjectNamespace,
  scope:     string,
  uid:       string,
  limit:     number,
  windowMs:  number,
): Promise<RateLimitOutcome> {
  const id   = namespace.idFromName(`${scope}:${uid}`)
  const stub = namespace.get(id)
  const res  = await stub.fetch(
    `https://do.local/check?limit=${limit}&windowMs=${windowMs}`,
  )
  return await res.json() as RateLimitOutcome
}
