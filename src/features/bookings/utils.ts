// src/features/bookings/utils.ts
// Shared display helpers — keeps the list, preview modal, and any future
// booking renderer in lockstep when the schema gains optional fields.
import { Plane, Hotel, TrainFront, Bus, MapPin, type LucideIcon } from 'lucide-react'
import type { Booking, BookingAttachment } from '@/types'

/** Thumbnail Storage PATH for getBlob (path-only model). The small WebP
 *  variant ONLY -- deliberately no fall-back to the full filePath so a
 *  thumb-less attachment (PDF, or a pre-thumb upload) renders the type-
 *  emoji / placeholder instead of pulling a full-size blob into the
 *  thumbnail cache. Returns undefined when there's no thumb path. Feed the
 *  result to `useAttachmentUrl(path, { kind: 'thumb' })`. */
export function attachmentThumbPath(att: BookingAttachment | undefined): string | undefined {
  return att?.thumbPath
}

/** True when the attachment is renderable as an `<img>`. PDFs and other
 *  non-image types route through the AttachmentPreviewModal instead. */
export function isImageAttachment(att: BookingAttachment | undefined): boolean {
  return (att?.fileType ?? '').startsWith('image/')
}

/**
 * Per-type display metadata — lucide icon shown in section headers /
 * fallback card thumbnails / form picker, label rendered as the heading
 * text. Single source of truth so adding a new booking type is a one-file
 * edit and BookingsPage / BookingPassCard / BookingFormModal never disagree.
 */
export const BOOKING_TYPE_META: Record<Booking['type'], { icon: LucideIcon; label: string }> = {
  flight: { icon: Plane,      label: 'フライト' },
  hotel:  { icon: Hotel,      label: 'ホテル'   },
  train:  { icon: TrainFront, label: '電車'     },
  bus:    { icon: Bus,        label: 'バス'     },
  other:  { icon: MapPin,     label: 'その他'   },
}

/** 表示順(section / form picker 共用)。BOOKING_TYPE_META と二重管理しないよう
 *  並び順だけをここに持つ。 */
export const BOOKING_TYPE_ORDER: Booking['type'][] = ['flight', 'hotel', 'train', 'bus', 'other']

/**
 * Primary user-facing label for a booking. Transport types prefer the
 * "出発 → 到着" route; everything else uses the title. Falls back to a
 * generic word when neither is set so the UI never renders an empty header.
 */
export function bookingDisplayName(b: Booking): string {
  if (b.origin && b.destination) return `${b.origin} → ${b.destination}`
  if (b.title) return b.title
  return '予約'
}

/**
 * Subtitle for transport bookings. Includes the vehicle name (flight
 * number / train name → stored as `title`) and the provider, separated
 * by middle dots. Returns an empty string if neither piece is set so the
 * caller can decide to omit the row entirely.
 */
export function bookingSubtitle(b: Booking): string {
  const parts: string[] = []
  // For transport, title acts as the vehicle name; show alongside provider.
  // For non-transport, title is already the primary header → don't repeat.
  const isTransport = b.type === 'flight' || b.type === 'train' || b.type === 'bus'
  if (isTransport && b.title) parts.push(b.title)
  if (b.provider) parts.push(b.provider)
  return parts.join(' · ')
}
