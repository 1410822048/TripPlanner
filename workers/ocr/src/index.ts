// TripMate OCR Worker — entry point.
//
// Single endpoint: POST /ocr
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body:    { image, mimeType, currency? }   (see ./schema.ts)
//   Returns: { items, total, currency? }      (see ./schema.ts)
//
// All non-/ocr requests get a 404. CORS preflight (OPTIONS) is handled
// inline. No router lib needed — one route doesn't earn the bundle bloat.
import { verifyFirebaseToken, extractBearerToken } from './auth'
import { extractReceiptItems, GeminiError }       from './gemini'
import { OcrRequestSchema }                       from './schema'

interface WorkerEnv {
  FIREBASE_PROJECT_ID: string
  ALLOWED_ORIGINS:     string  // comma-separated
  GEMINI_API_KEY:      string  // secret
}

/** Resolve CORS headers for a given request origin. We allowlist exact
 *  origins rather than reflecting any origin — reflecting Origin: * is
 *  fine for read-only public APIs but ours requires auth so we tighten. */
function corsHeaders(env: WorkerEnv, originHeader: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  const allow   = originHeader && allowed.includes(originHeader) ? originHeader : allowed[0]
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
    if (url.pathname !== '/ocr' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, cors)
    }

    console.log(`[req] ${request.method} ${url.pathname} origin=${request.headers.get('Origin') ?? '?'}`)

    // ─── Auth ─────────────────────────────────────────────────────────
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

    // ─── Body validation ──────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      console.warn('[body] not valid JSON')
      return json({ error: 'Invalid JSON' }, 400, cors)
    }
    const parsed = OcrRequestSchema.safeParse(body)
    if (!parsed.success) {
      console.warn(`[body] schema fail: ${parsed.error.message.slice(0, 200)}`)
      return json({ error: 'Invalid body', detail: parsed.error.message }, 400, cors)
    }

    // ─── OCR call ─────────────────────────────────────────────────────
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
