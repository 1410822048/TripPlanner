// src/types/notification.ts
// Persistent notification inbox row — written by Firebase Functions
// (firebase-functions/src/notifications.ts) alongside the FCM send.
// Distinct from the server-only `_pushEvents` dedupe record: this is one
// doc PER RECIPIENT (so each has its own readAt), while `_pushEvents` is
// one doc per event carrying a lease + delivery status.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema, CurrencyCodeSchema } from './_shared'

export type NotificationEntityType = 'expense' | 'booking' | 'settlement' | 'member'

// users/{uid}/notifications/{eventId}
export interface Notification {
  id: string
  recipientUid: string
  tripId: string
  tripTitle: string
  entityType: NotificationEntityType
  entityId: string
  action: 'created' | 'updated' | 'deleted' | 'joined'
  actorUid: string
  actorName: string
  title: string
  body: string
  route: '/schedule' | '/expense' | '/bookings'
  settlement?: {
    fromUid: string
    fromName: string
    toUid: string
    toName: string
    amountMinor: number
    currency: string
  }
  createdAt: Timestamp
  readAt: Timestamp | null
  /** Set when the recipient soft-dismisses the row from the inbox. Server
   *  query filters `dismissedAt == null` so dismissed rows never surface. */
  dismissedAt: Timestamp | null
  expiresAt: Timestamp
}

const notificationSettlementInfoSchema = z.object({
  fromUid:     z.string(),
  fromName:    z.string(),
  toUid:       z.string(),
  toName:      z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency:    CurrencyCodeSchema,
})

export const NotificationDocSchema = z.object({
  recipientUid:  z.string(),
  tripId:        z.string(),
  tripTitle:     z.string(),
  entityType:    z.enum(['expense', 'booking', 'settlement', 'member']),
  entityId:      z.string(),
  action:        z.enum(['created', 'updated', 'deleted', 'joined']),
  actorUid:      z.string(),
  actorName:     z.string(),
  title:         z.string(),
  body:          z.string(),
  route:         z.enum(['/schedule', '/expense', '/bookings']),
  settlement:    notificationSettlementInfoSchema.optional(),
  createdAt:     TimestampSchema,
  readAt:        TimestampSchema.nullable(),
  dismissedAt:   TimestampSchema.nullable(),
  expiresAt:     TimestampSchema,
})
