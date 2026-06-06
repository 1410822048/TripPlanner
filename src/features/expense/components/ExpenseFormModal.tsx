// src/features/expense/components/ExpenseFormModal.tsx
// The ExpensePage caller keys this component by `editTarget?.id ?? 'new'`,
// so any change to the edit target produces a fresh mount. That lets the
// form initialize every piece of state directly from props below — no
// sync-in-effect step, no cascade renders after mount.
//
// Two split modes:
//   - "traditional" (items.length === 0): 均等 / カスタム tabs, manual entry
//   - "by-item"     (items.length  > 0): chip-per-row member assignment,
//                                        splits computed from items at save
// The mode is implicit in `items.length` rather than a separate flag —
// the receipt photo drives whether items exist, and items existing drives
// the UI shape.
//
// Heavy state is delegated to feature-scoped hooks:
//   - useFormReducer   — title/amount/date/category/paidBy/note
//   - useSplitsState   — 均等/カスタム split mode
//   - useAttachment    — receipt file lifecycle (existing/new/cleared)
//   - useExpenseItems  — by-item state + mutators
//   - useOcrFlow       — OCR pipeline (compress + worker + error copy)
import { useRef, useState } from 'react'
import { Camera, Globe, Loader2, Plus, ScanLine, Trash2, Upload } from 'lucide-react'
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type Expense,
  type ExpenseAdjustmentKind,
  type ExpenseAdjustmentScope,
  type ExpenseCategory,
  type ExpenseItem,
  type CreateExpenseInput,
} from '@/types'
import type { TripMember } from '@/features/trips/types'
import {
  adjustmentSign,
  convertSourceLinesToTarget,
} from '@tripmate/expense-materialize'
import { convertMinorHalfEven } from '@tripmate/fx-core'
import FormModalShell from '@/components/ui/FormModalShell'
import { DatePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { compactInputClass, inputClass } from '@/components/ui/inputStyle'
import CurrencyInput from '@/components/ui/CurrencyInput'
import CurrencyPicker from '@/components/ui/CurrencyPicker'
import MemberChip from '@/components/ui/MemberChip'
import MemberAvatar from '@/components/ui/MemberAvatar'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useSplitsState, type SplitMode } from '../hooks/useSplitsState'
import { useExpenseItems } from '../hooks/useExpenseItems'
import { useExpenseMoneyDraft } from '../hooks/useExpenseMoneyDraft'
import { useFxPreview } from '@/hooks/useFxPreview'
import { useOcrFlow } from '../hooks/useOcrFlow'
import { ocrResultStillApplicable } from '../services/ocrService'
import { buildExpenseFormResult } from '../services/buildExpenseFormResult'
import {
  safeReparseMoney,
  splitEqually,
} from '../utils'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { useTripId } from '@/hooks/useTripId'
import { CURRENCY_OPTIONS, currencySymbol } from '@/utils/currency'
import {
  formatMinorAmount,
  formatMinorForInput,
  parseMoneyToMinor,
  currencyFractionDigits,
} from '@/utils/money'
import { compressImage } from '@/utils/image'
import AttachmentPreviewModal from '@/features/bookings/components/AttachmentPreviewModal'

const IMAGE_ACCEPT = 'image/*'
const ANY_ACCEPT   = 'image/*,application/pdf'

const ADJUSTMENT_KIND_LABEL: Record<ExpenseAdjustmentKind, string> = {
  DISCOUNT:   '割引',
  COUPON:     'クーポン',
  TAX_EXEMPT: '免税',
  SURCHARGE:  '追加料金',
  TAX:        '税',
  TIP:        'チップ',
  OTHER:      'その他',
}

const ADJUSTMENT_SCOPE_OPTIONS: { value: ExpenseAdjustmentScope; label: string }[] = [
  { value: 'EXPENSE', label: '全体' },
  { value: 'ITEM',    label: '項目' },
]

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'food',          label: '食事'   },
  { value: 'transport',     label: '交通'   },
  { value: 'accommodation', label: '宿泊'   },
  { value: 'activity',      label: '体験'   },
  { value: 'shopping',      label: '買物'   },
  { value: 'other',         label: 'その他' },
]

// `type` (not `interface`): TS won't widen interfaces to satisfy
// `Record<string, unknown>` since interfaces are open for declaration
// merging. Type aliases are closed and pass useFormReducer's constraint.
type FormState = {
  title:    string
  date:     string
  category: ExpenseCategory
  paidBy:   string
  note:     string
}

export interface ExpenseFormResult {
  input:      CreateExpenseInput
  attachment: AttachmentChange
}

interface Props {
  editTarget:  Expense | null
  defaultDate: string
  members:     TripMember[]
  isOpen:      boolean
  isSaving:    boolean
  onClose:     () => void
  onSave:      (result: ExpenseFormResult) => void
}

/** OCR 等待中的內嵌提示。給使用者三件事:
 *   1) 還在跑(spinner 動)
 *   2) 跑了多久(N.Ns)→ 比純 spinner 安心,知道沒卡死
 *   3) 慢的時候給原因 / 鼓勵繼續等(8s 後切換文案 + 黃色強調)
 *
 * Worker p99 ~5s,8s 為界把「正常」與「比較慢」分開 — slow 路徑
 * 通常是收據複雜 / line items 多 / 字跡模糊,讓使用者知道沒問題、
 * 不要急著按取消。 */
