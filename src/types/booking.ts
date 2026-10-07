// src/types/booking.ts
// Booking entity — flights / hotels / trains / buses. Includes the
// thumbnail variant + memberIds denormalisation introduced for
// PastLodgingPage's collection-group hotel query.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema, isHttpUrl } from './_shared'
import { ATTACHMENT_PATH_MAX, BOOKING_LIMITS } from '@tripmate/entity-contracts'

/**
 * Attachment metadata for a booking file with an optional smaller thumbnail
 * variant. Bookings use role-specific fields:
 *   - coverImage: visual hotel cover image (image-only)
 *   - document: confirmation document (PDF or image, future parser input)
 */
export interface BookingAttachment {
  /**
   * Private R2 object path (`trips/{tripId}/bookings/{bookingId}/file.webp`).
   * This is the canonical reference; the authenticated Worker proxy reads and
   * deletes the bytes after trip/role authorization.
   * No bearer download URL is ever persisted.
   */
  filePath:   string
  /** Mime type at upload time — drives icon vs <img> rendering in the UI. */
  fileType:   string
  /** Smaller variant (192px @ q=0.7 WebP) path used by the list row
   *  thumbnail. Optional: PDFs (and other non-image attachments) have no
   *  thumbnail. */
  thumbPath?: string
}

