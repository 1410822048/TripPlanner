// src/features/expense/services/buildExpenseFormResult.ts
// 純函式:把 ExpenseFormModal 的草稿狀態(form draft + trip context +
// members + FX state)組裝成可送出的 CreateExpenseInput,或回傳逐欄錯誤。
//
// 從 ExpenseFormModal.validate() 抽出 —— validate() 過去把錯誤訊息、money
// parse、外幣 FX gate、items/adjustments materialize、splits 檢查、payload
// 組裝全揉在一起,還夾帶 setErrors / att.pickAttachmentChange 兩個 side
// effect。這裡只留「資料進、結果出」:
//   - 不碰 React state(呼叫端負責 setErrors)
//   - 不碰 attachment(呼叫端 onSave 時自行附上)
// 讓外幣 / 明細 / 分帳這三條最容易出錯的路徑得以脫離 component 單元測試。
//
// 與 component 的關係:ExpenseFormModal 仍各自計算 live-preview 衍生值
// (amountMinor / itemsDiff / equalSplits …)來驅動畫面;本函式為了
// self-contained 會在內部「重算」同一組值來決定 save 結果。兩者若漂移只
// 影響 optimistic preview 的顯示(Worker 仍為 authoritative,落地時會重算
// 覆蓋),不會寫錯資料。後續 P3(useExpenseMoneyDraft)會把這層 draft 收斂、
// 消除這份重算重複。
import {
  type CreateExpenseInput,
  type ExpenseAdjustment,
  type ExpenseCategory,
  type ExpenseItem,
  type ExpenseSplit,
  type SourceExpenseAdjustment,
  type SourceExpenseItem,
  type SourceExpenseSplit,
} from '@/types'
import {
  adjustmentSign,
  convertAndMaterializeFromSource,
  convertSourceSplitsToTarget,
  materializeExpenseSplits,
  MaterializeError,
  type MaterializeErrorCode,
  type ConvertAndMaterializeSourceAdjustment,
  type ConvertAndMaterializeSourceItem,
} from '@tripmate/expense-materialize'
import { currencyFractionDigits, formatMinorAmount } from '@/utils/money'
import type { FxPreviewDisabledReason } from '@/hooks/useFxPreview'
import type { SplitMode } from '../hooks/useSplitsState'
import {
  moneyErrorMessage,
  parsePositiveMoneyToMinorResult,
  safeReparseMoney,
  splitEqually,
} from '../utils'

/** 草稿行項目 —— form 的 FormItem 去掉純輸入用的 `amountText`,只留
 *  materializer / 持久層真正需要的整數 minor 欄位。 */
export interface ExpenseFormDraftItem {
  id:          string
  name:        string
  amountMinor: number
  assignees:   string[]
}

/** buildExpenseFormResult 的純輸入 —— 對應舊 validate() 從 component scope
 *  讀的每一個值,改以扁平資料傳入,讓金額組裝可獨立測試。 */
export interface BuildExpenseFormInput {
  // 純量欄位
  title:          string
  amountText:     string
  date:           string
  category:       ExpenseCategory
  paidBy:         string
  note:           string
  /** 收據來源幣別;同幣別(非外幣)模式時等於 tripCurrency。 */
  sourceCurrency: string

  // 行項目 + 分帳狀態
  items:       ExpenseFormDraftItem[]
  adjustments: ExpenseAdjustment[]
  splitMode:   SplitMode
  /** 均等模式被勾選納入分攤的 member id(原始集合內容;builder 會與
   *  `memberIds` 取交集以保留成員順序)。 */
  includedIds:   string[]
  /** 自訂模式每位成員的輸入文字,key 為 memberId。 */
  customAmounts: Record<string, string>

  // Context
  tripCurrency: string
  memberIds:    string[]
  /** useFxPreview 的精簡投影。外幣模式 submit 必須有 rateDecimal;無 rate
   *  時 disabledReason / isError 決定回給使用者的精準理由。 */
  fx: {
    rateDecimal:    string | null
    disabledReason: FxPreviewDisabledReason | null
    isError:        boolean
  }
}

/** 成功帶 payload(CreateExpenseInput),失敗帶逐欄錯誤訊息(沿用舊
 *  validate() 的 `errors` 形狀,呼叫端直接餵 setErrors)。 */
export type BuildExpenseFormResult =
  | { ok: true;  input: CreateExpenseInput }
  | { ok: false; errors: Record<string, string> }

