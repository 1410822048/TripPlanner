// Tests for the P3 money-draft consolidation:
//   - renormalizeMoneyDraftForCurrency: the pure, historically bug-prone
//     currency-switch math (golden cases).
//   - useExpenseMoneyDraft: the reducer wiring — init, the single
//     switchCurrency transition, and the adjustment mutators.
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  renormalizeMoneyDraftForCurrency,
  useExpenseMoneyDraft,
  defaultForeignCurrencyFor,
  type MoneyDraftCurrencyRenormInput,
} from './useExpenseMoneyDraft'
import type { Expense } from '@/types'
import type { FormItem } from './useExpenseItems'

function item(over: Partial<FormItem> = {}): FormItem {
  return { id: 'i1', name: 'Coffee', amountMinor: 1200, amountText: '1200', allocations: [{ memberId: 'x', shares: 1 }], ...over }
}

describe('renormalizeMoneyDraftForCurrency', () => {
  it('JPY → USD: no-decimal text is kept, minor rederived under USD cents', () => {
    const input: MoneyDraftCurrencyRenormInput = {
      oldCurrency: 'JPY', nextCurrency: 'USD',
      amountText: '1200',
      items: [item({ amountMinor: 1200, amountText: '1200' })],
      adjustments: [{ id: 'a1', label: 'c', kind: 'COUPON', scope: 'EXPENSE', amountMinor: 100 }],
      adjustmentAmountText: { a1: '100' },
      customSplits: { x: '600', y: '600' },
    }
    const r = renormalizeMoneyDraftForCurrency(input)
    expect(r.amountText).toBe('1200')                 // no decimal point → unchanged
    expect(r.items[0]!.amountText).toBe('1200')
    expect(r.items[0]!.amountMinor).toBe(120000)       // USD "1200" = 120000 minor
    expect(r.adjustments[0]!.amountMinor).toBe(10000)  // USD "100" = 10000 minor
    expect(r.adjustmentAmountText).toEqual({ a1: '100' })
    expect(r.customSplits).toEqual({ x: '600', y: '600' })
  })

  it('USD → JPY: an invalid decimal is PRESERVED as text but its minor collapses to 0', () => {
    const input: MoneyDraftCurrencyRenormInput = {
      oldCurrency: 'USD', nextCurrency: 'JPY',
      amountText: '12.34',
      items: [item({ amountMinor: 1234, amountText: '12.34' })],
      adjustments: [{ id: 'a1', label: 'c', kind: 'COUPON', scope: 'EXPENSE', amountMinor: 50 }],
      adjustmentAmountText: { a1: '0.50' },
      customSplits: { x: '6.17' },
    }
    const r = renormalizeMoneyDraftForCurrency(input)
    // Text preserved so the save-time validation can reject it, not silently truncate.
    expect(r.amountText).toBe('12.34')
    expect(r.items[0]!.amountText).toBe('12.34')
    expect(r.items[0]!.amountMinor).toBe(0)            // JPY rejects decimals → safeReparse 0
    expect(r.adjustments[0]!.amountMinor).toBe(0)
    expect(r.adjustmentAmountText).toEqual({ a1: '0.50' })
    expect(r.customSplits).toEqual({ x: '6.17' })
  })

  it('USD → JPY: a clean ".00" is stripped and the minor rederived', () => {
    const r = renormalizeMoneyDraftForCurrency({
      oldCurrency: 'USD', nextCurrency: 'JPY',
      amountText: '12.00',
      items: [item({ amountMinor: 1200, amountText: '12.00' })],
      adjustments: [],
      adjustmentAmountText: {},
      customSplits: { x: '12.00' },
    })
    expect(r.amountText).toBe('12')
    expect(r.items[0]!.amountText).toBe('12')
    expect(r.items[0]!.amountMinor).toBe(12)
    expect(r.customSplits).toEqual({ x: '12' })
  })

  it('adjustment with no inflight text recovers display from the OLD-currency format', () => {
    const r = renormalizeMoneyDraftForCurrency({
      oldCurrency: 'JPY', nextCurrency: 'USD',
      amountText: '',
      items: [],
      adjustments: [{ id: 'a1', label: 'c', kind: 'COUPON', scope: 'EXPENSE', amountMinor: 300 }],
      adjustmentAmountText: {},                          // no inflight
      customSplits: {},
    })
    // recover "300" (JPY format of 300) → USD reparse 30000.
    expect(r.adjustmentAmountText).toEqual({ a1: '300' })
    expect(r.adjustments[0]!.amountMinor).toBe(30000)
  })

  it('a blank (zero, no-inflight) adjustment yields no text entry', () => {
    const r = renormalizeMoneyDraftForCurrency({
      oldCurrency: 'JPY', nextCurrency: 'USD',
      amountText: '',
      items: [],
      adjustments: [{ id: 'a1', label: '', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 0 }],
      adjustmentAmountText: {},
      customSplits: {},
    })
    expect(r.adjustmentAmountText).toEqual({})           // empty text not recorded
    expect(r.adjustments[0]!.amountMinor).toBe(0)
  })
})

