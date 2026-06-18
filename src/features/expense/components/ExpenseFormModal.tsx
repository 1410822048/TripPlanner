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
//   - useReceiptOcr    — OCR orchestration (source + worker flow + compare +
//                        camera/upload pick handlers)
import { useRef, useState } from 'react'
import {
  type Expense,
  type ExpenseCategory,
  type ExpenseItem,
  type CreateExpenseInput,
} from '@/types'
import type { TripMember } from '@/features/trips/types'
import { reconcileReceipt } from '@tripmate/expense-materialize'
import { convertMinorHalfEven } from '@tripmate/fx-core'
import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import MemberAvatar from '@/components/ui/MemberAvatar'
import ReceiptSection from './expenseForm/ReceiptSection'
import CurrencySection from './expenseForm/CurrencySection'
import SplitsSection from './expenseForm/SplitsSection'
import LineItemsSection from './expenseForm/LineItemsSection'
import { CATEGORY_ICON } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { useSplitsState, type SplitMode } from '../hooks/useSplitsState'
import { useExpenseItems } from '../hooks/useExpenseItems'
import { useExpenseMoneyDraft } from '../hooks/useExpenseMoneyDraft'
import { useFxPreview } from '@/hooks/useFxPreview'
import { type OcrResult } from '../services/ocrService'
import { OCR_COMPARE_UI_ENABLED, OCR_FALLBACK_UI_ENABLED } from '../services/ocrFeatures'
import { useReceiptOcr } from '../hooks/useReceiptOcr'
import { buildExpenseFormResult } from '../services/buildExpenseFormResult'
import { buildOcrExpenseDraft } from '../services/buildOcrExpenseDraft'
import { buildForeignLinePreview } from '../services/buildForeignLinePreview'
import {
  safeReparseMoney,
  splitEqually,
} from '../utils'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { useTripId } from '@/hooks/useTripId'
import { currencySymbol } from '@/utils/currency'
import {
  formatMinorForInput,
  currencyFractionDigits,
} from '@/utils/money'
import AttachmentPreviewModal from '@/features/bookings/components/AttachmentPreviewModal'


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
    // previewPath = real thumb only (no full-path fallback): a thumb-less /
    // PDF receipt shows the row icon, and the full blob resolves only when
    // the preview modal opens (path-driven via fullPath).
    previewPath: editTarget?.receipt?.thumbPath ?? null,
    fullPath:    editTarget?.receipt?.path      ?? null,
    type:        editTarget?.receipt?.type      ?? null,
  })
  // Full-size receipt preview: new file → its local blob; existing →
  // resolve fullPath via getBlob only while the modal is open (path-driven).
  const previewFullUrl  = useAttachmentUrl(previewOpen && !att.hasNewFile ? att.fullPath : null, { kind: 'full' })
  const previewModalUrl = att.hasNewFile ? att.previewUrl : previewFullUrl

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
        allocations: si.allocations,
      }))
    : (editTarget?.items ?? [])
  const items = useExpenseItems(initialItems, effectiveCurrency, members.map(m => m.id))

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

  // Shared OCR-apply effect. The pure draft assembly (currency detect +
  // fail-fast money parse + item id mint + adjustment target resolution +
  // title/category fill) lives in buildOcrExpenseDraft so it can be
  // unit-tested with a deterministic id generator; this is the SIDE-EFFECT
  // half — apply the returned draft to the sibling hooks.
  //
  // FAIL-FAST: buildOcrExpenseDraft throws BEFORE returning a draft when the
  // Worker's currency-agnostic decimal shape can't be parsed for this currency
  // (e.g. OCR emitting "12.34" for JPY breaks parseMoneyToMinor). Nothing is
  // mutated before the throw, so partial application is never visible. The two
  // callers differ ONLY in how they surface the throw + which source key gets
  // marked analyzed — keeping the apply itself here means they never drift:
  //   - useOcrFlow.onSuccess lets it propagate → useOcrFlow catches → error banner
  //   - applyComparedOcrResult catches → compareError
  function applyOcrResultToForm(result: OcrResult) {
    const draft = buildOcrExpenseDraft(
      result,
      {
        // FRESH captures fall back to tripCurrency (don't inherit an ephemeral
        // picker); EXISTING foreign expenses keep their PERSISTED authoritative
        // currency when OCR can't detect one.
        tripCurrency,
        persistedSourceCurrency: editTarget?.sourceCurrency,
        isEdit:                  editTarget !== null,
        currentTitle:            state.title,
      },
      () => crypto.randomUUID(),
    )

    // Auto-set sourceCurrency BEFORE the other field updates so React batches
    // them in a single render — avoids a "trip currency for one tick, then
    // detected currency" flash on the items list. items.reset below replaces
    // items wholesale; the switch still matters for the sourceCurrency state +
    // custom-splits renormalization.
    if (draft.ocrCurrency !== sourceCurrency) {
      applyCurrencySwitch(draft.ocrCurrency)
    }
    items.reset(draft.items)
    resetAdjustments(draft.adjustments, draft.adjustmentText)
    setAmountText(draft.amountText)
    if (draft.title !== undefined) setField('title', draft.title)
    if (draft.category !== undefined) setField('category', draft.category)
    setErrors(prev => ({ ...prev, items: '' }))
  }

  // OCR orchestration — source state machine + worker flow + compare + the
  // camera/upload pick handlers, all consolidated in useReceiptOcr. The
  // form-domain apply (applyOcrResultToForm) and the sibling clears
  // (att/items/adjustments) stay here; everything else is the hook's.
  const receiptOcr = useReceiptOcr({
    existingReceipt: {
      tripId,
      expenseId:       editTarget?.id,
      receiptPath:     editTarget?.receipt?.path,
      receiptType:     editTarget?.receipt?.type,
      updatedAtMillis: editTarget?.updatedAt?.toMillis?.(),
    },
    tripCurrency,
    currencyHint:    effectiveCurrency,
    fallbackEnabled: OCR_FALLBACK_UI_ENABLED,
    compareEnabled:  OCR_COMPARE_UI_ENABLED,
    hasAttachment:   att.hasAttachment,
    previewIsImage:  att.previewIsImage,
    hasItems:        items.hasItems,
    pickFile:        att.pickFile,
    applyOcrResult:  applyOcrResultToForm,
  })

  const titleRef  = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  function handleClearReceipt() {
    // clearOcrOnly resets the OCR / source / compare slices; the sibling
    // clears (attachment / items / adjustments) stay the component's.
    receiptOcr.handlers.clearOcrOnly()
    att.clear()
    items.clear()
    clearAdjustments()
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
  // Phase 3c-1 — trip-currency per-line preview of the source-side amounts
  // ("USD 12.34 → ¥1804 @ 146.2" display rows). PREVIEW only: save-time math
  // runs through buildExpenseFormResult → convertAndMaterializeFromSource and
  // the Worker recompute is authoritative, so any drift here is harmless.
  // null = not foreign-open / no rate yet / no amount typed. See
  // buildForeignLinePreview for the balanced-vs-imbalanced-draft split.
  const foreignLinePreview = buildForeignLinePreview({
    isForeignOpen,
    rateDecimal:       fxPreview.rateDecimal,
    sourceAmountMinor: amountMinor,
    sourceCurrency,
    tripCurrency,
    items:             items.items,
    adjustments,
  })
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
  // Lines-vs-bill reconciliation (signed adjustments, shared with the
  // save-path validator). effectiveItemsTotal nets discounts/taxes so the
  // sum-check banner doesn't read a discounted receipt as "超過";
  // residualMinor drives the 不足/超過 display in LineItemsSection.
  const { effectiveItemsTotal, residualMinor: itemsDiff } = reconcileReceipt({
    totalMinor: amountMinor, items: items.items, adjustments,
  })
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
        allocations: it.allocations,
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
  const receiptErrText = att.error ?? receiptOcr.status.error ?? undefined

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
            const CatIcon = CATEGORY_ICON[c.value]
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
                <CatIcon size={13} strokeWidth={2} />{c.label}
              </button>
            )
          })}
        </div>
      </FormField>

      <ReceiptSection
        error={receiptErrText}
        hasAttachment={att.hasAttachment}
        attachmentName={att.attachmentName}
        previewUrl={att.previewUrl}
        previewIsImage={att.previewIsImage}
        canPreview={att.hasNewFile || !!att.fullPath}
        ocrLoading={receiptOcr.status.loading}
        ocrElapsedMs={receiptOcr.status.elapsedMs}
        canAnalyze={receiptOcr.caps.canAnalyze}
        canReanalyze={receiptOcr.caps.canReanalyze}
        canFallback={receiptOcr.caps.canFallback}
        canCompare={receiptOcr.caps.canCompare}
        compareLoading={receiptOcr.compare.loading}
        compareError={receiptOcr.compare.error}
        compareResult={receiptOcr.compare.result}
        onCameraPicked={receiptOcr.handlers.onCameraPicked}
        onUploadPicked={receiptOcr.handlers.onUploadPicked}
        onClear={handleClearReceipt}
        onAnalyze={receiptOcr.handlers.analyze}
        onFallback={receiptOcr.handlers.fallback}
        onCompare={() => { void receiptOcr.compare.run() }}
        onApplyCompareResult={receiptOcr.compare.apply}
        onPreview={() => (att.hasNewFile || att.fullPath) && setPreviewOpen(true)}
      />

      <CurrencySection
        isForeignOpen={isForeignOpen}
        sourceCurrency={sourceCurrency}
        tripCurrency={tripCurrency}
        lastForeignCurrency={lastForeignCurrency}
        symbol={symbol}
        amountText={amountText}
        amountMinor={amountMinor}
        amountError={errors.amount}
        date={state.date}
        dateError={errors.date}
        fx={fxPreview}
        previewConvertedMinor={previewConvertedMinor}
        onSwitchCurrency={applyCurrencySwitch}
        onAmountChange={setAmountText}
        onDateChange={v => setField("date", v)}
      />

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
        <LineItemsSection
          error={errors.items}
          members={members}
          currency={currency}
          tripCurrency={tripCurrency}
          symbol={symbol}
          items={items.items}
          adjustments={adjustments}
          amountMinor={amountMinor}
          effectiveItemsTotal={effectiveItemsTotal}
          itemsDiff={itemsDiff}
          foreignLinePreview={foreignLinePreview}
          adjustmentAmountValue={adjustmentAmountValue}
          onAddItem={items.add}
          onRemoveItem={removeItemRow}
          onSetItemName={items.setName}
          onSetItemAmount={items.setAmount}
          onToggleItemAllocation={items.toggleAllocation}
          onSetItemAllocationShares={items.setAllocationShares}
          onAddAdjustment={addAdjustment}
          onRemoveAdjustment={removeAdjustment}
          onSetAdjustmentLabel={setAdjustmentLabel}
          onSetAdjustmentAmount={setAdjustmentAmount}
          onSetAdjustmentKind={setAdjustmentKind}
          onSetAdjustmentScope={setAdjustmentScope}
          onSetAdjustmentTarget={setAdjustmentTarget}
        />
      ) : (
        <SplitsSection
          error={errors.splits}
          mode={splits.state.mode}
          members={members}
          included={splits.state.included}
          custom={splits.state.custom}
          symbol={symbol}
          currency={currency}
          amountMinor={amountMinor}
          equalSplits={equalSplits}
          customAmountOf={customAmountOf}
          customSum={customSum}
          customDiff={customDiff}
          onSwitchMode={switchMode}
          onToggleIncluded={splits.toggleIncluded}
          onSetCustom={splits.setCustom}
        />
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

      {previewOpen && (att.hasNewFile || att.fullPath) && (
        <AttachmentPreviewModal
          url={previewModalUrl}
          fileType={att.previewMime}
          fileName={att.attachmentName}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </FormModalShell>
  )
}
