import { describe, it, expect } from 'vitest'
import {
  moneyErrorMessage,
  normalizeMoneyTextForCurrency,
  parsePositiveMoneyToMinorResult,
  safeReparseMoney,
  splitEqually,
  splitSummary,
} from './utils'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'

function mkExpense(splits: Array<{ memberId: string; amountMinor: number }>): Expense {
  return {
    id: 'e1', tripId: 'demo', title: 't',
    amountMinor: splits.reduce((s, x) => s + x.amountMinor, 0),
    currency: 'JPY', category: 'food', paidBy: 'm1', splits,
    date: '2026-05-01', adjustments: [],
    memberIds: ['m1', 'm2', 'm3', 'm4'], createdBy: 'u', updatedBy: 'u', createdAt: TS, updatedAt: TS,
    deletedAt: null, receiptPurgedAt: null,
  }
}

describe('splitEqually', () => {
  it('splits evenly when divisible', () => {
    const r = splitEqually(1000, ['a', 'b', 'c', 'd'])
    expect(r.map(s => s.amountMinor)).toEqual([250, 250, 250, 250])
    expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(1000)
  })

  it('distributes remainder to earliest members so sum === total', () => {
    // 1001 / 4 = 250.25 → base 250, remainder 1
    const r = splitEqually(1001, ['a', 'b', 'c', 'd'])
    expect(r.map(s => s.amountMinor)).toEqual([251, 250, 250, 250])
    expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(1001)
  })

  it('rounds non-integer totals before splitting', () => {
    // Float input shouldn't drift sum — this guards the pre-Phase-2 regression.
    const r = splitEqually(100.7, ['a', 'b', 'c'])
    // Math.round(100.7) = 101; 101/3 → base 33, rem 2
    expect(r.map(s => s.amountMinor)).toEqual([34, 34, 33])
    expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(101)
  })

  it('returns empty when total is 0 or no members', () => {
    expect(splitEqually(0, ['a'])).toEqual([])
    expect(splitEqually(100, [])).toEqual([])
  })

  it('sum always equals total across many inputs', () => {
    for (const total of [1, 7, 100, 333, 1000, 9_999]) {
      for (const n of [1, 2, 3, 4, 5, 7]) {
        const ids = Array.from({ length: n }, (_, i) => `m${i}`)
        const r = splitEqually(total, ids)
        expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(total)
      }
    }
  })

  it('handles negative totals — settlement/adjustment apportionment', () => {
    // -6 / 2 → each -3. Still exercised by the materializer's
    // EXPENSE-scope apportionment path; the materializer itself uses
    // the same splitEqually copy (packages/expense-materialize).
    const r = splitEqually(-6, ['a', 'b'])
    expect(r.map(s => s.amountMinor)).toEqual([-3, -3])
    expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(-6)
  })

  it('distributes negative remainder correctly', () => {
    // -7 / 2 → base 3, rem 1 → [-4, -3], sum -7 (NOT JS's naive Math.floor(-7/2) = -4 trap)
    const r = splitEqually(-7, ['a', 'b'])
    expect(r.map(s => s.amountMinor)).toEqual([-4, -3])
    expect(r.reduce((s, x) => s + x.amountMinor, 0)).toBe(-7)
  })
})

describe('splitSummary', () => {
  it('reports N人均等 when all N members share equally', () => {
    const e = mkExpense([
      { memberId: 'm1', amountMinor: 1000 },
      { memberId: 'm2', amountMinor: 1000 },
      { memberId: 'm3', amountMinor: 1000 },
      { memberId: 'm4', amountMinor: 1000 },
    ])
    expect(splitSummary(e, 4)).toBe('4人均等')
  })

  it('tolerates ±1 rounding residual as equal split', () => {
    // Remainder from splitEqually(1001, 3) = [334, 334, 333]
    const e = mkExpense([
      { memberId: 'm1', amountMinor: 334 },
      { memberId: 'm2', amountMinor: 334 },
      { memberId: 'm3', amountMinor: 333 },
    ])
    expect(splitSummary(e, 3)).toBe('3人均等')
  })

  it('reports 人で均等 when subset of members split equally', () => {
    const e = mkExpense([
      { memberId: 'm1', amountMinor: 500 },
      { memberId: 'm2', amountMinor: 500 },
    ])
    expect(splitSummary(e, 4)).toBe('2 人均分')
  })

  it('reports カスタム分担 when amounts diverge beyond ±1', () => {
    const e = mkExpense([
      { memberId: 'm1', amountMinor: 700 },
      { memberId: 'm2', amountMinor: 300 },
    ])
    expect(splitSummary(e, 2)).toBe('自訂分攤')
  })

  it('returns — when every split is zero', () => {
    const e = mkExpense([
      { memberId: 'm1', amountMinor: 0 },
      { memberId: 'm2', amountMinor: 0 },
    ])
    expect(splitSummary(e, 2)).toBe('—')
  })
})

