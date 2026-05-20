import { describe, expect, test } from 'vitest'
import { groupBy } from './groupBy'

describe('groupBy', () => {
  test('buckets items by the derived key', () => {
    const items = [
      { id: 'a', type: 'flight' as const },
      { id: 'b', type: 'hotel'  as const },
      { id: 'c', type: 'flight' as const },
    ]
    const out = groupBy(items, x => x.type)
    expect(out.flight!.map(x => x.id)).toEqual(['a', 'c'])
    expect(out.hotel!.map(x => x.id)).toEqual(['b'])
  })

  test('preserves insertion order within each bucket', () => {
    const out = groupBy([3, 1, 4, 1, 5, 9, 2, 6, 5, 3], n => (n % 2 === 0 ? 'even' : 'odd') as 'even' | 'odd')
    expect(out.odd).toEqual([3, 1, 1, 5, 9, 5, 3])
    expect(out.even).toEqual([4, 2, 6])
  })

  test('empty input returns empty record', () => {
    expect(groupBy([], (x: number) => String(x) as string)).toEqual({})
  })

  test('single bucket when all items map to one key', () => {
    const out = groupBy([1, 2, 3], () => 'all' as const)
    expect(out.all).toEqual([1, 2, 3])
  })
})
