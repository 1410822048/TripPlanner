// src/features/bookings/components/BookingFormModal.tsx
// Add / edit form for a single booking. Parent re-keys this modal by
// `editTarget?.id ?? 'new'` and unmounts on close, so every state hook
// initializes once from props — no setState-in-effect for prop sync.
//
// Attachment handling is tri-state and mirrors the service contract:
//   - undefined → user didn't touch the file (no change on save)
//   - null      → user removed the existing file (clear on save)
//   - File      → user picked a new file (replace on save)
import { useEffect, useId, useRef, useState } from 'react'
import { Paperclip, CalendarDays, ChevronRight, FileText, Image as ImageIcon, KeyRound, Loader2, PencilLine, RefreshCw } from 'lucide-react'
import { isHttpUrl, type Booking, type CreateBookingInput } from '@/types/booking'
import FormModalShell from '@/components/ui/FormModalShell'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import AttachmentPreviewModal from '@/features/attachments/components/AttachmentPreviewModal'
import { useBookingFormState, type BookingFormDraft } from '../hooks/useBookingFormState'
import { ATTACHMENT_SIZE_ERROR, useAttachment, type AttachmentChange } from '@/hooks/useAttachment'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { BOOKING_TYPE_META, BOOKING_TYPE_ORDER } from '../utils'
import { deriveBookingLinkDraft } from '../linkDraft'
import {
  BookingPdfExtractError,
  bookingPdfCandidateToCreateInput,
  bookingPdfExtractToDraftPatch,
  extractBookingPdfAutofill,
  type BookingPdfExtractCandidate,
} from '../services/bookingPdfExtractService'
import { isPdfFile } from '../services/bookingPdfText'

/** Transport types use origin → destination as the primary identifier;
 *  other types use a single title field. */
const TRANSPORT_TYPES: ReadonlySet<Booking['type']> = new Set(['flight', 'train', 'bus'])

/** Per-type label for the title field. Transport types treat title as
 *  a supplementary "vehicle name" (flight number / train name); hotel and
 *  other use it as the primary identifier. */
function titleLabel(type: Booking['type']): string {
  switch (type) {
    case 'flight': return '航班編號'
    case 'train':  return '列車名稱'
    case 'bus':    return '巴士名稱'
    case 'hotel':  return '飯店名稱'
    case 'other':  return '標題'
  }
}

function titlePlaceholder(type: Booking['type']): string {
  switch (type) {
    case 'flight': return '例如：NH802（選填）'
    case 'train':  return '例如：希望 47 號（選填）'
    case 'bus':    return '例如：夜行巴士 XYZ（選填）'
    case 'hotel':  return '例如：Dormy Inn 淺草'
    case 'other':  return '例如：當地行程預約'
  }
}

function providerPlaceholder(type: Booking['type']): string {
  switch (type) {
    case 'flight': return 'ANA'
    case 'train':  return 'JR東日本'
    case 'bus':    return 'WILLER EXPRESS'
    case 'hotel':  return 'Booking.com'
    case 'other':  return 'Klook'
  }
}

const IMAGE_ACCEPT_TYPES = 'image/*'
const DOCUMENT_ACCEPT_TYPES = 'image/*,application/pdf'
const PDF_ACCEPT_TYPES = 'application/pdf,.pdf'

function bookingRouteInputClass(hasError?: boolean): string {
  return [
    'w-full min-w-0 border-0 border-b border-dashed bg-transparent px-0 py-1',
    'text-[16px] leading-6 font-black text-ink outline-none transition-colors',
    'placeholder:text-muted focus-visible:border-accent focus-visible:ring-0',
    hasError ? 'border-danger' : 'border-border',
  ].join(' ')
}

