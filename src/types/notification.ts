// src/types/notification.ts
// Persistent notification inbox row — written by Firebase Functions
// (firebase-functions/src/notifications.ts) alongside the FCM send.
// Distinct from the server-only `_pushEvents` dedupe record: this is one
// doc PER RECIPIENT (so each has its own readAt), while `_pushEvents` is
// one doc per event carrying a lease + delivery status.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema, CurrencyCodeSchema } from './_shared'
import { NOTIFICATION_ROUTES, NOTIFICATION_SCOPES, type NotificationRoute, type NotificationScope } from './notificationRoute'

export type NotificationEntityType = 'expense' | 'booking' | 'settlement' | 'member' | 'schedule' | 'wish' | 'planning' | 'trip'

/** 通知可導向的頁面白名單。收件匣 doc 與推播點擊（SW → client）共用同一份，
 *  任何不在清單內的 route 一律忽略。 */
export const NotificationRouteSchema = z.enum(NOTIFICATION_ROUTES)
export const NotificationScopeSchema = z.enum(NOTIFICATION_SCOPES)
export type { NotificationRoute, NotificationScope }

// users/{uid}/notifications/{eventId}
export interface Notification {
  id: string
  recipientUid: string
  tripId: string
  tripTitle: string
  /** 'trip' rows are scoped to a trip the recipient is a member of and load
   *  via the trip-scoped inbox query. 'account' rows (member.removed_self)
   *  target a recipient who has lost trip access, so they load via a separate
   *  membership-independent query and route to /account. */
  scope: NotificationScope
  entityType: NotificationEntityType
  entityId: string
  action: 'created' | 'updated' | 'deleted' | 'joined' | 'role_changed' | 'removed'
  /** null for admin/Worker-authored events with no resolvable actor
   *  (member role_changed / removed). */
  actorUid: string | null
  actorName: string
  title: string
  body: string
  route: NotificationRoute
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
  scope:         NotificationScopeSchema,
  entityType:    z.enum(['expense', 'booking', 'settlement', 'member', 'schedule', 'wish', 'planning', 'trip']),
  entityId:      z.string(),
  action:        z.enum(['created', 'updated', 'deleted', 'joined', 'role_changed', 'removed']),
  actorUid:      z.string().nullable(),
  actorName:     z.string(),
  title:         z.string(),
  body:          z.string(),
  route:         NotificationRouteSchema,
  settlement:    notificationSettlementInfoSchema.optional(),
  createdAt:     TimestampSchema,
  readAt:        TimestampSchema.nullable(),
  dismissedAt:   TimestampSchema.nullable(),
  expiresAt:     TimestampSchema,
})
