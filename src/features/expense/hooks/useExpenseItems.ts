// src/features/expense/hooks/useExpenseItems.ts
// State machine for the by-item split mode. Owns the items[] array
// and every mutator the form needs — add / remove / setName /
// setAmount / item allocation — plus derived state (sum, hasItems).
//
// Money domain note: each row carries BOTH `amountText` (raw user
// input / OCR string) AND `amountMinor` (integer minor units, the
// thing the materializer + Firestore see). The text is preserved
// verbatim while the user types so mid-keystroke states like "12."
// don't lose the trailing dot; the minor value is rederived on each
// keystroke via `parseMoneyToMinor` and falls back to 0 on partial
// input. Consumers read `amountMinor` for math / persistence and
// `amountText` for input value binding.
//
// Why a hook, not raw useState in the form:
//   - The form was getting 6 inline mutator functions sharing the same
//     immutable-update pattern. That repetition is what hooks exist for.
//   - The reset/clear distinction matters: reset replaces the list
//     wholesale (OCR result lands), clear empties (receipt removed).
//     Naming them separately at the boundary makes the form's intent
//     obvious at the call site.
import { useState } from 'react'
import type { ExpenseItem } from '@/types'
import { parseMoneyToMinor, formatMinorForInput } from '@/utils/money'

/** Form-only superset of ExpenseItem. The `amountText` field tracks
 *  the raw input string so partial keystrokes like "12." survive the
 *  parse → reformat round-trip. `amountMinor` stays the canonical
 *  integer minor-unit value the materializer / Worker see. */
export interface FormItem extends ExpenseItem {
  amountText: string
}

export interface UseExpenseItemsResult {
  items:    FormItem[]
  hasItems: boolean
  /** sum(item.amountMinor). Phase B: positive only. Discount /
   *  surcharge lines live in the sibling Expense.adjustments[] array. */
  sum:      number
  /** Replace the whole list (e.g. OCR result lands). */
  reset:    (next: FormItem[]) => void
  /** Empty the list (called when the receipt is removed). */
  clear:    () => void
  /** Append a blank row (manual "+ 行を追加" button). */
  add:      () => void
  remove:   (i: number) => void
  setName:  (i: number, value: string) => void
  setAmount: (i: number, value: string) => void
  toggleAllocation:  (i: number, memberId: string) => void
  setAllocationShares: (i: number, memberId: string, shares: number) => void
}

function orderAllocations<T extends ExpenseItem['allocations'][number]>(
  allocations: T[],
  memberIds: string[],
): T[] {
  if (memberIds.length === 0) return allocations
  const order = new Map(memberIds.map((id, idx) => [id, idx]))
  return [...allocations].sort((a, b) =>
    (order.get(a.memberId) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(b.memberId) ?? Number.MAX_SAFE_INTEGER),
  )
}

function seedFormItems(initial: ExpenseItem[], currency: string, memberIds: string[]): FormItem[] {
  return initial.map(it => ({
    ...it,
    allocations: orderAllocations(it.allocations, memberIds),
    amountText: formatMinorForInput(it.amountMinor, currency),
  }))
}

export function useExpenseItems(
  initial: ExpenseItem[] = [],
  currency: string,
  memberIds: string[] = [],
): UseExpenseItemsResult {
  const [items, setItems] = useState<FormItem[]>(() => seedFormItems(initial, currency, memberIds))

  // No useCallback / useMemo — React Compiler auto-memoises this hook's
  // returned values and functions. reduce() over 4-20 items is trivial
  // anyway, so even without compiler memoisation the cost is negligible.
  const sum = items.reduce((s, it) => s + it.amountMinor, 0)

  const add = () => {
    // Mint id at row birth — ITEM-scope adjustments reference items by
    // id, so every row needs a stable identifier even before save.
    setItems(prev => [...prev, {
      id:          crypto.randomUUID(),
      name:        '',
      amountMinor: 0,
      amountText:  '',
      allocations: [],
    }])
  }

  const remove = (i: number) => {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  const setName = (i: number, value: string) => {
    setItems(prev => prev.map((it, idx) =>
      idx === i ? { ...it, name: value } : it,
    ))
  }

  const setAmount = (i: number, value: string) => {
    // Preserve the raw user text so "12." mid-keystroke survives; the
    // minor value rederives every keystroke and falls back to 0 when
    // the text can't be parsed (empty, "12.", "1e3", etc.).
    let minor = 0
    if (value.trim() !== '') {
      try { minor = Math.max(0, parseMoneyToMinor(value, currency)) }
      catch { minor = 0 }
    }
    setItems(prev => prev.map((it, idx) =>
      idx === i ? { ...it, amountText: value, amountMinor: minor } : it,
    ))
  }

  const toggleAllocation = (i: number, memberId: string) => {
    setItems(prev => prev.map((it, idx) => {
      if (idx !== i) return it
      const has = it.allocations.some(a => a.memberId === memberId)
      return {
        ...it,
        allocations: has
          ? it.allocations.filter(a => a.memberId !== memberId)
          : orderAllocations([...it.allocations, { memberId, shares: 1 }], memberIds),
      }
    }))
  }

  const setAllocationShares = (i: number, memberId: string, shares: number) => {
    const intShares = Number.isFinite(shares) ? Math.trunc(shares) : 1
    const nextShares = Math.max(1, Math.min(999, intShares))
    setItems(prev => prev.map((it, idx) => {
      if (idx !== i) return it
      return {
        ...it,
        allocations: it.allocations.map(a =>
          a.memberId === memberId ? { ...a, shares: nextShares } : a,
        ),
      }
    }))
  }

  const reset = (next: FormItem[]) => setItems(next)
  const clear = () => setItems([])

  return {
    items,
    hasItems: items.length > 0,
    sum,
    reset,
    clear,
    add,
    remove,
    setName,
    setAmount,
    toggleAllocation,
    setAllocationShares,
  }
}
