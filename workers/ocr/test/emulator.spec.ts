// emulator.ts — the local Firebase-emulator mode. The point of these tests
// is the fence: without both emulator variables, a demo- project and
// loopback hosts, everything stays on production behaviour, and unsigned
// tokens are never accepted.
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureEmulators,
  emulatorActive,
  firestoreRestBase,
  PRODUCTION_FIRESTORE_BASE,
  verifyEmulatorToken,
} from '../src/emulator'
import { getAdminToken } from '../src/admin'
import { verifyFirebaseToken } from '../src/auth'

const DEMO = 'demo-tripmate-e2e'
const sa = (projectId: string) => JSON.stringify({ project_id: projectId, client_email: 'x', private_key: 'x', token_uri: 'x' })
const env = (over: Record<string, string | undefined> = {}) => ({
  FIRESTORE_EMULATOR_HOST:     '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_PROJECT_ID:         DEMO,
  FIREBASE_SERVICE_ACCOUNT:    sa(DEMO),
  ...over,
}) as Parameters<typeof configureEmulators>[0]

const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
/** An Auth-emulator ID token: unsigned (alg none), empty signature. */
function emulatorToken(claims: Record<string, unknown> = {}, alg = 'none'): string {
  const now = Math.floor(Date.now() / 1000)
  return `${b64url({ alg, typ: 'JWT' })}.${b64url({
    iss: `https://securetoken.google.com/${DEMO}`, aud: DEMO, sub: 'alice', iat: now, exp: now + 3600, ...claims,
  })}.`
}

afterEach(() => configureEmulators(env({ FIRESTORE_EMULATOR_HOST: undefined, FIREBASE_AUTH_EMULATOR_HOST: undefined })))

describe('emulator mode is off by default', () => {
  it('without the variables: production Firestore, no unsigned tokens', async () => {
    configureEmulators(env({ FIRESTORE_EMULATOR_HOST: undefined, FIREBASE_AUTH_EMULATOR_HOST: undefined, FIREBASE_PROJECT_ID: 'tripplanner-80a4f' }))
    expect(emulatorActive()).toBe(false)
    expect(firestoreRestBase()).toBe(PRODUCTION_FIRESTORE_BASE)
    expect(() => verifyEmulatorToken(emulatorToken(), DEMO)).toThrow('not in emulator mode')
    // The real verifier never accepts an unsigned token.
    await expect(verifyFirebaseToken(emulatorToken(), DEMO)).rejects.toThrow()
  })
})

describe('emulator mode refuses anything but a fully local demo setup', () => {
  it.each([
    ['only Firestore set', { FIREBASE_AUTH_EMULATOR_HOST: undefined }],
    ['only Auth set', { FIRESTORE_EMULATOR_HOST: undefined }],
    ['a real project', { FIREBASE_PROJECT_ID: 'tripplanner-80a4f', FIREBASE_SERVICE_ACCOUNT: sa('tripplanner-80a4f') }],
    ['a service account for another project', { FIREBASE_SERVICE_ACCOUNT: sa('tripplanner-80a4f') }],
    ['an unreadable service account', { FIREBASE_SERVICE_ACCOUNT: 'not json' }],
    ['a remote Firestore host', { FIRESTORE_EMULATOR_HOST: 'firestore.example.com:8080' }],
    ['a remote Auth host', { FIREBASE_AUTH_EMULATOR_HOST: '10.0.0.5:9099' }],
  ])('%s → throws, and stays off', (_name, over) => {
    configureEmulators(env({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }))
    expect(() => configureEmulators(env(over))).toThrow()
    expect(emulatorActive()).toBe(false)
    expect(firestoreRestBase()).toBe(PRODUCTION_FIRESTORE_BASE)
  })
})

describe('emulator mode, when configured', () => {
  it('routes Firestore REST and admin calls to the emulator', async () => {
    configureEmulators(env())
    expect(emulatorActive()).toBe(true)
    expect(firestoreRestBase()).toBe('http://127.0.0.1:8080/v1')
    await expect(getAdminToken(sa(DEMO))).resolves.toBe('owner')
  })

  it('accepts an Auth-emulator token for the demo project', async () => {
    configureEmulators(env())
    await expect(verifyFirebaseToken(emulatorToken(), DEMO)).resolves.toMatchObject({ sub: 'alice' })
  })

  it.each([
    ['a signed token (only emulator accounts may sign in)', emulatorToken({}, 'RS256')],
    ['another project', emulatorToken({ iss: 'https://securetoken.google.com/other', aud: 'other' })],
    ['a wrong audience', emulatorToken({ aud: 'other' })],
    ['an expired token', emulatorToken({ exp: Math.floor(Date.now() / 1000) - 10 })],
    ['no subject', emulatorToken({ sub: '' })],
  ])('refuses %s', (_name, token) => {
    configureEmulators(env())
    expect(() => verifyEmulatorToken(token, DEMO)).toThrow()
  })
})
