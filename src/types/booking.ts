// src/types/booking.ts
// Booking entity — flights / hotels / trains / buses. Includes the
// thumbnail variant + memberIds denormalisation introduced for
// PastLodgingPage's collection-group hotel query.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

/**
 * Attachment metadata for a booking — single optional file (confirmation
 * PDF / hotel photo / etc.) with an optional smaller thumbnail variant.
 * Mirrors the Wish entity's `image: WishImage` shape.
 */
export interface BookingAttachment {
  /**
   * Storage object path (`trips/{tripId}/bookings/{bookingId}/file.webp`).
   * path-only: this IS the canonical reference — getBlob(filePath) reads
   * the bytes (Storage Rules), and deleteObject(filePath) removes them.
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
   * Optional in the type for backward-compat with bookings created before
   * the field was introduced; those rows will be excluded from the
   * orderBy query until backfilled.
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
  /** Optional attached file — see BookingAttachment for shape. */
  attachment?: BookingAttachment
  /** Free-form address used as a Google Maps search query. Most useful
   *  for hotels / venues where the user wants a one-tap deep link to
   *  the location; transport types already convey origin/destination
   *  through their dedicated fields. Same shape + URL builder as
   *  Wish.address — see utils/maps.ts. */
  address?: string
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
 *  made booking.attachment Worker-authoritative; firestore.rules no
 *  longer accepts client writes of the field). Drift would let one
 *  layer accept bytes the other rejects. */
export const BOOKING_ATTACHMENT_MIME_TYPES = [
  'image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/pdf',
] as const

export const BookingAttachmentSchema = z.object({
  // path-only: reads go through getBlob(filePath); no bearer URL persisted.
  filePath:  z.string().min(1).max(500),
  fileType:  z.enum(BOOKING_ATTACHMENT_MIME_TYPES),
  thumbPath: z.string().min(1).max(500).optional(),
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
  attachment:       BookingAttachmentSchema.optional(),
  address:          z.string().optional(),
  note:             z.string().optional(),
  createdBy:        z.string(),
  updatedBy:        z.string(),
  createdAt:        TimestampSchema,
  updatedAt:        TimestampSchema,
  sortDate:         TimestampSchema.optional(),
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
  title:            z.string().max(100).optional(),
  origin:           z.string().max(60).optional(),
  destination:      z.string().max(60).optional(),
  confirmationCode: z.string().max(64).optional(),
  provider:         z.string().max(60).optional(),
  // All string caps (title 100 / origin 60 / destination 60 /
  // confirmationCode 64 / provider 60 / address 200 / checkIn 32 /
  // checkOut 32 / note 2000) mirror firestore.rules booking
  // create/update AND workers/ocr/src/booking-write.ts. Three-way
  // lockstep is mandatory: the Worker uses admin SDK and bypasses
  // rules, so a looser cap on either side is a real exploit (a
  // megabyte `note` written via Worker bypassing rules cap; or a
  // no-file booking writing client-side past Worker cap).
  checkIn:          z.string().max(32).optional(),
  checkOut:         z.string().max(32).optional(),
  address:          z.string().max(200).optional(),
  note:             z.string().max(2000).optional(),
})
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>

/** Update payload — every field optional. Already-optional fields stay
 *  optional; required `type` becomes optional too so an update can omit
 *  it (a no-op write that doesn't change the booking type). */
export const UpdateBookingSchema = CreateBookingSchema.partial()
export type UpdateBookingInput = z.infer<typeof UpdateBookingSchema>
