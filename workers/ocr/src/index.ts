// TripMate OCR Worker — entry point.
//
// Endpoints:
//   POST /ocr             — Gemini receipt OCR (original endpoint)
//   POST /cascade-member  — server-side membership cascade for
//                           accept-invite (admin SDK bypasses rules)
//
// All non-matching requests get a 404. CORS preflight (OPTIONS) is
// handled inline. No router lib needed — two routes don't earn the
// bundle bloat.
import { verifyFirebaseToken, extractBearerToken } from './auth'
import { extractReceiptItems, GeminiError }       from './gemini'
import { OcrRequestSchema }                       from './schema'
import { cascadeMemberAdd, CascadeRequestSchema, CascadeError } from './cascade'
import { checkGlobalRateLimit }                   from './rate-limiter'

export { GlobalRateLimiter } from './rate-limiter'

interface WorkerEnv {
  FIREBASE_PROJECT_ID:      string
  ALLOWED_ORIGINS:          string  // comma-separated
  GEMINI_API_KEY:           string  // secret
  FIREBASE_SERVICE_ACCOUNT: string  // secret — JSON string of service account key
  /** Per-PoP per-uid rate limiter for the OCR endpoint. Cheap first-line
   *  filter (~0ms). Counters are local to each Cloudflare location. */
  OCR_RATE_LIMITER:         RateLimit
  /** Per-PoP per-uid rate limiter for the cascade endpoint. */
  CASCADE_RATE_LIMITER:     RateLimit
  /** Cross-PoP global rate limiter. Durable Object — strongly
   *  consistent counter per-uid that catches multi-PoP abuse that
   *  would slip past the per-PoP binding. ~10-50ms latency cost. */
  GLOBAL_LIMITER:           DurableObjectNamespace
}

/** Resolve CORS headers for a given request origin. We allowlist
 *  origins (no reflect-any) because the API requires auth. Entries
 *  starting with `*.` are matched as suffix wildcards — Cloudflare
 *  Pages assigns per-deployment subdomains (e.g. `0b885524.tripmate-
 *  2wg.pages.dev`) so an exact-only match would force every preview
 *  deploy to be re-listed. The wildcard scope is bounded to a single
 *  trusted apex domain we own.
 *
 *  Origin parsing uses URL() so we never fall for substring tricks
 *  (`https://evil.com/?x=tripmate-2wg.pages.dev` would have failed the
 *  old string `indexOf('://')` check anyway, but explicit parse is
 *  cleaner and rejects malformed origins outright). */
function originAllowed(origin: string, patterns: string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false  // malformed Origin header
  }
  // Only allow https + http (latter for localhost dev). Avoids exotic
  // schemes (file:, data:, chrome-extension:, etc.) being whitelisted
  // via wildcard match.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  const host = parsed.host  // hostname[:port]
  return patterns.some(p => {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)  // ".tripmate-2wg.pages.dev"
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return p === origin
  })
}

function corsHeaders(env: WorkerEnv, originHeader: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  const allow   = originHeader && originAllowed(originHeader, allowed)
    ? originHeader
    : allowed[0]
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                          'Origin',
  }
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

/** Truncated uid for logs. Full Firebase uids are 28 chars; logs end up
 *  in Workers tail / observability storage and we don't need full uids
 *  to diagnose abuse — the prefix is enough to correlate without
 *  retaining a fully-identifying token. */
function uidTag(uid: string): string {
  return uid.slice(0, 6) + '…'
}

