// src/features/expense/utils.ts
import type { Expense, ExpenseSplit } from '@/types'

/**
 * 均等分攤 — 餘數逐一分給前面的成員，保證 sum === total。
 * 回傳符合 Firestore schema 的 ExpenseSplit[]。
 *
 * 前置條件：`total` 以最小貨幣單位計（JPY=圓、USD=分），必須是整數。
 * 非整數輸入會先被 `Math.round` 正規化，以確保 base×n + remainder === total。
 */
export function splitEqually(total: number, memberIds: string[]): ExpenseSplit[] {
  if (!memberIds.length || total <= 0) return []
  const intTotal = Math.round(total)
  const base = Math.floor(intTotal / memberIds.length)
  const remainder = intTotal - base * memberIds.length
  return memberIds.map((id, i) => ({
    memberId: id,
    amount:   base + (i < remainder ? 1 : 0),
  }))
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
