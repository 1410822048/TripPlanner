// src/features/expense/utils.ts
import type { Expense, ExpenseItem, ExpenseSplit } from '@/types'

/**
 * 均等分攤 — 餘數逐一分給前面的成員，保證 sum === total。
 * 回傳符合 Firestore schema 的 ExpenseSplit[]。
 *
 * 支援正、負、零 total：
 *   - 正(購買、共享餐) → 每人正分攤
 *   - 負(收據裡的 折扣 / 回饋 / 退費 line) → 每人負分攤（金額相反符號）
 *   - 零 → 不分攤，回傳 []
 *
 * 前置條件：`total` 以最小貨幣單位計（JPY=圓、USD=分），整數化在內部處理。
 * 用 Math.trunc + 餘數補位確保 sum(amount) === intTotal 對正負皆成立。
 */
export function splitEqually(total: number, memberIds: string[]): ExpenseSplit[] {
  if (!memberIds.length) return []
  const intTotal = Math.round(total)
  if (intTotal === 0) return []
  const sign     = intTotal < 0 ? -1 : 1
  const absTotal = Math.abs(intTotal)
  const base     = Math.floor(absTotal / memberIds.length)
  const rem      = absTotal - base * memberIds.length
  // Sign multiplication preserves total sign while distributing remainder
  // to the first `rem` members. Math.floor of positive is safe; doing the
  // arithmetic on abs avoids JS's "floor of negative rounds away from
  // zero" gotcha that would mis-split (-7 / 2) into [-4, -4] = -8.
  return memberIds.map((id, i) => ({
    memberId: id,
    amount:   sign * (base + (i < rem ? 1 : 0)),
  }))
}

/**
 * Aggregate by-item assignments into per-member splits. Each item's
 * amount is divided equally across its assignees; per-item remainders
 * land on the first assignees so total stays exact. Members who weren't
 * assigned anything are omitted from the result.
 *
 * Precondition: every item has ≥1 assignee. Caller (form validation)
 * enforces this — items with empty assignees here are skipped silently.
 */
export function splitsFromItems(items: ExpenseItem[]): ExpenseSplit[] {
  // Accumulator over all items
  const totals = new Map<string, number>()
  for (const item of items) {
    if (item.assignees.length === 0) continue
    const per = splitEqually(item.amount, item.assignees)
    for (const { memberId, amount } of per) {
      totals.set(memberId, (totals.get(memberId) ?? 0) + amount)
    }
  }
  return [...totals.entries()].map(([memberId, amount]) => ({ memberId, amount }))
}

/** 依據 splits 判斷分攤方式摘要（用於列表顯示） */
export function splitSummary(e: Expense, totalMembers: number): string {
  const nonZero = e.splits.filter(s => s.amount > 0)
  const first = nonZero[0]
  if (!first) return '—'
  const allEqual = nonZero.every(s => Math.abs(s.amount - first.amount) <= 1)
  if (allEqual) {
    return nonZero.length === totalMembers
      ? `${nonZero.length}人均等`
      : `${nonZero.length}人で均等`
  }
  return 'カスタム分担'
}
