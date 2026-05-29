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
import { Camera, Loader2, Plus, ScanLine, Trash2, Upload } from 'lucide-react'
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type Expense,
  type ExpenseAdjustment,
  type ExpenseAdjustmentKind,
  type ExpenseAdjustmentScope,
  type ExpenseCategory,
  type ExpenseSplit,
  type CreateExpenseInput,
} from '@/types'
import type { TripMember } from '@/features/trips/types'
import {
  adjustmentSign,
  materializeExpenseSplits,
  MaterializeError,
} from '@tripmate/expense-materialize'
import FormModalShell from '@/components/ui/FormModalShell'
import { DatePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberChip from '@/components/ui/MemberChip'
import MemberAvatar from '@/components/ui/MemberAvatar'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useSplitsState, type SplitMode } from '../hooks/useSplitsState'
import { useExpenseItems } from '../hooks/useExpenseItems'
import { useOcrFlow } from '../hooks/useOcrFlow'
import { splitEqually } from '../utils'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { currencySymbol } from '@/utils/currency'
import {
  formatMinorAmount,
  formatMinorForInput,
  parseMoneyToMinor,
  parseMoneyToMinorResult,
  currencyFractionDigits,
  type MoneyParseErrorReason,
} from '@/utils/money'
import { compressImage } from '@/utils/image'
import AttachmentPreviewModal from '@/features/bookings/components/AttachmentPreviewModal'

const IMAGE_ACCEPT = 'image/*'
const ANY_ACCEPT   = 'image/*,application/pdf'

// NON_POSITIVE is UI-only: parseMoneyToMinor happily returns 0 / negative
// (refunds are legitimate at parser level), but the expense form rejects
// non-positive totals. Keeping it out of MoneyParseErrorReason preserves
// the parser's "0 / -1 are valid integers" contract; lifting it into this
// UI-facing union lets one mapper own every amount-field error message.
type AmountErrorReason = MoneyParseErrorReason | 'NON_POSITIVE'

// User-facing message for an amount-field error. Adding a new reason
// to MoneyParseErrorReason (or AmountErrorReason) forces a switch arm
// here — TS exhaustiveness covers the gap. DECIMALS_FORBIDDEN +
// NON_POSITIVE were both originally collapsed into a misleading
// "請輸入金額" (= "enter an amount").
function moneyErrorMessage(reason: AmountErrorReason, currency: string): string {
  switch (reason) {
    case 'EMPTY':
      return '金額を入力してください'
    case 'NON_POSITIVE':
      return '金額は0より大きく入力してください'
    case 'DECIMALS_FORBIDDEN':
      return `${currency} は小数を入力できません`
    case 'TOO_MANY_DECIMALS':
      return `${currency} は小数第${currencyFractionDigits(currency)}位まで入力できます`
    case 'MALFORMED':
      return '金額の形式が正しくありません'
    case 'OUT_OF_RANGE':
      return '金額が大きすぎます'
    case 'EXPECTED_STRING':
      return '金額の形式が正しくありません'
  }
}

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
  title:      string
  /** Raw decimal string the user types (e.g. "12.34" / "1200"). The
   *  canonical integer minor amount is rederived at validate-time via
   *  parseMoneyToMinor — wire never carries the float. */
  amountText: string
  date:       string
  category:   ExpenseCategory
  paidBy:     string
  note:       string
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
  return {
    title:      editTarget?.title ?? '',
    amountText: editTarget ? formatMinorForInput(editTarget.amountMinor, editTarget.currency) : '',
    date:       editTarget?.date ?? defaultDate,
    category:   editTarget?.category ?? 'food',
    paidBy:     editTarget?.paidBy ?? members[0]?.id ?? '',
    note:       editTarget?.note ?? '',
  }
}

