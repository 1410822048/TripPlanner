// stripEmpty owns the boundary between form state and Firestore writes.
// The semantic invariants:
//   - '' / undefined  -> dropped (avoid Firestore index noise)
//   - null            -> preserved (semantic clearing)
//   - 0 / false       -> preserved (valid falsy values)
// Regressions here silently break "user typed something, then cleared
// it -- did we keep the cleared state or revert?" -- both directions
// matter and have been broken before.
import { describe, expect, test } from 'vitest'
import { stripEmpty } from './stripEmpty'

describe('stripEmpty', () => {
  test('drops undefined values', () => {
    expect(stripEmpty({ a: 1, b: undefined, c: 'hi' })).toEqual({ a: 1, c: 'hi' })
  })

  test('drops empty strings', () => {
    expect(stripEmpty({ a: 'hi', b: '', c: 'x' })).toEqual({ a: 'hi', c: 'x' })
  })

  test('preserves null (semantic clearing)', () => {
    expect(stripEmpty({ a: 1, b: null })).toEqual({ a: 1, b: null })
  })

  test('preserves falsy-but-meaningful values', () => {
    expect(stripEmpty({ n: 0, f: false, s: 'kept' })).toEqual({ n: 0, f: false, s: 'kept' })
  })

  test('preserves nested objects untouched (single-level strip)', () => {
    const nested = { inner: { empty: '' } }
    expect(stripEmpty({ a: nested, b: '' })).toEqual({ a: nested })
  })

  test('preserves arrays', () => {
    expect(stripEmpty({ a: [], b: [1, 2], c: '' })).toEqual({ a: [], b: [1, 2] })
  })

  test('empty input returns empty object', () => {
    expect(stripEmpty({})).toEqual({})
  })

  test('all-empty input returns empty object', () => {
    expect(stripEmpty({ a: '', b: undefined })).toEqual({})
  })
})
