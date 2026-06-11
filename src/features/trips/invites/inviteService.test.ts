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

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db: {},
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

vi.stubGlobal('fetch', fetchMock)

import { InviteError, createInvite, revokeInvite } from './inviteService'

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
})

describe('InviteError', () => {
  it('carries a discriminator code for UI branching', () => {
    const e = new InviteError('expired', 'expired')
    expect(e.code).toBe('expired')
    expect(e.name).toBe('InviteError')
    expect(e instanceof Error).toBe(true)
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
