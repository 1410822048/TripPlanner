// src/features/bookings/components/BookingsPage.tsx
import { useEffect, useState } from 'react'
import { Plus, Ticket } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { toast } from '@/shared/toast'
import BookingsPageSkeleton from './BookingsPageSkeleton'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import PageHeader from '@/components/ui/PageHeader'
import ListEmptyCard from '@/components/ui/ListEmptyCard'
import GhostAddButton from '@/components/ui/GhostAddButton'
import {
  useBookings, useCreateBooking, useUpdateBooking, useDeleteBooking,
  bookingKeys, bookingOverlay as bookingListOverlay,
} from '../hooks/useBookings'
import { useOverlayPendingRowIds } from '@/hooks/listOverlay'
import { MOCK_BOOKINGS } from '../mocks'
import type { Booking } from '@/types'
import BookingFormModal, { type BookingFormBatchResult, type BookingFormResult } from './BookingFormModal'
import SwipeableBookingItem from './SwipeableBookingItem'
import AttachmentPreviewModal from '@/features/attachments/components/AttachmentPreviewModal'
import BookingReadonlyModal from './BookingReadonlyModal'
import BookingsListSkeleton from './BookingsListSkeleton'
import { bookingDisplayName, BOOKING_TYPE_META, BOOKING_TYPE_ORDER } from '../utils'
import { hasShareParams, sharedBookingDraftFromSearch, type SharedBookingDraft } from '../linkDraft'
import { parseStoredDate, toLocalDateString } from '@/utils/dates'
import { getClientWriteBlockReason, UPDATE_REQUIRED_EMPTY_STATE } from '@/services/clientCompatibility'
import { FORM_SCOPE_CHANGED_MESSAGE } from '@/hooks/useFormModal'

type BookingOverlay =
  | { kind: 'detail'; bookingId: string }
  | { kind: 'attachment'; bookingId: string }
  | null

/**
 * Format the user-facing date / range for a booking. Flights use a single
 * datetime; hotels typically have check-in + check-out; everything else
 * collapses to whichever is set.
 */
