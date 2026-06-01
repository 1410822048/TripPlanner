// Service-level tests for the Worker-cutover settlement create/delete.
//
// settlementService is mostly a thin wrapper around workerFetch, but
// there's one protocol-level invariant that's worth locking down: the
// `settledBy` field MUST NOT be sent to the Worker -- the Worker derives
// it from the verified Firebase token. Forgetting this would let a
// (future) raw-SDK caller pin `settledBy` to anything, and after M4
// closes the rule to `if false` the server-side check is the only one
// left.
//
// Other assertions cover: amountMinor integer pass-through (Worker schema
// is `int`; the form already parsed to minor units via parseMoneyToMinor),
// note conditional include (omit vs '' has Firestore-level semantics),
// the delete payload shape, and the caller-supplied settlementId
// (which the optimistic patch / Worker request / Firestore doc all
// share, so the cache row swap is atomic without temp-id juggling).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db: {},
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

import { createSettlement, deleteSettlement } from './settlementService'

const TRIP_ID       = 'trip-1'
const SETTLEMENT_ID = 'caller-minted-uuid'

beforeEach(() => {
  fetchMock.mockReset()
})

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createSettlement', () => {
  it('posts to /settlement-create with caller-supplied settlementId + does NOT send settledBy', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/settlement-create')
    expect(init.method).toBe('POST')

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({
      // Settlement FX Commit 2/4: client always labels TRIP_CURRENCY
      // payloads with the discriminator. Worker's discriminated union
      // rejects payloads missing this field as the wrong branch.
      mode:         'TRIP_CURRENCY',
      tripId:       TRIP_ID,
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
    })
    // Critical invariant: Worker derives settledBy from the token. If
    // the client started sending it, the Worker would still ignore it
    // -- but any future deserialization shim that forwarded the field
    // verbatim would let a caller forge settledBy on another uid.
    expect(sentBody).not.toHaveProperty('settledBy')
  })

  it('forwards the caller-minted settlementId verbatim (no internal re-minting)', async () => {
    // Guards against accidental regression to in-service minting --
    // optimistic cache row depends on the id matching exactly so the
    // listener-supplied real row replaces it without flicker.
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: 'another-uuid' }))

    await createSettlement(TRIP_ID, {
      settlementId: 'another-uuid',
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { settlementId: string }
    expect(sentBody.settlementId).toBe('another-uuid')
  })

  it('forwards integer amountMinor verbatim (no rounding inside the service)', async () => {
    // After the minor-units migration, the form parses to an integer at
    // the boundary via parseMoneyToMinor, so the service is allowed to
    // trust its input and pass through unchanged. Regression guard: if
    // anyone adds Math.round / Math.trunc back here, an off-by-one
    // rounding bug could mask a real client-side parse bug.
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  1234,
      currency:     'JPY',
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { amountMinor: number }
    expect(sentBody.amountMinor).toBe(1234)
  })

  it('omits note field when input.note is undefined', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('note')
  })

  it('includes note when provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
      note:         '焼肉の精算',
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { note: string }
    expect(sentBody.note).toBe('焼肉の精算')
  })

  it('omits note when input.note is empty string (preserves Firestore "field absent" semantics)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
      note:         '',
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('note')
  })

  it('propagates Worker rejection as WorkerRejected (no silent success)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('amount: exceeds remaining debt', {
      status:  400,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(createSettlement(TRIP_ID, {
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      amountMinor:  100,
      currency:     'JPY',
    })).rejects.toThrowError(/exceeds remaining debt/)
  })
})

describe('deleteSettlement', () => {
  it('posts to /settlement-delete with { tripId, settlementId }', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }))

    await deleteSettlement(TRIP_ID, 'settle-xyz')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/settlement-delete')
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ tripId: TRIP_ID, settlementId: 'settle-xyz' })
  })

  it('propagates Worker rejection (403 non-recorder / non-owner)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('only the recorder or owner may delete', {
      status:  403,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(deleteSettlement(TRIP_ID, 'settle-xyz'))
      .rejects.toThrowError(/recorder or owner/i)
  })
})
