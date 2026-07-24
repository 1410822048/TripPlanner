export const REGION = 'asia-east1'
export const MAX_SEND_TOKENS = 500

export type PushEntityType = 'member' | 'expense' | 'settlement' | 'booking' | 'schedule' | 'wish' | 'planning' | 'trip'
export type PushAction = 'joined' | 'created' | 'updated' | 'deleted' | 'role_changed' | 'removed'

// Inbox tap targets. '/account' is the destination for account-scoped events
// (member.removed_self) — the recipient has lost trip access, so we never
// route them into a trip they can no longer read.
export type PushRoute = '/schedule' | '/expense' | '/bookings' | '/wish' | '/planning' | '/account'

export type TemplateKey =
  | 'member.joined'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.removed_self'
  | 'member.left'
  | 'expense.created'
  | 'expense.updated'
  | 'expense.deleted'
  | 'settlement.created'
  | 'settlement.deleted'
  | 'booking.created'
  | 'booking.updated'
  | 'booking.deleted'
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.deleted'
  | 'route.optimized'
  | 'wish.created'
  | 'wish.updated'
  | 'wish.deleted'
  | 'planning.created'
  | 'planning.updated'
  | 'planning.deleted'
  | 'trip.title_updated'
  | 'trip.dates_updated'
  | 'trip.destination_updated'
  | 'wish.deadline_closed'

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
  // null when the write is admin/Worker-authored and no real actor can be
  // resolved (member role_changed / removed go through the Worker's admin SDK
  // and the member doc carries no updatedBy). A null actor is treated exactly
  // like actorUnknown by selectRecipients — nobody is excluded. Actor-required
  // events (expense/booking/schedule/wish/planning/trip) drop to [] instead of
  // emitting with a null actor.
  actorUid: string | null
  route: PushRoute
  templateKey: TemplateKey
  partyUids?: string[]
  // True when `actorUid` is a best-guess that must NOT be used to exclude a
  // recipient. Set for settlement HARD-delete, where the deleter's uid lives
  // on the Worker (admin SDK) and the only doc field available — `settledBy` —
  // is the RECORDER, not the deleter. See selectRecipients in dispatch.ts.
  actorUnknown?: boolean
  // true = include the actor in the inbox recipient set. Used for member
  // removal so the owner can still see the audit row for their own kick.
  includeActor?: boolean
  // false = write the actor's inbox row but do not send an FCM push to them.
  // Default is true.
  pushActor?: boolean
  settlement?: NormalizedSettlementInfo
  // false = inbox-only. Writes the notification row for every recipient but
  // skips token load + FCM send. Currently used for low-signal trip title
  // updates. Absent → true (push + inbox).
  push?: boolean
  // 'account' = notify `partyUids` regardless of current trip membership.
  // member.removed_self targets a uid who is no longer in trip.memberIds, so
  // it can't ride the trip-member recipient path. Absent → 'trip'.
  scope?: 'trip' | 'account'
  // The member a member.* event is ABOUT (not the actor). Carried from the
  // trigger's before/after so the inbox body can name them + show the new role
  // without re-reading a member doc that may already be deleted.
  subjectUid?: string
  subjectName?: string
  subjectRole?: 'owner' | 'editor' | 'viewer'
}

// Push-notification titles: static, no dynamic data (privacy — amounts/names/
// codes never leave in the FCM payload). The richer inbox body with actor /
// subject names lives in notifications.ts BODY_TEMPLATES.
export const TEMPLATES: Record<TemplateKey, string> = {
  'member.joined':            '成員已加入',
  'member.role_changed':      '權限已變更',
  'member.removed':           '成員已被移除',
  'member.removed_self':      '你已被移出行程',
  'member.left':              '成員已退出',
  'expense.created':          '已新增費用',
  'expense.updated':          '費用已更新',
  'expense.deleted':          '費用已刪除',
  'settlement.created':       '已記錄清算',
  'settlement.deleted':       '清算已取消',
  'booking.created':          '已新增訂單',
  'booking.updated':          '訂單已更新',
  'booking.deleted':          '訂單已刪除',
  'schedule.created':         '已新增行程',
  'schedule.updated':         '行程已更新',
  'schedule.deleted':         '行程已刪除',
  'route.optimized':          '行程順序已整理',
  'wish.created':             '已新增心願',
  'wish.updated':             '心願已更新',
  'wish.deleted':             '心願已刪除',
  'planning.created':         '已新增準備項目',
  'planning.updated':         '準備項目已更新',
  'planning.deleted':         '準備項目已刪除',
  'trip.title_updated':       '行程名稱已變更',
  'trip.dates_updated':       '日期已變更',
  'trip.destination_updated': '目的地已變更',
  'wish.deadline_closed':     '心願投票已截止',
}
