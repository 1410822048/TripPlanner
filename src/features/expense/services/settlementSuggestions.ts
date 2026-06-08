// src/features/expense/services/settlementSuggestions.ts
// UI 向け settlement suggestion 層 — 從 settlement.ts 拆出來純為可讀性
// (debt-edge 主算法 + orphan 時序 replay 留在那邊)。純函式,無 side
// effect,不影響 Worker contract:
//
//   computeSettlements(pairwise)          normalized debt edges → 平鋪 transfer
//                                         list(Worker create-gate 鏡像的 lean
//                                         shape)。
//   computeSettlementSuggestions({...})   同一份 list,對 partially-cleared
//                                         pair 疊上 settled-vs-owed 顯示 context
//                                         (應清算 / 已清算 / 還差)。
//
// 兩者都吃 `computeBalancesFull` 已回傳的 `{ pairwise, gross, applied }`,從不
// 自行重算 pairwise debt,讓 UI 建議與 Worker reject 語意保持 lockstep。
// `Settlement`(transfer 基本 shape)留在 settlement.ts 當 debt-edge 主域型別。
import { SETTLEMENT_EPS } from '@tripmate/settlement-core'
import type { Settlement } from './settlement'

/**
 * 把 normalized remaining debt edges 平鋪成 settlement suggestion list。
 *
 * 每條 `pairwise[from][to] > 0` 邊各自產生一筆建議,**不做 multi-hop
 * 收斂**。A→B=10、B→C=10 會建議兩筆(不會合成 A→C)。
 *
 * `pair-based suggestions intentionally prioritize Worker-verifiable
 * semantics over minimum-transfer optimization`:
 *   - UI 顯示的每一筆建議,Worker 寫入時都對得到一條真實的 pair debt
 *     edge,`amount <= remaining[from][to]` 一定成立,絕無「UI 建議的
 *     金額被 Worker 拒」的 drift。
 *   - 代價是某些長鏈情境會多列幾筆(例 3-人非平衡 cycle A→B=10、
 *     B→C=10、C→A=10:這版產 3 筆,舊版 net-greedy 產 0 筆)。對使用
 *     者來說每筆都連得到具體 expense,可審計性 > 條數最小化。
 *
 * 排序:by from then to,讓輸出在跨 reload / 跨 trip 之間穩定。
 */
export function computeSettlements(
  pairwise: Record<string, Record<string, number>>,
): Settlement[] {
  const out: Settlement[] = []
  for (const from of Object.keys(pairwise).sort()) {
    const row = pairwise[from]!
    for (const to of Object.keys(row).sort()) {
      const amount = row[to] ?? 0
      if (amount > SETTLEMENT_EPS) {
        out.push({ fromId: from, toId: to, amountMinor: Math.round(amount) })
      }
    }
  }
  return out
}

// ─── Enriched suggestions (UI display metadata) ───────────────────

/** Settled-vs-owed breakdown for a partially-cleared pair, computed in the
 *  domain so the UI just renders it. All integer minor units. */
export interface SettledContext {
  /** Total `from` owes `to` from expenses, before settlement (應清算). */
  grossMinor:     number
  /** How much of that gross settlements have already cleared (已清算). */
  appliedMinor:   number
  /** Outstanding remainder (還差) — equals the suggestion's amountMinor. */
  remainingMinor: number
}

/** A settlement suggestion plus optional display metadata. */
export interface SettlementSuggestion extends Settlement {
  /** Present IFF this pair was PARTIALLY settled (applied > 0) AND its
   *  directional `gross − applied` reconciles with the post-normalization
   *  net `amountMinor` — i.e. no opposite-direction debt was cancelled away.
   *  When it doesn't reconcile, the gross/applied figures wouldn't add up to
   *  the shown amount, so the context is omitted rather than rendered as a
   *  number that doesn't balance. This "is the breakdown mathematically
   *  explicable?" decision is settlement-domain knowledge, kept here so the
   *  UI only renders. */
  settledContext?: SettledContext
}

/**
 * UI-facing suggestion list: `computeSettlements(pairwise)` enriched with the
 * settled-vs-owed context for partially-cleared pairs (so a bumped-after-
 * settlement expense reads clearly: 應清算 / 已清算 / 還差).
 *
 * Deliberately SEPARATE from `computeSettlements`: that one stays lean
 * (pairwise-only, the exact shape the Worker create-gate mirrors) for simple
 * callers; this one takes the richer `{ pairwise, gross, applied }` that
 * `computeBalancesFull` already returns and layers display metadata on top.
 * Pure function, no ledger / Worker-contract impact.
 */
export function computeSettlementSuggestions(input: {
  pairwise: Record<string, Record<string, number>>
  gross:    Record<string, Record<string, number>>
  applied:  Record<string, Record<string, number>>
}): SettlementSuggestion[] {
  const { pairwise, gross, applied } = input
  return computeSettlements(pairwise).map(s => {
    const grossMinor   = gross[s.fromId]?.[s.toId]   ?? 0
    const appliedMinor = applied[s.fromId]?.[s.toId] ?? 0
    if (appliedMinor > 0 && grossMinor - appliedMinor === s.amountMinor) {
      return { ...s, settledContext: { grossMinor, appliedMinor, remainingMinor: s.amountMinor } }
    }
    return { ...s }
  })
}
