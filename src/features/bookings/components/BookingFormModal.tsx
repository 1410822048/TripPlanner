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
import { Paperclip, ArrowRight, Image as ImageIcon } from 'lucide-react'
import type { Booking, CreateBookingInput } from '@/types'
import { isHttpUrl } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import AttachmentPreviewModal from './AttachmentPreviewModal'
import { useBookingFormState, type BookingFormDraft } from '../hooks/useBookingFormState'
import { useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { BOOKING_TYPE_META, BOOKING_TYPE_ORDER } from '../utils'
import { deriveBookingLinkDraft } from '../linkDraft'

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

const IMAGE_ACCEPT_TYPES = 'image/*'
const DOCUMENT_ACCEPT_TYPES = 'image/*,application/pdf'

export interface BookingFormResult {
  input:      CreateBookingInput
  coverImage: AttachmentChange
  document:   AttachmentChange
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
  /** Create-only initial values, used by PWA Share Target. Edit mode
   *  intentionally ignores it so a shared URL can never overwrite the
   *  selected booking's persisted fields. */
  initialDraft?: BookingFormDraft
  onClose:    () => void
  onSave:     (data: BookingFormResult) => void
  /** Only present in edit mode for users with delete permission.
   *  Renders a two-step inline confirm above the save button. */
  onDelete?:  () => void
}

export default function BookingFormModal({
  editTarget, tripStartDate, tripEndDate,
  isOpen, isSaving, saveError, initialDraft, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useBookingFormState(editTarget, initialDraft)
  const coverSource = editTarget?.coverImage
  const documentSource = editTarget?.document
  const coverAtt = useAttachment({
    previewPath: coverSource?.thumbPath ?? null,
    fullPath:    coverSource?.filePath  ?? null,
    type:        coverSource?.fileType  ?? null,
  })
  const docAtt = useAttachment({
    // previewPath = real thumb only (no full-path fallback): a thumb-less /
    // PDF attachment shows the row icon, and the full blob resolves only
    // when the preview modal opens (path-driven via fullPath).
    previewPath: documentSource?.thumbPath ?? null,
    fullPath:    documentSource?.filePath  ?? null,
    type:        documentSource?.fileType  ?? null,
  })
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [previewTarget, setPreviewTarget] = useState<'cover' | 'document' | null>(null)
  // Full-size preview URL: a newly-picked file uses its local blob (already
  // full-res); an existing attachment resolves its fullPath via getBlob only
  // while the modal is open (path-driven). null → modal shows a spinner.
  const coverFullUrl = useAttachmentUrl(previewTarget === 'cover' && !coverAtt.hasNewFile ? coverAtt.fullPath : null, { kind: 'full' })
  const docFullUrl = useAttachmentUrl(previewTarget === 'document' && !docAtt.hasNewFile ? docAtt.fullPath : null, { kind: 'full' })
  const previewAtt = previewTarget === 'cover' ? coverAtt : previewTarget === 'document' ? docAtt : null
  const previewModalUrl = !previewAtt
    ? null
    : previewAtt.hasNewFile
      ? previewAtt.previewUrl
      : previewTarget === 'cover' ? coverFullUrl : docFullUrl

  const titleRef    = useRef<HTMLInputElement>(null)
  const originRef   = useRef<HTMLInputElement>(null)
  const coverFileRef = useRef<HTMLInputElement>(null)
  const docFileRef   = useRef<HTMLInputElement>(null)
  const checkOutRef = useRef<DatePickerHandle>(null)
  // For transport types the user wants origin first, so focus that input
  // on open. Hotel / other open with their primary text field focused.
  const isTransport = TRANSPORT_TYPES.has(state.type)
  useAutoFocus(isTransport ? originRef : titleRef, isOpen)

  // Hotel is the only type that conventionally has both check-in and check-out.
  const showRange = state.type === 'hotel'

  function pickCoverImage() {
    coverFileRef.current?.click()
  }

  function pickDocument() {
    docFileRef.current?.click()
  }

  function onCoverImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (f) coverAtt.pickFile(f)
  }

  function onDocumentPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (f) docAtt.pickFile(f)
  }

  function applyLinkDefaults(linkValue = state.link) {
    const draft = deriveBookingLinkDraft({ link: linkValue })
    if (!draft?.link) return

    const isBlankIdentity = !state.title.trim() && !state.origin.trim() && !state.destination.trim()

    if (!state.provider.trim()) setField('provider', draft.provider)
    if (isBlankIdentity) {
      setField('title', draft.title)
      // The create form defaults to flight. If URL is the first meaningful
      // input, choose the closest non-transport type so the draft is saveable.
      // Once title/route exists, or in edit mode, never rewrite the type.
      if (!editTarget && state.type === 'flight') {
        setField('type', draft.type)
      }
    }
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
      e.checkOut = 'Check-out は Check-in 以降を選んでください'
    }
    // link は href に出すので http(s) のみ。空欄は許可(任意項目)。
    const linkTrimmed = state.link.trim()
    if (linkTrimmed && !isHttpUrl(linkTrimmed)) {
      e.link = 'http:// または https:// で始まる URL を入力してください'
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
      link:             linkTrimmed || undefined,
      note:             state.note.trim() || undefined,
    }

    return {
      input,
      coverImage: showRange ? coverAtt.pickAttachmentChange() : coverAtt.hasAttachment ? null : undefined,
      document:   docAtt.pickAttachmentChange(),
    }
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
          {BOOKING_TYPE_ORDER.map(value => {
            const { icon: TypeIcon, label } = BOOKING_TYPE_META[value]
            const active = state.type === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setField('type', value)}
                className={[
                  'flex items-center gap-[5px] px-3 py-1.5 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-muted font-normal hover:border-muted',
                ].join(' ')}
              >
                <TypeIcon size={13} strokeWidth={2} />{label}
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
        <FormField label="Check-in" className="flex-1">
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
        <FormField label="Check-out" error={errors.checkOut} className="flex-1">
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
        <FormField label="住所 / Google Maps URL（任意）">
          <input
            value={state.address}
            onChange={e => setField('address', e.target.value)}
            placeholder={state.type === 'hotel' ? '例：東京都台東区浅草 1-1-1 / Google Maps の URL' : '例：上野公園 / Google Maps の URL'}
            maxLength={500}
            className={inputClass(false)}
          />
        </FormField>
      )}

      {/* 予約 URL — OTA / 公式サイトの予約ページ。全 type 共通
          (機票も飯店も予約 URL を持ち得る)。href に出すため http(s)
          のみ(form validate + Zod + firestore.rules で三重 enforce)。 */}
      <FormField label="予約 URL（任意）" error={errors.link}>
        <input
          value={state.link}
          onChange={e => setField('link', e.target.value)}
          onBlur={() => applyLinkDefaults()}
          placeholder="https://..."
          type="url"
          maxLength={500}
          className={inputClass(!!errors.link)}
        />
      </FormField>

      {showRange && (
        <FormField label="カバー画像" error={coverAtt.error ?? undefined}>
          <input
            ref={coverFileRef}
            type="file"
            accept={IMAGE_ACCEPT_TYPES}
            onChange={onCoverImagePicked}
            className="hidden"
          />
          {coverAtt.hasAttachment ? (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <button
                type="button"
                onClick={() => (coverAtt.hasNewFile || coverAtt.fullPath) && setPreviewTarget('cover')}
                disabled={!coverAtt.hasNewFile && !coverAtt.fullPath}
                className="relative block h-[154px] w-full overflow-hidden border-0 bg-tile p-0 text-left cursor-pointer disabled:cursor-default"
                aria-label="カバー画像を表示"
              >
                {coverAtt.previewUrl ? (
                  <img
                    src={coverAtt.previewUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                    <ImageIcon size={28} strokeWidth={1.7} />
                    <span className="text-[12px] font-bold">カバー画像</span>
                  </div>
                )}
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span className="min-w-0 truncate text-[12px] font-bold text-ink">
                  {coverAtt.attachmentName}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={pickCoverImage}
                    className="h-8 rounded-chip border border-border bg-surface px-3 text-[11.5px] font-bold text-muted"
                  >
                    変更
                  </button>
                  <button
                    type="button"
                    onClick={coverAtt.clear}
                    className="h-8 rounded-chip border border-danger-soft bg-danger-pale px-3 text-[11.5px] font-bold text-danger"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={pickCoverImage}
              className="w-full h-[132px] rounded-card border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-accent hover:text-accent transition-colors"
            >
              <ImageIcon size={22} strokeWidth={1.7} />
              <span>ホテルカード用の画像を追加</span>
            </button>
          )}
        </FormField>
      )}

      <FormField label="予約確認書（PDF / 画像）" error={docAtt.error ?? undefined}>
        <input
          ref={docFileRef}
          type="file"
          accept={DOCUMENT_ACCEPT_TYPES}
          onChange={onDocumentPicked}
          className="hidden"
        />
        {docAtt.hasAttachment ? (
          <AttachmentRow
            fileName={docAtt.attachmentName}
            previewUrl={docAtt.previewUrl}
            isImage={docAtt.previewIsImage}
            onReplace={pickDocument}
            onClear={docAtt.clear}
            onPreview={() => (docAtt.hasNewFile || docAtt.fullPath) && setPreviewTarget('document')}
            canPreview={docAtt.hasNewFile || !!docAtt.fullPath}
            replaceAriaLabel="ファイルを変更"
            previewAriaLabel="添付を表示"
            clearAriaLabel="添付を削除"
          />
        ) : (
          <button
            type="button"
            onClick={pickDocument}
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

      {previewTarget && previewAtt && (previewAtt.hasNewFile || previewAtt.fullPath) && (
        <AttachmentPreviewModal
          url={previewModalUrl}
          fileType={previewAtt.previewMime}
          fileName={previewAtt.attachmentName}
          onClose={() => setPreviewTarget(null)}
        />
      )}

    </FormModalShell>
  )
}
