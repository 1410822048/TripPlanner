// Golden tests for buildExpenseFormResult — the pure form-result builder
// extracted out of ExpenseFormModal.validate(). Covers the payment-shape
// matrix the form must get right:
//   - trip-currency manual (equal / custom split)
//   - foreign-currency manual (sourceSplits)
//   - OCR / by-item (same-currency + foreign line-mode)
//   - adjustments / coupon
//   - edit existing expense (builder is create/edit agnostic)
//   - invalid / stale FX + amount-mismatch error surfaces
//
// FX cases use rate "100" (USD cents → JPY) so every conversion is exact
// and hand-verifiable: USD $X.XX (sourceMinor) → JPY = dollars × 100.
import { describe, it, expect } from 'vitest'
import {
  buildExpenseFormResult,
  type BuildExpenseFormInput,
} from './buildExpenseFormResult'
import type { ExpenseAdjustment } from '@/types'

/** Minimal valid trip-currency (JPY) equal-split draft; override per case. */
function baseInput(over: Partial<BuildExpenseFormInput> = {}): BuildExpenseFormInput {
  return {
    title:          'Lunch',
    amountText:     '3000',
    date:           '2026-06-01',
    category:       'food',
    paidBy:         'a',
    note:           '',
    sourceCurrency: 'JPY',
    items:          [],
    adjustments:    [],
    splitMode:      'equal',
    includedIds:    ['a', 'b'],
    customAmounts:  {},
    tripCurrency:   'JPY',
    memberIds:      ['a', 'b'],
    fx:             { rateDecimal: null, disabledReason: null, isError: false },
    ...over,
  }
}

