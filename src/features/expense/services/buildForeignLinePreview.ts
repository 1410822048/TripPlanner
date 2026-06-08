// src/features/expense/services/buildForeignLinePreview.ts
// 純函式:外幣模式下,把 source-currency 的 amount / items / adjustments
// 換算成 trip-currency 的「逐行預覽」(總額 + 每行 id→trip-minor map),
// 給 ExpenseFormModal 的 "USD 12.34 → ¥1804 @ 146.2" 顯示列用。
//
// 從 ExpenseFormModal 的 inline IIFE 抽出。這只是 PREVIEW —— save 路徑的
// 權威換算走 buildExpenseFormResult → convertAndMaterializeFromSource,
// Worker 再以自己的權威 rate 重算覆寫。所以這裡的任何漂移最終都會被
// Worker recompute 蓋掉,不會寫錯資料。
//
// 兩條路徑(對應 convertSourceLinesToTarget 的成功 / 失敗):
//   - balanced:items + signed adjustments === total → 走權威逐行換算
//     (與 save-time 同一個 import),itemAmountById / adjustmentAmountById
//     是 residual-allocated 後的精確值。
//   - draft 不平衡:編輯途中 items + adjustments != total 是常態,
//     convertSourceLinesToTarget 會丟 SOURCE_SUM_MISMATCH。此時不該把每行
//     FX 提示整個藏起來,改用「各行獨立近似換算」讓使用者仍看得到方向,
//     最終一致性交給 save-time / Worker enforce。
import { convertMinorHalfEven } from '@tripmate/fx-core'
import {
  convertSourceLinesToTarget,
  type ConvertSourceLineItem,
  type ConvertSourceLineAdjustment,
} from '@tripmate/expense-materialize'
import { currencyFractionDigits } from '@/utils/money'

export interface ForeignLinePreviewInput {
  /** sourceCurrency !== tripCurrency。false 直接回 null。 */
  isForeignOpen:     boolean
  /** useFxPreview 的 rate;null / 空字串(loading / disabled)回 null。 */
  rateDecimal:       string | null
  /** 收據總額(source-currency minor)。<= 0 回 null。 */
  sourceAmountMinor: number
  sourceCurrency:    string
  tripCurrency:      string
  /** 收據行(只需要 id + source-currency amountMinor)。 */
  items:             ConvertSourceLineItem[]
  /** 調整行(id / kind / scope / amountMinor / targetItemId)。 */
  adjustments:       ConvertSourceLineAdjustment[]
}

export interface ForeignLinePreview {
  /** trip-currency 總額(balanced 走權威換算,fallback 走總額直換)。 */
  amountMinor:          number
  /** item id → trip-currency minor。fallback 下無法換算的行會缺席。 */
  itemAmountById:       Map<string, number>
  /** adjustment id → trip-currency minor(同上)。 */
  adjustmentAmountById: Map<string, number>
}

export function buildForeignLinePreview(
  input: ForeignLinePreviewInput,
): ForeignLinePreview | null {
  const {
    isForeignOpen, rateDecimal, sourceAmountMinor,
    sourceCurrency, tripCurrency, items, adjustments,
  } = input

  // null = 非外幣 / 尚無 rate / 還沒輸入金額。
  if (!isForeignOpen || !rateDecimal || sourceAmountMinor <= 0) return null

  const sourceFractionDigits = currencyFractionDigits(sourceCurrency)
  const targetFractionDigits = currencyFractionDigits(tripCurrency)
  const convertPreviewMinor = (sourceMinor: number): number | undefined => {
    if (!Number.isInteger(sourceMinor) || sourceMinor <= 0) return undefined
    return convertMinorHalfEven({
      sourceMinor,
      rateDecimal,
      sourceFractionDigits,
      targetFractionDigits,
    })
  }

  try {
    const converted = convertSourceLinesToTarget({
      sourceItems:          items.map(item => ({ id: item.id, amountMinor: item.amountMinor })),
      sourceAdjustments:    adjustments.map(adj => ({
        id:           adj.id,
        kind:         adj.kind,
        scope:        adj.scope,
        amountMinor:  adj.amountMinor,
        targetItemId: adj.targetItemId,
      })),
      sourceAmountMinor,
      rateDecimal,
      sourceFractionDigits,
      targetFractionDigits,
    })
    return {
      amountMinor: converted.amountMinor,
      itemAmountById: new Map(
        converted.items.map(item => [item.id, item.amountMinor] as const),
      ),
      adjustmentAmountById: new Map(
        converted.adjustments.map(adj => [adj.id, adj.amountMinor] as const),
      ),
    }
  } catch {
    // Draft 暫時不平衡 → 各行獨立近似換算,別整個藏掉 FX 提示。
    const convertedAmount = convertPreviewMinor(sourceAmountMinor)
    if (convertedAmount === undefined) return null

    const itemAmountById = new Map<string, number>()
    for (const item of items) {
      const convertedItem = convertPreviewMinor(item.amountMinor)
      if (convertedItem !== undefined) itemAmountById.set(item.id, convertedItem)
    }

    const adjustmentAmountById = new Map<string, number>()
    for (const adj of adjustments) {
      const convertedAdjustment = convertPreviewMinor(adj.amountMinor)
      if (convertedAdjustment !== undefined) {
        adjustmentAmountById.set(adj.id, convertedAdjustment)
      }
    }

    return { amountMinor: convertedAmount, itemAmountById, adjustmentAmountById }
  }
}
