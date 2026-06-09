// workers/ocr/src/gcs-sign.ts
// GCS V4 signed-URL minting with a LOCAL RSA signature.
//
// We sign with the Firebase service-account private_key directly (WebCrypto
// RSASSA-PKCS1-v1_5 / SHA-256) instead of calling the IAM signBlob API:
//   - no extra Google API round-trip on the hot path
//   - no extra IAM permission (the SA key is already in
//     FIREBASE_SERVICE_ACCOUNT for the admin OAuth flow in admin.ts)
//
// Algorithm verified against
// cloud.google.com/storage/docs/access-control/signing-urls-manually
// (V4, query-string, GET). Notes that bit us / are load-bearing:
//   - PATH-STYLE host `storage.googleapis.com`, canonical URI
//     `/{bucket}/{object}`. NOT virtual-hosted: the bucket name
//     `tripplanner-80a4f.firebasestorage.app` has dots, so
//     `{bucket}.storage.googleapis.com` would break the
//     `*.storage.googleapis.com` single-label wildcard cert (TLS fail).
//   - credential-scope region = `auto` (official sample uses it; valid
//     for multi-region / unknown-region buckets).
//   - signature is HEX of the raw RSA signature.
//   - query keys+values are percent-encoded with RFC3986 strictness
//     (only A-Za-z0-9-_.~ stay literal); the object path keeps `/`.
//
// The pure canonical-request / string-to-sign builder is split out
// (buildV4SigningStrings) so it's golden-testable without a key; signV4Url
// wraps it with the WebCrypto RSA sign. `nowMs` is injected so callers
// (Date.now()) and tests (a fixed epoch) both stay deterministic.

const HOST = 'storage.googleapis.com'

/** RFC 3986 percent-encode: everything except unreserved (A-Za-z0-9-_.~)
 *  is encoded. Matches Python `urllib.parse.quote(s, safe="")` semantics
 *  used by Google's reference signer (which never encodes _.-~). JS
 *  encodeURIComponent leaves !*'() literal, so we additionally encode
 *  those to stay byte-exact with the spec. */
export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** Percent-encode an object path while PRESERVING `/` separators: encode
 *  each segment, rejoin with `/`. `~` stays literal (it's unreserved, so
 *  strictEncode keeps it). */
export function encodeObjectPath(path: string): string {
  return path.split('/').map(strictEncode).join('/')
}

function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return hex(digest)
}

/** Zero-pad to 2 digits. */
function p2(n: number): string { return String(n).padStart(2, '0') }

/** `YYYYMMDD` and `YYYYMMDDTHHMMSSZ` (UTC) for the credential scope +
 *  X-Goog-Date. Built from getUTC* so it's TZ-independent. */
export function googDate(d: Date): { date: string; dateTime: string } {
  const y  = d.getUTCFullYear()
  const mo = p2(d.getUTCMonth() + 1)
  const da = p2(d.getUTCDate())
  const h  = p2(d.getUTCHours())
  const mi = p2(d.getUTCMinutes())
  const s  = p2(d.getUTCSeconds())
  const date = `${y}${mo}${da}`
  return { date, dateTime: `${date}T${h}${mi}${s}Z` }
}

export interface V4SigningInput {
  bucket:         string
  /** Object path WITHOUT leading slash, e.g. `trips/abc/expenses/x/r.webp`. */
  objectPath:     string
  clientEmail:    string
  expiresSeconds: number
  nowMs:          number
}

/** Pure builder: produces the canonical query string + the string-to-sign,
 *  given the inputs and clock. No key, no crypto-signing — golden-testable.
 *  Returns everything the URL assembly needs except the signature itself. */
export async function buildV4SigningStrings(
  input: V4SigningInput,
): Promise<{ canonicalUri: string; canonicalQuery: string; stringToSign: string; dateTime: string }> {
  const { date, dateTime } = googDate(new Date(input.nowMs))

  // Canonical URI: /{bucket}/{object}, each segment percent-encoded, `/` kept.
  const canonicalUri = '/' + encodeObjectPath(`${input.bucket}/${input.objectPath}`)

  const credential   = `${input.clientEmail}/${date}/auto/storage/goog4_request`

  // Query params sorted by key, key+value each strictEncode'd, joined `&`.
  const params: Array<[string, string]> = [
    ['X-Goog-Algorithm',     'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential',    credential],
    ['X-Goog-Date',          dateTime],
    ['X-Goog-Expires',       String(input.expiresSeconds)],
    ['X-Goog-SignedHeaders', 'host'],
  ]
  const canonicalQuery = params
    .map(([k, v]) => [strictEncode(k), strictEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  // Canonical headers end with a trailing \n; the blank line before
  // SignedHeaders comes from the join's own \n.
  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${HOST}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    dateTime,
    `${date}/auto/storage/goog4_request`,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  return { canonicalUri, canonicalQuery, stringToSign, dateTime }
}

// ─── Private-key import (module cache keyed by PEM string) ──────────

let keyCache: { pem: string; key: CryptoKey } | null = null

/** Strip PKCS#8 PEM armor + base64-decode to DER. */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return der.buffer
}

/** Import the SA private key as an RSASSA-PKCS1-v1_5 / SHA-256 signing
 *  key. Cached per-PEM (Workers reuse the instance across requests, so we
 *  pay the import once). */
export async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  if (keyCache && keyCache.pem === privateKeyPem) return keyCache.key
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  keyCache = { pem: privateKeyPem, key }
  return key
}

/** Mint a GET signed URL for `objectPath` under `bucket`, valid for
 *  `expiresSeconds`. Returns the URL + the absolute expiry (ISO 8601) the
 *  client uses to schedule a refresh. The URL contains a bearer signature
 *  — callers MUST NOT log it. */
export async function signV4Url(
  input: V4SigningInput & { privateKeyPem: string },
): Promise<{ url: string; expiresAt: string }> {
  const { canonicalUri, canonicalQuery, stringToSign } = await buildV4SigningStrings(input)
  const key = await importSigningKey(input.privateKeyPem)
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(stringToSign),
  )
  const url = `https://${HOST}${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${hex(sig)}`
  const expiresAt = new Date(input.nowMs + input.expiresSeconds * 1000).toISOString()
  return { url, expiresAt }
}
