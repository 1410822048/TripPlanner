import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import type { CreateScheduleInput, Schedule } from '@/types/schedule'

const mocks = vi.hoisted(() => ({
  updateDoc: vi.fn(),
  deleteField: vi.fn(() => ({ __deleteField: true })),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
  firestoreDocFromSchema: vi.fn(),
  capturedFromDoc: undefined as ((doc: QueryDocumentSnapshot) => Schedule) | undefined,
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db: {},
    doc: vi.fn(() => ({ path: 'schedule' })),
    updateDoc: mocks.updateDoc,
    deleteField: mocks.deleteField,
    serverTimestamp: mocks.serverTimestamp,
  })),
}))
vi.mock('@/services/firestoreDocFromSchema', () => ({
  firestoreDocFromSchema: mocks.firestoreDocFromSchema,
}))
vi.mock('@/services/tripScopedList', () => ({
  createTripScopedListServices: vi.fn((config: { fromDoc: (doc: QueryDocumentSnapshot) => Schedule }) => {
    mocks.capturedFromDoc = config.fromDoc
    return { fetch: vi.fn(), subscribe: vi.fn() }
  }),
}))
vi.mock('@/services/tripMemberIds', () => ({ getTripMemberIds: vi.fn() }))
vi.mock('@/services/tripActivity', () => ({ bumpTripActivity: vi.fn() }))

import { buildScheduleUpdate, updateSchedule } from './scheduleService'

const resolvedLocation = {
  status: 'resolved' as const,
  place: {
    provider: 'geoapify' as const,
    providerPlaceId: 'place-1',
    name: '江ノ島駅',
    lat: 35.311,
    lng: 139.487,
    timeZone: 'Asia/Tokyo',
    countryCode: 'JP',
  },
}

const current = {
  id: 'schedule-1',
  tripId: 'trip-1',
  date: '2026-07-20',
  order: 1,
  title: '舊標題',
  description: '舊說明',
  location: resolvedLocation,
  timeMode: 'flexible',
  durationMinutes: 60,
  category: 'activity',
  estimatedCostMinor: 500,
  routeRevision: 'revision-1',
} as Schedule

function nextInput(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    title: current.title,
    date: current.date,
    timeMode: current.timeMode,
    durationMinutes: current.durationMinutes,
    category: current.category,
    description: current.description,
    estimatedCostMinor: current.estimatedCostMinor,
    location: current.location,
    ...overrides,
  }
}

describe('schedule update diff', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps title-only edits as a title-only patch and emits no-op patches as empty', () => {
    expect(buildScheduleUpdate(current, nextInput({ title: '新標題' }))).toEqual({ title: '新標題' })
    expect(buildScheduleUpdate(current, nextInput())).toEqual({})
  })

  it('deep-compares location and preserves an explicit undefined when clearing optional fields', () => {
    expect(buildScheduleUpdate(current, nextInput({
      location: structuredClone(resolvedLocation),
      description: undefined,
    }))).toEqual({ description: undefined })
    expect(Object.hasOwn(buildScheduleUpdate(current, nextInput({ description: undefined })), 'description')).toBe(true)
  })

  it('reads pending snapshots with server timestamp estimates through the shared parser', () => {
    const doc = { id: 'pending-1', data: vi.fn() } as unknown as QueryDocumentSnapshot
    const parsed = { id: 'pending-1', title: 'pending' } as Schedule
    mocks.firestoreDocFromSchema.mockReturnValue(parsed)

    expect(mocks.capturedFromDoc?.(doc)).toBe(parsed)
    expect(mocks.firestoreDocFromSchema).toHaveBeenCalledWith(expect.anything(), doc, 'scheduleFromDoc')
  })

  it('does not clear routeRevision for title-only updates', async () => {
    await updateSchedule('trip-1', 'schedule-1', { title: '新標題' }, { uid: 'user-1' })
    expect(mocks.updateDoc).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ routeRevision: null }))
  })

  it('materializes optional clears as Firestore deleteField sentinels', async () => {
    await updateSchedule('trip-1', 'schedule-1', { description: undefined }, { uid: 'user-1' })
    expect(mocks.updateDoc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      description: { __deleteField: true },
    }))
  })
})
