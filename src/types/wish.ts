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
// removes the ambiguous "other" bucket. Legacy docs with `activity`
// or `other` need to run scripts/migrate-wish-categories.mjs once
// before this stricter enum is deployed.
export type WishCategory = 'place' | 'food'

export interface WishImage {
  url:       string
  path:      string
  thumbUrl:  string
  thumbPath: string
}

// trips/{tripId}/wishes/{wishId}
export interface Wish {
  id: string
  tripId: string
  category: WishCategory
  title: string
  description?: string
  /** External URL — Google Maps / restaurant page / Instagram. Optional. */
  link?: string
  /** Single optional cover image. Multi-image isn't needed for wishes;
   *  one representative photo plus a link covers most cases. */
  image?: WishImage
  /** uid of the member who proposed this wish. */
  proposedBy: string
  /** uids that have +1'd this wish. Sort key: votes.length desc. */
  votes: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export const WishImageSchema = z.object({
  url:       z.string(),
  path:      z.string(),
  thumbUrl:  z.string(),
  thumbPath: z.string(),
})

export const WishDocSchema = z.object({
  tripId:      z.string(),
  category:    z.enum(['place', 'food']),
  title:       z.string(),
  description: z.string().optional(),
  link:        z.string().optional(),
  image:       WishImageSchema.optional(),
  proposedBy:  z.string(),
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
})
export type CreateWishInput = z.infer<typeof CreateWishSchema>

/** Update payload — every field optional, but each present field still
 *  goes through the Create rules (length caps, enum membership, etc.).
 *  Defense-in-depth: TS already gates this at the call site, but a Zod
 *  check at the service boundary catches edge cases like a future code
 *  path that bypasses the typed form layer. */
export const UpdateWishSchema = CreateWishSchema.partial()
export type UpdateWishInput = z.infer<typeof UpdateWishSchema>
