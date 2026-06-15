// Cloudflare Pages proxy for Firebase Auth's redirect helper.
//
// Firebase Web Auth's redirect flow loads helper pages from `authDomain`
// under /__/auth/*. Hosting this path on the app origin keeps the iframe
// same-origin, avoiding third-party storage blocking in modern browsers.

const FIREBASE_AUTH_ORIGIN = 'https://tripplanner-80a4f.firebaseapp.com'
const UPSTREAM_AUTH_PREFIX = '/__/auth/'
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS'])

// Allowlist of request headers forwarded upstream. Default-deny: anything
// not listed (cookie, authorization, host, cf-*, x-forwarded-*, and any
// header a future browser adds) is dropped, so first-party credentials can
// never leak to firebaseapp.com. /__/auth/* is a public OAuth redirect
// helper whose state lives in web storage — these are all it needs to fetch
// the helper HTML/JS and POST form_post callbacks. Add here (deliberately)
// if a flow ever needs more.
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
]

interface PagesContext {
  request: Request
  params: {
    path?: string | string[]
  }
}

function authPathFromParam(path: string | string[] | undefined): string {
  if (Array.isArray(path)) return path.map(encodeURIComponent).join('/')
  return path ? encodeURIComponent(path) : ''
}

function rewriteLocation(location: string, requestUrl: URL): string {
  const upstream = new URL(FIREBASE_AUTH_ORIGIN)
  const next = new URL(location, upstream)
  if (next.origin !== upstream.origin || !next.pathname.startsWith(UPSTREAM_AUTH_PREFIX)) {
    return location
  }
  return `${requestUrl.origin}${next.pathname}${next.search}${next.hash}`
}

/** Build the upstream request headers from the strict allowlist — the single
 *  point where the request-side header policy lives. */
function buildUpstreamAuthHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

/** Clone the upstream response headers, stripping what must not reach the app
 *  origin. set-cookie: the helper doesn't rely on cookies (web storage carries
 *  redirect state), so block the upstream planting cookies on our domain. */
function buildResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers)
  headers.delete('set-cookie')
  return headers
}

export async function onRequest({ request, params }: PagesContext): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: Array.from(ALLOWED_METHODS).join(', ') },
    })
  }

  const requestUrl = new URL(request.url)
  const authPath = authPathFromParam(params.path)
  const upstreamUrl = new URL(`${UPSTREAM_AUTH_PREFIX}${authPath}`, FIREBASE_AUTH_ORIGIN)
  upstreamUrl.search = requestUrl.search

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamAuthHeaders(request),
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  })

  const responseHeaders = buildResponseHeaders(upstreamResponse)
  const location = responseHeaders.get('location')
  if (location) {
    responseHeaders.set('location', rewriteLocation(location, requestUrl))
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  })
}