describe('safeReparseMoney', () => {
  // The motivating bug (Phase 3c P2): the form stored each item's
  // amountMinor as React state, parsed at typing time with the THEN-
  // current source currency. After the user toggled foreign / picked a
  // new currency, the displayed amountText stayed valid but the stored
  // minor unit was stale — itemsDiff / FX preview silently used the old
  // canonical value. ExpenseFormModal's setSourceCurrency now routes
  // every item / adjustment through this function with the NEW currency.
  // These tests pin the cross-currency invariant the bug violated.
  it('reparses the same display digits to different minor values across currencies', () => {
    // "1200" under JPY (0 fraction digits) reads as ¥1,200 → 1200 minor
    expect(safeReparseMoney('1200', 'JPY')).toBe(1200)
    // Same "1200" under USD (2 fraction digits) reads as $1,200.00 →
    // 120000 minor. This delta is exactly what the P2 fix exists to keep
    // in sync after a currency switch.
    expect(safeReparseMoney('1200', 'USD')).toBe(120000)
  })

  it('parses fractional input correctly under the new currency', () => {
    // Inflight text "12.34" under USD → $12.34 → 1234 minor
    expect(safeReparseMoney('12.34', 'USD')).toBe(1234)
  })

  it('returns 0 for empty / whitespace text without throwing', () => {
    expect(safeReparseMoney('',     'JPY')).toBe(0)
    expect(safeReparseMoney('   ',  'USD')).toBe(0)
  })

  it('returns 0 for partial / malformed input rather than throwing', () => {
    // Mid-keystroke "12." would throw inside parseMoneyToMinor; the
    // helper must clamp to 0 so the form never sees NaN. JPY rejects
    // any decimal at all — same clamp behaviour.
    expect(safeReparseMoney('12.',   'USD')).toBe(0)
    expect(safeReparseMoney('12.34', 'JPY')).toBe(0)
    expect(safeReparseMoney('abc',   'USD')).toBe(0)
  })

  it('never returns a negative value', () => {
    // parseMoneyToMinor itself accepts "-1" → -100 minor; the form's
    // contract is "no negative amounts" — adjustments encode the sign
    // via kind, items + total are positive. Max(0, …) enforces that.
    expect(safeReparseMoney('-1',     'USD')).toBe(0)
    expect(safeReparseMoney('-99.99', 'USD')).toBe(0)
  })
})

describe('parsePositiveMoneyToMinorResult / moneyErrorMessage', () => {
  it('keeps parser reasons instead of collapsing them into empty input', () => {
    expect(parsePositiveMoneyToMinorResult('12.34', 'JPY')).toEqual({
      ok: false,
      reason: 'DECIMALS_FORBIDDEN',
    })
    expect(moneyErrorMessage('DECIMALS_FORBIDDEN', 'JPY')).toBe('JPY 不支援小數')
  })

  it('treats zero and negative totals as UI-level non-positive errors', () => {
    expect(parsePositiveMoneyToMinorResult('0', 'USD')).toEqual({
      ok: false,
      reason: 'NON_POSITIVE',
    })
    expect(parsePositiveMoneyToMinorResult('-1', 'USD')).toEqual({
      ok: false,
      reason: 'NON_POSITIVE',
    })
    expect(moneyErrorMessage('NON_POSITIVE', 'USD')).toBe('金額必須大於 0')
  })

  it('returns positive minor units for valid input', () => {
    expect(parsePositiveMoneyToMinorResult('12.34', 'USD')).toEqual({
      ok: true,
      value: 1234,
    })
  })
})

describe('normalizeMoneyTextForCurrency', () => {
  it('strips zero-only decimals when switching to a zero-fraction currency', () => {
    expect(normalizeMoneyTextForCurrency('888.00', 'JPY')).toBe('888')
    expect(normalizeMoneyTextForCurrency('888.0', 'JPY')).toBe('888')
    expect(normalizeMoneyTextForCurrency('888.', 'JPY')).toBe('888')
    expect(normalizeMoneyTextForCurrency('1,234.00', 'JPY')).toBe('1,234')
  })

  it('keeps non-zero decimals so JPY validation can reject them', () => {
    expect(normalizeMoneyTextForCurrency('888.34', 'JPY')).toBe('888.34')
  })

  it('trims only excess zero precision for currencies with decimals', () => {
    expect(normalizeMoneyTextForCurrency('12.300', 'USD')).toBe('12.30')
    expect(normalizeMoneyTextForCurrency('12.345', 'USD')).toBe('12.345')
    expect(normalizeMoneyTextForCurrency('12.3', 'USD')).toBe('12.3')
  })

  it('leaves malformed and empty text unchanged', () => {
    expect(normalizeMoneyTextForCurrency('', 'JPY')).toBe('')
    expect(normalizeMoneyTextForCurrency('abc.00', 'JPY')).toBe('abc.00')
  })
})