// trips/{tripId}/bookings/{bookingId}
export interface Booking {
  id: string
  tripId: string
  type: 'flight' | 'hotel' | 'train' | 'bus' | 'other'
  /**
   * For transport types (flight/train/bus) `title` is optional and holds a
   * supplementary label like flight number / train name. The primary
   * identifier on these is `origin → destination`. For hotel and `other`
   * types, `title` is the main label and is required at the form layer.
   */
  title?: string
  /** Only set for transport types. Renders as "{origin} → {destination}". */
  origin?:      string
  destination?: string
  confirmationCode?: string
  provider?: string
  checkIn?: string          // ISO datetime
  checkOut?: string
  /**
   * Server-side sort key. Always populated on create / update so Firestore
   * can `orderBy('sortDate', 'desc')` over the whole collection without
   * excluding docs that have a missing optional field. Mirrors the client-
   * side bookingSortKey() logic: prefer `checkIn` Timestamp; fall back to
   * `createdAt`.
   *
   * Required on every stored doc — firestore.rules rejects a create or
   * update without it, because Firestore drops docs missing the ordered
   * field and the booking would silently vanish from every list. Optional
   * in the interface only for the demo fixtures, which never round-trip
   * through Firestore.
   */
  sortDate?: Timestamp
  /**
   * Denormalised list of member uids who can read this booking. Mirrored
   * from /trips/{tripId}/members/{uid} so collection-group queries (e.g.
   * PastLodgingPage's "every hotel booking I'm a member of") can use
   * `where('memberIds', 'array-contains', uid)` instead of the per-trip
   * fan-out pattern.
   *
   * Sync rules:
   *   - createBooking populates from current member roster
   *   - acceptInvite (member added) appends uid to every booking
   *   - removeMember splices uid from every booking
   * Doubles as the read-rule gate: `allow read: if request.auth.uid in
   * resource.data.memberIds` — same-doc check, no cross-document lag.
   */
  memberIds: string[]
  /** Visual hotel card cover image. */
  coverImage?: BookingAttachment
  /** Reservation confirmation document. This is intentionally independent
   *  from the cover image so PDF/text import can parse the source document
   *  without stealing the card's visual hero. */
  document?: BookingAttachment
  /** Free-form address used as a Google Maps search query. Most useful
   *  for hotels / venues where the user wants a one-tap deep link to
   *  the location; transport types already convey origin/destination
   *  through their dedicated fields. Same shape + URL builder as
   *  Wish.address — see utils/maps.ts. */
  address?: string
  /** External booking URL — the OTA / hotel reservation page (Airbnb,
   *  Booking.com, the hotel's own site, …). Surfaced as a one-tap
   *  external link so the user can reopen the source listing. Restricted to
   *  http(s) at every write boundary (Zod here, Worker, firestore.rules)
   *  because it renders into an `<a href>`. Mirrors Wish.link. */
  link?: string
  note?: string
  createdBy: string
  /** Last-writer uid. See useFeatureBadges. */
  updatedBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * `type` 限制在現行支援集合，未來擴充時需同步擴表。
 */
/** Accepted attachment mime types. Mirrors `extForMime()` in
 *  bookingStorage.ts AND the allowlist enforced by the Worker
 *  /booking-file-create + /booking-file-update endpoints (Phase 3.7
 *  made booking file fields Worker-authoritative; firestore.rules no
 *  longer accepts client writes of the field). Drift would let one
 *  layer accept bytes the other rejects. */
export const BOOKING_ATTACHMENT_MIME_TYPES = [
  'image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/pdf',
] as const

export const BookingAttachmentSchema = z.object({
  // Path-only: reads go through the Worker proxy; no bearer URL persisted.
  filePath:  z.string().min(1).max(ATTACHMENT_PATH_MAX),
  fileType:  z.enum(BOOKING_ATTACHMENT_MIME_TYPES),
  thumbPath: z.string().min(1).max(ATTACHMENT_PATH_MAX).optional(),
})

export const BookingDocSchema = z.object({
  tripId:           z.string(),
  type:             z.enum(['flight', 'hotel', 'train', 'bus', 'other']),
  /**
   * Title is optional in the doc shape — transport bookings often save
   * `origin/destination` only. Form-level validation enforces "title XOR
   * (origin && destination)".
   */
  title:            z.string().optional(),
  origin:           z.string().optional(),
  destination:      z.string().optional(),
  confirmationCode: z.string().optional(),
  provider:         z.string().optional(),
  checkIn:          z.string().optional(),
  checkOut:         z.string().optional(),
  coverImage:       BookingAttachmentSchema.optional(),
  document:         BookingAttachmentSchema.optional(),
  address:          z.string().optional(),
  // Same constraint as every write gate. The read side is where the value
  // becomes an <a href>, so it is the last place worth checking: a doc
  // that somehow carries a javascript:/data: link fails to parse and the
  // booking drops out with a Sentry capture, rather than rendering a live
  // link nobody validated. No `''` allowance — the sentinel is translated
  // to a field delete before it reaches storage.
  link:             z.string().max(BOOKING_LIMITS.link).refine(isHttpUrl).optional(),
  note:             z.string().optional(),
  createdBy:        z.string(),
  updatedBy:        z.string(),
  createdAt:        TimestampSchema,
  updatedAt:        TimestampSchema,
  sortDate:         TimestampSchema,
  memberIds:        z.array(z.string().min(1)).min(1),
})

/**
 * Form input for creating / editing a booking. File upload is handled
 * out-of-band. All identifying fields are optional in the schema; the form
 * layer enforces "title required for hotel/other, origin+destination
 * required for flight/train/bus" (depends on `type` so it can't be
 * expressed cleanly with a single .refine).
 */
export const CreateBookingSchema = z.object({
  type:             z.enum(['flight', 'hotel', 'train', 'bus', 'other']),
  title:            z.string().max(BOOKING_LIMITS.title).optional(),
  origin:           z.string().max(BOOKING_LIMITS.origin).optional(),
  destination:      z.string().max(BOOKING_LIMITS.destination).optional(),
  confirmationCode: z.string().max(BOOKING_LIMITS.confirmationCode).optional(),
  provider:         z.string().max(BOOKING_LIMITS.provider).optional(),
  // All string caps come from @tripmate/entity-contracts BOOKING_LIMITS,
  // which the Worker (booking-write.ts) imports too; firestore.rules can't
  // import, so tests/invariants/entityContracts.test.ts compares it. The
  // lockstep is mandatory: the Worker uses admin SDK and bypasses
  // rules, so a looser cap on either side is a real exploit (a
  // megabyte `note` written via Worker bypassing rules cap; or a
  // no-file booking writing client-side past Worker cap).
  checkIn:          z.string().max(BOOKING_LIMITS.dateText).optional(),
  checkOut:         z.string().max(BOOKING_LIMITS.dateText).optional(),
  // 住所テキスト or Google Maps URL を受けるため 500(URL は 200 を超え得る)。
  address:          z.string().max(BOOKING_LIMITS.address).optional(),
  // 予約元 URL。http(s) のみ(href に出すため)。cap 500 は rules / Worker と lockstep。
  // '' はクリア用 sentinel として許可(stripEmpty / deleteField で
  // Firestore には届かないので rules 側は strict のまま)。
  link:             z.string().max(BOOKING_LIMITS.link).refine(v => v === '' || isHttpUrl(v), 'URL 必須以 http:// 或 https:// 開頭').optional(),
  note:             z.string().max(BOOKING_LIMITS.note).optional(),
})
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>

/** Update payload — every field optional. Already-optional fields stay
 *  optional; required `type` becomes optional too so an update can omit
 *  it (a no-op write that doesn't change the booking type). */
export const UpdateBookingSchema = CreateBookingSchema.partial()
export type UpdateBookingInput = z.infer<typeof UpdateBookingSchema>
