// src/features/bookings/components/PastLodgingPage.tsx
// Dedicated history view for every hotel-type booking across the user's
// trips. Reached from マイページ → 過往の旅程 card. Layout mirrors the
// reference (image.png):
//   - Back arrow + 過往旅程 heading
//   - Flat list of bookings sorted by check-in date descending
//   - Year separator label shown whenever the year changes between rows
//     (the topmost year is implicit, matching the reference design)
//
// Route is top-level (outside AppLayout) so the page feels like a drill-
// down — no bottom nav distractions. Back arrow uses navigate(-1) to return
// to the previous route the user came from (/account in practice).
import { useQueries } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useUid } from '@/hooks/useAuth'
import { useMyTrips } from '@/features/schedule/hooks/useTrips'
import { getHotelBookingsByTrip } from '../services/bookingService'
import LoadingText from '@/components/ui/LoadingText'
import type { Booking } from '@/types'

const bookingKeys = {
  hotelByTrip: (tripId: string) => ['bookings', 'hotel', tripId] as const,
}

/** Milliseconds for ordering — use checkIn when available, fall back to createdAt. */
function bookingSortKey(b: Booking): number {
  if (b.checkIn) {
    const ms = new Date(b.checkIn).getTime()
    if (!Number.isNaN(ms)) return ms
  }
  return b.createdAt.toMillis()
}

function bookingYear(b: Booking): number {
  if (b.checkIn) {
    const d = new Date(b.checkIn)
    if (!Number.isNaN(d.getTime())) return d.getFullYear()
  }
  return b.createdAt.toDate().getFullYear()
}

/** Japanese-style date range label — collapses same-month / same-year spans. */
function formatRange(checkIn?: string, checkOut?: string): string {
  if (!checkIn) return ''
  const start = new Date(checkIn)
  if (Number.isNaN(start.getTime())) return ''
  const y1 = start.getFullYear(), m1 = start.getMonth() + 1, d1 = start.getDate()
  if (!checkOut) return `${y1}年${m1}月${d1}日`
  const end = new Date(checkOut)
  if (Number.isNaN(end.getTime())) return `${y1}年${m1}月${d1}日`
  const y2 = end.getFullYear(), m2 = end.getMonth() + 1, d2 = end.getDate()
  if (y1 === y2 && m1 === m2) return `${y1}年${m1}月${d1}日 至 ${d2}日`
  if (y1 === y2)               return `${y1}年${m1}月${d1}日 至 ${m2}月${d2}日`
  return `${y1}年${m1}月${d1}日 至 ${y2}年${m2}月${d2}日`
}

export default function PastLodgingPage() {
  const navigate = useNavigate()
  const uid = useUid()
  const { data: trips, isPending: tripsPending } = useMyTrips(uid)

  // Fan out per-trip queries. Each shares cache with other callers if any;
  // currently this is the sole call site, so it effectively owns the cache.
  const results = useQueries({
    queries: (trips ?? []).map(t => ({
      queryKey: bookingKeys.hotelByTrip(t.id),
      queryFn:  () => getHotelBookingsByTrip(t.id),
      enabled:  !!trips,
    })),
  })

  const anyLoading = tripsPending || results.some(r => r.isPending && r.fetchStatus !== 'idle')

  const bookings: Booking[] = results
    .flatMap(r => r.data ?? [])
    .sort((a, b) => bookingSortKey(b) - bookingSortKey(a))

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="戻る"
          className="w-9 h-9 rounded-full flex items-center justify-center text-ink hover:bg-tile transition-colors cursor-pointer"
        >
          <ArrowLeft size={18} strokeWidth={2} />
        </button>
      </div>
      <div className="px-5 pb-4 shrink-0">
        <h1 className="m-0 text-[26px] font-black text-ink -tracking-[0.4px] leading-[1.1]">
          過往旅程
        </h1>
      </div>

      {/* Body */}
      {!uid ? (
        <EmptyState
          title="サインインが必要です"
          description="旅程を確認するには、アカウントにサインインしてください。"
        />
      ) : anyLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted text-[13px]">
          <LoadingText />
        </div>
      ) : bookings.length === 0 ? (
        <EmptyState
          title="まだ記録がありません"
          description="予約が追加されると、ここに過去の宿泊が年ごとに並びます。"
        />
      ) : (
        <div className="px-4 pb-10 flex flex-col gap-3">
          {bookings.map((b, i) => {
            const year     = bookingYear(b)
            const prevYear = i > 0 ? bookingYear(bookings[i - 1]!) : null
            const showYear = prevYear !== null && prevYear !== year
            return (
              <div key={b.id} className="contents">
                {showYear && (
                  <div className="text-center text-[11px] text-muted font-semibold tracking-[0.12em] py-2">
                    {year}
                  </div>
                )}
                <BookingRow booking={b} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────

function BookingRow({ booking }: { booking: Booking }) {
  const range = formatRange(booking.checkIn, booking.checkOut)
  return (
    <div className="flex items-center gap-3 bg-surface border border-border rounded-[18px] px-3 py-2.5 shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
      <div className="w-14 h-14 rounded-xl shrink-0 flex items-center justify-center text-[26px] bg-tile border border-black/5">
        🏨
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-bold text-ink truncate">
          {booking.title}
        </div>
        {range && (
          <div className="text-[11px] text-muted mt-0.5 truncate">
            {range}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-2">
      <div className="text-[40px] leading-none mb-2">🏨</div>
      <h2 className="m-0 text-[15px] font-bold text-ink tracking-[0.02em]">
        {title}
      </h2>
      <p className="m-0 text-[12px] text-muted leading-[1.7] max-w-[280px]">
        {description}
      </p>
    </div>
  )
}
