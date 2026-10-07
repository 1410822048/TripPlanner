// Regression lock: Zod 4 keeps `.default()` values through `.partial()`.
// A default on CreateTripSchema.currency made every trip edit that didn't
// touch the currency write `currency: 'TWD'`, silently relabelling JPY/USD
// ledgers. Update schemas must never add keys the caller didn't send.
import { describe, expect, it } from 'vitest'
import { UpdateTripSchema } from './trip'
import { UpdateExpenseSchema } from './expense'

describe('partial update schemas never inject defaults', () => {
  it('UpdateTripSchema: a rename stays a rename', () => {
    expect(UpdateTripSchema.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' })
    expect(UpdateTripSchema.parse({ startDate: '2026-11-01' })).toEqual({ startDate: '2026-11-01' })
  })

  it('UpdateExpenseSchema: a text-only patch carries no currency', () => {
    const parsed = UpdateExpenseSchema.parse({ title: 'Lunch' })
    expect(parsed).toEqual({ title: 'Lunch' })
    expect('currency' in parsed).toBe(false)
  })

  it('every key UpdateTripSchema can emit was sent by the caller', () => {
    for (const key of Object.keys(UpdateTripSchema.shape)) {
      expect(Object.keys(UpdateTripSchema.parse({}))).not.toContain(key)
    }
  })
})