/** Friendly Japanese copy for EVERY materializer failure, keyed on its stable
 *  `code`. `satisfies Record<MaterializeErrorCode, string>` makes the table
 *  EXHAUSTIVE — when @tripmate/expense-materialize adds a code, TypeScript
 *  forces a copy entry here rather than letting a new error get swallowed by a
 *  default. Most codes are gated by the form's own validation before
 *  materialize runs (no-assignee / zero amounts / dangling target / sum
 *  mismatch); the genuinely form-reachable one is OVER_DISCOUNT_ITEM, the rest
 *  are defense-in-depth. Kept local — only buildExpenseFormResult consumes it. */
const MATERIALIZE_ERROR_COPY = {
  ITEM_NOT_POSITIVE_INTEGER:              '明細金額を確認してください',
  ITEM_NO_ASSIGNEES:                      '明細の割り当て先を選択してください',
  NON_MEMBER_ASSIGNEE:                    '明細の割り当て先に参加者以外が含まれています',
  DUPLICATE_ITEM_ASSIGNEE:                '同じ参加者が重複しています',
  DUPLICATE_ITEM_ID:                      '明細IDが重複しています',
  ADJUSTMENT_NOT_POSITIVE_INTEGER:        '割引・調整額を確認してください',
  ADJUSTMENT_UNKNOWN_KIND:                '割引・調整の種類を確認してください',
  UNKNOWN_SCOPE:                          '割引・調整の対象を確認してください',
  ITEM_SCOPE_NO_TARGET:                   '対象の明細を選択してください',
  EXPENSE_SCOPE_HAS_TARGET:               '全体対象の割引に明細指定はできません',
  TARGET_ITEM_NOT_FOUND:                  '対象の明細が見つかりません',
  OVER_DISCOUNT_ITEM:                     '割引が項目の金額を超えています',
  OVER_DISCOUNT_EXPENSE:                  '割引の合計が明細の合計を超えています',
  EXPENSE_SCOPE_NO_WEIGHT:                '割引を適用できる項目がありません',
  SOURCE_AMOUNT_NOT_POSITIVE_INTEGER:     '外貨の合計金額を確認してください',
  SOURCE_ITEM_NOT_POSITIVE_INTEGER:       '外貨の明細金額を確認してください',
  SOURCE_ADJUSTMENT_NOT_POSITIVE_INTEGER: '外貨の割引・調整額を確認してください',
  SOURCE_SUM_MISMATCH:                    '外貨の明細合計と請求書合計が一致しません',
  SOURCE_SPLITS_EMPTY:                    '外貨の分担先を選択してください',
  SOURCE_SPLIT_MEMBER_MISSING:            '外貨の分担先を確認してください',
  SOURCE_SPLIT_NOT_NONNEGATIVE_INTEGER:   '外貨の分担金額を確認してください',
  DUPLICATE_SOURCE_SPLIT_MEMBER:          '外貨の分担先が重複しています',
  SOURCE_SPLIT_SUM_MISMATCH:              '外貨の分担合計が請求書合計と一致しません',
} satisfies Record<MaterializeErrorCode, string>

function materializeErrorMessage(code: MaterializeErrorCode): string {
  return MATERIALIZE_ERROR_COPY[code]
}