function formatWhen(b: Booking): string {
  const fmtDate = (s: string) => {
    const d = parseStoredDate(s)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  }
  const fmtTime = (s: string) => {
    if (!/T\d{2}:\d{2}/.test(s)) return ''
    const d = new Date(s)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (!b.checkIn) return ''
  const inDate = fmtDate(b.checkIn)
  const inTime = fmtTime(b.checkIn)
  if (!b.checkOut) return inTime ? `${inDate} ${inTime}` : inDate
  const out = parseStoredDate(b.checkOut)
  if (Number.isNaN(out.getTime())) return inDate
  const inObj = parseStoredDate(b.checkIn)
  if (inObj.getFullYear() === out.getFullYear() && inObj.getMonth() === out.getMonth()) {
    return `${inDate} 至 ${out.getDate()}日`
  }
  return `${inDate} 至 ${fmtDate(b.checkOut)}`
}

export default function BookingsPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, canWrite, roleCanWrite, modal, signIn } =
    useFeatureListPage<Booking>()
  const swipe = useSwipeOpen(canWrite)
  const [bookingOverlay, setBookingOverlay] = useState<BookingOverlay>(null)
  const [sharedDraft, setSharedDraft] = useState<SharedBookingDraft | null>(null)

  // Hooks must run unconditionally — pull tripId via optional chaining so
  // useBookings is always called (just disabled in non-cloud states).
  const { data: cloudBookings, isLoading } = useBookings(cloudTripId)
  const demoBookings = ctx.status === 'demo' && ctx.trip.id === 'demo' ? MOCK_BOOKINGS : []
  const bookings = ctx.status === 'demo' ? demoBookings : (cloudBookings ?? [])
  const detailBooking =
    bookingOverlay?.kind === 'detail'
      ? bookings.find(booking => booking.id === bookingOverlay.bookingId) ?? null
      : null
  const attachmentBooking =
    bookingOverlay?.kind === 'attachment'
      ? bookings.find(booking => booking.id === bookingOverlay.bookingId) ?? null
      : null
  // Resolve the full-size private R2 blob for the preview modal via the Worker.
  // Starts fetching the instant a booking is set; the modal
  // shows a spinner until it lands, and the URL is revoked when closed.
  const attachmentPreview = attachmentBooking?.document
  const previewUrl = useAttachmentUrl(attachmentPreview?.filePath, { kind: 'full' })

  // Optimistic close — modal closes immediately on save; a failure drops
  // the overlay operation and MutationCache.onError raises the toast.
  const createMut = useCreateBooking(mutationTripId)
  const updateMut = useUpdateBooking(mutationTripId)
  const deleteMut = useDeleteBooking(mutationTripId)
  // Ids whose write is still in flight — drives the 保存中… pill and locks
  // the row. Covers create and update alike now that both are overlay ops
  // carrying the real id, so there is no id-shape check left to do.
  const pendingRowIds = useOverlayPendingRowIds(bookingListOverlay, bookingKeys.all(mutationTripId, uid))

  useEffect(() => {
    const search = window.location.search
    if (!search || !hasShareParams(search)) return
    // Cloud roles resolve asynchronously. Keep the query until canWrite
    // becomes true so a writable user does not lose the shared URL during
    // the role-loading frame. Viewers simply keep the URL and see no create UI.
    if (!canWrite) return

    const nextDraft = sharedBookingDraftFromSearch(search)
    window.history.replaceState(window.history.state, '', '/bookings')
    if (!nextDraft) return

    // 一次性消費 share-target URL → 開新增表單(等同 SchedulePage 消費
    // location.state.openCreateTrip 的模式)。URL 已 replaceState 清掉,不會重觸發。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSharedDraft(nextDraft)
    modal.openAdd()
  }, [canWrite, modal])

  if (ctx.status === 'loading') return <BookingsPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Ticket} reason="管理訂單" />

  const title = ctx.trip.title

  // Trip date range as 'YYYY-MM-DD' strings — cloud trips store them as
  // Firestore Timestamps, demo trips already have ISO strings. Pass to
  // DatePicker so check-in / check-out land on the trip's first month
  // and disable days outside the range.
  const tripStartDate = ctx.status === 'cloud'
    ? toLocalDateString(ctx.trip.startDate.toDate())
    : ctx.trip.startDate
  const tripEndDate = ctx.status === 'cloud'
    ? toLocalDateString(ctx.trip.endDate.toDate())
    : ctx.trip.endDate

  // Group by booking type for the section headers. Order is fixed so the
  // page layout doesn't shuffle when a type's count drops to zero.
  const grouped: Record<Booking['type'], Booking[]> = {
    flight: [], hotel: [], train: [], bus: [], other: [],
  }
  for (const b of bookings) grouped[b.type].push(b)
  const typeOrder = BOOKING_TYPE_ORDER

  function handleSave({ input, coverImage, document }: BookingFormResult) {
    if (isDemo) { setSharedDraft(null); modal.close(); signIn.open(); return }
    if (!uid) { setSharedDraft(null); toast.error('正在準備登入，請稍候'); return }
    // Before setSharedDraft(null): a refused save must keep the draft. The
    // mutations bind to the LIVE trip id — a form opened on another trip
    // (background reselect after kick / remote delete) must not write here.
    if (modal.scopeChanged) { modal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) {
      modal.setError(writeBlockReason)
      return
    }
    setSharedDraft(null)

    // Optimistic close (mirrors ExpensePage). Modal closes immediately;
    // the hook's onMutate adds an overlay operation so the row shows at
    // once, the real write runs in the background, and a failure drops
    // that operation while MutationCache.onError raises the toast.
    const editing = modal.editTarget
    modal.close()
    if (editing) {
      updateMut.mutate({
        bookingId:  editing.id,
        updates:    input,
        uid,
        files:      { coverImage, document },
        existing:   {
          coverImage: editing.coverImage,
          document:   editing.document,
        },
      })
    } else {
      createMut.mutate({
        bookingId: crypto.randomUUID(),
        input,
        files:     { coverImage, document },
        createdBy: uid,
      })
    }
  }

  function handleCreateManyFromPdf({ inputs, document }: BookingFormBatchResult) {
    if (isDemo) { setSharedDraft(null); modal.close(); signIn.open(); return }
    if (!uid) { setSharedDraft(null); toast.error('正在準備登入，請稍候'); return }
    if (modal.scopeChanged) { modal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) {
      modal.setError(writeBlockReason)
      return
    }
    setSharedDraft(null)
    modal.close()

    // Concurrent, not sequential: a round trip resolves in the time the
    // slowest segment takes rather than the sum. Safe because each segment
    // is its own overlay operation — a failure removes only that one,
    // where a whole-snapshot restore would have wiped the siblings that
    // had already landed.
    //
    // Each segment still uploads its own copy of the same PDF. Sharing one
    // object would need refcounting: upload intents and the delete cascade
    // are both keyed by bookingId, so deleting any one segment would take
    // the shared file away from the others.
    void Promise.allSettled(inputs.map(input => createMut.mutateAsync({
      bookingId: crypto.randomUUID(),
      input,
      files:     { coverImage: undefined, document },
      createdBy: uid,
    })))
    // Rejections are already handled by useTripListMutation's rollback and
    // the global MutationCache toast.
  }

  function handleOpenAdd() {
    setSharedDraft(null)
    modal.openAdd()
  }

  function handleCloseForm() {
    setSharedDraft(null)
    modal.close()
  }

  function handleSwipeDelete(b: Booking) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    // A dispatched gesture can still land after the epoch flip, and the
    // global toast deliberately skips UpdateRequiredError.
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { toast.error(writeBlockReason); return }
    deleteMut.mutate({
      bookingId: b.id,
      attachments: { coverImage: b.coverImage, document: b.document },
    })
  }

  function handleOpenBookingDetail(b: Booking) {
    swipe.closeAll()
    setBookingOverlay({ kind: 'detail', bookingId: b.id })
  }

  function handlePreviewBookingAttachment(b: Booking) {
    if (!b.document?.filePath) return
    swipe.closeAll()
    setBookingOverlay({ kind: 'attachment', bookingId: b.id })
  }

  function handleCloseAttachmentPreview() {
    if (bookingOverlay?.kind === 'attachment') {
      setBookingOverlay({ kind: 'detail', bookingId: bookingOverlay.bookingId })
      return
    }
    setBookingOverlay(null)
  }

  function handleEditBookingFromDetail(b: Booking) {
    setBookingOverlay(null)
    setSharedDraft(null)
    modal.openEdit(b)
  }

  /** Inline delete from the edit modal — closes the form immediately so
   *  the user lands back on the list. Demo mode short-circuits to the
   *  sign-in prompt (mutation can't run without a real trip). */
  function handleFormDelete() {
    const target = modal.editTarget
    if (!target) return
    if (isDemo) { modal.close(); signIn.open(); return }
    if (modal.scopeChanged) { modal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) {
      modal.setError(writeBlockReason)
      return
    }
    modal.close()
    deleteMut.mutate({
      bookingId: target.id,
      attachments: { coverImage: target.coverImage, document: target.document },
    })
  }

  return (
    // Click anywhere on the page wrapper closes any open swipe — the row's
    // inner buttons stopPropagation, so this only fires for taps in the
    // gaps between rows / headers / non-row areas.
    <div className="bg-app min-h-full pb-8" onClick={swipe.closeAll}>

      {isDemo && <DemoBanner reason="儲存訂單" onSignIn={signIn.open} />}

      {/* ── HEADER ─────────────────────────────────────────── */}
      <PageHeader eyebrow="訂單管理" title={title} />

      {/* ── BOOKINGS LIST ──────────────────────────────────── */}
      {/* Add-button placement mirrors SchedulePage:
            empty → solid teal CTA inside the empty card
            filled → dashed ghost button at the bottom of the list.
          Loading state uses a skeleton (not a centred spinner) so the
          page layout fills out at once instead of leaving the area below
          the header looking stuck. */}
      {isLoading && !isDemo ? (
        <BookingsListSkeleton />
      ) : (
      <div className="mt-4 px-4">
        {bookings.length === 0 ? (
          <ListEmptyCard
            icon={(
              <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
                <Ticket size={24} strokeWidth={1.6} />
              </div>
            )}
            title="尚未建立訂單"
            description={canWrite
              ? '將航班、飯店、火車等確認文件集中在這裡吧'
              : roleCanWrite
                ? UPDATE_REQUIRED_EMPTY_STATE
                : '你目前以檢視者身分加入。只有擁有者和編輯者可以新增訂單。'}
            actions={canWrite ? (
              <button
                type="button"
                onClick={handleOpenAdd}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
                style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
              >
                <Plus size={14} strokeWidth={2.5} />
                新增訂單
              </button>
            ) : undefined}
          />
        ) : (
          <>
            {typeOrder
              .filter(t => grouped[t].length > 0)
              .map(t => {
                const TypeIcon = BOOKING_TYPE_META[t].icon
                return (
                <div key={t} className="mb-4">
                  <div className="flex items-center justify-between px-1 mb-2">
                    <span className="flex items-center gap-1.5 text-[12px] font-bold text-ink tracking-[0.02em]">
                      <TypeIcon size={13} strokeWidth={2.2} className="text-muted" />
                      {BOOKING_TYPE_META[t].label}
                    </span>
                    <span className="text-[11px] text-muted font-medium tabular-nums">
                      {grouped[t].length} 筆
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {grouped[t].map(b => {
                      // Viewer mode: no swipe affordance + no delete
                      // callback. SwipeableBookingItem reads `isOpen`
                      // / `onOpen` / `onDelete` to decide whether to
                      // arm the gesture; passing nothing renders a
                      // plain non-swipeable card.
                      const swipeProps = canWrite ? swipe.bindRow(b.id) : {}
                      return (
                        <SwipeableBookingItem
                          key={b.id}
                          booking={b}
                          whenLabel={formatWhen(b)}
                          isUpdating={pendingRowIds.has(b.id)}
                          {...swipeProps}
                          onSelect={() => handleOpenBookingDetail(b)}
                          onDelete={canWrite ? () => handleSwipeDelete(b) : undefined}
                        />
                      )
                    })}
                  </div>
                </div>
                )
              })}

            {canWrite && (
              <GhostAddButton label="新增訂單" onClick={handleOpenAdd} />
            )}
          </>
        )}
      </div>
      )}

      {/* Conditional render so the modal unmounts on close. Combined with the
          per-target `key`, this gives fresh-state-on-open semantics: every
          open initialises useState directly from the editTarget prop. See
          ExpensePage for the shared rationale. */}
      {modal.isOpen && (
        <BookingFormModal
          key={sharedDraft?.key ?? modal.key}
          isOpen
          editTarget={modal.editTarget}
          initialDraft={modal.editTarget ? undefined : sharedDraft?.draft}
          tripStartDate={tripStartDate}
          tripEndDate={tripEndDate}
          isSaving={false}
          saveError={modal.saveError}
          onClose={handleCloseForm}
          onSave={handleSave}
          onCreateMany={handleCreateManyFromPdf}
          onDelete={modal.editTarget && !isDemo && canWrite ? handleFormDelete : undefined}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="若要儲存訂單，"
      />

      {detailBooking && (
        <BookingReadonlyModal
          isOpen
          booking={detailBooking}
          onClose={() => setBookingOverlay(null)}
          onEdit={canWrite ? () => handleEditBookingFromDetail(detailBooking) : undefined}
          onPreviewAttachment={handlePreviewBookingAttachment}
        />
      )}

      {attachmentBooking && attachmentPreview && (
        <AttachmentPreviewModal
          url={previewUrl}
          fileType={attachmentPreview.fileType}
          fileName={bookingDisplayName(attachmentBooking)}
          onClose={handleCloseAttachmentPreview}
        />
      )}
    </div>
  )
}
