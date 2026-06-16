// src/features/expense/services/buildOcrExpenseDraft.ts
// 純函式:把 OCR worker 回來的 OcrResult 組裝成 ExpenseFormModal 要套用的
// 草稿(幣別判斷 + fail-fast 金額 parse + item id mint + adjustment target
// 對應 + title/category 自動填入決策)。
//
// 從 ExpenseFormModal 的 useOcrFlow.onSuccess 抽出 —— 該 closure 過去把
// 「算什麼」(currency detect / parse / mint / target 解析)與「改什麼 state」
// (applyCurrencySwitch / items.reset / resetAdjustments / setAmountText /
// setField)揉成一團,且整段都依賴 component scope。這裡只留「資料進、草稿出」:
//   - 不碰 React state(呼叫端負責 applyCurrencySwitch / reset / setField)
//   - `crypto.randomUUID` 以 `newId` 注入,讓 id-mint 與 ITEM-scope target
//     對應可用 deterministic id 直接單元測試。
//
// FAIL-FAST 契約(load-bearing):Worker schema 只驗 currency-agnostic 的小數
// 字串形狀,所以 Gemini 對 JPY 吐 "12.34" 能過 wire 卻會 break
// parseMoneyToMinor(JPY 0 小數位)。靜默 coerce 成 0 會把垃圾行匯入並把
// 不一致漏進已存的費用。改成:先把每個欄位 parse 完,第一個失敗就 throw
// 一個本地化訊息(呼叫端的 useOcrFlow.run catch → receiptErrText banner),
// 因為是純函式,throw 發生在 return 之前 → 對使用者而言「部分套用」結構上
// 不可能出現。
import type { ExpenseAdjustment, ExpenseCategory } from '@/types'
import type { FormItem } from '../hooks/useExpenseItems'
import type { OcrResult } from './ocrService'
import { CURRENCY_OPTIONS } from '@/utils/currency'
import { formatMinorForInput, parseMoneyToMinor } from '@/utils/money'

/** buildOcrExpenseDraft 的純 context —— 對應舊 onSuccess 從 component scope
 *  讀的每一個值,改以扁平資料傳入。 */
export interface OcrExpenseDraftContext {
  tripCurrency: string
  /** editTarget?.sourceCurrency —— OCR 省略 / 用未註冊幣別時的 fallback。
   *  EXISTING 外幣費用保留它已存的權威幣別,而非 snap 回 trip。 */
  persistedSourceCurrency: string | undefined
  /** editTarget !== null —— category 只在「新增」套用,edit 不覆寫使用者
   *  已選的 ground truth。 */
  isEdit: boolean
  /** 現有 title;storeName 只在 title 仍為空白時才填(非破壞性)。 */
  currentTitle: string
}

/** OCR 套用草稿。呼叫端逐項套到 sibling hooks:
 *  - `ocrCurrency !== sourceCurrency` → applyCurrencySwitch(ocrCurrency)
 *  - items.reset(items) / resetAdjustments(adjustments, adjustmentText)
 *  - setAmountText(amountText)
 *  - title / category 存在時才 setField(present ⇔ 應套用)。 */
export interface OcrExpenseDraft {
  /** 解析後的收據幣別:detected(經 registry 驗證)→ persisted source → trip。 */
  ocrCurrency:    string
  items:          FormItem[]
  adjustments:    ExpenseAdjustment[]
  /** adjustment id → inflight 輸入文字(>0 才有,0 給空字串)。 */
  adjustmentText: Record<string, string>
  /** 收據總額,以 ocrCurrency 格式化後的輸入字串。 */
  amountText:     string
  /** 僅在 storeName 存在且現有 title 空白時帶出。 */
  title?:    string
  /** 僅在 OCR 偵測到 category 且為新增模式時帶出。 */
  category?: ExpenseCategory
}

