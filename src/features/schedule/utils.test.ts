// Pin `order` as the within-day single source of truth. startTime remains a
// displayed user constraint and must never silently override route order.
import { describe, expect, test } from 'vitest'
import { groupByDate } from './utils'
import type { Schedule } from '@/types'

function s(over: Partial<Schedule>): Schedule {
  // Minimal Schedule skeleton; only fields the helper reads are required.
  return {
    id:        'x',
    tripId:    't',
    title:     '',
    date:      '2026-05-15',
    order:     0,
    category:  'activity',
    timeMode:  'flexible',
    durationMinutes: 60,
    memberIds: ['u'],
    createdBy: 'u',
    updatedBy: 'u',
    createdAt: { toMillis: () => 0 } as Schedule['createdAt'],
    updatedAt: { toMillis: () => 0 } as Schedule['updatedAt'],
    ...over,
  }
}

describe('groupByDate', () => {
  test('groups items by date string', () => {
    const out = groupByDate([
      s({ id: 'a', date: '2026-05-15' }),
      s({ id: 'b', date: '2026-05-16' }),
      s({ id: 'c', date: '2026-05-15' }),
    ])
    expect(Object.keys(out).sort()).toEqual(['2026-05-15', '2026-05-16'])
    expect(out['2026-05-15']!.map(x => x.id).sort()).toEqual(['a', 'c'])
    expect(out['2026-05-16']!.map(x => x.id)).toEqual(['b'])
  })

  test('within-day: order is the only sort source, even when times differ', () => {
    const out = groupByDate([
      s({ id: 'noon',  order: 2, startTime: '12:00' }),
      s({ id: 'morn',  order: 1, startTime: '08:00' }),
      s({ id: 'eve',   order: 0, startTime: '18:00' }),
    ])
    expect(out['2026-05-15']!.map(x => x.id)).toEqual(['eve', 'morn', 'noon'])
  })

  test('within-day: untimed items stay at their explicit order', () => {
    const out = groupByDate([
      s({ id: 'untimed', order: 1 }),
      s({ id: 'timed',   order: 0, startTime: '10:00' }),
    ])
    expect(out['2026-05-15']!.map(x => x.id)).toEqual(['timed', 'untimed'])
  })

  test('within-day: untimed items fall back to manual order', () => {
    const out = groupByDate([
      s({ id: 'second', order: 2 }),
      s({ id: 'first',  order: 1 }),
      s({ id: 'third',  order: 3 }),
    ])
    expect(out['2026-05-15']!.map(x => x.id)).toEqual(['first', 'second', 'third'])
  })

  test('empty input returns empty record', () => {
    expect(groupByDate([])).toEqual({})
  })
})
