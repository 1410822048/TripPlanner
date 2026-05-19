// src/features/bookings/components/cards/TrainCard.tsx
// Train ticket layout — narrower than the boarding pass since trains
// usually only need: operator, route, vehicle name, departure time.
//
//   ┌─ operator band (rail brand) ─────────────────────────┐
//   │ JR EAST                                       TICKET  │
//   ├──────────────────────────────────────────────────────┤
//   │  東京 → 京都                                          │
//   │  のぞみ 7号                                           │
//   │  09:00   05/15(土)                                    │
//   └──────────────────────────────────────────────────────┘
//
// Same brand-color trick as FlightCard: matched operator paints the top
// band, unmatched falls back to a neutral teal so the card still reads
// like a ticket.
import type { Booking } from '@/types'
import { railBrand } from './brandMeta'
import { fmtDate, fmtTime } from './dateFormat'
import BrandBand from './BrandBand'

interface Props {
  booking: Booking
}

export default function TrainCard({ booking }: Props) {
  const brand     = railBrand(booking.provider)
  const vehicle   = booking.title          // e.g. "のぞみ7号"
  const date      = fmtDate(booking.checkIn)
  const time      = fmtTime(booking.checkIn)
  const conf      = booking.confirmationCode

  return (
    <div className="relative bg-surface overflow-hidden">
      <BrandBand brand={brand} provider={booking.provider}>TICKET</BrandBand>

      {/* Route + vehicle */}
      <div className="px-4 pt-3 pb-3">
        <div className="text-[15px] font-black text-ink -tracking-[0.3px] truncate">
          {booking.origin || '—'}
          <span className="mx-1.5 text-muted font-normal">→</span>
          {booking.destination || '—'}
        </div>
        {vehicle && (
          <div className="text-[12px] font-semibold text-muted mt-1 truncate">
            {vehicle}
          </div>
        )}

        {(time || date) && (
          <div className="mt-2 flex items-center gap-3 text-[10.5px] text-muted tabular-nums">
            {time && <span className="font-bold text-ink text-[12px]">{time}</span>}
            {date && <span>{date}</span>}
            {conf && (
              <span className="ml-auto px-1.5 py-0.5 rounded bg-app font-mono text-[10px] tracking-tight truncate">
                {conf}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