function HotelTitleTicketEditor({
  value,
  error,
  onChange,
}: {
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const titleId = useId()
  const errorId = useId()

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={[
          'relative overflow-hidden rounded-card border bg-[#FFFDF6] shadow-[0_8px_22px_rgba(32,42,45,0.07)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
          error ? 'border-danger' : 'border-[#F2C45D]',
        ].join(' ')}
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-[#FFB21F]" />
        <span aria-hidden="true" className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-[#F2C45D] bg-app" />
        <span aria-hidden="true" className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-[#F2C45D] bg-app" />

        <div className="grid grid-cols-[42px_minmax(0,1fr)] items-center gap-3 px-4 py-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-input bg-[#FFF1D6] text-[#C77700]">
            <KeyRound size={20} strokeWidth={2.3} />
          </div>

          <div className="min-w-0">
            <label htmlFor={titleId} className="block text-[9px] font-black uppercase tracking-[0.13em] text-[#E18700]">
              Hotel accommodation
              <span className="ml-[3px] text-danger">*</span>
            </label>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <input
                id={titleId}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder="東京虹夕諾雅 / Hoshinoya"
                maxLength={100}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] font-black leading-6 text-ink outline-none placeholder:text-[#C8BCA6] focus-visible:ring-0 [&::placeholder]:font-semibold"
              />
              <PencilLine size={13} strokeWidth={2.3} className="shrink-0 text-[#D18A18]" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
      {error && <span id={errorId} className="text-[11px] text-danger">{error}</span>}
    </div>
  )
}

type PdfAutofillState = {
  status: 'idle' | 'loading' | 'applied' | 'empty' | 'error'
  message?: string
}
type PdfAutofillSourceKey = number
type CreateablePdfCandidate = {
  candidate: BookingPdfExtractCandidate
  index:     number
  input:     CreateBookingInput
}

export interface BookingFormResult {
  input:      CreateBookingInput
  coverImage: AttachmentChange
  document:   AttachmentChange
}

export interface BookingFormBatchResult {
  inputs:   CreateBookingInput[]
  document: File
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
  onCreateMany?: (data: BookingFormBatchResult) => void
  /** Only present in edit mode for users with delete permission.
   *  Renders a two-step inline confirm above the save button. */
  onDelete?:  () => void
}

export default function BookingFormModal({
  editTarget, tripStartDate, tripEndDate,
  isOpen, isSaving, saveError, initialDraft, onClose, onSave, onCreateMany, onDelete,
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
  const [pdfAutofill, setPdfAutofill] = useState<PdfAutofillState>({ status: 'idle' })
  const [pdfAutofillCreateableCandidates, setPdfAutofillCreateableCandidates] = useState<CreateablePdfCandidate[]>([])
  const [selectedPdfCandidateIndexes, setSelectedPdfCandidateIndexes] = useState<number[]>([])
  const [pdfAutofillSourceKey, setPdfAutofillSourceKey] = useState<PdfAutofillSourceKey | null>(null)
  const [analyzedPdfSourceKey, setAnalyzedPdfSourceKey] = useState<PdfAutofillSourceKey | null>(null)
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

  const coverFileRef = useRef<HTMLInputElement>(null)
  const docFileRef   = useRef<HTMLInputElement>(null)
  const pdfAutofillFileRef = useRef<HTMLInputElement>(null)
  const checkOutRef = useRef<DatePickerHandle>(null)
  const stateRef = useRef(state)
  const pdfAutofillSeqRef = useRef(0)
  const pdfAutofillSourceSeqRef = useRef(0)
  const pdfAutofillControllerRef = useRef<AbortController | null>(null)
  const isTransport = TRANSPORT_TYPES.has(state.type)
  // Hotel is the only type that conventionally has both check-in and check-out.
  const showRange = state.type === 'hotel'
  const pdfAutofillSourceFile = docAtt.newFile && isPdfFile(docAtt.newFile) ? docAtt.newFile : null
  const hasAnalyzedCurrentPdf =
    pdfAutofillSourceFile !== null
    && pdfAutofillSourceKey !== null
    && analyzedPdfSourceKey === pdfAutofillSourceKey

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => () => {
    pdfAutofillControllerRef.current?.abort()
  }, [])

  function pickCoverImage() {
    coverFileRef.current?.click()
  }

  function pickDocument() {
    docFileRef.current?.click()
  }

  function pickPdfForAutofill() {
    pdfAutofillFileRef.current?.click()
  }

  function handlePdfAutofillCardClick() {
    if (!pdfAutofillSourceFile || pdfAutofillSourceKey === null || hasAnalyzedCurrentPdf) {
      pickPdfForAutofill()
      return
    }
    void runPdfAutofill(pdfAutofillSourceFile, pdfAutofillSourceKey)
  }

  function handlePdfAutofillRerunClick() {
    if (!pdfAutofillSourceFile || pdfAutofillSourceKey === null) return
    void runPdfAutofill(pdfAutofillSourceFile, pdfAutofillSourceKey)
  }

  function commitPdfAutofillSource(): PdfAutofillSourceKey {
    const nextKey = pdfAutofillSourceSeqRef.current + 1
    pdfAutofillSourceSeqRef.current = nextKey
    setPdfAutofillSourceKey(nextKey)
    return nextKey
  }

  function clearPdfAutofillCandidates() {
    setPdfAutofillCreateableCandidates([])
    setSelectedPdfCandidateIndexes([])
  }

  function rejectPdfAutofillPick(message: string) {
    resetPdfAutofill()
    setPdfAutofill({ status: 'error', message })
  }

  function onCoverImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (f) coverAtt.pickFile(f)
  }

  function onDocumentPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (!f) return
    abortPdfAutofill()
    if (docAtt.pickFile(f)) {
      if (isPdfFile(f)) commitPdfAutofillSource()
      else setPdfAutofillSourceKey(null)
    }
    clearPdfAutofillCandidates()
    setPdfAutofill({ status: 'idle' })
  }

  function onPdfAutofillPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (!f) return
    if (!isPdfFile(f)) {
      rejectPdfAutofillPick('請選擇 PDF 檔案')
      return
    }
    if (!docAtt.pickFile(f)) {
      rejectPdfAutofillPick(ATTACHMENT_SIZE_ERROR)
      return
    }
    void runPdfAutofill(f, commitPdfAutofillSource())
  }

  function abortPdfAutofill() {
    pdfAutofillSeqRef.current += 1
    pdfAutofillControllerRef.current?.abort()
    pdfAutofillControllerRef.current = null
  }

  function resetPdfAutofill() {
    abortPdfAutofill()
    setPdfAutofillSourceKey(null)
    setAnalyzedPdfSourceKey(null)
    clearPdfAutofillCandidates()
    setPdfAutofill({ status: 'idle' })
  }

  function pdfAutofillErrorMessage(e: unknown): string {
    if (e instanceof BookingPdfExtractError) {
      switch (e.kind) {
        case 'auth':
          return '請登入後再試一次'
        case 'rate-limit':
          return '請稍後再試一次'
        case 'network':
        case 'unavailable':
          return '無法連線至讀取服務'
        case 'parse':
          return e.message || '無法讀取 PDF，請手動輸入'
        case 'unknown':
          return '讀取 PDF 失敗'
      }
    }
    return '讀取 PDF 失敗'
  }

  function applyPdfAutofillPatch(patch: BookingFormDraft) {
    type DraftEntry = {
      [K in keyof BookingFormDraft]-?: [K, BookingFormDraft[K]]
    }[keyof BookingFormDraft]

    for (const [key, value] of Object.entries(patch) as DraftEntry[]) {
      if (value !== undefined) setField(key, value)
    }
  }

  function candidateRoleLabel(candidate: BookingPdfExtractCandidate, index: number): string {
    return candidate.segmentRole === 'outbound' ? '往路'
      : candidate.segmentRole === 'return' ? '復路'
      : candidate.segmentRole === 'connection' ? '乗継'
      : `候選 ${index + 1}`
  }

  function applySelectedPdfCandidate(candidate: BookingPdfExtractCandidate) {
    const { patch, appliedCount } = bookingPdfExtractToDraftPatch(stateRef.current, candidate, {
      isEdit: !!editTarget,
    })
    applyPdfAutofillPatch(patch)
    setPdfAutofill(appliedCount > 0
      ? { status: 'applied', message: '已套用 PDF 的候選資料' }
      : { status: 'empty', message: '找不到可填入的項目' })
  }

  function togglePdfCandidate(index: number) {
    setSelectedPdfCandidateIndexes(prev =>
      prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index])
  }

  function createSelectedPdfCandidates() {
    if (!pdfAutofillSourceFile || !onCreateMany) return
    const selected = pdfAutofillCreateableCandidates
      .filter(({ index }) => selectedPdfCandidateIndexes.includes(index))
      .map(({ input }) => input)
    if (selected.length === 0) {
      setPdfAutofill({ status: 'empty', message: '請選擇要新增的候選資料' })
      return
    }
    onCreateMany({ inputs: selected, document: pdfAutofillSourceFile })
  }

  async function runPdfAutofill(file: File, sourceKey: PdfAutofillSourceKey) {
    const seq = pdfAutofillSeqRef.current + 1
    pdfAutofillSeqRef.current = seq
    pdfAutofillControllerRef.current?.abort()
    const controller = new AbortController()
    pdfAutofillControllerRef.current = controller
    setPdfAutofill({ status: 'loading', message: '正在從 PDF 讀取訂單資料…' })
    clearPdfAutofillCandidates()

    try {
      const result = await extractBookingPdfAutofill(file, controller.signal)
      if (controller.signal.aborted || pdfAutofillSeqRef.current !== seq) return
      setAnalyzedPdfSourceKey(sourceKey)
      if (result.bookings.length > 1) {
        const createableCandidates = result.bookings.flatMap((candidate, index) => {
          const input = bookingPdfCandidateToCreateInput(candidate)
          return input ? [{ candidate, index, input }] : []
        })
        const createableIndexes = createableCandidates.map(({ index }) => index)
        setPdfAutofillCreateableCandidates(createableCandidates)
        setSelectedPdfCandidateIndexes(createableIndexes)
        setPdfAutofill({
          status:  createableIndexes.length > 0 ? 'applied' : 'empty',
          message: createableIndexes.length > 0
            ? `找到 ${createableIndexes.length} 筆訂單候選資料`
            : '找不到可新增的候選資料',
        })
        return
      }
      applySelectedPdfCandidate(result.bookings[0]!)
    } catch (e) {
      if (controller.signal.aborted || pdfAutofillSeqRef.current !== seq) return
      setPdfAutofill({ status: 'error', message: pdfAutofillErrorMessage(e) })
    } finally {
      if (pdfAutofillSeqRef.current === seq) {
        pdfAutofillControllerRef.current = null
      }
    }
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
      if (!state.origin.trim())      e.origin      = '請輸入出發地'
      if (!state.destination.trim()) e.destination = '請輸入目的地'
    } else if (!state.title.trim()) {
      e.title = state.type === 'hotel' ? '請輸入飯店名稱' : '請輸入標題'
    }
    if (showRange && state.checkIn && state.checkOut && state.checkOut < state.checkIn) {
      e.checkOut = '退房日期必須不早於入住日期'
    }
    // link は href に出すので http(s) のみ。空欄は許可(任意項目)。
    const linkTrimmed = state.link.trim()
    if (linkTrimmed && !isHttpUrl(linkTrimmed)) {
      e.link = '請輸入以 http:// 或 https:// 開頭的 URL'
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

  const showPdfAutofillStatus = !editTarget && pdfAutofill.status !== 'idle' && pdfAutofill.status !== 'loading'
  const pdfAutofillButtonLabel = pdfAutofill.status === 'loading'
    ? '正在讀取 PDF…'
    : pdfAutofillSourceFile
      ? hasAnalyzedCurrentPdf ? '從 PDF 自動填入' : '讀取 PDF'
      : '從 PDF 自動填入'
  const hasSelectedPdfCandidate = pdfAutofillCreateableCandidates
    .some(({ index }) => selectedPdfCandidateIndexes.includes(index))
  const CurrentTypeIcon = BOOKING_TYPE_META[state.type].icon

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '編輯訂單' : '新增訂單'}
      saveLabel={editTarget ? '儲存變更' : '手動新增訂單'}
      saveError={saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      {!editTarget && (
        <div className="space-y-3">
          <input
            ref={pdfAutofillFileRef}
            type="file"
            accept={PDF_ACCEPT_TYPES}
            onChange={onPdfAutofillPicked}
            className="hidden"
          />
          <div className="overflow-hidden rounded-card border border-accent/20 bg-surface shadow-[0_8px_22px_rgba(32,42,45,0.07)]">
            <div className="flex items-center gap-2 bg-accent-pale/70 px-3 py-3">
              <button
                type="button"
                onClick={handlePdfAutofillCardClick}
                disabled={pdfAutofill.status === 'loading'}
                className="group flex min-w-0 flex-1 items-center gap-3 text-left text-accent transition-colors hover:text-accent-pressed disabled:cursor-wait disabled:opacity-70"
              >
                <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-input bg-accent text-white shadow-[0_4px_10px_rgba(74,102,112,0.22)]">
                  {pdfAutofill.status === 'loading' ? (
                    <Loader2 size={18} strokeWidth={2} className="animate-spin" />
                  ) : (
                    <>
                      <FileText size={18} strokeWidth={2} />
                      <span aria-hidden="true" className="absolute -bottom-1 rounded-[5px] bg-surface px-1 py-px text-[7px] font-black leading-none text-accent shadow-[0_1px_4px_rgba(0,0,0,0.12)]">
                        PDF
                      </span>
                    </>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-black uppercase leading-[1.15] tracking-[0.14em] text-pick">
                    Automatic import
                  </span>
                  <span className="mt-0.5 block text-[15px] font-black leading-[1.25] text-accent">
                    {pdfAutofillButtonLabel}
                  </span>
                </span>
                <ChevronRight size={18} strokeWidth={2.2} className="shrink-0 opacity-80 transition-transform group-hover:translate-x-0.5" />
              </button>
              {pdfAutofillSourceFile && hasAnalyzedCurrentPdf && (
                <button
                  type="button"
                  onClick={handlePdfAutofillRerunClick}
                  disabled={pdfAutofill.status === 'loading'}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-chip px-2.5 text-[12px] font-bold text-pick transition-colors hover:bg-surface/80 hover:text-accent disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw size={13} strokeWidth={2.3} />
                  <span>重新讀取</span>
                </button>
              )}
            </div>
            {(showPdfAutofillStatus || pdfAutofillSourceFile) && (
              <div className="border-t border-accent/10 px-3.5 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  {showPdfAutofillStatus ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className={[
                        'flex min-w-0 flex-1 items-center gap-2 text-[12px] font-bold leading-[1.35]',
                        pdfAutofill.status === 'error'
                          ? 'text-danger'
                          : pdfAutofill.status === 'applied'
                            ? 'text-teal'
                        : 'text-muted',
                      ].join(' ')}
                    >
                      <span aria-hidden="true" className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                        {pdfAutofill.status === 'applied' ? (
                          <>
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-35" />
                            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-teal" />
                          </>
                        ) : (
                          <span className={[
                            'inline-flex h-2.5 w-2.5 rounded-full',
                            pdfAutofill.status === 'error' ? 'bg-danger' : 'bg-dot',
                          ].join(' ')}
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">{pdfAutofill.message}</span>
                    </div>
                  ) : (
                    <span className="min-w-0 truncate text-[12px] font-medium text-muted">
                      {pdfAutofillSourceFile?.name}
                    </span>
                  )}
                  {pdfAutofillSourceFile && !hasAnalyzedCurrentPdf && (
                    <button
                      type="button"
                      onClick={pickPdfForAutofill}
                      className="shrink-0 text-[12px] font-bold text-accent"
                    >
                      選擇其他 PDF
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          {pdfAutofillCreateableCandidates.length > 0 && (
            <div className="space-y-2">
              <div className="space-y-2.5">
                {pdfAutofillCreateableCandidates.map(({ candidate, index, input }) => {
                  const typeMeta = BOOKING_TYPE_META[input.type]
                  const TypeIcon = typeMeta.icon
                  const roleLabel = candidateRoleLabel(candidate, index)
                  const originText = input.origin?.trim() || input.title?.trim() || typeMeta.label
                  const destinationText = input.destination?.trim() || input.address?.trim() || input.provider?.trim() || typeMeta.label
                  const detailText = [input.provider?.trim(), input.title?.trim()].filter(Boolean).join(' ')
                  const dateText = input.checkIn?.trim()

                  return (
                    <label
                      key={`${candidate.segmentRole}-${index}`}
                      className="grid w-full grid-cols-[auto_1fr] items-center gap-3 rounded-card border border-border bg-surface px-3 py-3 text-left shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-colors hover:border-accent/45 hover:bg-accent-pale/35"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPdfCandidateIndexes.includes(index)}
                        onChange={() => togglePdfCandidate(index)}
                        className="h-4 w-4 shrink-0 accent-accent"
                      />
                      <span className="min-w-0 space-y-2">
                        <span className="flex min-w-0 items-start justify-between gap-2">
                          <span className="rounded-full bg-pick-pale px-2 py-0.5 text-[10px] font-black leading-none text-pick">
                            {roleLabel}
                          </span>
                          {detailText && (
                            <span className="min-w-0 truncate text-right text-[10px] font-bold leading-[1.2] text-pick">
                              {detailText}
                            </span>
                          )}
                        </span>
                        <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                          <span className="truncate text-[13px] font-black leading-[1.25] text-ink">
                            {originText}
                          </span>
                          <TypeIcon size={14} strokeWidth={2.2} className="text-dot" />
                          <span className="truncate text-right text-[13px] font-black leading-[1.25] text-ink">
                            {destinationText}
                          </span>
                        </span>
                        {dateText && (
                          <span className="flex items-center gap-1 text-[11px] font-semibold leading-none text-muted">
                            <CalendarDays size={12} strokeWidth={2} />
                            {dateText}
                          </span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={createSelectedPdfCandidates}
                disabled={!hasSelectedPdfCandidate || pdfAutofill.status === 'loading'}
                className="inline-flex h-10 w-full items-center justify-center rounded-chip bg-accent px-3 text-[13px] font-black text-white transition-colors hover:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-55"
              >
                新增選取的訂單
              </button>
            </div>
          )}
        </div>
      )}

      {!editTarget && (
        <div className="flex items-center gap-3 text-[11px] font-bold leading-none text-muted">
          <span className="h-px flex-1 bg-border" />
          <span>或（手動輸入）</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      <FormField label="訂單類型">
        <div className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max gap-2">
            {BOOKING_TYPE_ORDER.map(value => {
              const { icon: TypeIcon, label } = BOOKING_TYPE_META[value]
              const active = state.type === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setField('type', value)}
                  className={[
                    'flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-card border-[1.5px] px-3 py-1.5 text-[12px] cursor-pointer transition-all',
                    active
                      ? 'border-accent bg-accent text-white font-semibold'
                      : 'border-border bg-surface text-muted font-normal hover:border-muted',
                  ].join(' ')}
                >
                  <TypeIcon size={13} strokeWidth={2} />{label}
                </button>
              )
            })}
          </div>
        </div>
      </FormField>

      {isTransport && (
        <FormField
          label={state.type === 'flight' ? '航班航線' : '路線'}
          error={errors.origin ?? errors.destination}
          required
        >
          <div className="relative overflow-hidden rounded-input border border-border bg-surface shadow-[0_4px_14px_rgba(32,42,45,0.05)]">
            <span aria-hidden className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-border bg-app" />
            <span aria-hidden className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-border bg-app" />
            <div className="grid grid-cols-[minmax(0,1fr)_42px_minmax(0,1fr)] items-center">
              <label className="min-w-0 px-4 py-3">
                <span className="block text-[9px] font-black leading-none text-muted">DEPARTURE</span>
                <input
                  value={state.origin}
                  onChange={e => setField('origin', e.target.value)}
                  placeholder={state.type === 'flight' ? '桃園 / TPE' : '東京駅'}
                  aria-label="出発地"
                  className={bookingRouteInputClass(!!errors.origin)}
                />
              </label>
              <div className="flex flex-col items-center justify-center gap-1 text-pick">
                <CurrentTypeIcon size={16} strokeWidth={2.4} />
                <span aria-hidden className="h-px w-8 border-t border-dashed border-border" />
              </div>
              <label className="min-w-0 px-4 py-3 text-right">
                <span className="block text-[9px] font-black leading-none text-muted">ARRIVAL</span>
                <input
                  value={state.destination}
                  onChange={e => setField('destination', e.target.value)}
                  placeholder={state.type === 'flight' ? '成田 / NRT' : '京都駅'}
                  aria-label="到着地"
                  className={`${bookingRouteInputClass(!!errors.destination)} text-right`}
                />
              </label>
            </div>
          </div>
          {state.type === 'flight' && (
            <p className="mt-1.5 text-[11px] font-semibold leading-[1.45] text-pick">
              有機場代碼時，可輸入「Tokyo / NRT」
            </p>
          )}
        </FormField>
      )}

      {showRange ? (
        <HotelTitleTicketEditor
          value={state.title}
          error={errors.title}
          onChange={v => setField('title', v)}
        />
      ) : (
        <FormField
          label={titleLabel(state.type)}
          error={errors.title}
          required={!isTransport}
        >
          <input
            value={state.title}
            onChange={e => setField('title', e.target.value)}
            placeholder={titlePlaceholder(state.type)}
            className={inputClass(!!errors.title)}
          />
        </FormField>
      )}

      <div className="flex gap-2.5">
        <FormField label="確認編號" className="flex-1">
          <input
            value={state.confirmationCode}
            onChange={e => setField('confirmationCode', e.target.value)}
            placeholder="ABC123"
            className={`${inputClass(false)} font-mono tracking-tight`}
          />
        </FormField>
        <FormField label="提供者" className="flex-1">
          <input
            value={state.provider}
            onChange={e => setField('provider', e.target.value)}
            placeholder={providerPlaceholder(state.type)}
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
              placeholder="日期"
              minDate={tripStartDate}
              maxDate={tripEndDate}
            />
          </FormField>
          <FormField label="Check-out" error={errors.checkOut} className="flex-1">
            <DatePicker
              ref={checkOutRef}
              value={state.checkOut}
              onChange={v => setField('checkOut', v)}
              placeholder="日期"
              error={!!errors.checkOut}
              minDate={tripStartDate}
              maxDate={tripEndDate}
            />
          </FormField>
        </div>
      ) : (
        <FormField label="日期">
          <DatePicker
            value={state.checkIn}
            onChange={v => setField('checkIn', v)}
            placeholder="日期"
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
        <FormField label="地址 / Google Maps URL（選填）">
          <input
            value={state.address}
            onChange={e => setField('address', e.target.value)}
            placeholder={state.type === 'hotel' ? '例如：東京都台東區淺草 1-1-1 / Google Maps URL' : '例如：上野公園 / Google Maps URL'}
            maxLength={500}
            className={inputClass(false)}
          />
        </FormField>
      )}

      {/* 予約 URL — OTA / 公式サイトの予約ページ。全 type 共通
          (機票も飯店も予約 URL を持ち得る)。href に出すため http(s)
          のみ(form validate + Zod + firestore.rules で三重 enforce)。 */}
      <FormField label="訂單 URL（選填）" error={errors.link}>
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
        <FormField label="封面圖片" error={coverAtt.error ?? undefined}>
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
                aria-label="顯示封面圖片"
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
                    <span className="text-[12px] font-bold">封面圖片</span>
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
                    更換
                  </button>
                  <button
                    type="button"
                    onClick={coverAtt.clear}
                    className="h-8 rounded-chip border border-danger-soft bg-danger-pale px-3 text-[11.5px] font-bold text-danger"
                  >
                    刪除
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
              <span>新增飯店卡片圖片</span>
            </button>
          )}
        </FormField>
      )}

      <FormField label="訂單確認文件（PDF / 圖片）" error={docAtt.error ?? undefined}>
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
            onClear={() => {
              resetPdfAutofill()
              docAtt.clear()
            }}
            onPreview={() => (docAtt.hasNewFile || docAtt.fullPath) && setPreviewTarget('document')}
            canPreview={docAtt.hasNewFile || !!docAtt.fullPath}
            replaceAriaLabel="更換檔案"
            previewAriaLabel="顯示附件"
            clearAriaLabel="刪除附件"
          />
        ) : (
          <button
            type="button"
            onClick={pickDocument}
            className="w-full h-[58px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Paperclip size={16} strokeWidth={1.8} />
            <span>上傳確認文件</span>
          </button>
        )}
      </FormField>

      <FormField label="備註">
        <textarea
          value={state.note}
          onChange={e => setField('note', e.target.value)}
          placeholder="備註（座位、機場櫃檯資訊等）"
          rows={2}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="訂單" onDelete={onDelete} />}

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
