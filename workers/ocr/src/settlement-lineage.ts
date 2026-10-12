// workers/ocr/src/settlement-lineage.ts
// Worker binding of the shared settlement lineage (@tripmate/settlement-core
// lineage.ts): which expenses / items a settlement drew down (appliedSources)
// and which expenses it locks (appliedExpenseIds → settlementLockIds).
//
// The algorithm lives in settlement-core so the client's payment-suggestion
// preview runs the exact same code; this module only binds the receipt
// materializer (memberItemContributions) as the per-item attribution and
// fixes the Worker's decoded expense shape. The endpoint decodes Firestore
// docs into PairExpenseForSettlement before calling in; nothing here
// touches FsValue.
import type { CoreSettlement } from '@tripmate/settlement-core'
import {
  buildSettlementLineage as buildLineage,
  sourceUnitsForDirection as unitsForDirection,
  consumeSourceUnits,
  collapseAppliedSources,
  type LineageExpense,
  type SettlementAppliedSource,
  type SettlementLineage,
  type SettlementSourceUnit,
} from '@tripmate/settlement-core'
import {
  memberItemContributions,
  type MaterializeAdjustment,
  type MaterializeItem,
} from '@tripmate/expense-materialize'

/** A pair expense decoded far enough for lineage: LineageExpense plus the
 *  item allocations / adjustments the materializer needs. */
export interface PairExpenseForSettlement extends LineageExpense {
  items?:      Array<MaterializeItem & { name: string }>
  adjustments: Array<MaterializeAdjustment & { label: string }>
}

export type { SettlementAppliedSource, SettlementLineage }
export { consumeSourceUnits, collapseAppliedSources }

const attribute = (expense: PairExpenseForSettlement, memberId: string) =>
  memberItemContributions(expense, memberId)

export function sourceUnitsForDirection(
  expenses: PairExpenseForSettlement[],
  fromUid:  string,
  toUid:    string,
): SettlementSourceUnit[] {
  return unitsForDirection(expenses, fromUid, toUid, attribute)
}

export function buildSettlementLineage(
  expenses:    PairExpenseForSettlement[],
  settlements: CoreSettlement[],
  fromUid:     string,
  toUid:       string,
  amountMinor: number,
): SettlementLineage {
  return buildLineage(expenses, settlements, fromUid, toUid, amountMinor, attribute)
}
