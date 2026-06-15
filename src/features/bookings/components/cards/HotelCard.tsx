// src/features/bookings/components/cards/HotelCard.tsx
// Reservation-card layout for hotel bookings. Two halves:
//
//   ┌─ cover image (uploaded thumb) or color band ──────┐
//   │                                                    │
//   │           [hotel cover image]                      │
//   │                                                    │
//   │  ┌────────────┐                                    │
//   │  │  Marriott  │ ← brand chip (when matched)        │
//   │  └────────────┘                                    │
//   ├────────────────────────────────────────────────────┤
//   │  ホテル名                                           │
//   │                                                    │
//   │  ┌─ Check-in ─┐  ┌── 2泊 ──┐  ┌─ Check-out ─┐     │
//   │  │ 5/15 (土)  │  │   📅    │  │  5/17 (月)   │     │
//   │  │ 15:00      │  │         │  │  11:00       │     │
//   │  └────────────┘  └─────────┘  └──────────────┘     │
//   │                                                    │
//   │  Confirmation: HTL-2026                            │
//   └────────────────────────────────────────────────────┘
//
// Cover image is the existing booking attachment (thumbPath / filePath) —
// users typically upload the booking confirmation PDF or a hotel photo.
// When no image, fall back to a brand-colored band so the card still
// has a visual top half.
import { Map } from 'lucide-react'
import type { Booking } from '@/types'
import { hotelBrand } from './brandMeta'
import { fmtDate, fmtTime, nightsBetween } from './dateFormat'
import ActionChip from '@/components/ui/ActionChip'
import { addressMapHref } from '@/utils/maps'
import { attachmentThumbPath, isImageAttachment } from '../../utils'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'

interface Props {
  booking: Booking
}

export default function HotelCard({ booking }: Props) {
  const brand     = hotelBrand(booking.provider)
  // path-only: resolve the thumb path to a blob objectURL via Storage Rules.
  const coverPath = isImageAttachment(booking.attachment) ? attachmentThumbPath(booking.attachment) : undefined
  const coverSrc  = useAttachmentUrl(coverPath, { kind: 'thumb' })
  const nights    = nightsBetween(booking.checkIn, booking.checkOut)
  const inDate    = fmtDate(booking.checkIn)
  const inTime    = fmtTime(booking.checkIn)
  const outDate   = fmtDate(booking.checkOut)
  const outTime   = fmtTime(booking.checkOut)
  // Address-driven map deep-link. The hotel name in `title` is too
  // ambiguous to use as a fallback search query (multiple branches per
  // city), so we only surface the chip when the user explicitly
  // recorded an address.
  const mapHref   = addressMapHref(booking.address)

  return (
    <div className="relative bg-surface overflow-hidden">
      {/* Cover region */}
      <div
        className="relative h-20 w-full"
        style={!coverSrc ? { background: brand.bg } : undefined}
      >
        {coverSrc && (
          <img
            src={coverSrc}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {/* Subtle dark gradient at the bottom so the title below stays readable
            even when the cover is bright. */}
        {coverSrc && (
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/30 to-transparent" />
        )}
        {/* Brand chip — top-left corner. Only when the brand was matched
            (otherwise the chip would just say 🏨, redundant with the type emoji). */}
        {booking.provider && brand.aliases.length > 0 && (
          <div
            className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-[0.05em] backdrop-blur-sm"
            style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
          >
            {brand.label}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="px-4 pt-2.5 pb-3">
        <div className="text-[14px] font-bold text-ink truncate -tracking-[0.2px]">
          {booking.title || booking.provider || 'ホテル'}
        </div>

        {/* Stay block: in / nights / out, symmetric layout */}
        {(inDate || outDate) && (
          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
            <DateColumn label="チェックイン" date={inDate} time={inTime} align="left" />
            <NightsBadge nights={nights} />
            <DateColumn label="チェックアウト" date={outDate} time={outTime} align="right" />
          </div>
        )}

        {/* Confirmation code chip */}
        {booking.confirmationCode && (
          <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-muted">
            <span className="tracking-[0.04em]">確認碼</span>
            <span className="font-mono font-semibold text-ink tabular-nums tracking-tight">
              {booking.confirmationCode}
            </span>
          </div>
        )}

        {mapHref && (
          <div className="mt-2.5">
            <ActionChip
              href={mapHref}
              icon={Map}
              label="地図"
              ariaLabel={`${booking.address ?? ''} を地図で開く`}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function DateColumn({
  label, date, time, align,
}: {
  label: string
  date:  string
  time:  string
  align: 'left' | 'right'
}) {
  return (
    <div className={[
      'min-w-0 px-2 py-1.5 rounded-input bg-app border border-border',
      align === 'right' ? 'text-right' : '',
    ].join(' ')}>
      <div className="text-[8.5px] text-muted tracking-[0.08em] uppercase truncate">
        {label}
      </div>
      <div className="text-[11.5px] font-bold text-ink tabular-nums leading-tight mt-0.5 truncate">
        {date || '—'}
      </div>
      {time && (
        <div className="text-[10px] text-muted tabular-nums leading-tight">
          {time}
        </div>
      )}
    </div>
  )
}

function NightsBadge({ nights }: { nights: number | null }) {
  return (
    <div className="self-center flex flex-col items-center justify-center w-12 px-1">
      <div className="text-[16px] leading-none mb-0.5">📅</div>
      <div className="text-[10.5px] font-bold text-muted tabular-nums tracking-[0.04em]">
        {nights !== null ? `${nights}泊` : '—'}
      </div>
    </div>
  )
}