function OcrLoadingHint({ elapsedMs }: { elapsedMs: number }) {
  const elapsedSec = (elapsedMs / 1000).toFixed(1)
  const slow = elapsedMs > 8_000

  return (
    <div
      className={[
        'flex items-start gap-2 px-3 py-2 rounded-input text-[12px] font-medium',
        slow
          ? 'bg-[#FFF4E0] text-[#B5651D] border border-[#F0D49B]'
          : 'bg-teal-pale text-teal',
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      <Loader2 size={14} strokeWidth={2.2} className="animate-spin mt-px shrink-0" />
      <div className="flex-1 min-w-0 leading-[1.45]">
        <div className="flex items-center justify-between gap-2">
          <span>
            {slow ? 'もう少しで完了します…' : '明細を読み取り中…'}
          </span>
          <span className="text-[10.5px] tabular-nums opacity-80 shrink-0">
            {elapsedSec}s
          </span>
        </div>
        <div className="text-[10.5px] opacity-75 mt-0.5">
          {slow
            ? '複雑なレシートは少し時間がかかります'
            : 'Gemini で店名・品目・金額を解析しています'}
        </div>
      </div>
    </div>
  )
}

function initFormState(
  editTarget: Expense | null,
  defaultDate: string,
  members: TripMember[],
): FormState {
  // Money draft (amountText / sourceCurrency / adjustments) moved to
  // useExpenseMoneyDraft; FormState now holds only the non-money fields.
  return {
    title:    editTarget?.title ?? '',
    date:     editTarget?.date ?? defaultDate,
    category: editTarget?.category ?? 'food',
    paidBy:   editTarget?.paidBy ?? members[0]?.id ?? '',
    note:     editTarget?.note ?? '',
  }
}

export default function ExpenseFormModal({
  editTarget, defaultDate, members, isOpen, isSaving, onClose, onSave,
}: Props) {
  const tripCurrency = useTripCurrency()
  const tripId = useTripId()
  const { state, setField } = useFormReducer<FormState>(
    () => initFormState(editTarget, defaultDate, members),
  )
  const splitSeed = editTarget?.sourceSplits !== undefined && editTarget.sourceCurrency
    ? {
        currency: editTarget.sourceCurrency,
        splits:   editTarget.sourceSplits.map(split => ({
          memberId:    split.memberId,
          amountMinor: split.sourceAmountMinor,
        })),
      }
    : undefined
  const splits = useSplitsState(editTarget, members, splitSeed)
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [previewOpen, setPreviewOpen] = useState(false)

  // Money draft — sourceCurrency / amountText / adjustments(+inflight text)
  // / lastForeignCurrency under ONE reducer. `switchCurrency` is the single
  // 「切換幣別」 transition (renormalizes every owned slice in one dispatch).
  const money = useExpenseMoneyDraft(editTarget, tripCurrency)
  const {
    sourceCurrency, amountText, adjustments, lastForeignCurrency,
    setAmountText, switchCurrency,
    addAdjustment, removeAdjustment, dropAdjustmentsForItem,
    setAdjustmentKind, setAdjustmentLabel, setAdjustmentAmount,
    setAdjustmentScope, setAdjustmentTarget, adjustmentAmountValue,
    resetAdjustments, clearAdjustments,
  } = money

  // Phase 3c-1 — foreign-mode derivations. `isForeignOpen` keys every
  // currency-sensitive boundary in the form (parse, format, FX preview,
  // build). State of truth lives in `money.sourceCurrency`; the toggle
  // button below mutates it, the CurrencyPicker re-points it.
  const isForeignOpen     = sourceCurrency !== tripCurrency
  const effectiveCurrency = isForeignOpen ? sourceCurrency : tripCurrency
  // `currency` alias: every existing money parse / format boundary below
  // routes through this name — aliasing here means foreign mode is
  // transparent to the rest of the form (items input symbol, items diff
  // banner, adjustment sign, paid-by avatar caption all DTRT for free).
  const currency          = effectiveCurrency
  const symbol            = currencySymbol(effectiveCurrency)

  // FX preview — only fetches when foreign-open AND inputs are usable
  // (the hook gates internally). Returns null rate while loading /
  // disabled; save-button gate below blocks submission until the rate
  // resolves so buildExpenseFormResult never has to assume a fallback.
  const fxPreview = useFxPreview({
    requestedDate:  state.date,
    sourceCurrency,
    tripCurrency,
  })

  // Receipt attachment — owns the visual preview + file upload state.
  const att = useAttachment({
    url:  editTarget?.receipt?.url  ?? null,
    path: editTarget?.receipt?.path ?? null,
    type: editTarget?.receipt?.type ?? null,
  })

  // By-item state machine. For foreign EDIT the persisted `items` are
  // trip-currency materializations of the receipt; the form must show
  // SOURCE amounts (what the user originally typed), so we seed from
  // `sourceItems` mapping sourceAmountMinor → amountMinor. The hook is
  // currency-agnostic — it parses/formats using whatever currency we
  // pass, so feeding it `effectiveCurrency` makes the by-row inputs DTRT.
  const initialItems: ExpenseItem[] = editTarget?.sourceItems !== undefined
    ? editTarget.sourceItems.map(si => ({
        id:          si.id,
        name:        si.name,
        amountMinor: si.sourceAmountMinor,
        assignees:   si.assignees,
      }))
    : (editTarget?.items ?? [])
  const items = useExpenseItems(initialItems, effectiveCurrency)

  // Single 「切換幣別」 entry point. The money hook renormalizes its owned
  // slices in ONE dispatch (see useExpenseMoneyDraft.switchCurrency +
  // renormalizeMoneyDraftForCurrency) and returns the renormalized items +
  // custom splits, which we apply to the sibling hooks. The toggle button,
  // the CurrencyPicker, and the OCR auto-detect path all go through here.
  function applyCurrencySwitch(next: string) {
    if (next === sourceCurrency) return
    const renorm = switchCurrency(next, {
      items:        items.items,
      customSplits: splits.state.custom,
    })
    items.reset(renorm.items)
    splits.resetCustom(renorm.customSplits)
  }

  // OCR pipeline. onSuccess wires the parsed result into the existing
  // form state — items, adjustments, total, and (when blank) title.
  // Title-fill is intentionally non-destructive: if the user already
  // typed a title, OCR doesn't clobber it.
  //
  // Money: OCR emits decimal strings (amountText / totalText); the
  // client parses each via parseMoneyToMinor at this boundary so
  // everything downstream (items[].amountMinor, total) stays integer.
  //
  // Parse is FAIL-FAST: the Worker schema only validates a currency-
  // agnostic decimal shape, so e.g. Gemini emitting "12.34" for JPY
  // passes the wire but breaks parseMoneyToMinor (JPY has 0 fraction
  // digits). Silently coercing that to 0 would import garbage rows and
  // leak the mismatch into the saved expense. Instead we parse every
  // field up-front, abort on the first failure with a localised error
  // (surfaced through useOcrFlow → receiptErrText banner), and only
  // mutate form state after all parses succeed — partial application
  // is never visible to the user.
  const ocr = useOcrFlow({
    currency: tripCurrency,
    onSuccess: (result) => {
      // Phase 3c-3 — honor OCR-detected receipt currency.
      //
      // The Worker validates only the ISO 4217 SHAPE (^[A-Z]{3}$), so an
      // un-registered code (e.g. CAD) would parse + format here but the
      // CurrencyPicker can't display or switch away from it, trapping the
      // user. Gate on the registry: known codes auto-set sourceCurrency
      // (triggering foreign-mode if it differs from trip), unknown/omitted
      // codes fall back below (see ocrCurrency). For FRESH captures the hook
      // hint is tripCurrency: an ambiguous receipt should not inherit a
      // previously opened foreign picker (e.g. a JPY receipt parsed as USD
      // just because the user last tested USD mode). The existing-receipt
      // re-OCR path hints the draft's own currency instead — a saved foreign
      // expense's currency is known, not ephemeral.
      //
      // The parsing below uses `ocrCurrency` directly (not the React-
      // state `sourceCurrency`) so it doesn't depend on the setField
      // flushing before this closure body finishes. setField schedules
      // a re-render; the form's useExpenseItems / safeReparseMoney pick up
      // the new currency on the next paint.
      const detectedCurrency: string | undefined =
        result.currency && CURRENCY_OPTIONS.some(c => c.code === result.currency)
          ? result.currency
          : undefined
      // Fallback when OCR omits / uses an unregistered currency. A NEW or
      // trip-currency expense has no persisted sourceCurrency → tripCurrency
      // (preserving the "don't inherit an ephemeral picker" intent above,
      // since editTarget.sourceCurrency is the PERSISTED value, not the live
      // toggle). An EXISTING foreign expense keeps its authoritative saved
      // currency rather than snapping back to trip when Gemini can't detect.
      const ocrCurrency = detectedCurrency ?? editTarget?.sourceCurrency ?? tripCurrency

      const strictParse = (text: string, label: string): number => {
        try { return Math.max(0, parseMoneyToMinor(text, ocrCurrency)) }
        catch {
          throw new Error(
            `OCRの金額が${ocrCurrency}の形式と一致しません(${label}: "${text}")。撮り直してください。`,
          )
        }
      }
      // Phase 1: parse ALL fields up-front. Any failure throws before
      // a single setField runs, so the form stays at its prior state
      // and the user sees a single clear error banner.
      const itemMinors = result.items.map((it, i) =>
        strictParse(it.amountText, `item[${i}] ${it.name}`),
      )
      const adjustmentMinors = result.adjustments.map((adj, i) =>
        strictParse(adj.amountText, `adjustment[${i}] ${adj.label}`),
      )
      const totalMinor = strictParse(result.totalText, 'total')

      // Phase 2: all parses succeeded — now mutate form state. Mint
      // item ids first so OCR-emitted ITEM-scope adjustments can resolve
      // `suggestedTargetItemIndex` → `targetItemId` in the same pass.
      // Items reset to assignees=[] (Phase B contract: assignee picking
      // is a deliberate user action).
      //
      // Auto-set sourceCurrency BEFORE the other field updates so React
      // batches them in a single render — avoids a "trip currency for
      // one tick, then detected currency" flash on the items list.
      if (ocrCurrency !== sourceCurrency) {
        applyCurrencySwitch(ocrCurrency)
      }
      const mintedItemIds = result.items.map(() => crypto.randomUUID())
      items.reset(result.items.map((it, idx) => ({
        id:          mintedItemIds[idx]!,
        name:        it.name,
        amountMinor: itemMinors[idx]!,
        amountText:  formatMinorForInput(itemMinors[idx]!, ocrCurrency),
        assignees:   [],
      })))
      // Translate OCR adjustment drafts to persisted shape. UNKNOWN
      // scope defaults to EXPENSE (Phase B contract: persisted scope
      // is binary; the visible adjustment row lets the user switch it
      // back to ITEM when the receipt clearly ties it to one line).
      // ITEM scope falls back to EXPENSE if the target index is missing
      // or out-of-range — defensive against OCR producing a partial /
      // malformed adjustment payload.
      const nextAdjustments = result.adjustments.map((adj, i) => {
        const idx = adj.suggestedTargetItemIndex
        const itemTarget =
          adj.suggestedScope === 'ITEM' &&
          idx !== undefined &&
          idx >= 0 &&
          idx < mintedItemIds.length
            ? mintedItemIds[idx]
            : undefined
        const minor = adjustmentMinors[i]!
        return itemTarget
          ? {
              id:           crypto.randomUUID(),
              label:        adj.label,
              kind:         adj.kind,
              scope:        'ITEM' as const,
              amountMinor:  minor,
              targetItemId: itemTarget,
            }
          : {
              id:          crypto.randomUUID(),
              label:       adj.label,
              kind:        adj.kind,
              scope:       'EXPENSE' as const,
              amountMinor: minor,
            }
      })
      resetAdjustments(
        nextAdjustments,
        Object.fromEntries(
          nextAdjustments.map(adj => [
            adj.id,
            adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, ocrCurrency) : '',
          ]),
        ),
      )
      setAmountText(formatMinorForInput(totalMinor, ocrCurrency))
      if (result.storeName && !state.title.trim()) {
        setField('title', result.storeName)
      }
      // Category: 只在新增模式套用。拍照即「請幫我自動分類」的意圖,
      // 直接覆寫預設值('food')。edit 模式絕對不覆寫 — 使用者已選的
      // category 是 ground truth,不應因為重新跑 OCR 而被改掉。
      if (result.category && !editTarget) {
        setField('category', result.category)
      }
      setErrors(prev => ({ ...prev, items: '' }))
    },
  })

  // Two separate <input>s. We CAN'T detect "camera vs gallery" from a
  // single input — the browser doesn't tell us which option the user
  // picked. So the UX branches on which button was tapped:
  //   - camera button → capture=environment → auto-OCR on result
  //   - upload button → no capture → manual "✨ 解析" button
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const titleRef  = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  // Pre-compress at pick-time so both the OCR worker call AND the eventual
  // Storage upload share the same already-small WebP. Without this we ran
  // compressImage TWICE per save (once in OCR pipeline, once in
  // uploadReceipt), which on a 12MP camera capture meant 2-4s of canvas
  // re-encoding stacked on the save path — felt indistinguishable from
  // "stuck on saving" to the user.
  //
  // HEIC / PDF / decode failures fall through compressImage unchanged, so
  // the original File flows on. catch() swallows any unexpected throw and
  // falls back to the original — we never want a quirky image format to
  // block the user from attaching anything.
  async function compressForUpload(f: File): Promise<File> {
    try {
      const { full } = await compressImage(f)
      return full
    } catch {
      return f
    }
  }

  async function onCameraPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const small = await compressForUpload(f)
    att.pickFile(small)
    void ocr.run(small)
  }
  async function onUploadPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const small = await compressForUpload(f)
    att.pickFile(small)
    ocr.setFile(small)
  }
  function handleClearReceipt() {
    att.clear()
    items.clear()
    clearAdjustments()
    ocr.reset()
  }

  // Adjustment state + mutators (addAdjustment / removeAdjustment /
  // setAdjustmentKind|Label|Amount|Scope|Target / adjustmentAmountValue)
  // now live in useExpenseMoneyDraft and are destructured above.

  function removeItemRow(index: number) {
    const removedId = items.items[index]?.id
    items.remove(index)
    if (!removedId) return
    // Drop any ITEM-scope adjustment that targeted the removed row.
    dropAdjustmentsForItem(removedId)
  }

  // All money in form derivations is integer minor units. The user types
  // a decimal string into the amount field; safeReparseMoney is the
  // boundary that converts it (centralised in expense/utils so the
  // currency-switch reparse path uses the same try/catch + clamp).
  const amountMinor = safeReparseMoney(amountText, currency)
  // Phase 3c-1 — trip-currency preview of the source-side amount. Inline
  // mirror of the conversion the materializer runs at save-time; used only
  // for the "USD 12.34 → ¥1804 @ 146.2" display row. Save-time math runs
  // through `convertAndMaterializeFromSource`, so any drift here would be
  // caught (and rejected) by the Worker recompute anyway. null = either
  // not foreign-open, no rate yet, or user hasn't typed an amount.
  const foreignLinePreview =
    isForeignOpen && fxPreview.rateDecimal && amountMinor > 0
      ? (() => {
          const sourceFractionDigits = currencyFractionDigits(sourceCurrency)
          const targetFractionDigits = currencyFractionDigits(tripCurrency)
          const convertPreviewMinor = (sourceMinor: number): number | undefined => {
            if (!Number.isInteger(sourceMinor) || sourceMinor <= 0) return undefined
            return convertMinorHalfEven({
              sourceMinor,
              rateDecimal: fxPreview.rateDecimal!,
              sourceFractionDigits,
              targetFractionDigits,
            })
          }
          try {
            const converted = convertSourceLinesToTarget({
              sourceItems: items.items.map(item => ({
                id:          item.id,
                amountMinor: item.amountMinor,
              })),
              sourceAdjustments: adjustments.map(adj => ({
                id:           adj.id,
                kind:         adj.kind,
                scope:        adj.scope,
                amountMinor:  adj.amountMinor,
                targetItemId: adj.targetItemId,
              })),
              sourceAmountMinor:    amountMinor,
              rateDecimal:          fxPreview.rateDecimal,
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
            // Draft editing can be temporarily out of balance
            // (items + adjustments != total). Do not hide every per-line
            // FX hint in that state; show independent approximate line
            // conversions and let buildExpenseFormResult/Worker enforce the
            // exact materialized total on save.
            const convertedAmount = convertPreviewMinor(amountMinor)
            if (convertedAmount === undefined) return null

            const itemAmountById = new Map<string, number>()
            for (const item of items.items) {
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

            return {
              amountMinor: convertedAmount,
              itemAmountById,
              adjustmentAmountById,
            }
          }
        })()
      : null
  const previewConvertedMinor: number | null =
    foreignLinePreview?.amountMinor ??
    (isForeignOpen && fxPreview.rateDecimal && amountMinor > 0
      ? convertMinorHalfEven({
          sourceMinor:          amountMinor,
          rateDecimal:          fxPreview.rateDecimal,
          sourceFractionDigits: currencyFractionDigits(sourceCurrency),
          targetFractionDigits: currencyFractionDigits(tripCurrency),
        })
      : null)
  // Net effect of adjustments (signed). DISCOUNT/COUPON/TAX_EXEMPT/OTHER
  // subtract; SURCHARGE/TAX/TIP add. Same sign convention used by the
  // materializer — adjustmentSign is exported so the form can mirror
  // the math without re-deriving it.
  const adjustmentNetMinor  = adjustments.reduce((s, a) => s + adjustmentSign(a.kind) * a.amountMinor, 0)
  // Effective post-adjustment total. The sum-check banner compares this
  // (not raw items.sum) to amountMinor, so receipts with discounts don't
  // look like a "超過" error.
  const effectiveItemsTotal = items.sum + adjustmentNetMinor
  const itemsDiff           = amountMinor - effectiveItemsTotal
  const includedArr = members.map(m => m.id).filter(id => splits.state.included.has(id))
  const equalSplits: Record<string, number> = Object.fromEntries(
    splitEqually(amountMinor, includedArr).map(s => [s.memberId, s.amountMinor]),
  )

  function customAmountOf(id: string): number {
    const text = splits.state.custom[id]
    if (typeof text !== 'string') return 0
    return safeReparseMoney(text, currency)
  }
  const customSum  = members.reduce((s, m) => s + customAmountOf(m.id), 0)
  const customDiff = amountMinor - customSum

  function switchMode(mode: SplitMode) {
    const seed: Record<string, string> = {}
    members.forEach(m => {
      const v = equalSplits[m.id] ?? 0
      seed[m.id] = v > 0 ? formatMinorForInput(v, currency) : ''
    })
    splits.switchMode(mode, seed)
  }

  function handleSave() {
    // Financial assembly + validation now lives in the pure
    // `buildExpenseFormResult` (services/buildExpenseFormResult.ts) so it can
    // be unit-tested without the component. The two side effects stay here:
    //   - setErrors:               drive the inline field banners
    //   - att.pickAttachmentChange: pull the receipt lifecycle into onSave
    const result = buildExpenseFormResult({
      title:          state.title,
      amountText:     amountText,
      date:           state.date,
      category:       state.category,
      paidBy:         state.paidBy,
      note:           state.note,
      sourceCurrency: sourceCurrency,
      // Strip the form-only `amountText` — the builder works in minor units.
      items: items.items.map(it => ({
        id:          it.id,
        name:        it.name,
        amountMinor: it.amountMinor,
        assignees:   it.assignees,
      })),
      adjustments,
      splitMode:     splits.state.mode,
      includedIds:   [...splits.state.included],
      customAmounts: splits.state.custom,
      tripCurrency,
      memberIds:     members.map(m => m.id),
      fx: {
        rateDecimal:    fxPreview.rateDecimal,
        disabledReason: fxPreview.disabledReason,
        isError:        fxPreview.isError,
      },
    })
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSave({ input: result.input, attachment: att.pickAttachmentChange() })
  }

  // ─── Receipt section helpers ────────────────────────────────────────
  const receiptErrText = att.error ?? ocr.error ?? undefined
  // Re-OCR has two sources: a freshly-picked File (camera/upload → compress
  // → /ocr) or an EXISTING saved receipt (edit; only a URL → the Worker
  // /expense-receipt-ocr route reads receipt.path from the doc). Both feed
  // the same onSuccess. Existing-receipt is cloud-only (needs a real tripId)
  // and only for image receipts.
  const existingImageReceipt =
    !ocr.lastFile &&
    !!tripId &&
    !!editTarget?.id &&
    !!editTarget.receipt?.path &&
    (editTarget.receipt?.type.startsWith('image/') ?? false)
  const hasOcrSource = !!ocr.lastFile || existingImageReceipt

  function runReceiptOcr() {
    if (ocr.lastFile) { void ocr.run(ocr.lastFile); return }
    if (!tripId || !editTarget?.id || !editTarget.receipt?.path) return
    // Race snapshot captured at click time. The result is discarded unless,
    // when it returns, the Worker OCR'd the SAME receipt path AND (when both
    // sides carry it) the expense's updatedAt is unchanged — i.e. the
    // receipt wasn't swapped and the expense wasn't edited elsewhere while
    // the request was in flight. Worker re-OCR never re-uploads; only the
    // draft fields change, so SAVE still routes through /expense-update.
    const capturedPath   = editTarget.receipt.path
    const capturedMillis = editTarget.updatedAt?.toMillis?.()
    void ocr.runExisting({
      tripId,
      expenseId:    editTarget.id,
      // Hint the draft's CURRENT currency (foreign code when this is a
      // foreign expense), not tripCurrency — re-OCRing a saved foreign
      // receipt should bias Gemini toward the known currency rather than
      // risk it being reparsed as the trip currency.
      currencyHint: effectiveCurrency,
      isStillApplicable: (sourceReceiptPath, expenseUpdatedAt) =>
        ocrResultStillApplicable(
          { receiptPath: capturedPath, updatedAtMillis: capturedMillis },
          { sourceReceiptPath, expenseUpdatedAt },
        ),
    })
  }

  const canAnalyze   = att.hasAttachment && att.previewIsImage && !ocr.loading && !items.hasItems && hasOcrSource
  const canReanalyze = att.hasAttachment && att.previewIsImage && !ocr.loading && items.hasItems  && hasOcrSource

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '費用を編集' : '費用を追加'}
      saveLabel={editTarget ? '変更を保存' : '費用を追加'}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="タイトル" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder="例：壽司大 築地"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="カテゴリ">
        {/* Single-row compact chips — emoji + tighter padding lets all 6
            sit on one line down to ~340px viewport. Wrapping is still
            allowed as a safety net (narrow phones / accessibility zoom). */}
        <div className="flex gap-1.5 flex-wrap">
          {CATEGORIES.map(c => {
            const active = state.category === c.value
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setField('category', c.value)}
                className={[
                  'flex items-center gap-1 px-2 py-1 rounded-card text-[11px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-muted font-normal hover:border-muted',
                ].join(' ')}
              >
                <span className="text-[13px] leading-none">{CATEGORY_EMOJI[c.value]}</span>{c.label}
              </button>
            )
          })}
        </div>
      </FormField>

      {/* レシート appears EARLY in the form because OCR auto-fills 金額 +
          明細 below. Putting it after 金額 would mean the user types an
          amount only to have OCR overwrite it. */}
      <FormField label="レシート（任意）" error={receiptErrText}>
        <input ref={cameraRef} type="file" accept={IMAGE_ACCEPT} capture="environment" onChange={onCameraPicked} className="hidden" />
        <input ref={uploadRef} type="file" accept={ANY_ACCEPT}                          onChange={onUploadPicked} className="hidden" />

        {att.hasAttachment ? (
          <div className="flex flex-col gap-2">
            <AttachmentRow
              fileName={att.attachmentName}
              previewUrl={att.previewUrl}
              isImage={att.previewIsImage}
              onReplace={() => uploadRef.current?.click()}
              onClear={handleClearReceipt}
              onPreview={() => att.previewUrl && setPreviewOpen(true)}
              replaceAriaLabel="レシートを変更"
              previewAriaLabel="レシートを拡大表示"
              clearAriaLabel="レシートを削除"
            />

            {/* Manual read-items button (only when not yet OCR'd). ScanLine
                + "読み取る" reads as scanning a receipt, not AI magic. */}
            {canAnalyze && (
              <button
                type="button"
                onClick={runReceiptOcr}
                className="w-full h-10 rounded-input bg-teal text-white text-[13px] font-bold border-none cursor-pointer flex items-center justify-center gap-2 transition-all hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
              >
                <ScanLine size={16} strokeWidth={2.2} />
                明細を読み取る
              </button>
            )}

            {canReanalyze && (
              <button
                type="button"
                onClick={runReceiptOcr}
                className="flex items-center gap-1 text-[11.5px] text-accent font-medium border-none bg-transparent p-0 cursor-pointer hover:underline self-start"
              >
                <ScanLine size={12} strokeWidth={2} />
                もう一度読み取る
              </button>
            )}

            {ocr.loading && <OcrLoadingHint elapsedMs={ocr.elapsedMs} />}
          </div>
        ) : (
          // Compact dual-button (52px instead of 68px). Receipt is an
          // optional add-on, not a hero action — the previous chunky
          // empty state pulled too much attention from the rest of
          // the form. Inline icon + label fits in single row at 52px.
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="h-[52px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[11.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer hover:border-accent hover:text-accent transition-colors"
            >
              <Camera size={16} strokeWidth={1.8} />
              <span>撮影</span>
            </button>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              className="h-[52px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[11.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer hover:border-accent hover:text-accent transition-colors"
            >
              <Upload size={15} strokeWidth={1.8} />
              <span>ファイルから追加</span>
            </button>
          </div>
        )}
      </FormField>

      {/* Phase 3c-1 — foreign-mode toggle. Always-visible full-row button
          (≥48px tap target) above the amount field so it reads as "the
          currency for the next row" rather than a buried setting. The
          section below is conditionally rendered (not just visually
          hidden) so aria-expanded ↔ presence stays in sync for AT users.
          State of truth lives in `sourceCurrency` — toggling here
          flips it between trip-currency (degenerate / closed) and
          `defaultForeignCurrencyFor(tripCurrency)`. Picking trip-currency
          inside the picker also collapses the section (degenerate path),
          giving users two equivalent exits. */}
      <button
        type="button"
        onClick={() => applyCurrencySwitch(
          isForeignOpen ? tripCurrency : lastForeignCurrency,
        )}
        aria-expanded={isForeignOpen}
        aria-controls="foreign-currency-fields"
        className={[
          'w-full min-h-12 px-3 rounded-input border-[1.5px] text-[13px] font-semibold',
          'flex items-center justify-between gap-2 cursor-pointer transition-colors',
          isForeignOpen
            ? 'border-accent bg-accent-pale text-accent'
            : 'border-border bg-app text-muted hover:border-accent hover:text-accent',
        ].join(' ')}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Globe size={14} strokeWidth={2} className="shrink-0" />
          <span className="truncate">
            {isForeignOpen ? `${tripCurrency}で入力に戻す` : '別の通貨で入力'}
          </span>
        </span>
        {isForeignOpen && (
          <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums opacity-80">
            {sourceCurrency} → {tripCurrency}
          </span>
        )}
      </button>

      {isForeignOpen && (
        <section id="foreign-currency-fields" className="flex flex-col gap-2">
          <FormField label="入力する通貨">
            <CurrencyPicker
              value={sourceCurrency}
              onChange={applyCurrencySwitch}
            />
            <p className="text-[11px] leading-relaxed text-muted">
              入力した金額を{tripCurrency}に換算して保存します
            </p>
          </FormField>
        </section>
      )}

      <div className="flex gap-2.5">
        <FormField label={`金額（${symbol}）`} error={errors.amount} required className="flex-1">
          <CurrencyInput
            symbol={symbol}
            value={amountText}
            onChange={e => setAmountText(e.target.value)}
            placeholder="0"
            error={!!errors.amount}
          />
        </FormField>
        <FormField label="日付" error={errors.date} required className="flex-1">
          <DatePicker value={state.date} onChange={v => setField('date', v)} error={!!errors.date} />
        </FormField>
      </div>

      {/* Phase 3c-1 — inline FX preview. Four render states:
          - loading:  spinner + "rate will be finalized on save"
          - error:    neutral "Worker will retry on save" copy
          - blocked:  future/invalid inputs that Worker would also reject
          - success:  「{source} → {trip} @ {rate} ({rateDate})」 with both
                      sides rendered via the canonical money formatter so
                      symbols / fraction digits match the rest of the form.
          Only renders when foreign-open; same-currency keeps the form
          layout unchanged. */}
      {isForeignOpen && (
        <div
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 px-3 py-2 rounded-input text-[12px] font-medium',
            // Warn for terminal "no rate" states — submit will be
            // blocked by the buildExpenseFormResult FX gate, so the banner must
            // read as actionable. Loading stays teal-pale (transient,
            // shows a spinner) so it doesn't masquerade as an error.
            fxPreview.disabledReason || fxPreview.isError
              ? 'bg-warn-bg text-warn border border-warn'
              : 'bg-teal-pale text-teal',
          ].join(' ')}
        >
          {fxPreview.disabledReason === 'future-date' ? (
            <span>未来日付は換算できません。日付を変更してください。</span>
          ) : fxPreview.disabledReason === 'invalid-input' ? (
            <span>通貨または日付を確認してください。</span>
          ) : fxPreview.isLoading ? (
            <>
              <Loader2 size={14} strokeWidth={2.2} className="animate-spin shrink-0" />
              <span>換算レートを取得中…</span>
            </>
          ) : fxPreview.isError || !fxPreview.rateDecimal ? (
            <span>換算レートを取得できません。再試行してください。</span>
          ) : previewConvertedMinor !== null ? (
            <div className="flex-1 min-w-0 flex flex-col gap-1 tabular-nums sm:flex-row sm:items-baseline sm:justify-between">
              <span className="min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-5">
                <span>{formatMinorAmount(amountMinor, sourceCurrency)}</span>
                <span className="opacity-60">→</span>
                <span className="font-semibold">
                  {formatMinorAmount(previewConvertedMinor, tripCurrency)}
                </span>
              </span>
              <span className="shrink-0 whitespace-nowrap text-[10.5px] opacity-75">
                @ {fxPreview.rateDecimal} ({fxPreview.rateDate})
              </span>
            </div>
          ) : (
            <span>レート {fxPreview.rateDecimal}（{fxPreview.rateDate}）— 金額を入力してください</span>
          )}
        </div>
      )}

      <FormField label="立替えた人" error={errors.paidBy} required>
        {/* Avatar-only dot picker. The label inside the avatar IS the
            visual identifier (1-2 char initials with member colors), so
            a separate chip label would be redundant. Selected gets an
            accent ring offset, unselected fades to 60% opacity — same
            language as iOS Maps' transport-mode picker. */}
        <div className="flex gap-3 flex-wrap items-center">
          {members.map(m => {
            const active = state.paidBy === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setField('paidBy', m.id)}
                aria-label={`立替: ${m.label}`}
                aria-pressed={active}
                className={[
                  'p-0 bg-transparent border-none cursor-pointer rounded-full transition-all',
                  active
                    ? 'ring-2 ring-accent ring-offset-2 ring-offset-app scale-110'
                    : 'opacity-55 hover:opacity-100',
                ].join(' ')}
              >
                <MemberAvatar member={m} size={32} />
              </button>
            )
          })}
        </div>
      </FormField>

      {/* By-item mode replaces the 均等/カスタム block entirely. The
          two modes share `splits` semantics downstream — only the input
          UX differs. */}
      {items.hasItems ? (
        <FormField label="明細（各項目に分担者を選択）" error={errors.items}>
          <div className="flex flex-col gap-2">
            {/* Single bordered container holding all rows with hairline
                separators (divide-y) instead of each row being its own
                bordered card. Cuts row visual weight by ~25% and reads
                as a unified list — closer to Splitwise / native iOS
                table patterns than the previous "stack of cards". */}
            <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
              {items.items.map((it, i) => {
                const convertedItemAmount = foreignLinePreview?.itemAmountById.get(it.id)
                return (
                <div key={it.id} className="flex flex-col gap-1.5 px-2.5 py-2.5">
                  {/* Row 1: name + amount. Amount widened to 120px (was 100px)
                      so 5-digit JPY values like ¥10,000 fit without clipping.
                      Removed delete button from this row — it was crowding
                      both inputs. Delete moved to row 2's trailing edge. */}
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
                    {/* Font-size MUST be 16px or larger — iOS Safari auto-zooms
                        the viewport on focus of any input below 16px. Keep
                        compact rows descender-safe with explicit leading/padding. */}
                    <input
                      value={it.name}
                      onChange={e => items.setName(i, e.target.value)}
                      placeholder="項目名"
                      className={compactInputClass(false)}
                    />
                    <div className="min-w-0">
                      <CurrencyInput
                        symbol={symbol}
                        size="compact"
                        alignRight
                        shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                        value={it.amountText}
                        onChange={e => items.setAmount(i, e.target.value)}
                        placeholder="0"
                      />
                      {convertedItemAmount !== undefined && (
                        <div className="mt-1 text-right text-[10.5px] font-semibold text-muted tabular-nums">
                          ≈ {formatMinorAmount(convertedItemAmount, tripCurrency)}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 2: assignee chips + delete trailing.
                      Splitwise-style "primary action area / cleanup tail". */}
                  <div className="flex items-center gap-1.5">
                    <div className="flex gap-1 flex-wrap flex-1 min-w-0">
                      {members.map(m => (
                        <MemberChip
                          key={m.id}
                          member={m}
                          active={it.assignees.includes(m.id)}
                          onClick={() => items.toggleAssignee(i, m.id)}
                          size="sm"
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItemRow(i)}
                      aria-label={`行 ${i + 1} を削除`}
                      className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
                )
              })}
            </div>

            {adjustments.length > 0 && (
              <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
                <div className="px-2.5 py-2 text-[11px] font-semibold text-muted">
                  割引・税・調整
                </div>
                {adjustments.map((adj, i) => {
                  const sign = adjustmentSign(adj.kind)
                  const convertedAdjustmentAmount = foreignLinePreview?.adjustmentAmountById.get(adj.id)
                  return (
                    <div key={adj.id} className="flex flex-col gap-2 px-2.5 py-2.5">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
                        <input
                          value={adj.label}
                          onChange={e => setAdjustmentLabel(adj.id, e.target.value)}
                          placeholder={`調整 ${i + 1}`}
                          aria-label={`調整 ${i + 1} ラベル`}
                          className={compactInputClass(false)}
                        />
                        <div className="min-w-0">
                          <CurrencyInput
                            symbol={`${sign < 0 ? '-' : '+'}${symbol}`}
                            size="compact"
                            alignRight
                            shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                            value={adjustmentAmountValue(adj)}
                            onChange={e => setAdjustmentAmount(adj.id, e.target.value)}
                            placeholder="0"
                            aria-label={`調整 ${i + 1} 金額`}
                          />
                          {convertedAdjustmentAmount !== undefined && (
                            <div className="mt-1 text-right text-[10.5px] font-semibold text-muted tabular-nums">
                              ≈ {sign < 0 ? '-' : '+'}{formatMinorAmount(convertedAdjustmentAmount, tripCurrency)}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
                        <select
                          value={adj.kind}
                          onChange={e => setAdjustmentKind(adj.id, e.target.value as ExpenseAdjustmentKind)}
                          aria-label={`調整 ${i + 1} 種類`}
                          className={compactInputClass(false)}
                        >
                          {EXPENSE_ADJUSTMENT_KINDS.map(kind => (
                            <option key={kind} value={kind}>{ADJUSTMENT_KIND_LABEL[kind]}</option>
                          ))}
                        </select>

                        <select
                          value={adj.scope}
                          onChange={e => setAdjustmentScope(adj.id, e.target.value as ExpenseAdjustmentScope, items.items.map(i => i.id))}
                          aria-label={`調整 ${i + 1} 対象範囲`}
                          className={compactInputClass(false)}
                        >
                          {ADJUSTMENT_SCOPE_OPTIONS.map(scope => (
                            <option key={scope.value} value={scope.value}>{scope.label}</option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => removeAdjustment(adj.id)}
                          aria-label={`調整 ${i + 1} を削除`}
                          className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
                        >
                          <Trash2 size={13} strokeWidth={2} />
                        </button>
                      </div>

                      {adj.scope === 'ITEM' && (
                        <select
                          value={adj.targetItemId ?? ''}
                          onChange={e => setAdjustmentTarget(adj.id, e.target.value)}
                          aria-label={`調整 ${i + 1} 対象項目`}
                          className={compactInputClass(false)}
                        >
                          <option value="" disabled>対象項目を選択</option>
                          {items.items.map((item, itemIndex) => (
                            <option key={item.id} value={item.id}>
                              {item.name.trim() || `行 ${itemIndex + 1}`}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 「行」と「調整」を同列に並べることで「OCRが拾えなかった
                クーポン/税は手で足せる」というメンタルモデルを明示する。
                Phase Bで負金額itemが封じられた今、ここがズレ補正の唯一の
                正規ルート。 */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={items.add}
                className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
              >
                <Plus size={14} strokeWidth={2} />
                行を追加
              </button>
              <button
                type="button"
                onClick={addAdjustment}
                className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
              >
                <Plus size={14} strokeWidth={2} />
                調整を追加
              </button>
            </div>

            {/* Sum check — compares the post-adjustment effective total
                to the bill total. Same green/red pattern as カスタム split. */}
            {amountMinor > 0 && (
              <div
                className={[
                  'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
                  itemsDiff === 0
                    ? 'bg-teal-pale text-teal'
                    : 'bg-warn-bg text-warn',
                ].join(' ')}
              >
                <span>
                  {itemsDiff === 0 ? '✓ 合計一致' : itemsDiff > 0 ? '不足' : '超過'}
                </span>
                <span>
                  {formatMinorAmount(effectiveItemsTotal, currency)} / {formatMinorAmount(amountMinor, currency)}
                  {itemsDiff !== 0 && (
                    <span className="ml-1.5">({itemsDiff > 0 ? '+' : ''}{formatMinorAmount(itemsDiff, currency)})</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </FormField>
      ) : (
        <FormField label="割り勘" error={errors.splits}>
          <div className="flex flex-col gap-2">
            {/* 割勘方式切換 */}
            <div className="flex gap-1 p-1 rounded-card bg-app border border-border">
              {([
                { value: 'equal',  label: '均等' },
                { value: 'custom', label: 'カスタム' },
              ] as const).map(m => {
                const active = splits.state.mode === m.value
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => switchMode(m.value)}
                    className={[
                      'flex-1 h-8 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all',
                      active ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'bg-transparent text-muted',
                    ].join(' ')}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>

            <div className="flex flex-col gap-1.5">
              {members.map(m => {
                const included = splits.state.mode === 'equal'
                  ? splits.state.included.has(m.id)
                  : customAmountOf(m.id) > 0
                const displayAmount = splits.state.mode === 'equal'
                  ? (equalSplits[m.id] ?? 0)
                  : customAmountOf(m.id)

                return (
                  <div
                    key={m.id}
                    className={[
                      'flex items-center gap-2.5 px-2.5 py-1.5 rounded-input border-[1.5px] transition-colors',
                      included ? 'border-border bg-surface' : 'border-border bg-app opacity-55',
                    ].join(' ')}
                  >
                    <MemberAvatar member={m} size={28} />
                    <span className="flex-1 text-[13px] text-ink font-medium">{m.label}</span>

                    {splits.state.mode === 'equal' ? (
                      <>
                        <span className="text-[13px] font-semibold text-ink tabular-nums">
                          {included ? formatMinorAmount(displayAmount, currency) : '—'}
                        </span>
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => splits.toggleIncluded(m.id)}
                          className="w-4 h-4 accent-accent cursor-pointer"
                        />
                      </>
                    ) : (
                      <div className="w-[110px]">
                        <CurrencyInput
                          symbol={symbol}
                          size="compact"
                          alignRight
                          shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                          value={splits.state.custom[m.id] ?? ''}
                          onChange={e => splits.setCustom(m.id, e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {splits.state.mode === 'custom' && amountMinor > 0 && (
              <div
                className={[
                  'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
                  customDiff === 0
                    ? 'bg-teal-pale text-teal'
                    : 'bg-warn-bg text-warn',
                ].join(' ')}
              >
                <span>
                  {customDiff === 0 ? '✓ 總和一致' : customDiff > 0 ? '残り' : '超過'}
                </span>
                <span>
                  {formatMinorAmount(customSum, currency)} / {formatMinorAmount(amountMinor, currency)}
                  {customDiff !== 0 && (
                    <span className="ml-1.5">({customDiff > 0 ? '+' : ''}{formatMinorAmount(customDiff, currency)})</span>
                  )}
                </span>
              </div>
            )}
          </div>
        </FormField>
      )}

      <FormField label="メモ">
        <textarea
          value={state.note}
          onChange={e => setField('note', e.target.value)}
          placeholder="備考など"
          rows={2}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {previewOpen && att.previewUrl && (
        <AttachmentPreviewModal
          url={att.previewUrl}
          fileType={att.previewMime}
          fileName={att.attachmentName}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </FormModalShell>
  )
}
