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

interface WorkerEnv {
  FIREBASE_PROJECT_ID:      string
  ALLOWED_ORIGINS:          string  // comma-separated
  GEMINI_API_KEY:           string  // secret
  FIREBASE_SERVICE_ACCOUNT: string  // secret — JSON string of service account key
}

/** Resolve CORS headers for a given request origin. We allowlist
 *  origins (no reflect-any) because the API requires auth. Entries
 *  starting with `*.` are matched as suffix wildcards — Cloudflare
 *  Pages assigns per-deployment subdomains (e.g. `0b885524.tripmate-
 *  2wg.pages.dev`) so an exact-only match would force every preview
 *  deploy to be re-listed. The wildcard scope is bounded to a single
 *  trusted apex domain we own. */
function originAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some(p => {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)  // ".tripmate-2wg.pages.dev"
      const idx = origin.indexOf('://')
      if (idx < 0) return false
      const host = origin.slice(idx + 3)
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
      console.log(`[auth] ok uid=${uid}`)
    } catch (e) {
      console.warn(`[auth] invalid token: ${(e as Error).message}`)
      return json({ error: `Invalid token: ${(e as Error).message}` }, 401, cors)
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
        console.log(`[cascade] uid=${uid} trip=${parsed.data.tripId} updated=${result.updatedDocs}`)
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
      console.log(`[ocr] returning ${result.items.length} items to uid=${uid}`)
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