describe('useExpenseMoneyDraft', () => {
  it('inits a fresh (create) draft to trip currency + empty slices', () => {
    const { result } = renderHook(() => useExpenseMoneyDraft(null, 'JPY'))
    expect(result.current.sourceCurrency).toBe('JPY')
    expect(result.current.amountText).toBe('')
    expect(result.current.adjustments).toEqual([])
    expect(result.current.lastForeignCurrency).toBe(defaultForeignCurrencyFor('JPY')) // 'USD'
  })

  it('inits a foreign edit from the source-domain mirror', () => {
    const editTarget = {
      sourceCurrency: 'USD',
      sourceAmountMinor: 4500,
      sourceAdjustments: [
        { id: 'a1', label: 'クーポン', kind: 'COUPON', scope: 'EXPENSE', sourceAmountMinor: 100 },
      ],
    } as unknown as Expense
    const { result } = renderHook(() => useExpenseMoneyDraft(editTarget, 'JPY'))
    expect(result.current.sourceCurrency).toBe('USD')
    expect(result.current.amountText).toBe('45.00')             // 4500 USD cents
    expect(result.current.adjustments).toEqual([
      { id: 'a1', label: 'クーポン', kind: 'COUPON', scope: 'EXPENSE', amountMinor: 100 },
    ])
    expect(result.current.lastForeignCurrency).toBe('USD')
  })

  it('switchCurrency is the single transition: flips currency + remembers it + renormalizes externals', () => {
    const { result } = renderHook(() => useExpenseMoneyDraft(null, 'JPY'))
    act(() => { result.current.setAmountText('1200') })

    let returned!: { items: FormItem[]; customSplits: Record<string, string> }
    act(() => {
      returned = result.current.switchCurrency('USD', {
        items: [item({ amountMinor: 1200, amountText: '1200' })],
        customSplits: { x: '600' },
      })
    })
    expect(result.current.sourceCurrency).toBe('USD')
    expect(result.current.lastForeignCurrency).toBe('USD')
    expect(result.current.amountText).toBe('1200')              // text kept, minor handled at parse
    expect(returned.items[0]!.amountMinor).toBe(120000)         // renormalized for the caller to apply
    expect(returned.customSplits).toEqual({ x: '600' })
  })

  it('switchCurrency is a no-op (returns externals verbatim) when next === current', () => {
    const { result } = renderHook(() => useExpenseMoneyDraft(null, 'JPY'))
    const external: { items: FormItem[]; customSplits: Record<string, string> } =
      { items: [item()], customSplits: { x: '5' } }
    let returned!: typeof external
    act(() => { returned = result.current.switchCurrency('JPY', external) })
    expect(returned).toBe(external)                             // same reference
    expect(result.current.sourceCurrency).toBe('JPY')
  })

  it('adjustment mutators: add → set amount (text + minor) → clear', () => {
    const { result } = renderHook(() => useExpenseMoneyDraft(null, 'JPY'))
    act(() => { result.current.addAdjustment() })
    expect(result.current.adjustments).toHaveLength(1)
    const id = result.current.adjustments[0]!.id
    expect(result.current.adjustments[0]).toMatchObject({ kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 0 })

    act(() => { result.current.setAdjustmentAmount(id, '300') })
    expect(result.current.adjustments[0]!.amountMinor).toBe(300) // JPY
    expect(result.current.adjustmentAmountValue(result.current.adjustments[0]!)).toBe('300')

    act(() => { result.current.clearAdjustments() })
    expect(result.current.adjustments).toEqual([])
  })

  it('setAdjustmentScope=ITEM falls back to the first item id; dropAdjustmentsForItem removes dangling', () => {
    const { result } = renderHook(() => useExpenseMoneyDraft(null, 'JPY'))
    act(() => { result.current.addAdjustment() })
    const id = result.current.adjustments[0]!.id

    act(() => { result.current.setAdjustmentScope(id, 'ITEM', ['item-1', 'item-2']) })
    expect(result.current.adjustments[0]).toMatchObject({ scope: 'ITEM', targetItemId: 'item-1' })

    act(() => { result.current.dropAdjustmentsForItem('item-1') })
    expect(result.current.adjustments).toEqual([])              // targeted item removed → adjustment dropped
  })
})
