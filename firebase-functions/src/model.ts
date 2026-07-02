export const REGION = 'asia-east1'
export const MAX_SEND_TOKENS = 500

export type PushEntityType = 'member' | 'expense' | 'settlement' | 'booking'
export type PushAction = 'joined' | 'created' | 'updated' | 'deleted'

export type TemplateKey =
  | 'member.joined'
  | 'expense.created'
  | 'expense.updated'
  | 'expense.deleted'
  | 'settlement.created'
  | 'settlement.deleted'
  | 'booking.created'
  | 'booking.updated'

export interface EventAuth {
  authId?: string
  authType?: string
}

/** Settlement direction + amount, carried through to the notification
 *  inbox doc (`writeNotificationDocs`) so its body can say "誰付給誰多少"
 *  without dispatch.ts re-reading the (possibly soft-deleted) settlement
 *  doc a second time. Names are resolved separately from member docs —
 *  this only carries the raw uids + money. */
export interface NormalizedSettlementInfo {
  fromUid: string
  toUid: string
  amountMinor: number
  currency: string
}

export interface NormalizedPushEvent {
  eventId: string
  tripId: string
  entityType: PushEntityType
  entityId: string
  action: PushAction
  actorUid: string
  route: '/schedule' | '/expense' | '/bookings'
  templateKey: TemplateKey
  partyUids?: string[]
  // True when `actorUid` is a best-guess that must NOT be used to exclude a
  // recipient. Set for settlement HARD-delete, where the deleter's uid lives
  // on the Worker (admin SDK) and the only doc field available — `settledBy` —
  // is the RECORDER, not the deleter. See selectRecipients in dispatch.ts.
  actorUnknown?: boolean
  settlement?: NormalizedSettlementInfo
}

export const TEMPLATES: Record<TemplateKey, string> = {
  'member.joined':      'メンバーが参加しました',
  'expense.created':    '費用が追加されました',
  'expense.updated':    '費用が更新されました',
  'expense.deleted':    '費用が削除されました',
  'settlement.created': '精算が記録されました',
  'settlement.deleted': '精算が取り消されました',
  'booking.created':    '予約が追加されました',
  'booking.updated':    '予約が更新されました',
}
