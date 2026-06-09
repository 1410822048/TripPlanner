// workers/ocr/scripts/smoke-attachment-url.mjs
//
// One-shot end-to-end smoke for the attachment signed-URL endpoints, so we
// confirm REAL GCS accepts our V4 signature BEFORE building the Phase 2
// client resolver on top of it. The Worker unit tests only prove the
// sign→verify pipeline is self-consistent; this proves GCS says 200.
//
// It does two hops:
//   1. POST the Worker endpoint  → get { url, expiresAt }
//   2. GET that url against real GCS → expect 200 + the object's content-type
//
// Run the Worker locally first (no prod deploy needed — the signing is local
// and the GCS fetch works from anywhere):
//   cd workers/ocr && npx wrangler dev        # needs FIREBASE_SERVICE_ACCOUNT in .dev.vars
//
// Grab a real Firebase ID token from the signed-in app DevTools console:
//   await firebase.auth().currentUser.getIdToken()
//
// Then:
//   TOKEN=<idToken> node scripts/smoke-attachment-url.mjs entity <tripId> <expenseId> [variant=full] [entityType=expense]
//   TOKEN=<idToken> node scripts/smoke-attachment-url.mjs thumb  <tripId> <path> [path2 ...]
//
// Optional: WORKER_BASE (default http://localhost:8787).
//
// GOTCHAS this script handles for you (both look like a signature failure but
// aren't): it uses GET, never HEAD (a HEAD against a GET-signed URL → 403
// method mismatch); and a 200 on a NON-public object is the expected pass
// (the signature authorizes the read as the service account — that's the point).

const BASE  = process.env.WORKER_BASE ?? 'http://localhost:8787'
const TOKEN = process.env.TOKEN

const [, , mode, tripId, ...rest] = process.argv

function die(msg) { console.error(`✖ ${msg}`); process.exit(2) }

if (!TOKEN)            die('set TOKEN=<firebase id token> (app DevTools: await firebase.auth().currentUser.getIdToken())')
if (mode !== 'entity' && mode !== 'thumb') die('mode must be "entity" or "thumb"')
if (!tripId)          die('missing <tripId>')

/** Redact the X-Goog-Signature value so a bearer URL isn't dumped whole. */
function redact(url) {
  return url.replace(/(X-Goog-Signature=)[0-9a-f]+/i, '$1…')
}

/** POST the Worker endpoint; return parsed JSON or throw with the body. */
async function callWorker(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
  const text = await res.text()
  if (!res.ok) die(`Worker ${path} → ${res.status}: ${text}\n  (fix inputs/token — this is the endpoint, not the GCS signature)`)
  return JSON.parse(text)
}

/** GET the signed URL against real GCS (NOT HEAD); report status + type. */
async function fetchSigned(url) {
  const res = await fetch(url)                       // GET by default
  const type = res.headers.get('content-type') ?? '?'
  const ok   = res.status === 200
  console.log(`  ${ok ? '✅' : '❌'} GCS ${res.status} ${type}  ${redact(url)}`)
  if (!ok) {
    const body = await res.text().catch(() => '')
    console.log(`     GCS error body: ${body.slice(0, 400)}`)
  }
  return ok
}

let allOk = true

if (mode === 'entity') {
  const [entityId, variant = 'full', entityType = 'expense'] = rest
  if (!entityId) die('entity mode: node ... entity <tripId> <entityId> [variant=full] [entityType=expense]')
  console.log(`▶ entity ${entityType}/${entityId} variant=${variant} trip=${tripId}`)
  const out = await callWorker('/attachment-url', { tripId, entityType, entityId, variant })
  console.log(`  expiresAt=${out.expiresAt}`)
  allOk = await fetchSigned(out.url)
} else {
  const paths = rest
  if (paths.length === 0) die('thumb mode: node ... thumb <tripId> <path> [path2 ...]')
  console.log(`▶ thumb trip=${tripId} paths=${paths.length}`)
  const out = await callWorker('/attachment-thumb-urls', { tripId, paths })
  for (const entry of out.urls) {
    console.log(`  · ${entry.path}  expiresAt=${entry.expiresAt}`)
    if (!(await fetchSigned(entry.url))) allOk = false
  }
}

console.log(allOk
  ? '\n✅ PASS — GCS accepted the signature. Safe to proceed to Phase 2 client resolver.'
  : '\n❌ FAIL — GCS rejected a signature. Paste the GCS error body; gcs-sign.ts needs a fix before Phase 2.')
process.exit(allOk ? 0 : 1)
