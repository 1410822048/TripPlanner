// src/features/schedule/components/EditTripModal.tsx
// The caller (SchedulePage) passes a `key` of the trip id, so this component
// remounts whenever the trip being edited switches. That lets the form
// initialize state directly from props in useState initializers — no
// sync-in-effect, no accidental wipe from parent spreading a fresh object.
import { useRef, useState } from 'react'
import { AlertTriangle, MapPin } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import SaveButton from '@/components/ui/SaveButton'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import type { TripItem } from '../types'

const EMOJI_OPTIONS = [
  '🗼','🏯','⛩️','🗾','🌸','🍁',
  '⛄','🏖️','🌴','🗻','✈️','🚅',
  '🎡','🎋','🍣','🎎','🌋','📸',
]

interface Props {
  isOpen:      boolean
  editTarget:  TripItem | null
  /** 該行程目前所有 schedule 的日期陣列（用來偵測孤兒警告） */
  scheduleDates?: string[]
  isSaving?:   boolean
  onClose:     () => void
  onSave:      (data: TripItem) => void
}

export default function EditTripModal({
  isOpen, editTarget, scheduleDates = [], isSaving, onClose, onSave,
}: Props) {
  const [title,     setTitle]     = useState(editTarget?.title     ?? '')
  const [dest,      setDest]      = useState(editTarget?.dest      ?? '')
  const [emoji,     setEmoji]     = useState(editTarget?.emoji     ?? '🗼')
  const [startDate, setStartDate] = useState(editTarget?.startDate ?? '')
  const [endDate,   setEndDate]   = useState(editTarget?.endDate   ?? '')
  const [errors,    setErrors]    = useState<Record<string, string>>({})

  const titleRef   = useRef<HTMLInputElement>(null)
  const endDateRef = useRef<DatePickerHandle>(null)

  useAutoFocus(titleRef, isOpen && !!editTarget)

  const orphanCount = scheduleDates.filter(d => {
    if (!startDate || !endDate) return false
    return d < startDate || d > endDate
  }).length

  function validate() {
    const e: Record<string, string> = {}
    if (!title.trim())     e.title = '請輸入行程名稱'
    if (!dest.trim())      e.dest  = '請輸入目的地'
    if (!startDate)        e.startDate = '請選擇開始日期'
    if (!endDate)          e.endDate   = '請選擇結束日期'
    if (startDate && endDate && endDate < startDate) {
      e.endDate = '結束日期不可早於開始日期'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSave() {
    if (!validate() || !editTarget) return
    onSave({
      ...editTarget,
      title:     title.trim(),
      dest:      dest.trim(),
      emoji,
      startDate,
      endDate,
    })
  }

  if (!editTarget) return null

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="旅程情報を編集"
      footer={<SaveButton onClick={handleSave} isSaving={isSaving} label="変更を保存" />}
    >
      <FormField label="アイコン">
        <div className="grid grid-cols-6 gap-1.5 p-2.5 bg-app rounded-input border-[1.5px] border-border">
          {EMOJI_OPTIONS.map(em => {
            const isActive = em === emoji
            return (
              <button
                key={em}
                type="button"
                onClick={() => setEmoji(em)}
                className={[
                  'h-[38px] rounded-input cursor-pointer text-[20px] transition-all',
                  isActive
                    ? 'border-2 border-accent bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.08)]'
                    : 'border-2 border-transparent bg-transparent hover:bg-surface',
                ].join(' ')}
              >
                {em}
              </button>
            )
          })}
        </div>
      </FormField>

      <FormField label="旅程名稱" error={errors.title} required>
        <input
          ref={titleRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="例：東京五日間"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="目的地" error={errors.dest} required>
        <div className="relative">
          <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted" />
          <input
            value={dest}
            onChange={e => setDest(e.target.value)}
            placeholder="例：東京 · 淺草 · 新宿"
            className={`${inputClass(!!errors.dest)} pl-[34px]`}
          />
        </div>
      </FormField>

      <div className="flex gap-2.5">
        <FormField label="開始日" error={errors.startDate} required className="flex-1">
          <DatePicker
            value={startDate}
            onChange={v => {
              setStartDate(v)
              // After picking start, always chain into the end-date picker —
              // users expect the guided flow even when editing a trip that
              // already has a valid end date. 160ms lets the first dialog's
              // close transition finish so the two pickers don't overlap.
              // Pass viewDate so the end picker opens on the start's month
              // instead of today (avoids a jarring jump back to April when
              // the user just navigated to September to pick their start).
              if (v) setTimeout(() => endDateRef.current?.open({ viewDate: v }), 160)
            }}
            error={!!errors.startDate}
          />
        </FormField>
        <FormField label="結束日" error={errors.endDate} required className="flex-1">
          <DatePicker ref={endDateRef} value={endDate} onChange={setEndDate} error={!!errors.endDate} />
        </FormField>
      </div>

      {orphanCount > 0 && (
        <div className="flex gap-2.5 px-3 py-[11px] rounded-xl bg-warn-bg border border-[#E8D5B0]">
          <AlertTriangle size={16} className="shrink-0 mt-px text-warn" />
          <div className="flex-1 text-[11.5px] text-warn leading-[1.6]">
            <div className="font-bold mb-0.5">
              {orphanCount} 件の行程が範圍外になります
            </div>
            <div className="text-[#9A7A4A]">
              新しい日付範圍に含まれない行程は表示されなくなります（削除はされません）。
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}
