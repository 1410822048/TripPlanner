// src/types/wish.ts
// Wish item — collaborative wishlist that members vote on. Replaces the
// earlier Journal entity. Voting is a single thumbs-up per member
// (toggle); the votes array stores uids and is the source of both
// "did I vote?" and "who voted?" rendering. arrayUnion / arrayRemove
// keep the toggle atomic at the Firestore layer.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

// Two-category model: 景點 vs 餐廳. Earlier versions had four
// (place / food / activity / other); the simpler split matches how
// users actually plan trips ("things to see" vs "things to eat") and
// removes the ambiguous "other" bucket. Firestore has since been
// cleared, so no legacy migration is needed — fresh wishes only ever
// see `place | food`.
export type WishCategory = 'place' | 'food'

export interface WishImage {
  /** Storage object path. path-only: reads via getBlob(path) + Storage
   *  Rules — no bearer download URL is ever persisted. */
  path:       string
  /** Small-variant path. Optional: thumb-less uploads (HEIC/HEIF pass-
   *  through) omit it rather than collapse to the full path, so the card
   *  shows its placeholder instead of pulling the full blob into the
   *  thumbnail cache. */
  thumbPath?: string
}

// trips/{tripId}/wishes/{wishId}
export interface Wish {
  id: string
  tripId: string
  category: WishCategory
  title: string
  description?: string
  /** External URL — restaurant page / Instagram / official site.
   *  Optional. The maps chip is now driven by `address` below;
   *  legacy data with a Google Maps URL pasted here still works
   *  (LinkChip auto-detects when `address` is absent). */
  link?: string
  /** Free-form address used as a Google Maps search query. When set,
   *  the card surfaces a dedicated 🗺 chip pointing at
   *  https://www.google.com/maps/search/?api=1&query={address}.
   *  Can be a street address, place name, or even lat/lng — Google
   *  resolves all three. Independent from `link` so users can keep
   *  the official site URL AND the address. */
  address?: string
  /** Single optional cover image. Multi-image isn't needed for wishes;
   *  one representative photo plus a link covers most cases. */
  image?: WishImage
  /** uid of the member who proposed this wish. */
  proposedBy: string
  /** Last-writer uid (incl. vote toggle). See useFeatureBadges. */
  updatedBy: string
  /** Denormalised member uids — drives the same-doc read rule. See
   *  trip.memberIds for rationale. */
  memberIds: string[]
  /** uids that have +1'd this wish. Sort key: votes.length desc. */
  votes: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

// Shape + size guards only. The Storage-origin + path-binding contract
// (URL must point at this wish's own Storage folder) is enforced by the
// Worker's /wish-file-create + /wish-file-update endpoints after verifying
// the upload-intent doc — image is Worker-authoritative since Phase 3.7,
// firestore.rules no longer accepts client-side image writes. Zod here
// stays bucket-agnostic so a future bucket move doesn't require both
// layers to update in lockstep.
export const WishImageSchema = z.object({
  // path-only: reads go through getBlob(path); no bearer URL persisted.
  // thumbPath optional (omitted for thumb-less uploads, no full-path collapse).
  path:      z.string().min(1).max(500),
  thumbPath: z.string().min(1).max(500).optional(),
})

export const WishDocSchema = z.object({
  tripId:      z.string(),
  category:    z.enum(['place', 'food']),
  title:       z.string(),
  description: z.string().optional(),
  link:        z.string().optional(),
  address:     z.string().optional(),
  image:       WishImageSchema.optional(),
  proposedBy:  z.string(),
  updatedBy:   z.string(),
  memberIds:   z.array(z.string().min(1)).min(1),
  votes:       z.array(z.string()),
  createdAt:   TimestampSchema,
  updatedAt:   TimestampSchema,
})

/** Form input for creating / editing a wish. Image upload + vote toggle
 *  are handled out-of-band. */
export const CreateWishSchema = z.object({
  category:    z.enum(['place', 'food']),
  title:       z.string().min(1, '請輸入標題').max(100),
  description: z.string().max(500).optional(),
  link:        z.string().max(500).optional(),
  address:     z.string().max(200).optional(),
})
export type CreateWishInput = z.infer<typeof CreateWishSchema>

/** Update payload — every field optional, but each present field still
 *  goes through the Create rules (length caps, enum membership, etc.).
 *  Defense-in-depth: TS already gates this at the call site, but a Zod
 *  check at the service boundary catches edge cases like a future code
 *  path that bypasses the typed form layer. */
export const UpdateWishSchema = CreateWishSchema.partial()
export type UpdateWishInput = z.infer<typeof UpdateWishSchema>
