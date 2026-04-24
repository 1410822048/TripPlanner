// src/features/expense/components/ExpenseFormModal.tsx
// The ExpensePage caller keys this component by `editTarget?.id ?? 'new'`,
// so any change to the edit target produces a fresh mount. That lets the
// form initialize every piece of state directly from props below — no
// sync-in-effect step, no cascade renders after mount.
import { useRef, useState } from 'react'
import type { Expense, ExpenseCategory, CreateExpenseInput } from '@/types'
import type { TripMember } from '@/features/schedule/types'
import BottomSheet from '@/components/ui/BottomSheet'
import { DatePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import SaveButton from '@/components/ui/SaveButton'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { splitEqually } from '../utils'

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'food',          label: '食事'   },
  { value: 'transport',     label: '交通'   },
  { value: 'accommodation', label: '宿泊'   },
  { value: 'activity',      label: '体験'   },
  { value: 'shopping',      label: '買物'   },
  { value: 'other',         label: 'その他' },
]

type SplitMode = 'equal' | 'custom'

interface Props {
  editTarget:  Expense | null
  defaultDate: string
  members:     TripMember[]
  isOpen:      boolean
  isSaving:    boolean
  onClose:     () => void
  onSave:      (data: CreateExpenseInput) => void
}

/**
 * Derive the initial split-mode + membership + custom-splits state from the
 * expense being edited (or the member roster when creating new). Called
 * once per mount via useState initializer; that's sufficient because the
 * parent re-keys on edit-target change, remounting fresh.
 */
function initialSplitState(
  editTarget: Expense | null,
  members: TripMember[],
): { mode: SplitMode; included: Set<string>; custom: Record<string, string> } {
  if (!editTarget) {
    return {
      mode:     'equal',
      included: new Set(members.map(m => m.id)),
      custom:   {},
    }
  }
  const nonZero = editTarget.splits.filter(s => s.amount > 0)
  const first = nonZero[0]
  const allEqual =
    first !== undefined &&
    nonZero.every(s => Math.abs(s.amount - first.amount) <= 1)

  if (allEqual) {
    return {
      mode:     'equal',
      included: new Set(nonZero.map(s => s.memberId)),
      custom:   {},
    }
  }
  const custom: Record<string, string> = {}
  editTarget.splits.forEach(s => { custom[s.memberId] = String(s.amount) })
  return {
    mode:     'custom',
    included: new Set(members.map(m => m.id)),
    custom,
  }
}

