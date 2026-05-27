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
import type { Expense, ExpenseCategory, ExpenseSplit, CreateExpenseInput } from '@/types'
import type { TripMember } from '@/features/trips/types'
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
import { splitEqually, splitsFromItems } from '../utils'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { formatAmount, currencySymbol } from '@/utils/currency'
import { compressImage } from '@/utils/image'
import AttachmentPreviewModal from '@/features/bookings/components/AttachmentPreviewModal'

const IMAGE_ACCEPT = 'image/*'
const ANY_ACCEPT   = 'image/*,application/pdf'

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
  amount:   string                // string for input control; rounded to int on save
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
  return {
    title:    editTarget?.title ?? '',
    amount:   editTarget ? String(editTarget.amount) : '',
    date:     editTarget?.date ?? defaultDate,
    category: editTarget?.category ?? 'food',
    paidBy:   editTarget?.paidBy ?? members[0]?.id ?? '',
    note:     editTarget?.note ?? '',
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
  const items = useExpenseItems(editTarget?.items ?? [])

  // OCR pipeline. onSuccess wires the parsed result into the existing
  // form state — items, total, and (when blank) title. Title-fill is
  // intentionally non-destructive: if the user already typed a title,
  // OCR doesn't clobber it.
  const ocr = useOcrFlow({
    currency,
    onSuccess: (result) => {
      items.reset(result.items.map(it => ({
        name:      it.name,
        amount:    Math.round(it.amount),
        assignees: [],
      })))
      setField('amount', String(Math.max(0, Math.round(result.total))))
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
    ocr.reset()
  }

  // Amounts are integer minor units (JPY=yen). Round at the boundary so
  // downstream math (splits, settlement) stays integer-exact regardless of
  // any fractional input the user types.
  const amountNum   = Math.round(Number(state.amount) || 0)
  const itemsDiff   = amountNum - items.sum
  const includedArr = members.map(m => m.id).filter(id => splits.state.included.has(id))
  const equalSplits: Record<string, number> = Object.fromEntries(
    splitEqually(amountNum, includedArr).map(s => [s.memberId, s.amount]),
  )

  function customAmountOf(id: string): number {
    const v = Number(splits.state.custom[id])
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  const customSum  = members.reduce((s, m) => s + customAmountOf(m.id), 0)
  const customDiff = amountNum - customSum

  function switchMode(mode: SplitMode) {
    const seed: Record<string, string> = {}
    members.forEach(m => {
      const v = equalSplits[m.id] ?? 0
      seed[m.id] = v > 0 ? String(v) : ''
    })
    splits.switchMode(mode, seed)
  }

  function validate(): ExpenseFormResult | null {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    if (!amountNum)          e.amount = '請輸入金額'
    if (!state.date)         e.date = '請選擇日期'
    if (!state.paidBy)       e.paidBy = '請選擇付款人'

    let resultSplits: ExpenseSplit[] = []
    // Always send `items` (even empty) so that clearing a receipt's items
    // overwrites whatever was previously stored. Don't rely on deleteField
    // gymnastics — empty array IS the canonical "no items" state.
    let resultItems = items.items

    if (items.hasItems) {
      // Strict by-item validation. The user chose strict over lenient so
      // both invariants must hold before save:
      //   - every item is assigned to ≥1 person
      //   - sum(items) === amount
      const noAssigneeIdx = items.items.findIndex(it => it.assignees.length === 0)
      const blankNameIdx  = items.items.findIndex(it => !it.name.trim())
      // Allow negative — discount lines are valid. Reject only exact zero
      // since that's almost certainly garbage (OCR mis-read).
      const zeroAmountIdx = items.items.findIndex(it => it.amount === 0)
      if (noAssigneeIdx >= 0) {
        e.items = `行 ${noAssigneeIdx + 1}：分担者を選択してください`
      } else if (blankNameIdx >= 0) {
        e.items = `行 ${blankNameIdx + 1}：項目名を入力してください`
      } else if (zeroAmountIdx >= 0) {
        e.items = `行 ${zeroAmountIdx + 1}：金額を入力してください`
      } else if (Math.abs(itemsDiff) >= 0.01) {
        e.items = `明細合計 ${formatAmount(items.sum, currency)} と請求書合計 ${formatAmount(amountNum, currency)} が一致しません`
      }
      if (!e.items) {
        resultSplits = splitsFromItems(items.items)
      }
    } else {
      if (splits.state.mode === 'equal') {
        if (includedArr.length === 0) e.splits = '至少選擇一位分攤人'
        resultSplits = includedArr.map(id => ({ memberId: id, amount: equalSplits[id] ?? 0 }))
      } else {
        resultSplits = members
          .map(m => ({ memberId: m.id, amount: customAmountOf(m.id) }))
          .filter(s => s.amount > 0)
        if (resultSplits.length === 0) e.splits = '至少需有一人分攤'
        else if (Math.abs(customDiff) >= 0.01) e.splits = `分攤總和需等於 ${formatAmount(amountNum, currency)}`
      }
      resultItems = []
    }

    setErrors(e)
    if (Object.keys(e).length > 0) return null

    const input: CreateExpenseInput = {
      title:    state.title.trim(),
      amount:   amountNum,
      currency,
      category: state.category,
      paidBy:   state.paidBy,
      splits:   resultSplits,
      date:     state.date,
      items:    resultItems,
      note:     state.note.trim() || undefined,
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
            value={state.amount}
            onChange={e => setField('amount', e.target.value)}
            placeholder="0"
            min={0}
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
                <div key={i} className="flex flex-col gap-1.5 px-2.5 py-2.5">
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
                        value={it.amount || ''}
                        onChange={e => items.setAmount(i, e.target.value)}
                        placeholder="0"
                        // Tint negative amounts so discounts read as such at a glance.
                        className={it.amount < 0 ? 'text-warn' : ''}
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
                      onClick={() => items.remove(i)}
                      aria-label={`行 ${i + 1} を削除`}
                      className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={items.add}
              className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
            >
              <Plus size={14} strokeWidth={2} />
              行を追加
            </button>

            {/* Sum check — same green/red pattern as カスタム split */}
            {amountNum > 0 && (
              <div
                className={[
                  'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
                  Math.abs(itemsDiff) < 0.01
                    ? 'bg-teal-pale text-teal'
                    : 'bg-warn-bg text-warn',
                ].join(' ')}
              >
                <span>
                  {Math.abs(itemsDiff) < 0.01 ? '✓ 合計一致' : itemsDiff > 0 ? '不足' : '超過'}
                </span>
                <span>
                  {formatAmount(items.sum, currency)} / {formatAmount(amountNum, currency)}
                  {Math.abs(itemsDiff) >= 0.01 && (
                    <span className="ml-1.5">({itemsDiff > 0 ? '+' : ''}{formatAmount(itemsDiff, currency)})</span>
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
                          {included ? formatAmount(displayAmount, currency) : '—'}
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
                          min={0}
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

            {splits.state.mode === 'custom' && amountNum > 0 && (
              <div
                className={[
                  'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
                  Math.abs(customDiff) < 0.01
                    ? 'bg-teal-pale text-teal'
                    : 'bg-warn-bg text-warn',
                ].join(' ')}
              >
                <span>
                  {Math.abs(customDiff) < 0.01 ? '✓ 總和一致' : customDiff > 0 ? '残り' : '超過'}
                </span>
                <span>
                  {formatAmount(customSum, currency)} / {formatAmount(amountNum, currency)}
                  {Math.abs(customDiff) >= 0.01 && (
                    <span className="ml-1.5">({customDiff > 0 ? '+' : ''}{formatAmount(customDiff, currency)})</span>
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
