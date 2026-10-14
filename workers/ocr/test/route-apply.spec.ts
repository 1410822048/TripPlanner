import { beforeEach, describe, expect, test, vi } from 'vitest'

const {
  getAdminToken,
  requireTripMember,
  routeScheduleFingerprint,
  scheduleFromDoc,
  runFirestoreTransaction,
} = vi.hoisted(() => ({
  getAdminToken: vi.fn(),
  requireTripMember: vi.fn(),
  routeScheduleFingerprint: vi.fn(),
  scheduleFromDoc: vi.fn((doc: unknown) => doc),
  runFirestoreTransaction: vi.fn(),
}))

vi.mock('../src/admin', () => ({ getAdminToken }))
vi.mock('../src/membership-shared', () => ({ requireTripMember }))
vi.mock('../src/route-preview', () => ({ routeScheduleFingerprint, scheduleFromDoc }))
vi.mock('../src/firestore-tx', () => ({
  docResourceName: (projectId: string, path: string) => `projects/${projectId}/databases/(default)/documents/${path}`,
  runFirestoreTransaction,
}))

import { applyRoute } from '../src/route-apply'
import { createPreviewToken, stableHash } from '../src/route-security'
import { RouteApplyRequestSchema } from '../src/route-schema'

describe('route apply authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const applyRequest = (leg: Record<string, unknown>) => ({
    tripId: 'trip-1',
    revision: 'revision-1234567890',
    date: '2026-07-15',
    previewToken: 't'.repeat(32),
    schedules: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
    legs: [{
      legIndex: 0,
      fromId: 'a',
      toId: 'b',
      walkingMinutes: 38,
      walkingDistanceMeters: 3_040,
      geometryAvailable: false,
      ...leg,
    }],
  })

  test('accepts the measurement-only route-leg wire shape', () => {
    expect(RouteApplyRequestSchema.safeParse(applyRequest({})).success).toBe(true)
    expect(RouteApplyRequestSchema.safeParse(applyRequest({
      walkingMinutes: 10_080, walkingDistanceMeters: 2_000_000,
    })).success).toBe(true)
  })

  // The strict write side of travelToNext; bounds match firestore.rules.
  test.each([
    ['a derived class', { kind: 'walking' }],
    ['a derived transit range', { transitEstimate: { minMinutes: 15, maxMinutes: 25 } }],
    ['fractional minutes', { walkingMinutes: 38.4 }],
    ['a fractional distance', { walkingDistanceMeters: 3_040.5 }],
    ['an out-of-range distance', { walkingDistanceMeters: 2_000_001 }],
    ['a missing distance', { walkingDistanceMeters: undefined }],
  ])('rejects a leg with %s', (_label, leg) => {
    expect(RouteApplyRequestSchema.safeParse(applyRequest(leg)).success).toBe(false)
  })

  test('maps malformed preview tokens to a safe 401 before any Firestore call', async () => {
    await expect(applyRoute('u1', {
      tripId: 'trip-1',
      revision: 'revision-1234567890',
      date: '2026-07-15',
      previewToken: 'malformed-preview-token-that-is-long-enough',
      schedules: [
        { id: 'a', order: 0 },
        { id: 'b', order: 1 },
      ],
      legs: [],
    }, 'not-used', 'project', 'test-secret-with-at-least-16-bytes')).rejects.toMatchObject({
      status: 401,
      code: 'PREVIEW_TOKEN_INVALID',
    })
  })

  test('rejects route estimates that differ from the signed preview', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const schedules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }]
    const revision = 'revision-1234567890'
    const date = '2026-07-15'
    const legs = [{
      legIndex: 0,
      fromId: 'a',
      toId: 'b',
      walkingMinutes: 8,
      walkingDistanceMeters: 640,
      geometryAvailable: true,
    }]
    const previewToken = await createPreviewToken({
      uid: 'u1',
      tripId: 'trip-1',
      revision,
      inputHash: 'input-hash',
      payloadHash: await stableHash({ revision, date, schedules }),
      legsHash: await stableHash([{ ...legs[0], walkingMinutes: 9 }]),
    }, secret)

    await expect(applyRoute('u1', {
      tripId: 'trip-1', revision, date, schedules, legs, previewToken,
    }, 'not-used', 'project', secret)).rejects.toMatchObject({
      status: 409,
      code: 'PREVIEW_PAYLOAD_MISMATCH',
    })
  })

  test('rejects signed legs whose topology does not match the signed order', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const schedules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }]
    const revision = 'revision-1234567890'
    const date = '2026-07-15'
    const legs = [{
      legIndex: 0,
      fromId: 'b',
      toId: 'a',
      walkingMinutes: 8,
      walkingDistanceMeters: 640,
      geometryAvailable: true,
    }]
    const previewToken = await createPreviewToken({
      uid: 'u1',
      tripId: 'trip-1',
      revision,
      inputHash: 'input-hash',
      payloadHash: await stableHash({ revision, date, schedules }),
      legsHash: await stableHash(legs),
    }, secret)

    await expect(applyRoute('u1', {
      tripId: 'trip-1', revision, date, schedules, legs, previewToken,
    }, 'not-used', 'project', secret)).rejects.toMatchObject({
      status: 409,
      code: 'PREVIEW_PAYLOAD_MISMATCH',
    })
  })

  test('atomically projects signed legs onto schedules while keeping the receipt compact', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const schedules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }]
    const revision = 'revision-1234567890'
    const date = '2026-07-15'
    const legs = [{
      legIndex: 0,
      fromId: 'a',
      toId: 'b',
      walkingMinutes: 8,
      walkingDistanceMeters: 640,
      geometryAvailable: true,
    }]
    const previewToken = await createPreviewToken({
      uid: 'u1',
      tripId: 'trip-1',
      revision,
      inputHash: 'input-hash',
      payloadHash: await stableHash({ revision, date, schedules }),
      legsHash: await stableHash(legs),
    }, secret)
    getAdminToken.mockResolvedValue('admin-token')
    requireTripMember.mockResolvedValue({
      trip: { exists: true, fields: {}, name: 'trip', updateTime: 't1' },
      member: {
        exists: true,
        fields: { role: { stringValue: 'editor' } },
        name: 'member',
        updateTime: 't1',
      },
    })
    routeScheduleFingerprint.mockResolvedValue('input-hash')

    let committedWrites: Array<Record<string, unknown>> = []
    runFirestoreTransaction.mockImplementation(async (
      _token: string,
      _projectId: string,
      body: (tx: {
        get(path: string): Promise<Record<string, unknown>>
        runQuery(): Promise<Array<Record<string, unknown>>>
      }) => Promise<{ writes: Array<Record<string, unknown>>; result: unknown }>,
    ) => {
      const outcome = await body({
        get: async () => ({ exists: false, fields: {}, name: '', updateTime: null }),
        runQuery: async () => schedules,
      })
      committedWrites = outcome.writes
      return outcome.result
    })

    await expect(applyRoute('u1', {
      tripId: 'trip-1', revision, date, schedules, legs, previewToken,
    }, 'service-account', 'project', secret)).resolves.toEqual({ status: 'applied', revision })

    const firstSchedule = committedWrites.find(write => String(write.document).endsWith('/schedules/a'))
    expect(firstSchedule).toMatchObject({
      fields: {
        routeRevision: { stringValue: revision },
        travelToNext: {
          mapValue: {
            fields: {
              toId: { stringValue: 'b' },
              walkingMinutes: { integerValue: '8' },
              walkingDistanceMeters: { integerValue: '640' },
            },
          },
        },
      },
      updateMask: ['order', 'routeRevision', 'travelToNext', 'updatedBy'],
    })
    expect(firstSchedule?.fields).not.toHaveProperty('revision')
    // Measurements only: nothing derived is persisted.
    const travel = (firstSchedule?.fields as { travelToNext: { mapValue: { fields: object } } }).travelToNext
    expect(Object.keys(travel.mapValue.fields).sort()).toEqual(['toId', 'walkingDistanceMeters', 'walkingMinutes'])

    const lastSchedule = committedWrites.find(write => String(write.document).endsWith('/schedules/b'))
    expect(lastSchedule).toMatchObject({
      fields: {
        routeRevision: { stringValue: revision },
        travelToNext: { nullValue: null },
      },
      updateMask: ['order', 'routeRevision', 'travelToNext', 'updatedBy'],
    })
    expect(committedWrites.some(write => String(write.document).includes('/routePlans/'))).toBe(false)

    const receipt = committedWrites.find(write => String(write.document).includes('/routeApplications/'))
    expect(receipt?.fields).not.toHaveProperty('date')
    expect(receipt?.fields).not.toHaveProperty('legs')
  })

  test('requires legs on the wire', () => {
    expect(RouteApplyRequestSchema.safeParse({
      tripId: 'trip-1',
      revision: 'revision-1234567890',
      date: '2026-07-15',
      previewToken: 't'.repeat(32),
      schedules: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
    }).success).toBe(false)
  })

  test('refuses a preview token that never signed legs before any Firestore call', async () => {
    const secret = 'test-secret-with-at-least-16-bytes'
    const schedules = [{ id: 'a', order: 0 }, { id: 'b', order: 1 }]
    const revision = 'revision-1234567890'
    const date = '2026-07-15'
    const previewToken = await createPreviewToken({
      uid: 'u1',
      tripId: 'trip-1',
      revision,
      inputHash: 'input-hash',
      payloadHash: await stableHash({ revision, date, schedules }),
    }, secret)

    await expect(applyRoute('u1', {
      tripId: 'trip-1', revision, date, schedules, legs: [], previewToken,
    }, 'service-account', 'project', secret)).rejects.toMatchObject({
      status: 409,
      code: 'PREVIEW_PAYLOAD_MISMATCH',
    })
    expect(runFirestoreTransaction).not.toHaveBeenCalled()
  })
})
