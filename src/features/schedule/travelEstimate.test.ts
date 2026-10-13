import { describe, expect, test } from 'vitest'
import type { Schedule } from '@/types'
import {
  classifyScheduleSegment,
  feasibilityNotice,
  feasibilitySummary,
  scheduleDayFeasibility,
  scheduleSegment,
  segmentLabel,
  segmentTravelMode,
} from './travelEstimate'

// Kamakura area: 0.01° of latitude is about 1.1 km.
function schedule(overrides: Partial<Schedule> & Pick<Schedule, 'id'>): Schedule {
  return {
    tripId: 'trip-1',
    date: '2026-07-21',
    order: 0,
    title: overrides.id,
    category: 'activity',
    timeMode: 'flexible',
    durationMinutes: 60,
    routeRevision: null,
    travelToNext: null,
    location: {
      status: 'resolved',
      place: {
        provider: 'geoapify',
        providerPlaceId: `place-${overrides.id}`,
        name: overrides.id,
        lat: 35.31,
        lng: 139.53,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      },
    },
    createdBy: 'u1',
    updatedBy: 'u1',
    memberIds: ['u1'],
    createdAt: { toMillis: () => 0 } as Schedule['createdAt'],
    updatedAt: { toMillis: () => 0 } as Schedule['updatedAt'],
    ...overrides,
  }
}

function at(id: string, lat: number, lng: number, overrides: Partial<Schedule> = {}): Schedule {
  return schedule({
    id,
    location: {
      status: 'resolved',
      place: {
        provider: 'geoapify', providerPlaceId: `place-${id}`, name: id,
        lat, lng, timeZone: 'Asia/Tokyo', countryCode: 'JP',
      },
    },
    ...overrides,
  })
}

describe('classifyScheduleSegment / scheduleSegment', () => {
  test('a short local estimate is walking', () => {
    const segment = scheduleSegment(at('a', 35.31, 139.53), at('b', 35.312, 139.53))
    expect(segment.basis).toBe('local')
    expect(segment.estimate).toEqual({ kind: 'walking', walkingMinutes: 4 })
  })

  test('a missing coordinate is unknown, with no basis', () => {
    const segment = scheduleSegment(
      at('a', 35.31, 139.53),
      schedule({ id: 'b', location: { status: 'unresolved', query: '某處' } }),
    )
    expect(segment).toEqual({ estimate: { kind: 'unknown' }, basis: null })
  })

  test('leaving a transport schedule is unknown even when close', () => {
    expect(scheduleSegment(at('train', 35.31, 139.53, { category: 'transport' }), at('b', 35.311, 139.53)).estimate)
      .toEqual({ kind: 'unknown' })
  })

  test('far apart is long distance, whatever the walking measurement says', () => {
    // Tokyo → Kyoto.
    expect(scheduleSegment(at('a', 35.6812, 139.7671), at('b', 34.9858, 135.7588)).estimate)
      .toEqual({ kind: 'long-distance' })
  })

  test('uses the applied measurement only while both ends share the revision', () => {
    const measured = { toId: 'b', walkingMinutes: 22, walkingDistanceMeters: 1_800 }
    const from = at('a', 35.31, 139.53, { routeRevision: 'rev-1', travelToNext: measured })
    const to = at('b', 35.312, 139.53, { routeRevision: 'rev-1' })

    expect(scheduleSegment(from, to)).toEqual({
      estimate: { kind: 'either', walkingMinutes: 22, transit: { minMinutes: 10, maxMinutes: 20 } },
      basis: 'route',
    })
    expect(scheduleSegment(from, { ...to, routeRevision: 'rev-2' }).basis).toBe('local')
    expect(scheduleSegment({ ...from, travelToNext: { ...measured, toId: 'c' } }, to).basis).toBe('local')
  })

  test('two schedules at the same place are 0 minutes apart', () => {
    const segment = scheduleSegment(at('a', 35.31, 139.53), at('b', 35.31, 139.53))
    expect(segment.estimate).toEqual({ kind: 'walking', walkingMinutes: 0 })
    expect(segmentLabel(segment.estimate)).toBe('同一地點，不需移動')
  })

  test('keeps the Worker measurement when the app has not synced a schedule yet', () => {
    const segment = classifyScheduleSegment(at('a', 35.31, 139.53), undefined, { walkingMinutes: 12, walkingDistanceMeters: 960 })
    expect(segment).toEqual({ estimate: { kind: 'walking', walkingMinutes: 12 }, basis: 'route' })
    // Without a measurement a missing schedule stays unknown.
    expect(classifyScheduleSegment(at('a', 35.31, 139.53), undefined, undefined).estimate).toEqual({ kind: 'unknown' })
  })

  test('the preview passes the Worker measurement explicitly', () => {
    const segment = classifyScheduleSegment(
      at('a', 35.31, 139.53),
      at('b', 35.35, 139.53),
      { walkingMinutes: 60, walkingDistanceMeters: 4_800 },
    )
    expect(segment).toEqual({
      estimate: { kind: 'transit', walkingMinutes: 60, transit: { minMinutes: 15, maxMinutes: 30 } },
      basis: 'route',
    })
  })
})

describe('segmentLabel / segmentTravelMode', () => {
  test.each([
    [{ kind: 'walking', walkingMinutes: 8 } as const, '步行約 8 分鐘', 'walking'],
    [{ kind: 'either', walkingMinutes: 22, transit: { minMinutes: 15, maxMinutes: 25 } } as const,
      '大眾運輸約 15–25 分 · 步行約 22 分', 'transit'],
    [{ kind: 'transit', walkingMinutes: 60, transit: { minMinutes: 20, maxMinutes: 30 } } as const,
      '大眾運輸約 20–30 分鐘', 'transit'],
    [{ kind: 'long-distance' } as const, '長途移動，請以訂單或時刻表為準', 'transit'],
    [{ kind: 'unknown' } as const, '交通時間待確認', 'transit'],
  ])('%o', (estimate, label, mode) => {
    expect(segmentLabel(estimate)).toBe(label)
    expect(segmentTravelMode(estimate)).toBe(mode)
  })
})

