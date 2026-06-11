// Tests for getAdminToken's token-exchange resilience (timeout + transient
// retry). The unit under test is the retry policy, not the JWT signing, so
// jose is mocked to a no-op signer — no real RSA key needed. Global fetch is
// stubbed to script the OAuth token endpoint's responses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// No-op JWT signer: getAdminToken does importPKCS8 → new SignJWT(...).…sign().
vi.mock('jose', () => ({
  importPKCS8: vi.fn(async () => ({ fake: 'key' })),
  SignJWT: class {
    setProtectedHeader() { return this }
    setIssuer()         { return this }
    setSubject()        { return this }
    setAudience()       { return this }
    setIssuedAt()       { return this }
    setExpirationTime() { return this }
    async sign()        { return 'fake-jwt' }
  },
}))

import { getAdminToken, invalidateAdminToken } from '../src/admin'

const SA = JSON.stringify({
  client_email: 'sa@demo.iam.gserviceaccount.com',
  private_key:  '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
  token_uri:    'https://oauth2.googleapis.com/token',
  project_id:   'demo',
})

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
// Clear the module-level token cache so each test mints fresh.
beforeEach(() => { invalidateAdminToken() })

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

describe('getAdminToken token-exchange resilience', () => {
  it('retries a transient 5xx, then succeeds', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return calls === 1 ? new Response('upstream error', { status: 503 }) : tokenResponse()
    }) as typeof fetch

    expect(await getAdminToken(SA)).toBe('tok-abc')
    expect(calls).toBe(2)
  })

  it('retries a network/timeout failure, then succeeds', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }
      return tokenResponse()
    }) as typeof fetch

    expect(await getAdminToken(SA)).toBe('tok-abc')
    expect(calls).toBe(2)
  })

  it('does NOT retry a 4xx (permanent — invalid_grant / bad key)', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => { calls += 1; return new Response('invalid_grant', { status: 400 }) }) as typeof fetch

    await expect(getAdminToken(SA)).rejects.toThrow(/token exchange failed: 400/)
    expect(calls).toBe(1)
  })

  it('gives up after the max attempts on a persistent 5xx', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => { calls += 1; return new Response('down', { status: 503 }) }) as typeof fetch

    await expect(getAdminToken(SA)).rejects.toThrow(/token exchange failed: 503/)
    expect(calls).toBe(3)  // TOKEN_EXCHANGE_MAX_ATTEMPTS
  })
})
