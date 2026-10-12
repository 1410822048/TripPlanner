// Service-level tests for the Worker-authoritative settlement writes.
//
// settlementService is a thin wrapper around workerFetch; what is worth
// locking down is the wire contract: `settledBy` and the optimistic
// fields never cross it (the Worker derives settledBy from the token),
// legs go in canonical order (the Worker assigns leg doc ids by it, and so
// does the client overlay), and the route id is the caller's.

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

import { createSettlementRoute, deleteSettlement } from './settlementService'

const TRIP_ID = 'trip-1'

beforeEach(() => {
  fetchMock.mockReset()
})

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sentBody = () => JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>

// a → c 300 via b; legs deliberately out of canonical order.
const TRANSFER = {
  kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor: 300,
  legs: [
    { fromUid: 'b', toUid: 'c', amountMinor: 300, expectedRemainingMinor: 900 },
    { fromUid: 'a', toUid: 'b', amountMinor: 300, expectedRemainingMinor: 300 },
  ],
}
const OPTIMISTIC = { currency: 'JPY', settledBy: 'c', pendingAppliedExpenseIds: [['e1'], ['e2']] }

describe('createSettlementRoute', () => {
  it('posts the route in canonical leg order, with the caller-minted routeId and nothing local', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true, routeId: 'r-1', settlementIds: ['r-1-00', 'r-1-01'] }))
    await createSettlementRoute(TRIP_ID, { routeId: 'r-1', route: TRANSFER, optimistic: OPTIMISTIC })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker.example.dev/settlement-route-create')
    expect(init.method).toBe('POST')
    expect(sentBody()).toEqual({
      tripId: TRIP_ID, routeId: 'r-1', kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 300,
      // The Worker assigns leg doc ids by this order; so does the overlay.
      legs: [
        { fromUid: 'a', toUid: 'b', amountMinor: 300, expectedRemainingMinor: 300 },
        { fromUid: 'b', toUid: 'c', amountMinor: 300, expectedRemainingMinor: 900 },
      ],
    })
    // settledBy comes from the verified token; optimistic is local-only.
    expect(sentBody()).not.toHaveProperty('settledBy')
    expect(sentBody()).not.toHaveProperty('optimistic')
  })

  it('sends the foreign trio and note on a transfer; empty note is omitted', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }))
    await createSettlementRoute(TRIP_ID, {
      routeId: 'r-2', route: TRANSFER, note: '晚餐',
      foreign: { sourceCurrency: 'USD', settledOn: '2026-05-30', expectedFxRate: { rateDecimal: '150', rateDate: '2026-05-30' } },
      optimistic: { ...OPTIMISTIC, sourceAmountMinor: 200 },
    })
    expect(sentBody()).toMatchObject({
      note: '晚餐', sourceCurrency: 'USD', settledOn: '2026-05-30',
      expectedFxRate: { rateDecimal: '150', rateDate: '2026-05-30' },
    })
    // The Worker derives the source amount itself.
    expect(sentBody()).not.toHaveProperty('sourceAmountMinor')

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }))
    await createSettlementRoute(TRIP_ID, { routeId: 'r-3', route: TRANSFER, note: '', optimistic: OPTIMISTIC })
    expect(sentBody()).not.toHaveProperty('note')
  })

  it('an offset carries no payer, receiver, amount or currency', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }))
    await createSettlementRoute(TRIP_ID, {
      routeId: 'r-4',
      route: { kind: 'OFFSET', participantUids: ['a', 'b'], legs: [{ fromUid: 'a', toUid: 'b', amountMinor: 5, expectedRemainingMinor: 5 }] },
      optimistic: OPTIMISTIC,
    })
    expect(sentBody()).toEqual({
      tripId: TRIP_ID, routeId: 'r-4', kind: 'OFFSET',
      legs: [{ fromUid: 'a', toUid: 'b', amountMinor: 5, expectedRemainingMinor: 5 }],
    })
  })

  it('propagates Worker rejection (e.g. stale suggestion)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'settlement suggestion is stale', code: 'SETTLEMENT_STALE' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    }))
    await expect(createSettlementRoute(TRIP_ID, { routeId: 'r-5', route: TRANSFER, optimistic: OPTIMISTIC }))
      .rejects.toMatchObject({ name: 'WorkerRejected' })
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
