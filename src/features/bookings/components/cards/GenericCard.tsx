// src/features/bookings/components/cards/GenericCard.tsx
// Compact fallback layout for booking types where a templated card
// would be over-design — bus rides and miscellaneous reservations
// (museum tickets, tours, etc.). Keeps the slim row look the page had
// before the templated cards were introduced, so users editing simple
// "其他" entries don't get an oversized card.
//
// Owns its own PDF-attachment preview button — when the booking has a
// non-image attachment, the card surfaces a 📄 button that opens the
// preview modal. The dispatcher (SwipeableBookingItem) just forwards
// onPreview without needing to know which card types support attachments.
import { FileText, MapPin } from 'lucide-react'
import type { Booking } from '@/types'
import {
  attachmentThumbPath, bookingDisplayName, bookingSubtitle, BOOKING_TYPE_META, isImageAttachment,
} from '../../utils'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { mapsSearchUrl } from '@/utils/maps'

interface Props {
  booking:   Booking
  whenLabel: string
  /** Tap on the PDF icon — caller opens an AttachmentPreviewModal.
   *  Forwarded by the dispatcher; only matters when the booking has a
   *  non-image attachment (the icon is hidden otherwise). */
  onPreview: () => void
}

export default function GenericCard({ booking, whenLabel, onPreview }: Props) {
  const isImage  = isImageAttachment(booking.attachment)
  const thumbSrc = useAttachmentUrl(isImage ? attachmentThumbPath(booking.attachment) : undefined, { kind: 'thumb' })
  const showImage = isImage && !!thumbSrc
  const subtitle = bookingSubtitle(booking)
  const address  = booking.address
  const mapHref  = address ? mapsSearchUrl(address) : null
  const hasMeta  = subtitle.length > 0 || whenLabel.length > 0 || !!address
  // path-only: a non-image attachment exists iff it has a filePath (the
  // bearer fileUrl no longer exists to gate on).
  const hasPdf   = !isImage && !!booking.attachment?.filePath

  // Both handlers stop propagation so the PDF tap doesn't also arm the
  // outer swipe gesture or fire the row's tap-to-edit.
  function handlePreviewTap(e: React.MouseEvent) {
    e.stopPropagation()
    onPreview()
  }
  function handlePreviewPointerDown(e: React.PointerEvent) {
    e.stopPropagation()
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface">
      {showImage ? (
        <img
          src={thumbSrc}
          alt=""
          width={48}
          height={48}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="w-12 h-12 rounded-xl shrink-0 object-cover bg-tile border border-black/5 pointer-events-none"
        />
      ) : (
        <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-[22px] bg-tile border border-black/5 pointer-events-none">
          {BOOKING_TYPE_META[booking.type].emoji}
        </div>
      )}

      <div className="flex-1 min-w-0 pointer-events-none">
        <div className="text-[13.5px] font-bold text-ink truncate">
          {bookingDisplayName(booking)}
        </div>
        {hasMeta && (
          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted min-w-0">
            {subtitle && <span className="truncate">{subtitle}</span>}
            {subtitle && whenLabel && <span className="text-border shrink-0">·</span>}
            {whenLabel && <span className="truncate tabular-nums">{whenLabel}</span>}
            {address && (subtitle || whenLabel) && <span className="text-border shrink-0">·</span>}
            {address && (
              mapHref ? (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  onPointerDown={e => e.stopPropagation()}
                  aria-label={`${address} を地図で開く`}
                  className="flex items-center gap-[2px] text-accent no-underline hover:underline truncate min-w-0 pointer-events-auto"
                >
                  <MapPin size={10} strokeWidth={2} className="shrink-0" />
                  <span className="truncate">{address}</span>
                </a>
              ) : (
                <span className="flex items-center gap-[2px] truncate">
                  <MapPin size={10} strokeWidth={2} className="shrink-0" />
                  <span className="truncate">{address}</span>
                </span>
              )
            )}
          </div>
        )}
      </div>

      {hasPdf && (
        <button
          type="button"
          onClick={handlePreviewTap}
          onPointerDown={handlePreviewPointerDown}
          aria-label="添付を表示"
          className="shrink-0 w-9 h-9 rounded-md flex items-center justify-center bg-app text-muted border-none cursor-pointer hover:bg-tile transition-colors"
        >
          <FileText size={14} strokeWidth={1.8} className="pointer-events-none" />
        </button>
      )}

      {booking.confirmationCode && (
        <div className="shrink-0 px-2 py-1 rounded-md bg-app text-[10px] font-mono font-semibold text-muted tracking-tight tabular-nums max-w-[88px] truncate pointer-events-none">
          {booking.confirmationCode}
        </div>
      )}
    </div>
  )
}
