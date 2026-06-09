// Tests for gcs-sign.ts — GCS V4 signed-URL minting.
//
// Two layers:
//   1. The PURE builder (strictEncode / encodeObjectPath / googDate /
//      buildV4SigningStrings) — golden assertions on the canonical query
//      string + string-to-sign for a fixed clock. No key needed.
//   2. The full signV4Url — generate an EPHEMERAL RSA key in-runtime
//      (workerd WebCrypto), sign, then VERIFY the URL's X-Goog-Signature
//      against the same string-to-sign with the public key. Proves the
//      whole pipeline (canonical → hash → RSA sign → hex → URL) is
//      self-consistent without hard-coding a private key.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  strictEncode,
  encodeObjectPath,
  googDate,
  buildV4SigningStrings,
  signV4Url,
  type V4SigningInput,
} from '../src/gcs-sign'

const BUCKET = 'tripplanner-80a4f.firebasestorage.app'
const OBJECT = 'trips/trip-1/expenses/exp-1/abc.thumb.webp'
const EMAIL  = 'sa@proj.iam.gserviceaccount.com'
// 2026-06-09T12:00:00Z. Date is fine in tests (the Date.now/new Date ban is
// for Workflow scripts, not Worker test code).
const NOW_MS = Date.UTC(2026, 5, 9, 12, 0, 0)

const INPUT: V4SigningInput = {
  bucket: BUCKET, objectPath: OBJECT, clientEmail: EMAIL,
  expiresSeconds: 1800, nowMs: NOW_MS,
}

describe('strictEncode', () => {
  it('encodes / @ and space, keeps RFC3986 unreserved', () => {
    expect(strictEncode('a/b@c d')).toBe('a%2Fb%40c%20d')
    expect(strictEncode('-_.~')).toBe('-_.~')        // unreserved: untouched
  })
  it("encodes the chars encodeURIComponent leaves literal (!*'())", () => {
    expect(strictEncode("a'!*()b")).toBe('a%27%21%2A%28%29b')
  })
})

describe('encodeObjectPath', () => {
  it('percent-encodes segments but preserves / separators', () => {
    expect(encodeObjectPath('x/y z/a')).toBe('x/y%20z/a')
    expect(encodeObjectPath(OBJECT)).toBe(OBJECT)     // all safe chars
  })
})

describe('googDate', () => {
  it('formats UTC date + datetime', () => {
    const { date, dateTime } = googDate(new Date(NOW_MS))
    expect(date).toBe('20260609')
    expect(dateTime).toBe('20260609T120000Z')
  })
})

describe('buildV4SigningStrings', () => {
  it('canonical URI is path-style /{bucket}/{object}', async () => {
    const { canonicalUri } = await buildV4SigningStrings(INPUT)
    expect(canonicalUri).toBe(`/${BUCKET}/${OBJECT}`)
  })

  it('canonical query is sorted + strict-encoded with auto region', async () => {
    const { canonicalQuery } = await buildV4SigningStrings(INPUT)
    expect(canonicalQuery).toBe(
      'X-Goog-Algorithm=GOOG4-RSA-SHA256' +
      '&X-Goog-Credential=sa%40proj.iam.gserviceaccount.com%2F20260609%2Fauto%2Fstorage%2Fgoog4_request' +
      '&X-Goog-Date=20260609T120000Z' +
      '&X-Goog-Expires=1800' +
      '&X-Goog-SignedHeaders=host',
    )
  })

  it('string-to-sign = algo / date / scope / sha256-hex(canonical request)', async () => {
    const { stringToSign } = await buildV4SigningStrings(INPUT)
    const lines = stringToSign.split('\n')
    expect(lines[0]).toBe('GOOG4-RSA-SHA256')
    expect(lines[1]).toBe('20260609T120000Z')
    expect(lines[2]).toBe('20260609/auto/storage/goog4_request')
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/)   // sha256 hex digest
    expect(lines).toHaveLength(4)
  })
})

// ─── Full pipeline: sign + verify with an ephemeral key ────────────

function derToPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = btoa(bin).match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('signV4Url', () => {
  let pem: string
  let publicKey: CryptoKey

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    publicKey = pair.publicKey
    pem = derToPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  })

  it('produces a path-style HTTPS URL with an appended hex signature', async () => {
    const { url } = await signV4Url({ ...INPUT, privateKeyPem: pem })
    expect(url.startsWith(`https://storage.googleapis.com/${BUCKET}/${OBJECT}?`)).toBe(true)
    const sig = new URL(url).searchParams.get('X-Goog-Signature')
    expect(sig).toMatch(/^[0-9a-f]+$/)
  })

  it('signature verifies against the string-to-sign with the public key', async () => {
    const { url } = await signV4Url({ ...INPUT, privateKeyPem: pem })
    const sigHex = new URL(url).searchParams.get('X-Goog-Signature')!
    const { stringToSign } = await buildV4SigningStrings(INPUT)
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', publicKey,
      hexToBytes(sigHex), new TextEncoder().encode(stringToSign),
    )
    expect(ok).toBe(true)
  })

  it('expiresAt = nowMs + expiresSeconds (deterministic under injected clock)', async () => {
    const { url, expiresAt } = await signV4Url({ ...INPUT, privateKeyPem: pem })
    expect(expiresAt).toBe(new Date(NOW_MS + 1800 * 1000).toISOString())
    // Same inputs → byte-identical URL (no hidden Date.now()).
    const again = await signV4Url({ ...INPUT, privateKeyPem: pem })
    expect(again.url).toBe(url)
  })

  it('a tampered string-to-sign does NOT verify (signature is real, not a stub)', async () => {
    const { url } = await signV4Url({ ...INPUT, privateKeyPem: pem })
    const sigHex = new URL(url).searchParams.get('X-Goog-Signature')!
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', publicKey,
      hexToBytes(sigHex), new TextEncoder().encode('not-the-real-string-to-sign'),
    )
    expect(ok).toBe(false)
  })
})
