// Service-level tests for inviteService. Two concerns:
//
//   1. InviteError carries a discriminator code for UI branching.
//   2. The Worker-cutover createInvite / revokeInvite are thin wrappers
//      around workerFetch, but the wire body has a protocol-level
//      invariant worth locking down: the client sends ONLY the minimal
//      intent. createInvite ships { tripId, role } and NOTHING else --
//      the Worker mints the token and reads tripTitle/tripIcon off the
//      trip doc, so forwarding any of those would let a (future) raw
//      caller forge a token or spoof the trip metadata that ends up in
//      the redeemable invite doc. revokeInvite ships { tripId, token }.
//
// The redeem path (acceptInvite) + the single-active pointer logic are
// covered server-side in workers/ocr/test/membership-write.spec.ts; here
// we only pin the client-side request shape.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Trip } from '@/types'
import type { User } from 'firebase/auth'

const fetchMock = vi.fn()
const { captureErrorMock, docMock, getDocFromServerMock, getTripsByIdsMock } = vi.hoisted(() => ({
  captureErrorMock:       vi.fn(),
  docMock:               vi.fn((_db: unknown, ...path: string[]) => ({ path })),
  getDocFromServerMock:  vi.fn(),
  getTripsByIdsMock:     vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db: {},
    doc: docMock,
    getDocFromServer: getDocFromServerMock,
    // createInvite reconstructs the optimistic Invite's timestamps locally;
    // the real server values arrive on the next realtime push. Stub just
    // enough of the Timestamp surface it touches (now / fromMillis).
    Timestamp: {
      now:        () => ({ toMillis: () => 1_000 }),
      fromMillis: (ms: number) => ({ toMillis: () => ms }),
    },
  })),
  getFirebaseAuth: vi.fn(async () => ({
    auth: {
      currentUser: {
        getIdToken: vi.fn(async () => 'fake-id-token'),
      },
    },
  })),
}))

vi.mock('@/services/workerBase', async () => {
  const actual = await vi.importActual<typeof import('@/services/workerBase')>('@/services/workerBase')
  return {
    ...actual,
    requireWorkerWriteBase: vi.fn(() => 'https://worker.example.dev'),
  }
})

vi.mock('@/features/trips/services/tripService', () => ({
  getTripsByIds: getTripsByIdsMock,
}))

vi.mock('@/services/sentry', () => ({
  captureError: captureErrorMock,
}))

vi.stubGlobal('fetch', fetchMock)

import { InviteError, acceptInvite, createInvite, getInvite, revokeInvite } from './inviteService'

const TRIP: Trip = {
  id:    'trip-1',
  title: '東京五日間',
  icon:  '🗼',
} as Trip

const USER = { uid: 'owner-uid' } as User

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  captureErrorMock.mockReset()
  docMock.mockClear()
  getDocFromServerMock.mockReset()
  getTripsByIdsMock.mockReset()
})

describe('InviteError', () => {
  it('carries a discriminator code for UI branching', () => {
    const e = new InviteError('expired', 'expired')
    expect(e.code).toBe('expired')
    expect(e.name).toBe('InviteError')
    expect(e instanceof Error).toBe(true)
  })
})

describe('getInvite', () => {
  it('reads the invite from the server, never from IndexedDB', async () => {
    const createdAt = { toDate: () => new Date(0), toMillis: () => 1_000 }
    const expiresAt = { toDate: () => new Date(0), toMillis: () => Date.now() + 60_000 }
    getDocFromServerMock.mockResolvedValueOnce({
      id: 'a'.repeat(64),
      exists: () => true,
      data: () => ({
        tripId: 'trip-1', tripTitle: '東京五日間', tripIcon: '🗼', role: 'viewer',
        createdBy: 'owner-uid', createdAt, expiresAt,
      }),
    })

    await expect(getInvite('trip-1', 'a'.repeat(64))).resolves.toMatchObject({
      id: 'a'.repeat(64), tripId: 'trip-1', role: 'viewer',
    })
    expect(getDocFromServerMock).toHaveBeenCalledWith({ path: ['trips', 'trip-1', 'invites', 'a'.repeat(64)] })
  })

  it('maps Firestore unavailable to a retryable error and captures the original', async () => {
    const cause = Object.assign(new Error('Failed to get document because the client is offline.'), {
      code: 'unavailable',
    })
    getDocFromServerMock.mockRejectedValueOnce(cause)

    await expect(getInvite('trip-1', 'a'.repeat(64))).rejects.toMatchObject({
      code: 'unavailable', message: 'Invite could not be confirmed',
    })
    expect(captureErrorMock).toHaveBeenCalledWith(cause, {
      source: 'getInvite/serverRead', tripId: 'trip-1',
    })
  })

  it('maps a permanent server-read failure to non-retryable failed', async () => {
    const cause = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    })
    getDocFromServerMock.mockRejectedValueOnce(cause)

    await expect(getInvite('trip-1', 'a'.repeat(64))).rejects.toMatchObject({
      code: 'failed', message: 'Invite could not be loaded',
    })
    expect(captureErrorMock).toHaveBeenCalledWith(cause, {
      source: 'getInvite/serverRead', tripId: 'trip-1',
    })
  })
})

