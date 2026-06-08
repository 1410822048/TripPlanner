// src/features/bookings/components/BookingFormModal.tsx
// Add / edit form for a single booking. Parent re-keys this modal by
// `editTarget?.id ?? 'new'` and unmounts on close, so every state hook
// initializes once from props — no setState-in-effect for prop sync.
//
// Attachment handling is tri-state and mirrors the service contract:
//   - undefined → user didn't touch the file (no change on save)
//   - null      → user removed the existing file (clear on save)
//   - File      → user picked a new file (replace on save)
import { useRef, useState } from 'react'
import { Paperclip, ArrowRight } from 'lucide-react'
import type { Booking, CreateBookingInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import AttachmentPreviewModal from './AttachmentPreviewModal'
import { useBookingFormState } from '../hooks/useBookingFormState'
import { useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'

const TYPES: { value: Booking['type']; emoji: string; label: string }[] = [
  { value: 'flight', emoji: '✈️', label: 'フライト' },
  { value: 'hotel',  emoji: '🏨', label: 'ホテル'   },
  { value: 'train',  emoji: '🚆', label: '電車'     },
  { value: 'bus',    emoji: '🚌', label: 'バス'     },
  { value: 'other',  emoji: '📌', label: 'その他'   },
]

/** Transport types use origin → destination as the primary identifier;
 *  other types use a single title field. */
const TRANSPORT_TYPES: ReadonlySet<Booking['type']> = new Set(['flight', 'train', 'bus'])

/** Per-type label for the title field. Transport types treat title as
 *  a supplementary "vehicle name" (flight number / train name); hotel and
 *  other use it as the primary identifier. */
function titleLabel(type: Booking['type']): string {
  switch (type) {
    case 'flight': return '便名'
    case 'train':  return '列車名'
    case 'bus':    return 'バス名'
    case 'hotel':  return 'ホテル名'
    case 'other':  return 'タイトル'
  }
}

function titlePlaceholder(type: Booking['type']): string {
  switch (type) {
    case 'flight': return '例：NH802（任意）'
    case 'train':  return '例：のぞみ47号（任意）'
    case 'bus':    return '例：夜行バス XYZ（任意）'
    case 'hotel':  return '例：Dormy Inn 淺草'
    case 'other':  return '例：現地ツアー予約'
  }
}

const ACCEPT_TYPES = 'image/*,application/pdf'

export interface BookingFormResult {
  input:      CreateBookingInput
  attachment: AttachmentChange
}

interface Props {
  editTarget: Booking | null
  /** Inclusive trip date range — DatePickers (checkIn / checkOut) open
   *  on the trip's first month and disable days outside the window.
   *  When omitted (e.g. demo mode without a real trip) the pickers
   *  fall back to today's month, no range constraint. */
  tripStartDate?: string
  tripEndDate?:   string
  isOpen:     boolean
  isSaving:   boolean
  saveError?: string | null
  onClose:    () => void
  onSave:     (data: BookingFormResult) => void
  /** Only present in edit mode for users with delete permission.
   *  Renders a two-step inline confirm above the save button. */
  onDelete?:  () => void
}

export default function BookingFormModal({
  editTarget, tripStartDate, tripEndDate,
  isOpen, isSaving, saveError, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useBookingFormState(editTarget)
  const att = useAttachment({
    // previewPath = real thumb only (no full-path fallback): a thumb-less /
    // PDF attachment shows the row icon, and the full blob resolves only
    // when the preview modal opens (path-driven via fullPath).
    previewPath: editTarget?.attachment?.thumbPath ?? null,
    fullPath:    editTarget?.attachment?.filePath  ?? null,
    type:        editTarget?.attachment?.fileType  ?? null,
  })
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  // Full-size preview URL: a newly-picked file uses its local blob (already
  // full-res); an existing attachment resolves its fullPath via getBlob only
  // while the modal is open (path-driven). null → modal shows a spinner.
  const previewFullUrl = useAttachmentUrl(previewOpen && !att.hasNewFile ? att.fullPath : null, { kind: 'full' })
  const previewModalUrl = att.hasNewFile ? att.previewUrl : previewFullUrl

  const titleRef    = useRef<HTMLInputElement>(null)
  const originRef   = useRef<HTMLInputElement>(null)
  const fileRef     = useRef<HTMLInputElement>(null)
  const checkOutRef = useRef<DatePickerHandle>(null)
  // For transport types the user wants origin first, so focus that input
  // on open. Hotel / other open with their primary text field focused.
  const isTransport = TRANSPORT_TYPES.has(state.type)
  useAutoFocus(isTransport ? originRef : titleRef, isOpen)

  // Hotel is the only type that conventionally has both check-in and check-out.
  const showRange = state.type === 'hotel'

  function pickFile() {
    fileRef.current?.click()
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (f) att.pickFile(f)
  }

  function validate(): BookingFormResult | null {
    const e: Record<string, string> = {}
    // Validation rules differ by type:
    //   transport (flight/train/bus): require both origin and destination;
    //     title (= flight number / train name) is supplementary
    //   hotel / other: require title; origin/destination not used
    if (isTransport) {
      if (!state.origin.trim())      e.origin      = '出発地を入力してください'
      if (!state.destination.trim()) e.destination = '到着地を入力してください'
    } else if (!state.title.trim()) {
      e.title = state.type === 'hotel' ? 'ホテル名を入力してください' : 'タイトルを入力してください'
    }
    if (showRange && state.checkIn && state.checkOut && state.checkOut < state.checkIn) {
      e.checkOut = 'チェックアウトはチェックイン以降を選んでください'
    }
    setErrors(e)
    if (Object.keys(e).length > 0) return null

    const input: CreateBookingInput = {
      type:             state.type,
      title:            state.title.trim() || undefined,
      origin:           isTransport ? state.origin.trim() || undefined      : undefined,
      destination:      isTransport ? state.destination.trim() || undefined : undefined,
      confirmationCode: state.confirmationCode.trim() || undefined,
      provider:         state.provider.trim() || undefined,
      checkIn:          state.checkIn || undefined,
      checkOut:         showRange ? (state.checkOut || undefined) : undefined,
      // Address is most useful for hotel + その他 (the user wants a
      // map deep-link). Transport types already convey location via
      // origin/destination so we don't show the input there.
      address:          isTransport ? undefined : state.address.trim() || undefined,
      note:             state.note.trim() || undefined,
    }

    return { input, attachment: att.pickAttachmentChange() }
  }

  function handleSave() {
    const result = validate()
    if (result) onSave(result)
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '予約を編集' : '予約を追加'}
      saveLabel={editTarget ? '変更を保存' : '予約を追加'}
      saveError={saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="種類">
        <div className="flex gap-[7px] flex-wrap">
          {TYPES.map(t => {
            const active = state.type === t.value
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setField('type', t.value)}
                className={[
                  'flex items-center gap-[5px] px-3 py-1.5 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-muted font-normal hover:border-muted',
                ].join(' ')}
              >
                <span>{t.emoji}</span>{t.label}
              </button>
            )
          })}
        </div>
      </FormField>

      {isTransport && (
        <FormField
          label={state.type === 'flight' ? '出発地 → 到着地' : '出発 → 到着'}
          error={errors.origin ?? errors.destination}
          required
        >
          <div className="flex items-center gap-2">
            <input
              ref={originRef}
              value={state.origin}
              onChange={e => setField('origin', e.target.value)}
              placeholder={state.type === 'flight' ? '桃園 / TPE' : '東京駅'}
              className={inputClass(!!errors.origin)}
            />
            <ArrowRight size={16} strokeWidth={2} className="shrink-0 text-muted" />
            <input
              value={state.destination}
              onChange={e => setField('destination', e.target.value)}
              placeholder={state.type === 'flight' ? '成田 / NRT' : '京都駅'}
              className={inputClass(!!errors.destination)}
            />
          </div>
        </FormField>
      )}

      <FormField
        label={titleLabel(state.type)}
        error={errors.title}
        required={!isTransport}
      >
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder={titlePlaceholder(state.type)}
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <div className="flex gap-2.5">
        <FormField label="確認番号" className="flex-1">
          <input
            value={state.confirmationCode}
            onChange={e => setField('confirmationCode', e.target.value)}
            placeholder="ABC123"
            className={`${inputClass(false)} font-mono tracking-tight`}
          />
        </FormField>
        <FormField label="提供元" className="flex-1">
          <input
            value={state.provider}
            onChange={e => setField('provider', e.target.value)}
            placeholder={state.type === 'flight' ? 'ANA' : state.type === 'hotel' ? 'Booking.com' : ''}
            className={inputClass(false)}
          />
        </FormField>
      </div>

      {showRange ? (
        <div className="flex gap-2.5">
          <FormField label="チェックイン" className="flex-1">
            <DatePicker
              value={state.checkIn}
              onChange={v => {
                setField('checkIn', v)
                // Mirror EditTripModal's chained-picker UX: after the
                // user picks check-in, auto-open check-out on the same
                // month so they don't have to tap a second field. The
                // 160ms delay lets the first dialog's close transition
                // finish before the second opens — without it the two
                // dialogs briefly overlap on iOS.
                if (v) setTimeout(() => checkOutRef.current?.open({ viewDate: v }), 160)
              }}
              placeholder="日付"
              minDate={tripStartDate}
              maxDate={tripEndDate}
            />
          </FormField>
          <FormField label="チェックアウト" error={errors.checkOut} className="flex-1">
            <DatePicker
              ref={checkOutRef}
              value={state.checkOut}
              onChange={v => setField('checkOut', v)}
              placeholder="日付"
              error={!!errors.checkOut}
              minDate={tripStartDate}
              maxDate={tripEndDate}
            />
          </FormField>
        </div>
      ) : (
        <FormField label="日付">
          <DatePicker
            value={state.checkIn}
            onChange={v => setField('checkIn', v)}
            placeholder="日付"
            minDate={tripStartDate}
            maxDate={tripEndDate}
          />
        </FormField>
      )}

      {/* Address — only useful for hotel / その他 (transport types
          already convey location via origin/destination). Free-text;
          Google Maps treats it as a search query so anything from a
          street address to a venue name resolves cleanly. */}
      {!isTransport && (
        <FormField label="住所（任意）">
          <input
            value={state.address}
            onChange={e => setField('address', e.target.value)}
            placeholder={state.type === 'hotel' ? '例：東京都台東区浅草 1-1-1' : '例：上野公園'}
            maxLength={200}
            className={inputClass(false)}
          />
        </FormField>
      )}

      <FormField label="添付（画像 / PDF）" error={att.error ?? undefined}>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_TYPES}
          onChange={onFilePicked}
          className="hidden"
        />
        {att.hasAttachment ? (
          <AttachmentRow
            fileName={att.attachmentName}
            previewUrl={att.previewUrl}
            isImage={att.previewIsImage}
            onReplace={pickFile}
            onClear={att.clear}
            onPreview={() => (att.hasNewFile || att.fullPath) && setPreviewOpen(true)}
            canPreview={att.hasNewFile || !!att.fullPath}
            replaceAriaLabel="ファイルを変更"
            previewAriaLabel="添付を表示"
            clearAriaLabel="添付を削除"
          />
        ) : (
          <button
            type="button"
            onClick={pickFile}
            className="w-full h-[58px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Paperclip size={16} strokeWidth={1.8} />
            <span>確認書をアップロード</span>
          </button>
        )}
      </FormField>

      <FormField label="メモ">
        <textarea
          value={state.note}
          onChange={e => setField('note', e.target.value)}
          placeholder="備考（座席、空港カウンター情報など）"
          rows={2}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="予約" onDelete={onDelete} />}

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
