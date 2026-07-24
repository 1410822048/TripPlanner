import { describe, expect, test } from 'vitest'
import { decodeProtectedHeader, SignJWT } from 'jose'
import { createPreviewToken, verifyPreviewToken, stableHash } from '../src/route-security'

describe('route preview security', () => {
  test('HMAC token verifies only for the same actor and revision', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const token = await createPreviewToken({ uid: 'u1', tripId: 't1', revision: 'rev-1234567890', inputHash: 'i', payloadHash: 'p' }, secret, 60_000, 1_000)
    await expect(verifyPreviewToken(token, secret, 30_000)).resolves.toMatchObject({ uid: 'u1', payloadHash: 'p' })
    await expect(verifyPreviewToken(token, 'wrong', 30_000)).rejects.toThrow()
    await expect(verifyPreviewToken(token, secret, 70_000)).rejects.toThrow(/expired/i)
  })

  test('uses a standard HS256 JWT and rejects another HMAC algorithm', async () => {
    const secret = 'test-secret-with-at-least-32-bytes'
    const token = await createPreviewToken({ uid: 'u1', tripId: 't1', revision: 'rev-1234567890', inputHash: 'i', payloadHash: 'p' }, secret)
    expect(token.split('.')).toHaveLength(3)
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT' })

    const wrongAlgorithm = await new SignJWT({ uid: 'u1', tripId: 't1', revision: 'rev-1234567890', inputHash: 'i', payloadHash: 'p' })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(secret))
    await expect(verifyPreviewToken(wrongAlgorithm, secret)).rejects.toThrow(/invalid preview token/i)

    const missingType = await new SignJWT({ uid: 'u1', tripId: 't1', revision: 'rev-1234567890', inputHash: 'i', payloadHash: 'p' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(secret))
    await expect(verifyPreviewToken(missingType, secret)).rejects.toThrow(/invalid preview token/i)
  })

  test('stable hash ignores object key order', async () => {
    await expect(stableHash({ b: 2, a: 1 })).resolves.toBe(await stableHash({ a: 1, b: 2 }))
  })

  test('rejects preview tokens that are not bound to an apply payload', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const token = await createPreviewToken({ uid: 'u1', tripId: 't1', revision: 'rev-legacy-1234', inputHash: 'i' }, secret)
    await expect(verifyPreviewToken(token, secret)).rejects.toThrow(/invalid preview token/i)
  })
})
