// src/features/expense/hooks/useExpenseItems.ts
// State machine for the by-item split mode. Owns the items[] array
// and every mutator the form needs — add / remove / setName /
// setAmount / toggleAssignee — plus derived state (sum, hasItems).
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

export interface UseExpenseItemsResult {
  items:    ExpenseItem[]
  hasItems: boolean
  /** sum(item.amount) — note: can be negative (discount lines). */
  sum:      number
  /** Replace the whole list (e.g. OCR result lands). */
  reset:    (next: ExpenseItem[]) => void
  /** Empty the list (called when the receipt is removed). */
  clear:    () => void
  /** Append a blank row (manual "+ 行を追加" button). */
  add:      () => void
  remove:   (i: number) => void
  setName:  (i: number, value: string) => void
  setAmount: (i: number, value: string) => void
  toggleAssignee: (i: number, memberId: string) => void
}

export function useExpenseItems(initial: ExpenseItem[] = []): UseExpenseItemsResult {
  const [items, setItems] = useState<ExpenseItem[]>(initial)

  // No useCallback / useMemo — React Compiler auto-memoises this hook's
  // returned values and functions. reduce() over 4-20 items is trivial
  // anyway, so even without compiler memoisation the cost is negligible.
  const sum = items.reduce((s, it) => s + it.amount, 0)

  const add = () => {
    setItems(prev => [...prev, { name: '', amount: 0, assignees: [] }])
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
    // Round to int (currency alignment) and preserve sign — discount
    // lines from OCR have negative amounts. Number('') === 0 handles
    // the "user cleared the field" path.
    const n = Math.round(Number(value) || 0)
    setItems(prev => prev.map((it, idx) =>
      idx === i ? { ...it, amount: n } : it,
    ))
  }

  const toggleAssignee = (i: number, memberId: string) => {
    setItems(prev => prev.map((it, idx) => {
      if (idx !== i) return it
      const has = it.assignees.includes(memberId)
      return {
        ...it,
        assignees: has ? it.assignees.filter(id => id !== memberId) : [...it.assignees, memberId],
      }
    }))
  }

  const reset = (next: ExpenseItem[]) => setItems(next)
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
    toggleAssignee,
  }
}
