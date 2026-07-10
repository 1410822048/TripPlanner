// src/features/wish/components/WishDeadlineSheet.tsx
// Owner-only editor for the trip's shared Wish voting deadline. Mirrors
// EditTripModal's BottomSheet + FormField + SaveButton shape; date + time
// picked separately (DatePicker + TimePicker, like ScheduleFormModal) then
// combined into one Date on save — the service layer converts to a
// Firestore Timestamp (setWishVotingDeadline).
import { useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import { DatePicker, TimePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import SaveButton from '@/components/ui/SaveButton'
import { useFormReducer } from '@/hooks/useFormReducer'
import { toLocalDateString } from '@/utils/dates'
import type { Timestamp } from 'firebase/firestore'

interface Props {
  isOpen:            boolean
  currentDeadlineAt: Timestamp | null
  isSaving?:         boolean
  onClose:           () => void
  onSave:            (deadlineAt: Date | null) => void
}

type FormState = {
  date: string // 'YYYY-MM-DD'
  time: string // 'HH:MM'
}

function initFormState(deadlineAt: Timestamp | null): FormState {
  if (!deadlineAt) return { date: '', time: '' }
  const d = deadlineAt.toDate()
  return {
    date: toLocalDateString(d),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  }
}

export default function WishDeadlineSheet({
  isOpen, currentDeadlineAt, isSaving, onClose, onSave,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(() => initFormState(currentDeadlineAt))
  const [errors, setErrors] = useState<Record<string, string>>({})

  function validate(): Date | null {
    const e: Record<string, string> = {}
    if (!state.date) e.date = '日付を選択してください'
    if (!state.time) e.time = '時刻を選択してください'
    if (Object.keys(e).length > 0) { setErrors(e); return null }
    const combined = new Date(`${state.date}T${state.time}:00`)
    if (combined.getTime() <= Date.now()) {
      setErrors({ time: '締切は現在より後の時刻にしてください' })
      return null
    }
    setErrors({})
    return combined
  }

  function handleSave() {
    const combined = validate()
    if (combined) onSave(combined)
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="投票締切を設定"
      footer={<SaveButton onClick={handleSave} isSaving={isSaving} label="締切を保存" />}
    >
      <div className="flex gap-2.5">
        <FormField label="日付" error={errors.date} required className="flex-1">
          <DatePicker value={state.date} onChange={v => setField('date', v)} error={!!errors.date} />
        </FormField>
        <FormField label="時刻" error={errors.time} required className="flex-1">
          <TimePicker value={state.time} onChange={v => setField('time', v)} error={!!errors.time} />
        </FormField>
      </div>

      {currentDeadlineAt && (
        <button
          type="button"
          disabled={isSaving}
          onClick={() => onSave(null)}
          className="w-full h-11 rounded-[16px] border border-danger/20 bg-danger-pale text-danger text-[12.5px] font-bold cursor-pointer transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          締切を削除
        </button>
      )}
    </BottomSheet>
  )
}