export default function ExpenseFormModal({
  editTarget, defaultDate, members, isOpen, isSaving, onClose, onSave,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(
    () => initFormState(editTarget, defaultDate, members),
  )
  const splits = useSplitsState(editTarget, members)
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  const currency = useTripCurrency()
  const symbol   = currencySymbol(currency)

  // Receipt attachment — owns the visual preview + file upload state.
  const att = useAttachment({
    url:  editTarget?.receipt?.url  ?? null,
    path: editTarget?.receipt?.path ?? null,
    type: editTarget?.receipt?.type ?? null,
  })

  // By-item state machine
  const items = useExpenseItems(editTarget?.items ?? [], currency)

  // Phase B: adjustments are a separate state slice. OCR populates
  // them, the form exposes the rows for correction, and save-time
  // materialization is the single source of split truth. A later UI pass
  // can add richer confidence chips, but Phase B must not hide financial
  // adjustments from the user.
  const [adjustments, setAdjustments] = useState<ExpenseAdjustment[]>(
    editTarget?.adjustments ?? [],
  )

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
    currency,
    onSuccess: (result) => {
      const strictParse = (text: string, label: string): number => {
        try { return Math.max(0, parseMoneyToMinor(text, currency)) }
        catch {
          throw new Error(
            `OCRの金額が${currency}の形式と一致しません(${label}: "${text}")。撮り直してください。`,
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
      const mintedItemIds = result.items.map(() => crypto.randomUUID())
      items.reset(result.items.map((it, idx) => ({
        id:          mintedItemIds[idx]!,
        name:        it.name,
        amountMinor: itemMinors[idx]!,
        amountText:  formatMinorForInput(itemMinors[idx]!, currency),
        assignees:   [],
      })))
      // Translate OCR adjustment drafts to persisted shape. UNKNOWN
      // scope defaults to EXPENSE (Phase B contract: persisted scope
      // is binary; the visible adjustment row lets the user switch it
      // back to ITEM when the receipt clearly ties it to one line).
      // ITEM scope falls back to EXPENSE if the target index is missing
      // or out-of-range — defensive against OCR producing a partial /
      // malformed adjustment payload.
      setAdjustments(result.adjustments.map((adj, i) => {
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
      }))
      setField('amountText', formatMinorForInput(totalMinor, currency))
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
    setAdjustments([])
    ocr.reset()
  }

  function updateAdjustment(
    id: string,
    mapper: (adjustment: ExpenseAdjustment) => ExpenseAdjustment,
  ) {
    setAdjustments(prev => prev.map(adj => adj.id === id ? mapper(adj) : adj))
  }

  function setAdjustmentKind(id: string, kind: ExpenseAdjustmentKind) {
    updateAdjustment(id, adj => ({ ...adj, kind }))
  }

  function setAdjustmentLabel(id: string, label: string) {
    updateAdjustment(id, adj => ({ ...adj, label }))
  }

  // Adjustment rows hold the raw input text per-row (keyed by id) so the
  // `amountMinor` on the persisted adjustment stays integer minor units
  // while the input keeps its in-flight value (handles mid-keystroke
  // "12." like the items hook). Lookup falls back to formatting the
  // current amountMinor so edit-mode / OCR-populated rows render
  // without needing to dual-write at every entry point.
  const [adjustmentAmountText, setAdjustmentAmountText] = useState<Record<string, string>>({})

  function adjustmentAmountValue(adj: ExpenseAdjustment): string {
    const inFlight = adjustmentAmountText[adj.id]
    if (inFlight !== undefined) return inFlight
    return adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, currency) : ''
  }

  function setAdjustmentAmount(id: string, value: string) {
    setAdjustmentAmountText(prev => ({ ...prev, [id]: value }))
    let minor = 0
    if (value.trim() !== '') {
      try { minor = Math.max(0, parseMoneyToMinor(value, currency)) }
      catch { minor = 0 }
    }
    updateAdjustment(id, adj => ({ ...adj, amountMinor: minor }))
  }

  function setAdjustmentScope(id: string, scope: ExpenseAdjustmentScope) {
    updateAdjustment(id, adj => {
      if (scope === 'EXPENSE') {
        return {
          id:          adj.id,
          label:       adj.label,
          kind:        adj.kind,
          scope:       'EXPENSE',
          amountMinor: adj.amountMinor,
        }
      }

      const existingTarget =
        adj.targetItemId && items.items.some(item => item.id === adj.targetItemId)
          ? adj.targetItemId
          : undefined
      const targetItemId = existingTarget ?? items.items[0]?.id
      return targetItemId
        ? { ...adj, scope: 'ITEM', targetItemId }
        : adj
    })
  }

  function setAdjustmentTarget(id: string, targetItemId: string) {
    updateAdjustment(id, adj => ({ ...adj, scope: 'ITEM', targetItemId }))
  }

  function removeAdjustment(id: string) {
    setAdjustments(prev => prev.filter(adj => adj.id !== id))
  }

  // Manual escape-hatch for OCR misses (e.g. クーポン unprinted on the
  // receipt or low-confidence line that came back as a regular item).
  // Defaults: DISCOUNT (the most common manual case — subtractive),
  // EXPENSE scope (simpler mental model; switch to ITEM if needed).
  // Label/amount start blank so the existing validation gate forces
  // the user to fill them — surfaces "未入力" instead of silently saving
  // a zero-amount adjustment that would leak the mismatch into splits.
  function addAdjustment() {
    setAdjustments(prev => [
      ...prev,
      {
        id:          crypto.randomUUID(),
        label:       '',
        kind:        'DISCOUNT',
        scope:       'EXPENSE',
        amountMinor: 0,
      },
    ])
  }

  function removeItemRow(index: number) {
    const removedId = items.items[index]?.id
    items.remove(index)
    if (!removedId) return
    setAdjustments(prev => prev.filter(adj => adj.targetItemId !== removedId))
  }

  // All money in form derivations is integer minor units. The user types
  // a decimal string into the amount field; parseMoneyToMinor is the
  // boundary that converts it. Parse failures (partial input "12." /
  // empty) clamp to 0 so downstream math doesn't see NaN.
  function safeParseMinor(text: string): number {
    if (text.trim() === '') return 0
    try { return Math.max(0, parseMoneyToMinor(text, currency)) }
    catch { return 0 }
  }
  const amountMinor = safeParseMinor(state.amountText)
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
    return safeParseMinor(text)
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

  function validate(): ExpenseFormResult | null {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    // Specific reason via the Result wrapper — the legacy `if (!amountMinor)`
    // branch coerced parse failures (e.g. JPY 12.34) to look like empty
    // input and surfaced a misleading "請輸入金額". moneyErrorMessage maps
    // the structured reason so the banner matches the actual problem.
    const amountResult = parseMoneyToMinorResult(state.amountText, currency)
    if (!amountResult.ok)               e.amount = moneyErrorMessage(amountResult.reason, currency)
    else if (amountResult.value <= 0)   e.amount = moneyErrorMessage('NON_POSITIVE', currency)
    if (!state.date)         e.date = '請選擇日期'
    if (!state.paidBy)       e.paidBy = '請選擇付款人'

    let resultSplits: ExpenseSplit[] = []
    // Always send `items` (even empty) so that clearing a receipt's items
    // overwrites whatever was previously stored. Don't rely on deleteField
    // gymnastics — empty array IS the canonical "no items" state.
    // Strip the form-only amountText before persistence — ExpenseItem
    // (the persisted shape) has no such field.
    let resultItems = items.items.map(it => ({
      id:          it.id,
      name:        it.name,
      amountMinor: it.amountMinor,
      assignees:   it.assignees,
    }))
    const resultAdjustments: ExpenseAdjustment[] = items.hasItems
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

    if (items.hasItems) {
      // Strict by-item validation. The user chose strict over lenient so
      // both invariants must hold before save:
      //   - every item is assigned to ≥1 person
      //   - sum(items) + Σ adjustment sign·amountMinor === amountMinor
      const noAssigneeIdx = items.items.findIndex(it => it.assignees.length === 0)
      const blankNameIdx  = items.items.findIndex(it => !it.name.trim())
      // Phase B: items are positive-int minor units. The setter clamps to
      // ≥0; reject exact zero since that's almost certainly garbage (OCR
      // mis-read or partial input).
      const zeroAmountIdx = items.items.findIndex(it => it.amountMinor <= 0)
      const blankAdjustmentIdx = resultAdjustments.findIndex(adj => !adj.label)
      const zeroAdjustmentIdx  = resultAdjustments.findIndex(adj => adj.amountMinor <= 0)
      const danglingAdjustmentIdx = resultAdjustments.findIndex(adj =>
        adj.scope === 'ITEM' && !items.items.some(it => it.id === adj.targetItemId),
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
      if (!e.items) {
        // Authoritative split derivation. Matches the Worker recompute
        // (same `@tripmate/expense-materialize` import); if this throws,
        // the Worker would reject SPLIT_PREVIEW_DRIFT anyway, so we
        // surface the same gate locally and keep the modal open.
        try {
          resultSplits = materializeExpenseSplits({
            items:       resultItems,
            adjustments: resultAdjustments,
            members:     members.map(m => m.id),
          })
        } catch (err) {
          e.items = err instanceof MaterializeError
            ? `明細の計算エラー: ${err.message}`
            : '明細の計算に失敗しました'
        }
      }
    } else {
      if (splits.state.mode === 'equal') {
        if (includedArr.length === 0) e.splits = '至少選擇一位分攤人'
        resultSplits = includedArr.map(id => ({ memberId: id, amountMinor: equalSplits[id] ?? 0 }))
      } else {
        resultSplits = members
          .map(m => ({ memberId: m.id, amountMinor: customAmountOf(m.id) }))
          .filter(s => s.amountMinor > 0)
        if (resultSplits.length === 0) e.splits = '至少需有一人分攤'
        else if (customDiff !== 0) e.splits = `分攤總和需等於 ${formatMinorAmount(amountMinor, currency)}`
      }
      resultItems = []
    }

    setErrors(e)
    if (Object.keys(e).length > 0) return null

    const input: CreateExpenseInput = {
      title:       state.title.trim(),
      amountMinor,
      currency,
      category:    state.category,
      paidBy:      state.paidBy,
      splits:      resultSplits,
      date:        state.date,
      items:       resultItems,
      // Phase B: adjustments only attach to by-item mode. The Worker
      // rejects adjustments-without-items, so blanking here is the
      // single source of truth for "manual entry has no adjustments".
      adjustments: resultAdjustments,
      note:        state.note.trim() || undefined,
    }
    return { input, attachment: att.pickAttachmentChange() }
  }

  function handleSave() {
    const result = validate()
    if (result) onSave(result)
  }

  // ─── Receipt section helpers ────────────────────────────────────────
  const receiptErrText = att.error ?? ocr.error ?? undefined
  const canAnalyze   = att.hasAttachment && att.previewIsImage && !ocr.loading && !items.hasItems
  const canReanalyze = att.hasAttachment && att.previewIsImage && !ocr.loading && items.hasItems && !!ocr.lastFile

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
                onClick={() => ocr.lastFile && void ocr.run(ocr.lastFile)}
                disabled={!ocr.lastFile}
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
                onClick={() => ocr.lastFile && void ocr.run(ocr.lastFile)}
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

      <div className="flex gap-2.5">
        <FormField label={`金額（${symbol}）`} error={errors.amount} required className="flex-1">
          <CurrencyInput
            symbol={symbol}
            value={state.amountText}
            onChange={e => setField('amountText', e.target.value)}
            placeholder="0"
            error={!!errors.amount}
          />
        </FormField>
        <FormField label="日付" error={errors.date} required className="flex-1">
          <DatePicker value={state.date} onChange={v => setField('date', v)} error={!!errors.date} />
        </FormField>
      </div>

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
              {items.items.map((it, i) => (
                <div key={it.id} className="flex flex-col gap-1.5 px-2.5 py-2.5">
                  {/* Row 1: name + amount. Amount widened to 120px (was 100px)
                      so 5-digit JPY values like ¥10,000 fit without clipping.
                      Removed delete button from this row — it was crowding
                      both inputs. Delete moved to row 2's trailing edge. */}
                  <div className="flex items-center gap-2">
                    {/* Font-size MUST be 16px or larger — iOS Safari auto-zooms
                        the viewport on focus of any input below 16px. The h-9
                        height is unchanged; only the type size grows. */}
                    <input
                      value={it.name}
                      onChange={e => items.setName(i, e.target.value)}
                      placeholder="項目名"
                      className="flex-1 min-w-0 h-9 px-2.5 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink outline-none focus-visible:border-accent"
                    />
                    <div className="shrink-0 w-[120px]">
                      <CurrencyInput
                        symbol={symbol}
                        size="compact"
                        alignRight
                        shellClassName="h-9 px-2.5 rounded-[8px]"
                        value={it.amountText}
                        onChange={e => items.setAmount(i, e.target.value)}
                        placeholder="0"
                      />
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
              ))}
            </div>

            {adjustments.length > 0 && (
              <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
                <div className="px-2.5 py-2 text-[11px] font-semibold text-muted">
                  割引・税・調整
                </div>
                {adjustments.map((adj, i) => {
                  const sign = adjustmentSign(adj.kind)
                  return (
                    <div key={adj.id} className="flex flex-col gap-2 px-2.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={adj.label}
                          onChange={e => setAdjustmentLabel(adj.id, e.target.value)}
                          placeholder={`調整 ${i + 1}`}
                          aria-label={`調整 ${i + 1} ラベル`}
                          className="flex-1 min-w-0 h-9 px-2.5 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink outline-none focus-visible:border-accent"
                        />
                        <div className="shrink-0 w-[120px]">
                          <CurrencyInput
                            symbol={`${sign < 0 ? '-' : '+'}${symbol}`}
                            size="compact"
                            alignRight
                            shellClassName="h-9 px-2.5 rounded-[8px]"
                            value={adjustmentAmountValue(adj)}
                            onChange={e => setAdjustmentAmount(adj.id, e.target.value)}
                            placeholder="0"
                            aria-label={`調整 ${i + 1} 金額`}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                        <select
                          value={adj.kind}
                          onChange={e => setAdjustmentKind(adj.id, e.target.value as ExpenseAdjustmentKind)}
                          aria-label={`調整 ${i + 1} 種類`}
                          className="h-9 min-w-0 px-2.5 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink outline-none focus-visible:border-accent"
                        >
                          {EXPENSE_ADJUSTMENT_KINDS.map(kind => (
                            <option key={kind} value={kind}>{ADJUSTMENT_KIND_LABEL[kind]}</option>
                          ))}
                        </select>

                        <select
                          value={adj.scope}
                          onChange={e => setAdjustmentScope(adj.id, e.target.value as ExpenseAdjustmentScope)}
                          aria-label={`調整 ${i + 1} 対象範囲`}
                          className="h-9 min-w-0 px-2.5 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink outline-none focus-visible:border-accent"
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
                          className="h-9 w-full min-w-0 px-2.5 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink outline-none focus-visible:border-accent"
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
                          shellClassName="h-9 px-2.5 rounded-[8px]"
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
