// src/features/expense/components/settlementOrphanCopy.ts
// Orphan-reason presentation vocabulary shared by the settlement history
// banner (aggregate explanation) and the per-row orphan chip. The reason
// classification itself is computed in services/settlement.ts
// (buildOrphanReasonMap / classifyOrphan); this module is purely the
// 繁體中文 copy + label mapping the UI renders for each reason. It lives
// here (not inside SettlementRow / SettlementHistory) because both render
// orphan copy and a one-directional component import would otherwise form
// a cycle between the two.
import type { OrphanReason } from '../services/settlement'

/**
 * 整段警告 banner 的說明文案。單一 reason → 對應文案;多 reason 時
 * `orphanReasonExplain` 改走 generic「展開逐筆確認」提示。
 */
export const ORPHAN_REASON_COPY: Record<OrphanReason, string> = {
  OVERPAYMENT:     '屬於過度支付。多出的金額視為對方的預存金,無需額外操作。',
  EXPENSE_DELETED: '對應的費用已被刪除。如不需要可從下方刪除這筆清算。',
  MIXED:           '同時包含過度支付與已刪除費用兩種情況。可逐筆檢查並刪除。',
  UNKNOWN:         '找不到對應的費用。如不需要可從下方刪除這筆清算。',
}

/**
 * 每列 orphan chip 的短標籤(2-3 字),擠在金額 + 刪除鈕旁邊也放得下。
 * 語言對齊 ORPHAN_REASON_COPY(繁中);完整文案靠 title hover 帶出。
 */
export const ORPHAN_REASON_LABEL: Record<OrphanReason, string> = {
  OVERPAYMENT:     '多付',
  EXPENSE_DELETED: '已刪除',
  MIXED:           '混合',
  UNKNOWN:         '不明',
}

/**
 * 依 orphan reason buckets 選 banner 說明行。
 * 單一 reason → 該 reason 文案;多 reason → generic「展開逐筆確認」。
 */
export function orphanReasonExplain(byReason: Partial<Record<OrphanReason, number>>): string {
  const reasons = (Object.keys(byReason) as OrphanReason[]).filter(k => (byReason[k] ?? 0) > 0)
  if (reasons.length === 0) return ''
  if (reasons.length > 1) return '原因不一,可展開下方記錄逐筆確認。'
  return ORPHAN_REASON_COPY[reasons[0]!]
}
