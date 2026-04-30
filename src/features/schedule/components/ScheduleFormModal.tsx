// src/features/schedule/components/ScheduleFormModal.tsx
// The caller (SchedulePage) re-keys this component by `editTarget?.id ?? 'new'`
// so every switch to a different schedule (or to "create new") produces a
// fresh mount. That lets all form state initialize directly from props via
// useState initializers — no sync-in-effect, no mid-typing state wipes.
import { useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { Schedule, ScheduleCategory, CreateScheduleInput } from '@/types'
import BottomSheet from '@/components/ui/BottomSheet'
import { DatePicker, TimePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import SaveButton from '@/components/ui/SaveButton'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'

const CATEGORIES: { value: ScheduleCategory; label: string }[] = [
  { value: 'transport',     label: '交通' },
  { value: 'accommodation', label: '住宿' },
  { value: 'food',          label: '餐廳' },
  { value: 'activity',      label: '活動' },
  { value: 'shopping',      label: '購物' },
  { value: 'other',         label: '其他' },
]

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
  cost:      string                // string for input control; coerced to number on save
}

function initFormState(t: Schedule | null, defaultDate: string): FormState {
  return {
    title:     t?.title ?? '',
    date:      t?.date ?? defaultDate,
    startTime: t?.startTime ?? '',
    endTime:   t?.endTime ?? '',
    category:  t?.category ?? 'activity',
    location:  t?.location?.name ?? '',
    desc:      t?.description ?? '',
    cost:      t?.estimatedCost ? String(t.estimatedCost) : '',
  }
}

interface Props {
  editTarget:  Schedule | null
  defaultDate: string
  isOpen:      boolean
  isSaving:    boolean
  onClose:     () => void
  onSave:      (data: CreateScheduleInput) => void
  onDelete?:   () => void
}

export default function ScheduleFormModal({
  editTarget, defaultDate, isOpen, isSaving, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(
    () => initFormState(editTarget, defaultDate),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  function validate() {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    if (!state.date)         e.date  = '請選擇日期'
    if (state.cost && isNaN(Number(state.cost))) e.cost = '請輸入數字'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSave() {
    if (!validate()) return
    const loc = state.location.trim()
    onSave({
      title: state.title.trim(),
      date:  state.date,
      startTime:     state.startTime || undefined,
      endTime:       state.endTime   || undefined,
      category:      state.category,
      description:   state.desc      || undefined,
      estimatedCost: state.cost ? Number(state.cost) : undefined,
      location:      loc ? { name: loc } : undefined,
    } as CreateScheduleInput)
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={editTarget ? '行程を編集' : '行程を追加'}
      footer={
        <SaveButton
          onClick={handleSave}
          isSaving={isSaving}
          label={editTarget ? '変更を保存' : '行程を追加'}
        />
      }
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
          {CATEGORIES.map(c => {
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
                <span>{CATEGORY_EMOJI[c.value]}</span>{c.label}
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
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2.5">
        <FormField label="開始時間">
          <TimePicker value={state.startTime} onChange={v => setField('startTime', v)} />
        </FormField>
        <FormField label="終了時間">
          <TimePicker value={state.endTime} onChange={v => setField('endTime', v)} />
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

      <FormField label="予算（¥）" error={errors.cost}>
        <div className="relative">
          <span className="absolute left-[13px] top-1/2 -translate-y-1/2 text-muted text-[13px] pointer-events-none">¥</span>
          <input
            type="number"
            value={state.cost}
            onChange={e => setField('cost', e.target.value)}
            placeholder="0"
            min={0}
            className={`${inputClass(!!errors.cost)} pl-7`}
          />
        </div>
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

      {editTarget && onDelete && (
        confirmDelete ? (
          <div className="flex gap-2 p-3 rounded-xl bg-danger-pale border border-danger-soft">
            <span className="flex-1 text-[12px] text-danger self-center leading-[1.5]">
              この行程を削除しますか？
            </span>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-app transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1.5 rounded-lg border border-danger-soft bg-transparent text-danger text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-danger-pale transition-colors"
            >
              削除
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-full p-[11px] rounded-xl border border-danger-soft bg-transparent text-danger text-[13px] font-medium cursor-pointer tracking-[0.04em] hover:bg-danger-pale transition-colors"
          >
            この行程を削除
          </button>
        )
      )}
    </BottomSheet>
  )
}