describe('createInvite', () => {
  it('posts ONLY { tripId, role } to /invite-create (no client token / tripTitle / tripIcon / createdBy)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      ok:        true,
      token:     'a'.repeat(64),
      expiresAt: '2026-06-18T00:00:00.000Z',
    }))

    await createInvite(TRIP, 'editor', USER)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/invite-create')
    expect(init.method).toBe('POST')

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ tripId: 'trip-1', role: 'editor' })
    // Critical invariant: the Worker mints the token and reads trip
    // metadata off the trip doc. None of these may cross the wire, or a
    // future raw caller could forge a token / spoof the invite doc's
    // tripTitle / tripIcon / createdBy.
    expect(sentBody).not.toHaveProperty('token')
    expect(sentBody).not.toHaveProperty('tripTitle')
    expect(sentBody).not.toHaveProperty('tripIcon')
    expect(sentBody).not.toHaveProperty('createdBy')
    expect(sentBody).not.toHaveProperty('expiresAt')
    expect(sentBody).not.toHaveProperty('expiresInMs')
  })

  it('builds the optimistic Invite from the Worker token + local trip/user inputs', async () => {
    const token = 'b'.repeat(64)
    fetchMock.mockResolvedValueOnce(okResponse({
      ok:        true,
      token,
      expiresAt: '2026-06-18T00:00:00.000Z',
    }))

    const invite = await createInvite(TRIP, 'viewer', USER)

    expect(invite.id).toBe(token)
    expect(invite.tripId).toBe('trip-1')
    expect(invite.tripTitle).toBe('東京五日間')
    expect(invite.tripIcon).toBe('🗼')
    expect(invite.role).toBe('viewer')
    expect(invite.createdBy).toBe('owner-uid')
    expect(invite.expiresAt.toMillis()).toBe(Date.parse('2026-06-18T00:00:00.000Z'))
  })

  it('falls back to ✈️ icon when the trip has none', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      ok:        true,
      token:     'c'.repeat(64),
      expiresAt: '2026-06-18T00:00:00.000Z',
    }))

    const invite = await createInvite({ ...TRIP, icon: undefined } as Trip, 'editor', USER)
    expect(invite.tripIcon).toBe('✈️')
  })

  it('propagates Worker rejection (403 non-owner)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('only the trip owner may create invites', {
      status:  403,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(createInvite(TRIP, 'editor', USER))
      .rejects.toThrowError(/trip owner/i)
  })
})

describe('revokeInvite', () => {
  it('posts { tripId, token } to /invite-revoke', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }))

    await revokeInvite('trip-1', 'd'.repeat(64))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/invite-revoke')
    expect(init.method).toBe('POST')

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ tripId: 'trip-1', token: 'd'.repeat(64) })
  })

  it('propagates a stale-token 409 as WorkerRejected (no silent success)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('invite token is stale; a newer invite is active', {
      status:  409,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(revokeInvite('trip-1', 'e'.repeat(64)))
      .rejects.toThrowError(/stale/i)
  })
})

describe('acceptInvite', () => {
  it('reads the freshly joined trip from the server before seeding the cache', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, outcome: 'joined' }))
    getTripsByIdsMock.mockResolvedValueOnce([TRIP])

    const result = await acceptInvite('trip-1', 'f'.repeat(64), USER)

    expect(result).toEqual({ outcome: 'joined', trip: TRIP })
    expect(getTripsByIdsMock).toHaveBeenCalledWith(['trip-1'], 'server')
  })
})
