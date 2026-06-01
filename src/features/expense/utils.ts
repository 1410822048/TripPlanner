// src/features/expense/utils.ts
import type { Expense, ExpenseSplit } from '@/types'
import { currencyFractionDigits, parseMoneyToMinor } from '@/utils/money'

/** Parse a money text under a currency without throwing. Empty /
 *  unparseable / negative inputs collapse to 0.
 *
 *  Why this exists (vs. calling parseMoneyToMinor directly): the form
 *  modal needs to repeatedly reparse user-input text whenever the source
 *  currency changes (toggle / picker / OCR auto-detect). Throwing inside
 *  a render path would be a footgun — partial keystrokes like "12." are
 *  legitimate mid-edit states the parser rejects, and we want those to
 *  silently fall back to 0 rather than blow up the form. Centralising
 *  the try/catch + clamp here keeps every reparse callsite consistent.
 *
 *  Used by:
 *    - ExpenseFormModal's safeParseMinor (per-keystroke amount preview)
 *    - ExpenseFormModal's setSourceCurrency (reparse items/adjustments
 *      against a freshly-chosen source currency) */
export function safeReparseMoney(text: string, currency: string): number {
  if (text.trim() === '') return 0
  try { return Math.max(0, parseMoneyToMinor(text, currency)) }
  catch { return 0 }
}

/**
 * Normalize display text after switching the currency attached to an
 * existing controlled money input. This is intentionally conservative:
 * only zeros that are no longer representable in the target currency are
 * stripped. Non-zero fractional digits are preserved so validation can
 * reject them instead of silently rounding or truncating user input.
 */
export function normalizeMoneyTextForCurrency(text: string, currency: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return text

  const match = /^(-?[\d,\s_\u00A0\u202F\uFF0C]+)(?:\.(\d*))$/.exec(trimmed)
  if (!match) return text

  const whole = match[1]!
  const fraction = match[2] ?? ''
  const targetDigits = currencyFractionDigits(currency)

  if (targetDigits === 0 && fraction.length === 0) return whole
  if (fraction.length <= targetDigits) return text

  const excess = fraction.slice(targetDigits)
  if (!/^0+$/.test(excess)) return text

  const kept = fraction.slice(0, targetDigits)
  return targetDigits === 0 ? whole : `${whole}.${kept}`
}

/**
 * 均等分攤 — 餘數逐一分給前面的成員,保證 sum === totalMinor。
 * 回傳符合 Firestore schema 的 ExpenseSplit[]。
 *
 * 支援正、負、零 totalMinor:
 *   - 正(購買、共享餐) → 每人正分攤
 *   - 負(收據裡的 折扣 / 回饋 / 退費 line) → 每人負分攤(金額相反符號)
 *   - 零 → 不分攤,回傳 []
 *
 * 前置條件:`totalMinor` 已是整數最小貨幣單位(JPY=圓、USD=分)。
 * 用 Math.trunc + 餘數補位確保 sum(amountMinor) === totalMinor 對正負皆成立。
 */
export function splitEqually(totalMinor: number, memberIds: string[]): ExpenseSplit[] {
  if (!memberIds.length) return []
  const intTotal = Math.round(totalMinor)
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
    memberId:    id,
    amountMinor: sign * (base + (i < rem ? 1 : 0)),
  }))
}

/** 依據 splits 判斷分攤方式摘要(用於列表顯示) */
export function splitSummary(e: Expense, totalMembers: number): string {
  const nonZero = e.splits.filter(s => s.amountMinor > 0)
  const first = nonZero[0]
  if (!first) return '—'
  const allEqual = nonZero.every(s => Math.abs(s.amountMinor - first.amountMinor) <= 1)
  if (allEqual) {
    return nonZero.length === totalMembers
      ? `${nonZero.length}人均等`
      : `${nonZero.length}人で均等`
  }
  return 'カスタム分担'
}