describe('scheduleDayFeasibility', () => {
  test('judges a timed schedule against the previous one', () => {
    const items = [
      at('a', 35.31, 139.53, { timeMode: 'preferred', startTime: '10:00', durationMinutes: 60 }),
      at('b', 35.312, 139.53, { timeMode: 'fixed', startTime: '11:06', durationMinutes: 60 }),
    ]
    const segments = [scheduleSegment(items[0]!, items[1]!)]
    // 4 minutes of walking after an 11:00 end, 2 minutes spare.
    expect(scheduleDayFeasibility(items, segments)).toEqual([
      undefined,
      { status: 'tight', minSlack: 2, maxSlack: 2 },
    ])
  })

  test('back-to-back schedules at the same place are not late', () => {
    const items = [
      at('a', 35.31, 139.53, { timeMode: 'preferred', startTime: '10:00', durationMinutes: 60 }),
      at('b', 35.31, 139.53, { timeMode: 'fixed', startTime: '11:00', durationMinutes: 60 }),
    ]
    const verdict = scheduleDayFeasibility(items, [scheduleSegment(items[0]!, items[1]!)])[1]
    expect(verdict).toEqual({ status: 'ok', minSlack: 0, maxSlack: 0 })
    expect(feasibilityNotice(verdict, 'fixed')?.tone).toBe('muted')
  })

  test('skips a day spanning several time zones', () => {
    const a = at('a', 35.31, 139.53, { timeMode: 'preferred', startTime: '10:00' })
    const elsewhere = at('b', 35.312, 139.53, { timeMode: 'preferred', startTime: '10:30' })
    if (elsewhere.location?.status === 'resolved') elsewhere.location.place.timeZone = 'Asia/Seoul'
    // On one clock this would be an overlap (10:00–11:00, then 10:30), so the
    // time-zone skip is what yields no verdict.
    expect(scheduleDayFeasibility([a, elsewhere], [scheduleSegment(a, elsewhere)])).toEqual([undefined, undefined])
  })
})

describe('feasibilityNotice / feasibilitySummary', () => {
  test('a missed reservation is more serious than a missed preferred time', () => {
    expect(feasibilityNotice({ status: 'late', lateMinutes: 5 }, 'fixed'))
      .toEqual({ status: 'late', tone: 'danger', text: '依估計至少晚到 5 分鐘' })
    expect(feasibilityNotice({ status: 'late', lateMinutes: 5 }, 'preferred')?.tone).toBe('warn')
  })

  test.each([
    [{ status: 'overlap', overflowMinutes: 30, flexibleBetween: 0 } as const, 'danger', '與上一個行程時間重疊 30 分鐘'],
    [{ status: 'overlap', overflowMinutes: 15, flexibleBetween: 2 } as const, 'danger', '中間行程排不下，超出 15 分鐘'],
    [{ status: 'possibly-late', maxLateMinutes: 10 } as const, 'warn', '可能晚到，最多約 10 分鐘'],
    [{ status: 'tight', minSlack: 0, maxSlack: 10 } as const, 'warn', '時間很趕，餘裕約 0–10 分鐘'],
    [{ status: 'tight', minSlack: 5, maxSlack: 5 } as const, 'warn', '時間很趕，餘裕約 5 分鐘'],
    [{ status: 'ok', minSlack: 20, maxSlack: 35 } as const, 'muted', '餘裕約 20–35 分鐘'],
  ])('%o', (verdict, tone, text) => {
    expect(feasibilityNotice(verdict, 'preferred')).toMatchObject({ tone, text })
  })

  test('names an ordering problem instead of a huge overlap', () => {
    const notice = feasibilityNotice({ status: 'out-of-order' }, 'preferred')
    expect(notice).toEqual({ status: 'out-of-order', tone: 'warn', text: '開始時間早於上一個行程，順序可能要調整' })
    expect(feasibilitySummary([notice])).toEqual({ tone: 'warn', text: '1 處時間順序不一致' })
  })

  test('stays quiet for an unknown stretch or a generous gap', () => {
    expect(feasibilityNotice(undefined, 'fixed')).toBeUndefined()
    expect(feasibilityNotice({ status: 'unknown' }, 'fixed')).toBeUndefined()
    expect(feasibilityNotice({ status: 'ok', minSlack: 60, maxSlack: 80 }, 'fixed')).toBeUndefined()
  })

  test('summarizes only what needs attention, most serious first', () => {
    const notices = [
      undefined,
      feasibilityNotice({ status: 'tight', minSlack: 3, maxSlack: 8 }, 'preferred'),
      feasibilityNotice({ status: 'late', lateMinutes: 5 }, 'preferred'),
      feasibilityNotice({ status: 'tight', minSlack: 1, maxSlack: 4 }, 'preferred'),
      feasibilityNotice({ status: 'ok', minSlack: 20, maxSlack: 30 }, 'preferred'),
    ]
    expect(feasibilitySummary(notices)).toEqual({ tone: 'warn', text: '1 處預估遲到 · 2 處時間很趕' })
    expect(feasibilitySummary([...notices, feasibilityNotice({ status: 'late', lateMinutes: 1 }, 'fixed')])?.tone)
      .toBe('danger')
    expect(feasibilitySummary([undefined, notices[4]])).toBeUndefined()
  })
})
