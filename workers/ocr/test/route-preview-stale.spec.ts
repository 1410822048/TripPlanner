import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TxReadDoc } from '../src/firestore-tx'

const mocks = vi.hoisted(() => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  requireTripMember: vi.fn(async () => ({
    trip: { exists: true, fields: {}, name: 'trips/trip-1', updateTime: null },
    member: {
      exists: true,
      fields: { role: { stringValue: 'editor' } },
      name: 'trips/trip-1/members/user-1',
      updateTime: null,
    },
  })),
  runFirestoreTransaction: vi.fn(),
  orsMatrix: vi.fn(async () => ({
    durationsMinutes: [[0, 10], [10, 0]],
    distancesMeters: [[0, 1000], [1000, 0]],
  })),
  orsDirections: vi.fn(async () => ({
    durationMinutes: 10,
    distanceMeters: 1000,
    coordinates: [[139, 35], [139.01, 35.01]],
    legs: [{
      durationMinutes: 10,
      distanceMeters: 1000,
      coordinates: [[139, 35], [139.01, 35.01]],
    }],
  })),
}))

vi.mock('../src/admin', () => ({ getAdminToken: mocks.getAdminToken }))
vi.mock('../src/membership-shared', () => ({ requireTripMember: mocks.requireTripMember }))
vi.mock('../src/firestore-tx', async importOriginal => ({
  ...await importOriginal<typeof import('../src/firestore-tx')>(),
  runFirestoreTransaction: mocks.runFirestoreTransaction,
}))
vi.mock('../src/route-provider', async importOriginal => ({
  ...await importOriginal<typeof import('../src/route-provider')>(),
  orsMatrix: mocks.orsMatrix,
  orsDirections: mocks.orsDirections,
}))

import { previewRoute } from '../src/route-preview'

function scheduleDoc(id: string, order: number, lat: number, lng: number): TxReadDoc {
  return {
    exists: true,
    name: `projects/test/databases/(default)/documents/trips/trip-1/schedules/${id}`,
    updateTime: '2026-07-20T00:00:00.000Z',
    fields: {
      order: { integerValue: String(order) },
      timeMode: { stringValue: 'flexible' },
      durationMinutes: { integerValue: '60' },
      location: {
        mapValue: {
          fields: {
            status: { stringValue: 'resolved' },
            place: {
              mapValue: {
                fields: {
                  provider: { stringValue: 'geoapify' },
                  providerPlaceId: { stringValue: `place-${id}` },
                  name: { stringValue: id },
                  lat: { doubleValue: lat },
                  lng: { doubleValue: lng },
                  timeZone: { stringValue: 'Asia/Tokyo' },
                  countryCode: { stringValue: 'JP' },
                },
              },
            },
          },
        },
      },
    },
  }
}

describe('route preview freshness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const snapshots = [
      [scheduleDoc('a', 0, 35, 139), scheduleDoc('b', 1, 35.01, 139.01)],
      [scheduleDoc('a', 0, 35, 139), scheduleDoc('b', 1, 35.02, 139.02)],
    ]
    let transactionIndex = 0
    mocks.runFirestoreTransaction.mockImplementation(async (_token, _projectId, work) => {
      const docs = snapshots[transactionIndex++] ?? snapshots.at(-1)!
      const outcome = await work({
        runQuery: vi.fn(async () => docs),
      })
      return outcome.result
    })
  })

  test('rejects the preview when route inputs change while providers are running', async () => {
    await expect(previewRoute(
      'user-1',
      { tripId: 'trip-1', date: '2026-07-20' },
      '{}',
      'test-project',
      { ORS_API_KEY: 'ors-key', ROUTE_PREVIEW_HMAC_SECRET: 'x'.repeat(32) },
    )).rejects.toMatchObject({ status: 409, field: 'schedules' })

    expect(mocks.runFirestoreTransaction).toHaveBeenCalledTimes(2)
    for (const call of mocks.runFirestoreTransaction.mock.calls) {
      expect(call[3]).toEqual({ signal: expect.any(AbortSignal) })
    }
  })

  test('materializes a static transit estimate from the optimized leg matrix distance', async () => {
    const docs = [
      scheduleDoc('a', 0, 35, 139),
      scheduleDoc('b', 1, 35.03, 139.03),
    ]
    mocks.runFirestoreTransaction.mockImplementation(async (_token, _projectId, work) => {
      const outcome = await work({ runQuery: vi.fn(async () => docs) })
      return outcome.result
    })
    mocks.orsMatrix.mockResolvedValueOnce({
      durationsMinutes: [[0, 38], [38, 0]],
      distancesMeters: [[0, 3500], [3500, 0]],
    })
    mocks.orsDirections.mockResolvedValueOnce({
      durationMinutes: 38,
      distanceMeters: 3500,
      coordinates: [[139, 35], [139.03, 35.03]],
      legs: [{
        durationMinutes: 38,
        distanceMeters: 3500,
        coordinates: [[139, 35], [139.03, 35.03]],
      }],
    })

    const result = await previewRoute(
      'user-1',
      { tripId: 'trip-1', date: '2026-07-20' },
      '{}',
      'test-project',
      { ORS_API_KEY: 'ors-key', ROUTE_PREVIEW_HMAC_SECRET: 'x'.repeat(32) },
    )

    expect(result.legs).toEqual([expect.objectContaining({
      kind: 'transit-check',
      walkingMinutes: 38,
      transitEstimate: {
        minMinutes: 10,
        maxMinutes: 15,
        basis: 'ors-walking-distance',
      },
    })])
  })
})