export function buildOcrExpenseDraft(
  result: OcrResult,
  ctx:    OcrExpenseDraftContext,
  newId:  () => string,
): OcrExpenseDraft {
  // Worker 只驗 ISO 4217 SHAPE(^[A-Z]{3}$),未註冊碼(例 CAD)能 parse +
  // format,但 CurrencyPicker 顯示不出來也切不走,會把使用者卡住。Gate 在
  // registry:已知碼才自動 set(差異即觸發外幣模式),未知 / 省略走下方
  // fallback。
  const detectedCurrency: string | undefined =
    result.currency && CURRENCY_OPTIONS.some(c => c.code === result.currency)
      ? result.currency
      : undefined
  const ocrCurrency = detectedCurrency ?? ctx.persistedSourceCurrency ?? ctx.tripCurrency

  const strictParse = (text: string, label: string): number => {
    try { return Math.max(0, parseMoneyToMinor(text, ocrCurrency)) }
    catch {
      throw new Error(
        `OCRの金額が${ocrCurrency}の形式と一致しません(${label}: "${text}")。撮り直してください。`,
      )
    }
  }

  // Phase 1:把 ALL 欄位先 parse 完。任一失敗在任何 state 變更之前就 throw,
  // 草稿不會 return,呼叫端維持原狀並顯示單一錯誤 banner。
  const itemMinors = result.items.map((it, i) =>
    strictParse(it.amountText, `item[${i}] ${it.name}`),
  )
  const adjustmentMinors = result.adjustments.map((adj, i) =>
    strictParse(adj.amountText, `adjustment[${i}] ${adj.label}`),
  )
  const totalMinor = strictParse(result.totalText, 'total')

  // Phase 2:全部 parse 成功 —— 組裝草稿。先 mint item id,讓 OCR 帶的
  // ITEM-scope adjustment 能在同一輪把 suggestedTargetItemIndex →
  // targetItemId 解析掉。items 一律 assignees=[](Phase B 契約:分擔者
  // 是使用者刻意動作)。
  const mintedItemIds = result.items.map(() => newId())
  const items: FormItem[] = result.items.map((it, idx) => ({
    id:          mintedItemIds[idx]!,
    name:        it.name,
    amountMinor: itemMinors[idx]!,
    amountText:  formatMinorForInput(itemMinors[idx]!, ocrCurrency),
    assignees:   [],
  }))

  // OCR adjustment draft → persisted shape. Only explicit EXPENSE stays
  // receipt-wide; only ITEM with a valid target index stays item-scoped.
  // UNKNOWN / broken ITEM targets are dropped so the item-total mismatch
  // forces manual review instead of silently spreading a discount globally.
  const adjustments: ExpenseAdjustment[] = result.adjustments.flatMap((adj, i): ExpenseAdjustment[] => {
    const idx = adj.suggestedTargetItemIndex
    const itemTarget =
      adj.suggestedScope === 'ITEM' &&
      idx !== undefined &&
      idx >= 0 &&
      idx < mintedItemIds.length
        ? mintedItemIds[idx]
        : undefined
    const minor = adjustmentMinors[i]!
    if (itemTarget) {
      return [{
        id:           newId(),
        label:        adj.label,
        kind:         adj.kind,
        scope:        'ITEM' as const,
        amountMinor:  minor,
        targetItemId: itemTarget,
      }]
    }
    if (adj.suggestedScope === 'EXPENSE') {
      return [{
        id:          newId(),
        label:       adj.label,
        kind:        adj.kind,
        scope:       'EXPENSE' as const,
        amountMinor: minor,
      }]
    }
    return []
  })

  const adjustmentText = Object.fromEntries(
    adjustments.map(adj => [
      adj.id,
      adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, ocrCurrency) : '',
    ]),
  )

  const draft: OcrExpenseDraft = {
    ocrCurrency,
    items,
    adjustments,
    adjustmentText,
    amountText: formatMinorForInput(totalMinor, ocrCurrency),
  }
  // 標題:OCR 不覆寫使用者已輸入的 title。
  if (result.storeName && !ctx.currentTitle.trim()) {
    draft.title = result.storeName
  }
  // Category:拍照即「請幫我自動分類」,只在新增模式覆寫;edit 絕不動。
  if (result.category && !ctx.isEdit) {
    draft.category = result.category
  }
  return draft
}
