// src/features/bookings/components/cards/FlightCard.tsx
// Boarding-pass styled card for flight bookings. Layout:
//
//   ┌─ brand band (airline color) ──────────────────────────┐
//   │ [ANA] All Nippon Airways              ✈ BOARDING PASS │
//   ├──────────────────────────────────────────────────────┤
//   │                                                       │
//   │   NRT  ─────  ✈  ─────  TPE                           │
//   │   東京                   台北                          │
//   │                                                       │
//   │   05/15 (土)             09:30                         │
//   ├ ─ ─ ─ ─ ─ ─ ─ ─ ticket stub (dashed) ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
//   │ FLIGHT NO.            CONFIRMATION                    │
//   │ NH102                 ABC123                          │
//   └───────────────────────────────────────────────────────┘
//
// Design philosophy: use brand color + initials chip instead of fetching
// real airline SVG logos. Bundle stays tiny (~5 KB JSON), no third-party
// CDN dependency, looks ~90% like a real boarding pass.
//
// Falls back gracefully when the airline isn't matched (neutral navy
// brand band) — the card still reads as a boarding pass even for
// budget carriers we haven't catalogued.
import { Plane } from 'lucide-react'
import type { Booking } from '@/types'
import { airlineBrand } from './brandMeta'
import { fmtDate, fmtTime } from './dateFormat'

interface Props {
  booking: Booking
}

export default function FlightCard({ booking }: Props) {
  const brand     = airlineBrand(booking.provider)
  const flightNo  = booking.title    // e.g. "NH102" — stored as title for transport bookings
  const conf      = booking.confirmationCode
  const date      = fmtDate(booking.checkIn)
  const time      = fmtTime(booking.checkIn)

  return (
    <div className="relative bg-surface overflow-hidden">
      {/* Brand band */}
      <div
        className="flex items-center justify-between px-3 h-7 text-[10.5px] font-bold tracking-[0.05em]"
        style={{ background: brand.bg, color: brand.fg }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="px-1.5 py-px rounded-sm bg-black/15 text-[10px] tracking-[0.06em] shrink-0">
            {brand.label}
          </span>
          <span className="truncate opacity-90">{booking.provider ?? brand.name}</span>
        </div>
        <span className="flex items-center gap-1 shrink-0 opacity-90">
          <Plane size={11} strokeWidth={2.4} />
          BOARDING
        </span>
      </div>

      {/* Route */}
      <div className="px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-[18px] font-black text-ink -tracking-[0.5px] leading-none truncate">
              {booking.origin || '—'}
            </div>
          </div>
          <div className="shrink-0 flex items-center text-muted">
            <div className="w-3 h-px bg-border" />
            <Plane size={14} strokeWidth={2} className="mx-1 -rotate-0" style={{ color: brand.bg }} />
            <div className="w-3 h-px bg-border" />
          </div>
          <div className="flex-1 min-w-0 text-right">
            <div className="text-[18px] font-black text-ink -tracking-[0.5px] leading-none truncate">
              {booking.destination || '—'}
            </div>
          </div>
        </div>

        {(date || time) && (
          <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-muted font-medium tabular-nums">
            <span>{date}</span>
            <span className="font-bold text-ink">{time}</span>
          </div>
        )}
      </div>

      {/* Ticket stub — dashed separator + meta grid */}
      {(flightNo || conf) && (
        <div className="relative">
          {/* Hole-punches that hint at a tear-off ticket */}
          <div className="absolute -left-1.5 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-app border border-border" />
          <div className="absolute -right-1.5 top-0 -translate-y-1/2 w-3 h-3 rounded-full bg-app border border-border" />
          <div
            className="mx-3 border-t border-dashed border-border"
            aria-hidden
          />
          <div className="px-4 py-2 flex items-center gap-4">
            {flightNo && (
              <div className="min-w-0">
                <div className="text-[8.5px] text-muted tracking-[0.1em] uppercase">Flight</div>
                <div className="text-[12.5px] font-bold text-ink tabular-nums truncate">{flightNo}</div>
              </div>
            )}
            {conf && (
              <div className="min-w-0 ml-auto text-right">
                <div className="text-[8.5px] text-muted tracking-[0.1em] uppercase">Confirmation</div>
                <div className="text-[12px] font-mono font-semibold text-ink tabular-nums truncate">
                  {conf}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
