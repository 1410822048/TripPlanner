// workers/ocr/scripts/smoke-attachment-url.mjs
//
// One-shot end-to-end smoke for the attachment signed-URL endpoint: confirm
// REAL GCS accepts our V4 signature (the Worker unit tests only prove the
// sign→verify pipeline is self-consistent). Use it as the Phase 3 rollout gate
// (re-run before flipping VITE_ATTACHMENT_URL_MODE=signed) and as a regression
// check after gcs-sign.ts changes.
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
//
// Optional: WORKER_BASE (default http://localhost:8787).
//   --allow-missing : treat a 404 NoSuchKey (stale path, signature still
//                     accepted) as a pass. For a PURE signing-regression check
//                     only — NOT the rollout gate, which must actually read an
//                     object. By default a 404 exits non-zero.
//
// Exit codes: 0 = served (or signature-ok with --allow-missing); 1 = signature
// REJECTED (403) or unexpected response; 2 = object missing (404, gate not
// satisfied) or token/input/Worker error.
//
// GOTCHAS this script handles for you (both look like a signature failure but
// aren't): it uses GET, never HEAD (a HEAD against a GET-signed URL → 403
// method mismatch); and a 200 on a NON-public object is the expected pass
// (the signature authorizes the read as the service account — that's the point).

const BASE  = process.env.WORKER_BASE ?? 'http://localhost:8787'
const TOKEN = process.env.TOKEN

// Strip flags before positional parsing so `--allow-missing` can't land in the
// positional args. --allow-missing downgrades a 404 to a pass (signing-only
// regression); the default rollout-gate behaviour exits non-zero on a 404.
const rawArgs      = process.argv.slice(2)
const allowMissing = rawArgs.includes('--allow-missing')
const [mode, tripId, ...rest] = rawArgs.filter(a => !a.startsWith('--'))

function die(msg) { console.error(`✖ ${msg}`); process.exit(2) }

if (!TOKEN)            die('set TOKEN=<firebase id token> (app DevTools: await firebase.auth().currentUser.getIdToken())')
if (mode !== 'entity') die('mode must be "entity"')
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

/** GET the signed URL against real GCS (NOT HEAD) and CLASSIFY the outcome.
 *  The point is to separate a real signature failure from a missing object:
 *    200                         → PASS           (signature valid, object served)
 *    403 (SignatureDoesNotMatch) → SIG_FAIL       (the real gcs-sign.ts bug)
 *    404 (NoSuchKey)             → OBJECT_MISSING (signature ACCEPTED; the object
 *                                                  isn't at this path — stale/replaced)
 *    other                       → OTHER          (unexpected; investigate)
 *  GCS validates the signature BEFORE object lookup, so a 404 NoSuchKey proves
 *  auth passed — it is NOT a signing failure, just a stale test path. */
async function fetchSigned(url) {
  const res = await fetch(url)                       // GET by default
  const type = res.headers.get('content-type') ?? '?'
  let kind, icon
  if (res.status === 200)      { kind = 'PASS';           icon = '✅' }
  else if (res.status === 403) { kind = 'SIG_FAIL';       icon = '❌' }
  else if (res.status === 404) { kind = 'OBJECT_MISSING'; icon = '⚠️' }
  else                         { kind = 'OTHER';          icon = '❓' }
  console.log(`  ${icon} GCS ${res.status} ${type}  ${redact(url)}`)
  if (kind !== 'PASS') {
    const body = await res.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
    if (code) console.log(`     GCS <Code>: ${code}`)
    console.log(`     GCS body: ${body.slice(0, 300)}`)
  }
  return { kind, status: res.status }
}

const results = []

const [entityId, variant = 'full', entityType = 'expense'] = rest
if (!entityId) die('entity mode: node ... entity <tripId> <entityId> [variant=full] [entityType=expense]')
console.log(`▶ entity ${entityType}/${entityId} variant=${variant} trip=${tripId}`)
const out = await callWorker('/attachment-url', { tripId, entityType, entityId, variant })
console.log(`  expiresAt=${out.expiresAt}`)
results.push(await fetchSigned(out.url))

const sigFail = results.filter(r => r.kind === 'SIG_FAIL').length
const other   = results.filter(r => r.kind === 'OTHER').length
const missing = results.filter(r => r.kind === 'OBJECT_MISSING').length
const served  = results.filter(r => r.kind === 'PASS').length

// Only a 403 condemns gcs-sign.ts. A 404 NoSuchKey means the signature was
// ACCEPTED (auth runs before object lookup) — verified-good signing against a
// stale path — so it does NOT fail the signing check.
if (sigFail > 0) {
  console.log(`\n❌ FAIL — GCS REJECTED ${sigFail} signature(s) (403). Real gcs-sign.ts bug — see the <Code>/body above.`)
  process.exit(1)
}
if (other > 0) {
  console.log(`\n❓ UNCLEAR — ${other} unexpected response(s); investigate (not a clean signature pass).`)
  process.exit(1)
}
if (missing > 0) {
  console.log(
    `\n⚠️  SIGNATURE OK — but ${missing} object(s) returned 404 NoSuchKey (signature ACCEPTED; path stale/replaced). ` +
    `${served} served 200. This is NOT a signing failure.`,
  )
  if (allowMissing) {
    console.log('    --allow-missing set → signing-regression PASS (exit 0). NOT a rollout-gate pass.')
    process.exit(0)
  }
  console.log('    Rollout gate NOT satisfied — no object was actually read. Re-run with a CURRENT path for a clean 200, or pass --allow-missing for a signing-only check.')
  process.exit(2)
}
console.log(`\n✅ PASS — GCS served all ${served} object(s); signatures valid.`)
process.exit(0)
