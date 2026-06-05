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
// Phase 4.1 rearchitecture invariants additionally locked:
//   - `expectedRemainingMinor` crosses the wire only as a stale-confirmation
//     guard. NO `amountMinor` / `currency` / `sourceAmountMinor` cross the
//     wire. The Worker derives the canonical from pair-remaining at tx
//     time; forwarding any of these would invite a totals-only-validation
//     regression and re-open the OVERPAY class of bug.
//   - NO `optimistic` field crosses the wire — it's strictly for the
//     local cache patch row (see useSettlements.ts).
//
// Other assertions cover: note conditional include (omit vs '' has
// Firestore-level semantics), the delete payload shape, and the caller-
// supplied settlementId (which the optimistic patch / Worker request /
// Firestore doc all share, so the cache row swap is atomic without
// temp-id juggling).

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

/** Stub optimistic slice — local-only field on the variables type. None
 *  of these values should ever appear in the wire body. */
const OPTIMISTIC_STUB = {
  amountMinor: 9750,
  currency:    'JPY',
} as const

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
  it('TRIP_CURRENCY: posts stale-confirmed intent body (no amount, no currency) + does NOT send settledBy/optimistic', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      optimistic:   OPTIMISTIC_STUB,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/settlement-create')
    expect(init.method).toBe('POST')

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({
      mode:         'TRIP_CURRENCY',
      tripId:       TRIP_ID,
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
    })
    // Critical invariant: Worker derives settledBy from the token. If
    // the client started sending it, the Worker would still ignore it
    // -- but any future deserialization shim that forwarded the field
    // verbatim would let a caller forge settledBy on another uid.
    expect(sentBody).not.toHaveProperty('settledBy')
    expect(sentBody).not.toHaveProperty('amountMinor')
    expect(sentBody).not.toHaveProperty('currency')
    expect(sentBody).not.toHaveProperty('optimistic')
  })

  it('forwards the caller-minted settlementId verbatim (no internal re-minting)', async () => {
    // Guards against accidental regression to in-service minting --
    // optimistic cache row depends on the id matching exactly so the
    // listener-supplied real row replaces it without flicker.
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: 'another-uuid' }))

    await createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: 'another-uuid',
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      optimistic:   OPTIMISTIC_STUB,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { settlementId: string }
    expect(sentBody.settlementId).toBe('another-uuid')
  })

  it('TRIP_CURRENCY: omits note field when input.note is undefined', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      optimistic:   OPTIMISTIC_STUB,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('note')
  })

  it('TRIP_CURRENCY: includes note when provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      note:         '焼肉の精算',
      optimistic:   OPTIMISTIC_STUB,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { note: string }
    expect(sentBody.note).toBe('焼肉の精算')
  })

  it('TRIP_CURRENCY: omits note when input.note is empty string (preserves Firestore "field absent" semantics)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      note:         '',
      optimistic:   OPTIMISTIC_STUB,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('note')
  })

  // ── FOREIGN_CURRENCY branch ─────────────────────────────────────
  //
  // Phase 4.1 rearchitecture: the client ships only a stale-confirmed
  // intent (mode + uids + expectedRemainingMinor + sourceCurrency +
  // settledOn + note?). NO sourceAmountMinor — Worker inverse-derives it
  // from pair-remaining via atMost policy and writes both source +
  // canonical authoritatively.
  //
  // These assertions are the only thing standing between a future
  // refactor of the wire body and a silent regression where the
  // client either (a) starts forwarding optimistic canonical (Worker
  // .strict() now rejects, but a "tolerant" shim could re-open it) or
  // (b) drops a required intent field (Worker 400s but the failure
  // reads like "FX provider issue" to support).
  const FOREIGN_OPTIMISTIC = {
    amountMinor:       9750,
    currency:          'JPY',
    sourceAmountMinor: 6500,
  } as const

  it('FOREIGN_CURRENCY: ships stale-confirmed intent body + omits all amount fields', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:           'FOREIGN_CURRENCY',
      settlementId:   SETTLEMENT_ID,
      fromUid:        'from-uid',
      toUid:          'to-uid',
      expectedRemainingMinor: FOREIGN_OPTIMISTIC.amountMinor,
      sourceCurrency: 'USD',
      settledOn:      '2026-05-30',
      optimistic:     FOREIGN_OPTIMISTIC,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).toEqual({
      mode:           'FOREIGN_CURRENCY',
      tripId:         TRIP_ID,
      settlementId:   SETTLEMENT_ID,
      fromUid:        'from-uid',
      toUid:          'to-uid',
      expectedRemainingMinor: FOREIGN_OPTIMISTIC.amountMinor,
      sourceCurrency: 'USD',
      settledOn:      '2026-05-30',
    })
    // Worker is authoritative on every amount field — none cross the wire.
    expect(sentBody).not.toHaveProperty('amountMinor')
    expect(sentBody).not.toHaveProperty('currency')
    expect(sentBody).not.toHaveProperty('sourceAmountMinor')
    expect(sentBody).not.toHaveProperty('optimistic')
    expect(sentBody).not.toHaveProperty('settledBy')
  })

  it('FOREIGN_CURRENCY: includes note when provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:           'FOREIGN_CURRENCY',
      settlementId:   SETTLEMENT_ID,
      fromUid:        'from-uid',
      toUid:          'to-uid',
      expectedRemainingMinor: FOREIGN_OPTIMISTIC.amountMinor,
      sourceCurrency: 'USD',
      settledOn:      '2026-05-30',
      note:           'NYで受取',
      optimistic:     FOREIGN_OPTIMISTIC,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { note: string }
    expect(sentBody.note).toBe('NYで受取')
  })

  it('FOREIGN_CURRENCY: omits note when empty string (same Firestore "field absent" semantics as TRIP_CURRENCY)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, settlementId: SETTLEMENT_ID }))

    await createSettlement(TRIP_ID, {
      mode:           'FOREIGN_CURRENCY',
      settlementId:   SETTLEMENT_ID,
      fromUid:        'from-uid',
      toUid:          'to-uid',
      expectedRemainingMinor: FOREIGN_OPTIMISTIC.amountMinor,
      sourceCurrency: 'USD',
      settledOn:      '2026-05-30',
      note:           '',
      optimistic:     FOREIGN_OPTIMISTIC,
    })

    const sentBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
    expect(sentBody).not.toHaveProperty('note')
  })

  it('propagates Worker rejection as WorkerRejected (no silent success)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no remaining debt from from-uid to to-uid', {
      status:  400,
      headers: { 'Content-Type': 'text/plain' },
    }))

    await expect(createSettlement(TRIP_ID, {
      mode:         'TRIP_CURRENCY',
      settlementId: SETTLEMENT_ID,
      fromUid:      'from-uid',
      toUid:        'to-uid',
      expectedRemainingMinor: OPTIMISTIC_STUB.amountMinor,
      optimistic:   OPTIMISTIC_STUB,
    })).rejects.toThrowError(/no remaining debt/i)
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