export function buildExpenseFormResult(input: BuildExpenseFormInput): BuildExpenseFormResult {
  const {
    title, amountText, date, category, paidBy, note,
    sourceCurrency, items, adjustments, splitMode,
    includedIds, customAmounts, tripCurrency, memberIds, fx,
  } = input

  // 幣別 alias:同 ExpenseFormModal 的 effectiveCurrency。foreign-open ⇔
  // sourceCurrency !== tripCurrency;其後所有 money 解析都走這個 currency。
  const isForeignOpen = sourceCurrency !== tripCurrency
  const currency      = isForeignOpen ? sourceCurrency : tripCurrency

  // ── 衍生值(component 端有同名 live-preview 版本;此處為 save 路徑重算)──
  const amountMinor         = safeReparseMoney(amountText, currency)
  const itemsSum            = items.reduce((s, it) => s + it.amountMinor, 0)
  const adjustmentNetMinor  = adjustments.reduce((s, a) => s + adjustmentSign(a.kind) * a.amountMinor, 0)
  const effectiveItemsTotal = itemsSum + adjustmentNetMinor
  const itemsDiff           = amountMinor - effectiveItemsTotal
  const hasItems            = items.length > 0

  const includedSet = new Set(includedIds)
  const includedArr = memberIds.filter(id => includedSet.has(id))
  const equalSplits: Record<string, number> = Object.fromEntries(
    splitEqually(amountMinor, includedArr).map(s => [s.memberId, s.amountMinor]),
  )
  const customAmountOf = (id: string): number => {
    const text = customAmounts[id]
    if (typeof text !== 'string') return 0
    return safeReparseMoney(text, currency)
  }
  const customSum  = memberIds.reduce((s, id) => s + customAmountOf(id), 0)
  const customDiff = amountMinor - customSum

  // ── 逐欄基本驗證 ──
  const e: Record<string, string> = {}
  if (!title.trim()) e.title = '請輸入標題'
  // 透過 Result wrapper 給精準理由 —— 舊 `if (!amountMinor)` 會把 parse 失敗
  // (例:JPY 12.34)誤判成空輸入。
  const amountResult = parsePositiveMoneyToMinorResult(amountText, currency)
  if (!amountResult.ok) e.amount = moneyErrorMessage(amountResult.reason, currency)
  if (!date)   e.date   = '請選擇日期'
  if (!paidBy) e.paidBy = '請選擇付款人'

  // 外幣模式必須有 rate:optimistic cache patch 必須已是 trip-currency,
  // 否則總額 / Settlement summary 會在 optimistic 視窗讀到 source-unit 垃圾。
  // 各種「無 rate」狀態給可行動的精準理由(日期 / 幣別 / 網路)。
  if (isForeignOpen && !e.amount && !fx.rateDecimal) {
    e.amount =
      fx.disabledReason === 'future-date'   ? '未来日付は換算できません' :
      fx.disabledReason === 'invalid-input' ? '通貨または日付を確認してください' :
      fx.isError                            ? '換算レートを取得できません。再試行してください' :
                                              '換算レートを取得中です。少し待ってから再送信してください'
  }

  let resultSplits: ExpenseSplit[] = []
  // 永遠送 `items`(即使空陣列)以覆寫先前存的 items。在外幣模式這些是
  // SOURCE 幣別 minor;下方 convert-and-materialize 會升格成 trip-currency。
  let resultItems: ExpenseItem[] = items.map(it => ({
    id: it.id, name: it.name, amountMinor: it.amountMinor, assignees: it.assignees,
  }))
  let resultSourceSplits: SourceExpenseSplit[] = []
  const resultAdjustments: ExpenseAdjustment[] = hasItems
    ? adjustments.map(adj => {
        const label = adj.label.trim()
        if (adj.scope === 'ITEM') {
          return { ...adj, label }
        }
        return {
          id:          adj.id,
          label,
          kind:        adj.kind,
          scope:       'EXPENSE',
          amountMinor: adj.amountMinor,
        }
      })
    : []

  if (hasItems) {
    // 嚴格 by-item 驗證:每行需有分擔者 + 名稱 + 正金額,調整需有標籤 +
    // 正金額 + ITEM scope 需指到存在的行,且 effective 合計 === 請求書合計。
    const noAssigneeIdx = items.findIndex(it => it.assignees.length === 0)
    const blankNameIdx  = items.findIndex(it => !it.name.trim())
    const zeroAmountIdx = items.findIndex(it => it.amountMinor <= 0)
    const blankAdjustmentIdx = resultAdjustments.findIndex(adj => !adj.label)
    const zeroAdjustmentIdx  = resultAdjustments.findIndex(adj => adj.amountMinor <= 0)
    const danglingAdjustmentIdx = resultAdjustments.findIndex(adj =>
      adj.scope === 'ITEM' && !items.some(it => it.id === adj.targetItemId),
    )
    if (noAssigneeIdx >= 0) {
      e.items = `行 ${noAssigneeIdx + 1}：分担者を選択してください`
    } else if (blankNameIdx >= 0) {
      e.items = `行 ${blankNameIdx + 1}：項目名を入力してください`
    } else if (zeroAmountIdx >= 0) {
      e.items = `行 ${zeroAmountIdx + 1}：金額を入力してください`
    } else if (blankAdjustmentIdx >= 0) {
      e.items = `調整 ${blankAdjustmentIdx + 1}: ラベルを入力してください`
    } else if (zeroAdjustmentIdx >= 0) {
      e.items = `調整 ${zeroAdjustmentIdx + 1}: 金額を入力してください`
    } else if (danglingAdjustmentIdx >= 0) {
      e.items = `調整 ${danglingAdjustmentIdx + 1}: 対象項目を選択してください`
    } else if (itemsDiff !== 0) {
      e.items = `明細合計 ${formatMinorAmount(effectiveItemsTotal, currency)} と請求書合計 ${formatMinorAmount(amountMinor, currency)} が一致しません`
    }
    if (!e.items && !isForeignOpen) {
      // 同幣別 by-item:client 端走 trip-currency materializer 算權威 split,
      // 與 Worker recompute 同一個 import;此處 throw 等於 Worker 也會
      // SPLIT_PREVIEW_DRIFT 拒,所以保留錯誤、不放行。外幣 by-item 的 split
      // 由下方 convertAndMaterializeFromSource 衍生。
      try {
        resultSplits = materializeExpenseSplits({
          items:       resultItems,
          adjustments: resultAdjustments,
          members:     memberIds,
        })
      } catch (err) {
        e.items = err instanceof MaterializeError
          ? materializeErrorMessage(err.code)
          : '明細の計算に失敗しました'
      }
    }
  } else {
    if (splitMode === 'equal') {
      if (includedArr.length === 0) e.splits = '至少選擇一位分攤人'
      resultSplits = includedArr.map(id => ({ memberId: id, amountMinor: equalSplits[id] ?? 0 }))
    } else {
      resultSplits = memberIds
        .map(id => ({ memberId: id, amountMinor: customAmountOf(id) }))
        .filter(s => s.amountMinor > 0)
      if (resultSplits.length === 0) e.splits = '至少需有一人分攤'
      else if (customDiff !== 0) e.splits = `分攤總和需等於 ${formatMinorAmount(amountMinor, currency)}`
    }
    // 手動外幣輸入沒有收據行;偽造 item 會把實作細節漏進 UI,所以 source
    // 域以隱藏的 sourceSplits 表示,Worker 權威轉換後寫 canonical trip splits。
    resultItems = []
    if (isForeignOpen) {
      resultSourceSplits = resultSplits.map(split => ({
        memberId:          split.memberId,
        sourceAmountMinor: split.amountMinor,
      }))
    }
  }

  if (Object.keys(e).length > 0) return { ok: false, errors: e }

  // ── 外幣分支:把 source-domain payload 轉成 trip-currency canonical,並
  // 同時送出兩側。client 端轉換只餵 optimistic cache;Worker 為 authoritative,
  // 會用自己的權威 rate 重算覆蓋。上方 FX gate 已保證 fx.rateDecimal 非 null,
  // 故此處 `!` 為真;刻意沒有 source-unit fallback(避免把 source-unit 數字
  // patch 進 trip-currency cache 欄位污染 optimistic 視窗)。 ──
  if (isForeignOpen) {
    const sourceFractionDigits = currencyFractionDigits(sourceCurrency)
    const targetFractionDigits = currencyFractionDigits(tripCurrency)

    if (resultSourceSplits.length > 0) {
      let converted: { amountMinor: number; splits: ExpenseSplit[] }
      try {
        converted = convertSourceSplitsToTarget({
          sourceSplits: resultSourceSplits.map(split => ({
            memberId:    split.memberId,
            amountMinor: split.sourceAmountMinor,
          })),
          sourceAmountMinor: amountMinor,
          rateDecimal:       fx.rateDecimal!,
          sourceFractionDigits,
          targetFractionDigits,
        })
      } catch (err) {
        return {
          ok: false,
          errors: {
            splits: err instanceof MaterializeError
              ? materializeErrorMessage(err.code)
              : '換算の計算に失敗しました',
          },
        }
      }

      const out: CreateExpenseInput = {
        mode:              'FOREIGN_CURRENCY',
        title:             title.trim(),
        amountMinor:       converted.amountMinor,
        currency:          tripCurrency,
        category,
        paidBy,
        splits:            converted.splits,
        date,
        items:             [],
        adjustments:       [],
        note:              note.trim() || undefined,
        sourceCurrency,
        sourceAmountMinor: amountMinor,
        sourceSplits:      resultSourceSplits,
      }
      return { ok: true, input: out }
    }

    const sourceItemsForMaterialize: ConvertAndMaterializeSourceItem[] = resultItems.map(it => ({
      id:          it.id,
      amountMinor: it.amountMinor,
      assignees:   it.assignees,
    }))
    const sourceAdjustmentsForMaterialize: ConvertAndMaterializeSourceAdjustment[] = resultAdjustments.map(a => ({
      id:           a.id,
      kind:         a.kind,
      scope:        a.scope,
      amountMinor:  a.amountMinor,
      targetItemId: a.targetItemId,
    }))

    let converted: {
      amountMinor: number
      items:       ConvertAndMaterializeSourceItem[]
      adjustments: ConvertAndMaterializeSourceAdjustment[]
      splits:      ExpenseSplit[]
    }
    try {
      converted = convertAndMaterializeFromSource({
        sourceItems:       sourceItemsForMaterialize,
        sourceAdjustments: sourceAdjustmentsForMaterialize,
        sourceAmountMinor: amountMinor,
        rateDecimal:       fx.rateDecimal!,
        sourceFractionDigits,
        targetFractionDigits,
        members:           memberIds,
      })
    } catch (err) {
      return {
        ok: false,
        errors: {
          items: err instanceof MaterializeError
            ? materializeErrorMessage(err.code)
            : '換算の計算に失敗しました',
        },
      }
    }

    // 把 name / label 接回 materialize 輸出(materializer 是 currency-agnostic
    // 純函式,不帶顯示字串)。
    const tripItems: ExpenseItem[] = converted.items.map((mi, i) => ({
      id:          mi.id,
      name:        resultItems[i]!.name,
      amountMinor: mi.amountMinor,
      assignees:   mi.assignees,
    }))
    const tripAdjustments: ExpenseAdjustment[] = converted.adjustments.map((ma, i) => {
      const srcLabel = resultAdjustments[i]!.label
      return ma.scope === 'ITEM'
        ? {
            id:           ma.id,
            label:        srcLabel,
            kind:         ma.kind,
            scope:        'ITEM' as const,
            amountMinor:  ma.amountMinor,
            targetItemId: ma.targetItemId!,
          }
        : {
            id:          ma.id,
            label:       srcLabel,
            kind:        ma.kind,
            scope:       'EXPENSE' as const,
            amountMinor: ma.amountMinor,
          }
    })

    // Source-domain 持久化形狀 —— id 與 trip items / adjustments 對齊,讓
    // Worker ExpenseDocSchema.superRefine 的逐 id 配對檢查在 read-back 通過。
    const sourceItemsOut: SourceExpenseItem[] = resultItems.map(it => ({
      id:                it.id,
      name:              it.name,
      sourceAmountMinor: it.amountMinor,
      assignees:         it.assignees,
    }))
    const sourceAdjustmentsOut: SourceExpenseAdjustment[] = resultAdjustments.map(a =>
      a.scope === 'ITEM'
        ? {
            id:                a.id,
            label:             a.label,
            kind:              a.kind,
            scope:             'ITEM' as const,
            sourceAmountMinor: a.amountMinor,
            targetItemId:      a.targetItemId!,
          }
        : {
            id:                a.id,
            label:             a.label,
            kind:              a.kind,
            scope:             'EXPENSE' as const,
            sourceAmountMinor: a.amountMinor,
          },
    )

    const out: CreateExpenseInput = {
      mode:              'FOREIGN_CURRENCY',
      title:             title.trim(),
      amountMinor:       converted.amountMinor,
      currency:          tripCurrency,
      category,
      paidBy,
      splits:            converted.splits,
      date,
      items:             tripItems,
      adjustments:       tripAdjustments,
      note:              note.trim() || undefined,
      sourceCurrency,
      sourceAmountMinor: amountMinor,
      sourceItems:       sourceItemsOut,
      sourceAdjustments: sourceAdjustmentsOut,
    }
    return { ok: true, input: out }
  }

  // ── 同幣別分支 ──
  const out: CreateExpenseInput = {
    mode:        'TRIP_CURRENCY',
    title:       title.trim(),
    amountMinor,
    currency,
    category,
    paidBy,
    splits:      resultSplits,
    date,
    items:       resultItems,
    // Phase B:adjustments 只掛在 by-item 模式;Worker 拒「有 adjustments 無
    // items」,所以這裡 blanking 是「手動輸入無 adjustments」的唯一真相來源。
    adjustments: resultAdjustments,
    note:        note.trim() || undefined,
  }
  return { ok: true, input: out }
}
