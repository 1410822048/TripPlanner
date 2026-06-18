// src/features/schedule/components/ScheduleFormModal.tsx
// The caller (SchedulePage) re-keys this component by `editTarget?.id ?? 'new'`
// so every switch to a different schedule (or to "create new") produces a
// fresh mount. That lets all form state initialize directly from props via
// useState initializers — no sync-in-effect, no mid-typing state wipes.
import { useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { Schedule, ScheduleCategory, CreateScheduleInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import { DatePicker, TimePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import CurrencyInput from '@/components/ui/CurrencyInput'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { currencySymbol } from '@/utils/currency'
import { formatMinorForInput, parseMoneyToMinor, MoneyParseError } from '@/utils/money'
import { CATEGORY_ICON, SCHEDULE_CATEGORIES } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'

// `type` (not `interface`) so TS treats it as closed and the shape
// satisfies useFormReducer's `Record<string, unknown>` constraint.
type FormState = {
  title:     string
  date:      string
  startTime: string
  endTime:   string
  category:  ScheduleCategory
  location:  string
  desc:      string
  costText:  string                // raw user-typed money string; parsed to minor units on save
}

function initFormState(t: Schedule | null, defaultDate: string, currency: string): FormState {
  return {
    title:     t?.title ?? '',
    date:      t?.date ?? defaultDate,
    startTime: t?.startTime ?? '',
    endTime:   t?.endTime ?? '',
    category:  t?.category ?? 'activity',
    location:  t?.location?.name ?? '',
    desc:      t?.description ?? '',
    costText:  typeof t?.estimatedCostMinor === 'number'
      ? formatMinorForInput(t.estimatedCostMinor, currency)
      : '',
  }
}

interface Props {
  editTarget:  Schedule | null
  defaultDate: string
  /** Inclusive trip date range — schedule must fall inside this window.
   *  Forwarded to DatePicker so out-of-range days are disabled in the
   *  calendar UI rather than rejected after submission. */
  tripStartDate?: string
  tripEndDate?:   string
  isOpen:      boolean
  isSaving:    boolean
  saveError?:  string | null
  onClose:     () => void
  onSave:      (data: CreateScheduleInput) => void
  onDelete?:   () => void
}

export default function ScheduleFormModal({
  editTarget, defaultDate, tripStartDate, tripEndDate,
  isOpen, isSaving, saveError, onClose, onSave, onDelete,
}: Props) {
  const currency = useTripCurrency()
  const symbol   = currencySymbol(currency)
  const { state, setField } = useFormReducer<FormState>(
    () => initFormState(editTarget, defaultDate, currency),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  // Drop a single key from the errors map. Used by the time-picker
  // onChange handlers to clear the end-time conflict message as soon
  // as the user fixes the ordering, without waiting for next save.
  function clearError(key: string) {
    setErrors(prev => {
      if (!(key in prev)) return prev
      const next: Record<string, string> = {}
      for (const k of Object.keys(prev)) if (k !== key) next[k] = prev[k]!
      return next
    })
  }

  function parseCostMinor(): { ok: true; value: number | undefined } | { ok: false; error: string } {
    const text = state.costText.trim()
    if (text === '') return { ok: true, value: undefined }
    try {
      const minor = parseMoneyToMinor(text, currency)
      if (minor < 0) return { ok: false, error: '0 以上の金額を入力してください' }
      return { ok: true, value: minor }
    } catch (e) {
      if (e instanceof MoneyParseError) return { ok: false, error: '請輸入數字' }
      throw e
    }
  }

  function validate() {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    if (!state.date)         e.date  = '請選擇日期'
    const parsed = parseCostMinor()
    if (!parsed.ok) e.cost = parsed.error
    // 'HH:MM' strings sort lexicographically the same as time-of-day,
    // so a direct string compare correctly catches end < start.
    if (state.startTime && state.endTime && state.endTime < state.startTime) {
      e.endTime = '終了は開始より後の時刻にしてください'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSave() {
    if (!validate()) return
    const parsed = parseCostMinor()
    if (!parsed.ok) return  // re-checked here for type narrowing; validate() already surfaced
    const loc = state.location.trim()
    onSave({
      title: state.title.trim(),
      date:  state.date,
      startTime:          state.startTime || undefined,
      endTime:            state.endTime   || undefined,
      category:           state.category,
      description:        state.desc      || undefined,
      estimatedCostMinor: parsed.value,
      location:           loc ? { name: loc } : undefined,
    } as CreateScheduleInput)
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '行程を編集' : '行程を追加'}
      saveLabel={editTarget ? '変更を保存' : '行程を追加'}
      saveError={saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="タイトル" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder="例：淺草雷門を見学"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="カテゴリ">
        <div className="flex gap-[7px] flex-wrap">
          {SCHEDULE_CATEGORIES.map(c => {
            const CatIcon = CATEGORY_ICON[c.value]
            const active = state.category === c.value
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setField('category', c.value)}
                className={[
                  'flex items-center gap-[5px] px-3 py-1.5 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
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

      <FormField label="日付" error={errors.date} required>
        <DatePicker
          value={state.date}
          onChange={v => setField('date', v)}
          error={!!errors.date}
          minDate={tripStartDate}
          maxDate={tripEndDate}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2.5 items-start">
        <FormField label="開始時間">
          <TimePicker
            value={state.startTime}
            onChange={v => {
              setField('startTime', v)
              // Clear the endTime error eagerly when the user fixes the
              // ordering by changing startTime — avoids the warning
              // sticking after the conflict is resolved but before save.
              if (errors.endTime && (!state.endTime || v <= state.endTime)) {
                clearError('endTime')
              }
            }}
          />
        </FormField>
        <FormField label="終了時間" error={errors.endTime}>
          <TimePicker
            value={state.endTime}
            onChange={v => {
              setField('endTime', v)
              if (errors.endTime && (!state.startTime || v >= state.startTime)) {
                clearError('endTime')
              }
            }}
          />
        </FormField>
      </div>

      <FormField label="場所">
        <div className="relative">
          <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted" />
          <input
            value={state.location}
            onChange={e => setField('location', e.target.value)}
            placeholder="例：淺草寺"
            className={`${inputClass(false)} pl-[34px]`}
          />
        </div>
      </FormField>

      <FormField label={`予算（${symbol}）`} error={errors.cost}>
        <CurrencyInput
          symbol={symbol}
          value={state.costText}
          onChange={e => setField('costText', e.target.value)}
          placeholder="0"
          error={!!errors.cost}
        />
      </FormField>

      <FormField label="メモ">
        <textarea
          value={state.desc}
          onChange={e => setField('desc', e.target.value)}
          placeholder="備考・注意事項など"
          rows={3}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="行程" onDelete={onDelete} />}
    </FormModalShell>
  )
}
