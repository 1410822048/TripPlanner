// src/features/bookings/components/BookingsPage.tsx
import { useState } from 'react'
import { Plus, Ticket } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { toast } from '@/shared/toast'
import BookingsPageSkeleton from './BookingsPageSkeleton'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  useBookings, useCreateBooking, useUpdateBooking, useDeleteBooking,
  bookingUpdateMutationKey,
} from '../hooks/useBookings'
import { usePendingMutationIds } from '@/hooks/usePendingMutationIds'
import { MOCK_BOOKINGS } from '../mocks'
import type { Booking } from '@/types'
import BookingFormModal, { type BookingFormResult } from './BookingFormModal'
import SwipeableBookingItem from './SwipeableBookingItem'
import AttachmentPreviewModal from './AttachmentPreviewModal'
import BookingsListSkeleton from './BookingsListSkeleton'
import { bookingDisplayName, BOOKING_TYPE_META } from '../utils'
import { toLocalDateString } from '@/utils/dates'

/**
 * Format the user-facing date / range for a booking. Flights use a single
 * datetime; hotels typically have check-in + check-out; everything else
 * collapses to whichever is set.
 */
function formatWhen(b: Booking): string {
  const fmtDate = (s: string) => {
    const d = new Date(s)
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
  const out = new Date(b.checkOut)
  if (Number.isNaN(out.getTime())) return inDate
  const inObj = new Date(b.checkIn)
  if (inObj.getFullYear() === out.getFullYear() && inObj.getMonth() === out.getMonth()) {
    return `${inDate} 至 ${out.getDate()}日`
  }
  return `${inDate} 至 ${fmtDate(b.checkOut)}`
}

export default function BookingsPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, canWrite, modal, signIn } =
    useFeatureListPage<Booking>()
  const swipe = useSwipeOpen()
  const [previewBooking, setPreviewBooking] = useState<Booking | null>(null)
  // path-only: resolve the full-size blob for the preview modal via getBlob
  // (Storage Rules). Starts fetching the instant a booking is set; the modal
  // shows a spinner until it lands, and the URL is revoked when closed.
  const previewUrl = useAttachmentUrl(previewBooking?.attachment?.filePath, { kind: 'full' })

  // Hooks must run unconditionally — pull tripId via optional chaining so
  // useBookings is always called (just disabled in non-cloud states).
  const { data: cloudBookings, isLoading } = useBookings(cloudTripId)
  const demoBookings = ctx.status === 'demo' && ctx.trip.id === 'demo' ? MOCK_BOOKINGS : []
  const bookings = ctx.status === 'demo' ? demoBookings : (cloudBookings ?? [])

  // Optimistic close — modal closes immediately on save; failures route
  // to the global toast via MutationCache.onError + the hook rollback.
  const createMut = useCreateBooking(mutationTripId)
  const updateMut = useUpdateBooking(mutationTripId)
  const deleteMut = useDeleteBooking(mutationTripId)
  // Set of booking ids whose UPDATE is in-flight — drives the 保存中… pill
  // on edited cards. CREATE pending is handled inside SwipeableBookingItem
  // via the temp- id prefix; UPDATE preserves the real id so we need this.
  const pendingUpdateIds = usePendingMutationIds<{ bookingId: string }>(
    bookingUpdateMutationKey,
    'bookingId',
  )

  if (ctx.status === 'loading') return <BookingsPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Ticket} reason="予約を管理" />

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
  const typeOrder: Booking['type'][] = ['flight', 'hotel', 'train', 'bus', 'other']

  function handleSave({ input, attachment }: BookingFormResult) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }

    // Optimistic close (mirrors ExpensePage). Modal closes immediately;
    // the hook's onMutate inserts a temp row into the list cache, the
    // real write runs in the background, and onError rolls back + the
    // global MutationCache.onError toasts on failure.
    const editing = modal.editTarget
    modal.close()
    if (editing) {
      updateMut.mutate({
        bookingId:  editing.id,
        updates:    input,
        uid,
        attachment,
        existing:   editing.attachment,
      })
    } else {
      createMut.mutate({
        input,
        file:      attachment instanceof File ? attachment : null,
        createdBy: uid,
      })
    }
  }

  function handleSwipeDelete(b: Booking) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    deleteMut.mutate({ bookingId: b.id, attachment: b.attachment })
  }

  /** Inline delete from the edit modal — closes the form immediately so
   *  the user lands back on the list. Demo mode short-circuits to the
   *  sign-in prompt (mutation can't run without a real trip). */
  function handleFormDelete() {
    const target = modal.editTarget
    if (!target) return
    if (isDemo) { modal.close(); signIn.open(); return }
    modal.close()
    deleteMut.mutate({ bookingId: target.id, attachment: target.attachment })
  }

  return (
    // Click anywhere on the page wrapper closes any open swipe — the row's
    // inner buttons stopPropagation, so this only fires for taps in the
    // gaps between rows / headers / non-row areas.
    <div className="bg-app min-h-full pb-8" onClick={swipe.closeAll}>

      {isDemo && <DemoBanner reason="予約を保存" onSignIn={signIn.open} />}

      {/* ── HEADER ─────────────────────────────────────────── */}
      <div className="px-5 pt-4 pb-2">
        <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
          予約管理
        </p>
        <h1 className="m-0 text-[22px] font-black text-ink -tracking-[0.5px]">
          {title}
        </h1>
      </div>

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
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <Ticket size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              まだ予約が登録されていません
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              {canWrite
                ? 'フライト・ホテル・電車などの確認書をここにまとめましょう'
                : '閲覧者として参加中です。予約の追加はオーナー / 編集者のみ行えます。'}
            </p>
            {canWrite && (
              <button
                onClick={modal.openAdd}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
                style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
              >
                <Plus size={14} strokeWidth={2.5} />
                予約を追加
              </button>
            )}
          </div>
        ) : (
          <>
            {typeOrder
              .filter(t => grouped[t].length > 0)
              .map(t => (
                <div key={t} className="mb-4">
                  <div className="flex items-center justify-between px-1 mb-2">
                    <span className="text-[12px] font-bold text-ink tracking-[0.02em]">
                      {BOOKING_TYPE_META[t].emoji} {BOOKING_TYPE_META[t].label}
                    </span>
                    <span className="text-[11px] text-muted font-medium tabular-nums">
                      {grouped[t].length} 件
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
                          isUpdating={pendingUpdateIds.has(b.id)}
                          {...swipeProps}
                          onSelect={canWrite ? () => { swipe.closeAll(); modal.openEdit(b) } : undefined}
                          onDelete={canWrite ? () => handleSwipeDelete(b) : undefined}
                          onPreview={() => setPreviewBooking(b)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}

            {canWrite && (
              <button
                onClick={modal.openAdd}
                className="w-full h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
              >
                <Plus size={14} strokeWidth={2} />
                予約を追加
              </button>
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
          key={modal.key}
          isOpen
          editTarget={modal.editTarget}
          tripStartDate={tripStartDate}
          tripEndDate={tripEndDate}
          isSaving={false}
          saveError={modal.saveError}
          onClose={modal.close}
          onSave={handleSave}
          onDelete={modal.editTarget && !isDemo && canWrite ? handleFormDelete : undefined}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="予約を保存するには、"
      />

      {previewBooking?.attachment && (
        <AttachmentPreviewModal
          url={previewUrl}
          fileType={previewBooking.attachment.fileType}
          fileName={bookingDisplayName(previewBooking)}
          onClose={() => setPreviewBooking(null)}
        />
      )}
    </div>
  )
}
