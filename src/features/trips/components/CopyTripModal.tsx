// src/features/trips/components/CopyTripModal.tsx
// "複製行程" — clones a trip's metadata + (optionally) its schedule
// itinerary and pre-trip checklist. The form is intentionally narrow:
// just title + new start date + two checkboxes. Destination, currency,
// and emoji come from the source unchanged; users can refine via
// EditTripModal afterwards if needed.
//
// Date-shifting is automatic: pick a new start date, the new end date
// is computed to preserve duration, and every schedule's date shifts
// by the same delta. If the user later changes the new trip's range
// to be shorter, schedule dates are not auto-trimmed (the cascade in
// EditTripModal already shows the orphan-warning).
import { useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import { DatePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import SaveButton from '@/components/ui/SaveButton'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { addDays, daysBetween, toLocalDateString } from '@/utils/dates'
import type { Trip } from '@/types'
import type { CopyTripInput } from '../services/tripService'

// `type` (not `interface`) so TS treats the shape as closed and it
// satisfies useFormReducer's `Record<string, unknown>` constraint.
type FormState = {
  title:          string
  newStartDate:   string
  copySchedules:  boolean
  copyPlanning:   boolean
}

function initFormState(source: Trip): FormState {
  // Default new trip starts today; preserves source duration via the
  // dateOffset computation in copyTrip. User can pick a different
  // start date — duration is held constant unless they edit later.
  const today = toLocalDateString(new Date())
  return {
    title:         `${source.title} (副本)`,
    newStartDate:  today,
    copySchedules: true,
    copyPlanning:  true,
  }
}

interface Props {
  isOpen:    boolean
  source:    Trip
  isSaving:  boolean
  onClose:   () => void
  onConfirm: (input: CopyTripInput) => void
}

export default function CopyTripModal({ isOpen, source, isSaving, onClose, onConfirm }: Props) {
  const { state, setField } = useFormReducer<FormState>(() => initFormState(source))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  const sourceDays = daysBetween(source.startDate, source.endDate)
  const newEndDate = state.newStartDate
    ? addDays(state.newStartDate, sourceDays - 1)
    : ''

  function validate(): CopyTripInput | null {
    const e: Record<string, string> = {}
    if (!state.title.trim())     e.title        = '請輸入新行程名稱'
    if (!state.newStartDate)     e.newStartDate = '請選擇新開始日期'
    setErrors(e)
    if (Object.keys(e).length > 0) return null
    return {
      title:         state.title.trim(),
      newStartDate:  state.newStartDate,
      copySchedules: state.copySchedules,
      copyPlanning:  state.copyPlanning,
    }
  }

  function handleConfirm() {
    const input = validate()
    if (input) onConfirm(input)
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="複製行程"
      footer={
        <SaveButton onClick={handleConfirm} isSaving={isSaving} label="複製" />
      }
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5 mb-1 rounded-xl bg-accent-pale border border-accent/15">
        <Copy size={15} strokeWidth={2} className="shrink-0 mt-px text-accent" />
        <div className="text-[11.5px] text-ink leading-[1.6]">
          將從「{source.title}」複製：
          <span className="font-semibold">基本資訊 + 行程內容（依日期偏移）+ 行前計畫</span>。
          訂單 / 費用 / 心願 / 成員 不會被複製。
        </div>
      </div>

      <FormField label="新行程名稱" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder="例：東京五日間（重訪）"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="新開始日期" error={errors.newStartDate} required>
        <DatePicker
          value={state.newStartDate}
          onChange={v => setField('newStartDate', v)}
          error={!!errors.newStartDate}
        />
      </FormField>

      {newEndDate && (
        <div className="px-1 -mt-1 text-[11.5px] text-muted leading-[1.6]">
          新結束日期：<span className="font-semibold text-ink tabular-nums">{newEndDate}</span>
          <span className="ml-1.5">（保留原行程 {sourceDays} 天的長度）</span>
        </div>
      )}

      <FormField label="複製內容">
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2.5 cursor-pointer text-[13px]">
            <input
              type="checkbox"
              checked={state.copySchedules}
              onChange={e => setField('copySchedules', e.target.checked)}
              className="w-4 h-4 accent-accent cursor-pointer"
            />
            <span>📅 行程内容（日期會依新開始日自動偏移）</span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer text-[13px]">
            <input
              type="checkbox"
              checked={state.copyPlanning}
              onChange={e => setField('copyPlanning', e.target.checked)}
              className="w-4 h-4 accent-accent cursor-pointer"
            />
            <span>✅ 行前計畫（已勾選的項目會重置為未完成）</span>
          </label>
        </div>
      </FormField>
    </BottomSheet>
  )
}
