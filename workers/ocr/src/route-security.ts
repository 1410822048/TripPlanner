import { errors, SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'

const PreviewTokenClaimsSchema = z.object({
  uid: z.string().min(1).max(128),
  tripId: z.string().min(1).max(60),
  revision: z.string().min(1).max(128),
  inputHash: z.string().min(1).max(128),
  payloadHash: z.string().min(1).max(128),
  exp: z.number().int().positive(),
}).strict()

export type PreviewTokenClaims = z.infer<typeof PreviewTokenClaimsSchema>

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export async function stableHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return base64Url(new Uint8Array(digest))
}

function previewTokenKey(secret: string): Uint8Array {
  if (!secret || secret.length < 16) throw new Error('route preview secret is not configured')
  return new TextEncoder().encode(secret)
}

export async function createPreviewToken(
  input: Omit<PreviewTokenClaims, 'exp'>,
  secret: string,
  ttlMs = 15 * 60_000,
  now = Date.now(),
): Promise<string> {
  return new SignJWT(input)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setExpirationTime(Math.floor((now + ttlMs) / 1_000))
    .sign(previewTokenKey(secret))
}

export async function verifyPreviewToken(token: string, secret: string, now = Date.now()): Promise<PreviewTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, previewTokenKey(secret), {
      algorithms: ['HS256'],
      typ: 'JWT',
      currentDate: new Date(now),
    })
    const parsed = PreviewTokenClaimsSchema.safeParse(payload)
    if (!parsed.success) throw new Error('invalid preview token')
    return parsed.data
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new Error('preview token expired')
    throw new Error('invalid preview token')
  }
}