export default function ExpenseFormModal({
  editTarget, defaultDate, members, isOpen, isSaving, onClose, onSave,
}: Props) {
  const [title,    setTitle]    = useState(editTarget?.title ?? '')
  const [amount,   setAmount]   = useState(editTarget ? String(editTarget.amount) : '')
  const [date,     setDate]     = useState(editTarget?.date ?? defaultDate)
  const [category, setCategory] = useState<ExpenseCategory>(editTarget?.category ?? 'food')
  const [paidBy,   setPaidBy]   = useState<string>(editTarget?.paidBy ?? members[0]?.id ?? '')
  const [note,     setNote]     = useState(editTarget?.note ?? '')

  // Single compute per mount, split into three setters. Parent re-keys on
  // editTarget change so this runs exactly once per edit session.
  const [splitInit] = useState(() => initialSplitState(editTarget, members))
  const [splitMode,    setSplitMode]    = useState<SplitMode>(splitInit.mode)
  const [includedIds,  setIncludedIds]  = useState<Set<string>>(splitInit.included)
  const [customSplits, setCustomSplits] = useState<Record<string, string>>(splitInit.custom)
  const [errors,       setErrors]       = useState<Record<string, string>>({})

  const titleRef = useRef<HTMLInputElement>(null)

  useAutoFocus(titleRef, isOpen)

  // Amounts are integer minor units (JPY=yen). Round at the boundary so
  // downstream math (splits, settlement) stays integer-exact regardless of
  // any fractional input the user types.
  const amountNum = Math.round(Number(amount) || 0)
  const includedArr = members.map(m => m.id).filter(id => includedIds.has(id))
  const equalSplits: Record<string, number> = Object.fromEntries(
    splitEqually(amountNum, includedArr).map(s => [s.memberId, s.amount]),
  )

  function customAmountOf(id: string): number {
    const v = Number(customSplits[id])
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  const customSum  = members.reduce((s, m) => s + customAmountOf(m.id), 0)
  const customDiff = amountNum - customSum

  function toggleIncluded(id: string) {
    setIncludedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function switchMode(mode: SplitMode) {
    if (mode === splitMode) return
    if (mode === 'custom') {
      // 從均等切到自訂 — 以目前均等結果作為起點
      const seed: Record<string, string> = {}
      members.forEach(m => {
        const v = equalSplits[m.id] ?? 0
        seed[m.id] = v > 0 ? String(v) : ''
      })
      setCustomSplits(seed)
    }
    setSplitMode(mode)
  }

  function validate(): CreateExpenseInput | null {
    const e: Record<string, string> = {}
    if (!title.trim())   e.title = '請輸入標題'
    if (!amountNum)      e.amount = '請輸入金額'
    if (!date)           e.date = '請選擇日期'
    if (!paidBy)         e.paidBy = '請選擇付款人'

    let splits: { memberId: string; amount: number }[] = []
    if (splitMode === 'equal') {
      if (includedArr.length === 0) e.splits = '至少選擇一位分攤人'
      splits = includedArr.map(id => ({ memberId: id, amount: equalSplits[id] ?? 0 }))
    } else {
      splits = members
        .map(m => ({ memberId: m.id, amount: customAmountOf(m.id) }))
        .filter(s => s.amount > 0)
      if (splits.length === 0) e.splits = '至少需有一人分攤'
      else if (Math.abs(customDiff) >= 0.01) e.splits = `分攤總和需等於 ¥${amountNum.toLocaleString()}`
    }

    setErrors(e)
    if (Object.keys(e).length > 0) return null

    return {
      title: title.trim(),
      amount: amountNum,
      currency: 'JPY',
      category,
      paidBy,
      splits,
      date,
      note: note.trim() || undefined,
    }
  }

  function handleSave() {
    const payload = validate()
    if (payload) onSave(payload)
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={editTarget ? '費用を編集' : '費用を追加'}
      footer={
        <SaveButton
          onClick={handleSave}
          isSaving={isSaving}
          label={editTarget ? '変更を保存' : '費用を追加'}
        />
      }
    >
      <FormField label="タイトル" error={errors.title} required>
        <input
          ref={titleRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="例：壽司大 築地"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="カテゴリ">
        <div className="flex gap-[7px] flex-wrap">
          {CATEGORIES.map(c => {
            const active = category === c.value
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={[
                  'flex items-center gap-[5px] px-3 py-1.5 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-muted font-normal hover:border-muted',
                ].join(' ')}
              >
                <span>{CATEGORY_EMOJI[c.value]}</span>{c.label}
              </button>
            )
          })}
        </div>
      </FormField>

      <div className="flex gap-2.5">
        <FormField label="金額（¥）" error={errors.amount} required className="flex-1">
          <div className="relative">
            <span className="absolute left-[13px] top-1/2 -translate-y-1/2 text-muted text-[13px] pointer-events-none">¥</span>
            <input
              type="number"
              inputMode="numeric"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              min={0}
              className={`${inputClass(!!errors.amount)} pl-7`}
            />
          </div>
        </FormField>
        <FormField label="日付" error={errors.date} required className="flex-1">
          <DatePicker value={date} onChange={setDate} error={!!errors.date} />
        </FormField>
      </div>

      <FormField label="立替えた人" error={errors.paidBy} required>
        <div className="flex gap-[7px] flex-wrap">
          {members.map(m => {
            const active = paidBy === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setPaidBy(m.id)}
                className={[
                  'flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-ink font-normal hover:border-muted',
                ].join(' ')}
              >
                <span
                  className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                  style={{ background: m.bg, color: m.color }}
                >
                  {m.label}
                </span>
                {m.label}
              </button>
            )
          })}
        </div>
      </FormField>

      <FormField label="割り勘" error={errors.splits}>
        <div className="flex flex-col gap-2">
          {/* 割勘方式切換 */}
          <div className="flex gap-1 p-1 rounded-card bg-app border border-border">
            {([
              { value: 'equal',  label: '均等' },
              { value: 'custom', label: 'カスタム' },
            ] as const).map(m => {
              const active = splitMode === m.value
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

          {/* 每位成員 row */}
          <div className="flex flex-col gap-1.5">
            {members.map(m => {
              const included = splitMode === 'equal' ? includedIds.has(m.id) : customAmountOf(m.id) > 0
              const displayAmount = splitMode === 'equal'
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
                  <span
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                    style={{ background: m.bg, color: m.color }}
                  >
                    {m.label}
                  </span>
                  <span className="flex-1 text-[13px] text-ink font-medium">{m.label}</span>

                  {splitMode === 'equal' ? (
                    <>
                      <span className="text-[13px] font-semibold text-ink tabular-nums">
                        {included ? `¥${displayAmount.toLocaleString()}` : '—'}
                      </span>
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleIncluded(m.id)}
                        className="w-4 h-4 accent-accent cursor-pointer"
                      />
                    </>
                  ) : (
                    <div className="relative w-[110px]">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-[12px] pointer-events-none">¥</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={customSplits[m.id] ?? ''}
                        onChange={e => setCustomSplits(prev => ({ ...prev, [m.id]: e.target.value }))}
                        placeholder="0"
                        className="w-full h-9 pl-6 pr-2 rounded-[8px] border-[1.5px] border-border bg-app text-[16px] text-ink text-right tabular-nums outline-none focus-visible:border-accent"
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* 自訂模式：差額指示 */}
          {splitMode === 'custom' && amountNum > 0 && (
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
                ¥{customSum.toLocaleString()} / ¥{amountNum.toLocaleString()}
                {Math.abs(customDiff) >= 0.01 && (
                  <span className="ml-1.5">({customDiff > 0 ? '+' : ''}¥{customDiff.toLocaleString()})</span>
                )}
              </span>
            </div>
          )}
        </div>
      </FormField>

      <FormField label="メモ">
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="備考など"
          rows={2}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

    </BottomSheet>
  )
}