/** Narrow a result to the ok branch (throws a readable error otherwise). */
function expectOk(r: ReturnType<typeof buildExpenseFormResult>) {
  if (!r.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(r.errors)}`)
  return r.input
}

function expectErr(r: ReturnType<typeof buildExpenseFormResult>) {
  if (r.ok) throw new Error(`expected errors, got ok: ${JSON.stringify(r.input)}`)
  return r.errors
}

describe('buildExpenseFormResult — trip currency manual', () => {
  it('equal split among included members', () => {
    const input = expectOk(buildExpenseFormResult(baseInput()))
    expect(input.mode).toBe('TRIP_CURRENCY')
    expect(input.currency).toBe('JPY')
    expect(input.amountMinor).toBe(3000)
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1500 },
      { memberId: 'b', amountMinor: 1500 },
    ])
    expect(input.items).toEqual([])
    expect(input.adjustments).toEqual([])
    // No FX / source fields on a same-currency expense.
    expect(input.sourceCurrency).toBeUndefined()
    expect(input.sourceAmountMinor).toBeUndefined()
    expect(input.sourceSplits).toBeUndefined()
  })

  it('equal split with an odd remainder lands on the first member', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({ amountText: '3001' })))
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1501 },
      { memberId: 'b', amountMinor: 1500 },
    ])
  })

  it('equal split drops a member who is unchecked', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({ includedIds: ['a'] })))
    expect(input.splits).toEqual([{ memberId: 'a', amountMinor: 3000 }])
  })

  it('custom split keeps per-member amounts, drops zero entries', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({
      splitMode:     'custom',
      customAmounts: { a: '1000', b: '2000' },
    })))
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1000 },
      { memberId: 'b', amountMinor: 2000 },
    ])
  })

  it('trims note; empty note becomes undefined', () => {
    expect(expectOk(buildExpenseFormResult(baseInput({ note: '  memo ' }))).note).toBe('memo')
    expect(expectOk(buildExpenseFormResult(baseInput({ note: '   ' }))).note).toBeUndefined()
  })
})

describe('buildExpenseFormResult — by-item (OCR) same currency', () => {
  const items = [
    { id: 'i1', name: 'Coffee', amountMinor: 1000, allocations: [{ memberId: 'a', shares: 1 }] },
    { id: 'i2', name: 'Cake',   amountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] },
  ]

  it('materializes per-allocation member splits from items', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({ items, amountText: '3000' })))
    expect(input.items).toEqual(items)
    expect(input.adjustments).toEqual([])
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1000 },
      { memberId: 'b', amountMinor: 2000 },
    ])
  })

  it('uses allocation shares for quantity-based item splits', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({
      items: [
        { id: 'i1', name: 'Dumplings', amountMinor: 4000, allocations: [{ memberId: 'a', shares: 3 }, { memberId: 'b', shares: 1 }] },
      ],
      amountText: '4000',
    })))
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 3000 },
      { memberId: 'b', amountMinor: 1000 },
    ])
  })

  it('applies an EXPENSE-scope coupon proportionally before splitting', () => {
    const adjustments: ExpenseAdjustment[] = [
      { id: 'adj1', label: 'クーポン', kind: 'COUPON', scope: 'EXPENSE', amountMinor: 300 },
    ]
    const input = expectOk(buildExpenseFormResult(baseInput({
      items, adjustments, amountText: '2700', // 3000 − 300 coupon
    })))
    expect(input.amountMinor).toBe(2700)
    // 300 discount apportioned 100 / 200 by item weight → item1 900, item2 1800.
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 900 },
      { memberId: 'b', amountMinor: 1800 },
    ])
    expect(input.adjustments).toEqual(adjustments)
  })
})

describe('buildExpenseFormResult — foreign currency (USD → JPY @ 100)', () => {
  const FX = { rateDecimal: '100', disabledReason: null, isError: false } as const

  it('manual equal split: emits trip splits + hidden sourceSplits', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({
      sourceCurrency: 'USD',
      amountText:     '30',          // USD $30.00 = 3000 source cents
      fx:             { ...FX },
    })))
    expect(input.mode).toBe('FOREIGN_CURRENCY')
    expect(input.currency).toBe('JPY')
    expect(input.amountMinor).toBe(3000)         // 3000 cents × rate100 / 100 = 3000 JPY
    expect(input.sourceCurrency).toBe('USD')
    expect(input.sourceAmountMinor).toBe(3000)
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1500 },
      { memberId: 'b', amountMinor: 1500 },
    ])
    expect(input.sourceSplits).toEqual([
      { memberId: 'a', sourceAmountMinor: 1500 },
      { memberId: 'b', sourceAmountMinor: 1500 },
    ])
    // Manual foreign must NOT manufacture visible items / adjustments.
    expect(input.items).toEqual([])
    expect(input.adjustments).toEqual([])
  })

  it('manual custom split converts each member share', () => {
    const input = expectOk(buildExpenseFormResult(baseInput({
      sourceCurrency: 'USD',
      amountText:     '30',
      splitMode:      'custom',
      customAmounts:  { a: '10', b: '20' }, // 1000 / 2000 source cents
      fx:             { ...FX },
    })))
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1000 },
      { memberId: 'b', amountMinor: 2000 },
    ])
    expect(input.sourceSplits).toEqual([
      { memberId: 'a', sourceAmountMinor: 1000 },
      { memberId: 'b', sourceAmountMinor: 2000 },
    ])
  })

  it('line-mode (by-item) emits both trip + source items', () => {
    const items = [
      { id: 'i1', name: 'Coffee', amountMinor: 1000, allocations: [{ memberId: 'a', shares: 1 }] }, // $10.00
      { id: 'i2', name: 'Cake',   amountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] }, // $20.00
    ]
    const input = expectOk(buildExpenseFormResult(baseInput({
      sourceCurrency: 'USD',
      items,
      amountText:     '30',
      fx:             { ...FX },
    })))
    expect(input.mode).toBe('FOREIGN_CURRENCY')
    expect(input.amountMinor).toBe(3000)
    expect(input.items).toEqual([
      { id: 'i1', name: 'Coffee', amountMinor: 1000, allocations: [{ memberId: 'a', shares: 1 }] },
      { id: 'i2', name: 'Cake',   amountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] },
    ])
    expect(input.sourceItems).toEqual([
      { id: 'i1', name: 'Coffee', sourceAmountMinor: 1000, allocations: [{ memberId: 'a', shares: 1 }] },
      { id: 'i2', name: 'Cake',   sourceAmountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] },
    ])
    expect(input.sourceAdjustments).toEqual([])
    expect(input.splits).toEqual([
      { memberId: 'a', amountMinor: 1000 },
      { memberId: 'b', amountMinor: 2000 },
    ])
  })
})

describe('buildExpenseFormResult — edit existing expense (create/edit agnostic)', () => {
  // The builder doesn't know create vs edit; an edit just feeds a populated
  // draft. Rebuilding a saved custom-split expense must reproduce its input.
  it('rebuilds a populated custom-split draft deterministically', () => {
    const draft = baseInput({
      title:         'Dinner',
      amountText:    '5000',
      paidBy:        'b',
      category:      'food',
      splitMode:     'custom',
      customAmounts: { a: '2000', b: '3000' },
    })
    const first  = expectOk(buildExpenseFormResult(draft))
    const second = expectOk(buildExpenseFormResult(draft))
    expect(first).toEqual(second)
    expect(first.title).toBe('Dinner')
    expect(first.paidBy).toBe('b')
    expect(first.splits).toEqual([
      { memberId: 'a', amountMinor: 2000 },
      { memberId: 'b', amountMinor: 3000 },
    ])
  })
})

describe('buildExpenseFormResult — base field validation', () => {
  it('requires a title', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ title: '   ' }))).title).toBe('請輸入標題')
  })

  it('rejects decimals for a zero-fraction currency (JPY)', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ amountText: '12.34' }))).amount)
      .toBe('JPY は小数を入力できません')
  })

  it('rejects a non-positive amount', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ amountText: '0' }))).amount)
      .toBe('金額は0より大きく入力してください')
  })

  it('rejects an empty amount', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ amountText: '' }))).amount)
      .toBe('金額を入力してください')
  })

  it('requires a date', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ date: '' }))).date).toBe('請選擇日期')
  })

  it('requires a payer', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ paidBy: '' }))).paidBy).toBe('請選擇付款人')
  })
})

describe('buildExpenseFormResult — foreign FX gate (no rate yet)', () => {
  const foreign = (fx: BuildExpenseFormInput['fx']) =>
    buildExpenseFormResult(baseInput({ sourceCurrency: 'USD', amountText: '30', fx }))

  it('future-date reason', () => {
    expect(expectErr(foreign({ rateDecimal: null, disabledReason: 'future-date', isError: false })).amount)
      .toBe('未来日付は換算できません')
  })

  it('invalid-input reason', () => {
    expect(expectErr(foreign({ rateDecimal: null, disabledReason: 'invalid-input', isError: false })).amount)
      .toBe('通貨または日付を確認してください')
  })

  it('hard error reason', () => {
    expect(expectErr(foreign({ rateDecimal: null, disabledReason: null, isError: true })).amount)
      .toBe('換算レートを取得できません。再試行してください')
  })

  it('still-loading reason (no rate, no disabledReason, not error)', () => {
    expect(expectErr(foreign({ rateDecimal: null, disabledReason: null, isError: false })).amount)
      .toBe('換算レートを取得中です。少し待ってから再送信してください')
  })

  it('does not gate when a rate is present', () => {
    expect(buildExpenseFormResult(baseInput({
      sourceCurrency: 'USD', amountText: '30',
      fx: { rateDecimal: '100', disabledReason: null, isError: false },
    })).ok).toBe(true)
  })
})

describe('buildExpenseFormResult — by-item validation surfaces', () => {
  const ok = { id: 'i1', name: 'Coffee', amountMinor: 1000, allocations: [{ memberId: 'a', shares: 1 }] }

  it('flags an item with no allocation member', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({
      items: [{ ...ok, allocations: [] }], amountText: '1000',
    }))).items).toBe('行 1：分担者を選択してください')
  })

  it('flags a blank item name', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({
      items: [{ ...ok, name: '  ' }], amountText: '1000',
    }))).items).toBe('行 1：項目名を入力してください')
  })

  it('flags a zero-amount item', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({
      items: [{ ...ok, amountMinor: 0 }], amountText: '1000',
    }))).items).toBe('行 1：金額を入力してください')
  })

  it('flags a blank adjustment label', () => {
    const adjustments: ExpenseAdjustment[] = [
      { id: 'adj1', label: '  ', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
    ]
    expect(expectErr(buildExpenseFormResult(baseInput({
      items: [ok], adjustments, amountText: '900',
    }))).items).toBe('調整 1: ラベルを入力してください')
  })

  it('flags a zero-amount adjustment', () => {
    const adjustments: ExpenseAdjustment[] = [
      { id: 'adj1', label: '値引', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 0 },
    ]
    expect(expectErr(buildExpenseFormResult(baseInput({
      items: [ok], adjustments, amountText: '1000',
    }))).items).toBe('調整 1: 金額を入力してください')
  })

  it('flags an items/total mismatch', () => {
    const errors = expectErr(buildExpenseFormResult(baseInput({
      items: [ok], amountText: '2000', // 1000 of items ≠ 2000 bill
    })))
    expect(errors.items).toContain('一致しません')
  })

  it('surfaces a materializer error (ITEM discount drives the item below zero)', () => {
    const items = [
      { id: 'i1', name: 'Coffee', amountMinor: 100,  allocations: [{ memberId: 'a', shares: 1 }] },
      { id: 'i2', name: 'Cake',   amountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] },
    ]
    const adjustments: ExpenseAdjustment[] = [
      { id: 'adj1', label: '値引', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 200, targetItemId: 'i1' },
    ]
    const errors = expectErr(buildExpenseFormResult(baseInput({
      items, adjustments, amountText: '1900', // 2100 − 200 = 1900, so itemsDiff passes
    })))
    expect(errors.items).toBe('割引が項目の金額を超えています')
  })
})

describe('buildExpenseFormResult — split validation surfaces', () => {
  it('equal: requires at least one included member', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({ includedIds: [] }))).splits)
      .toBe('至少選擇一位分攤人')
  })

  it('custom: requires at least one positive share', () => {
    expect(expectErr(buildExpenseFormResult(baseInput({
      splitMode: 'custom', customAmounts: {},
    }))).splits).toBe('至少需有一人分攤')
  })

  it('custom: rejects a sum that does not equal the total', () => {
    const errors = expectErr(buildExpenseFormResult(baseInput({
      splitMode: 'custom', customAmounts: { a: '1000', b: '1000' }, amountText: '3000',
    })))
    expect(errors.splits).toContain('分攤總和需等於')
  })
})

describe('buildExpenseFormResult — foreign conversion error surface', () => {
  it('surfaces the friendly over-discount copy for a foreign ITEM discount', () => {
    const items = [
      { id: 'i1', name: 'Coffee', amountMinor: 100,  allocations: [{ memberId: 'a', shares: 1 }] }, // $1.00
      { id: 'i2', name: 'Cake',   amountMinor: 2000, allocations: [{ memberId: 'b', shares: 1 }] }, // $20.00
    ]
    const adjustments: ExpenseAdjustment[] = [
      { id: 'adj1', label: '値引', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 200, targetItemId: 'i1' },
    ]
    const errors = expectErr(buildExpenseFormResult(baseInput({
      sourceCurrency: 'USD',
      items, adjustments,
      amountText: '19', // $19.00 = 1900 cents = 2100 − 200, itemsDiff passes
      fx: { rateDecimal: '100', disabledReason: null, isError: false },
    })))
    expect(errors.items).toBe('割引が項目の金額を超えています')
  })
})