export default {
  async fetch(request, env): Promise<Response> {
    const url     = new URL(request.url)
    const cors    = corsHeaders(env, request.headers.get('Origin'))

    // ─── CORS preflight ────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // ─── Routing ──────────────────────────────────────────────────────
    const isOcr     = url.pathname === '/ocr'             && request.method === 'POST'
    const isCascade = url.pathname === '/cascade-member'  && request.method === 'POST'
    if (!isOcr && !isCascade) {
      return json({ error: 'Not found' }, 404, cors)
    }

    console.log(`[req] ${request.method} ${url.pathname} origin=${request.headers.get('Origin') ?? '?'}`)

    // ─── Body size guard ──────────────────────────────────────────────
    // Done before auth so 100MB unauthenticated bodies are rejected
    // without burning CPU on JWT verification first. 9MB covers an 8MB
    // base64 image + JSON envelope; cascade body is <1KB so this is a
    // no-op for it. Content-Length is client-supplied — bytes-actually-
    // streamed are still bounded by the platform's 100MB hard cap.
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (contentLength > 9 * 1024 * 1024) {
      console.warn(`[body] too large: contentLength=${contentLength}`)
      return json({ error: 'Body too large' }, 413, cors)
    }

    // ─── Auth (shared by both routes) ─────────────────────────────────
    const token = extractBearerToken(request)
    if (!token) {
      console.warn('[auth] no bearer token')
      return json({ error: 'Missing Authorization' }, 401, cors)
    }
    let uid: string
    try {
      const claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID)
      uid = claims.sub
      console.log(`[auth] ok uid=${uidTag(uid)}`)
    } catch (e) {
      console.warn(`[auth] invalid token: ${(e as Error).message}`)
      return json({ error: `Invalid token: ${(e as Error).message}` }, 401, cors)
    }

    // ─── Rate limit (per-uid, two-layer) ──────────────────────────────
    // L1: Per-PoP binding — fast (~0ms), catches single-location abuse.
    //     Per-uid key. Done after auth so unauthenticated noise doesn't
    //     burn counter slots.
    // L2: Cross-PoP Durable Object — slower (~10-50ms), strongly
    //     consistent, catches botnet-style multi-PoP multiplication
    //     that L1 alone can't see. Cap deliberately looser than L1 —
    //     L1's tighter per-location bound is the primary defense; L2
    //     is the cluster ceiling.
    const limiter = isOcr ? env.OCR_RATE_LIMITER : env.CASCADE_RATE_LIMITER
    const localResult = await limiter.limit({ key: uid })
    if (!localResult.success) {
      console.warn(`[rate-limit] L1 deny uid=${uidTag(uid)} route=${url.pathname}`)
      return json({ error: 'Rate limit exceeded' }, 429, cors)
    }

    const scope       = isOcr ? 'ocr' : 'cascade'
    const globalLimit = isOcr ? 60   : 10   // 2× the per-PoP cap
    const globalResult = await checkGlobalRateLimit(
      env.GLOBAL_LIMITER, scope, uid, globalLimit, 60_000,
    )
    if (!globalResult.allowed) {
      console.warn(
        `[rate-limit] L2 deny uid=${uidTag(uid)} route=${url.pathname} ` +
        `count=${globalResult.count} resetMs=${globalResult.resetMs}`,
      )
      return json({ error: 'Global rate limit exceeded' }, 429, cors)
    }

    // ─── Body parsing (shared) ────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      console.warn('[body] not valid JSON')
      return json({ error: 'Invalid JSON' }, 400, cors)
    }

    // ─── /cascade-member ──────────────────────────────────────────────
    if (isCascade) {
      const parsed = CascadeRequestSchema.safeParse(body)
      if (!parsed.success) {
        console.warn(`[cascade] schema fail: ${parsed.error.message.slice(0, 200)}`)
        return json({ error: 'Invalid body', detail: parsed.error.message }, 400, cors)
      }
      try {
        const result = await cascadeMemberAdd(uid, parsed.data, env.FIREBASE_SERVICE_ACCOUNT)
        console.log(`[cascade] uid=${uidTag(uid)} trip=${parsed.data.tripId} updated=${result.updatedDocs}`)
        return json({ ok: true, ...result }, 200, cors)
      } catch (e) {
        if (e instanceof CascadeError) {
          console.warn(`[cascade] ${e.status} ${e.message}`)
          return json({ error: e.message }, e.status, cors)
        }
        console.error(`[cascade] internal error: ${(e as Error).message}`)
        return json({ error: 'Internal error' }, 500, cors)
      }
    }

    // ─── /ocr ─────────────────────────────────────────────────────────
    const parsed = OcrRequestSchema.safeParse(body)
    if (!parsed.success) {
      console.warn(`[body] schema fail: ${parsed.error.message.slice(0, 200)}`)
      return json({ error: 'Invalid body', detail: parsed.error.message }, 400, cors)
    }
    try {
      const result = await extractReceiptItems(
        parsed.data.image,
        parsed.data.mimeType,
        parsed.data.currency,
        env.GEMINI_API_KEY,
      )
      console.log(`[ocr] returning ${result.items.length} items to uid=${uidTag(uid)}`)
      return json(result, 200, cors)
    } catch (e) {
      if (e instanceof GeminiError) {
        console.warn(`[ocr] GeminiError status=${e.status} msg=${e.message}`)
        return json({ error: e.message }, e.status, cors)
      }
      console.error(`[ocr] internal error: ${(e as Error).message}`)
      return json({ error: 'Internal error' }, 500, cors)
    }
  },
} satisfies ExportedHandler<WorkerEnv>
