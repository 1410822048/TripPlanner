import type { EventAuth, NormalizedPushEvent, NormalizedSettlementInfo } from './model.js'

type Doc = Record<string, unknown>

const EXPENSE_MEANINGFUL_FIELDS = [
  'title',
  'amountMinor',
  'currency',
  'category',
  'paidBy',
  'splits',
  'date',
  'receipt',
  'items',
  'adjustments',
  'note',
  'sourceCurrency',
  'sourceAmountMinor',
  'sourceItems',
  'sourceAdjustments',
  'sourceSplits',
] as const

const BOOKING_MEANINGFUL_FIELDS = [
  'type',
  'title',
  'origin',
  'destination',
  'confirmationCode',
  'provider',
  'checkIn',
  'checkOut',
  'coverImage',
  'document',
  'address',
  'link',
  'note',
  'sortDate',
] as const

// Reorder-only writes bump `order`; excluded so drag-to-reorder is silent.
// createdBy/updatedBy/memberIds/timestamps are never notification-worthy.
const SCHEDULE_MEANINGFUL_FIELDS = [
  'title',
  'date',
  'description',
  'location',
  'startTime',
  'endTime',
  'category',
  'estimatedCostMinor',
] as const

// Wish vote toggles update `votes` + audit metadata and stay silent; content /
// cover changes notify.
const WISH_MEANINGFUL_FIELDS = [
  'category',
  'title',
  'description',
  'link',
  'address',
  'image',
] as const

// `completedBy` is the per-member checkbox state — deliberately NOT here, so
// ticking an item off produces no notification. Only content edits do.
const PLANNING_MEANINGFUL_FIELDS = [
  'title',
  'note',
  'category',
] as const

// Trip-root changes are split by push-worthiness. dates/destination push;
// title is inbox-only. Icon-only edits are deliberately silent. Everything else on the trip doc
// (lastActivityByFeature, updatedAt, memberIds, deletingAt, currency,
// coverImage) is silent.
const TRIP_DATE_FIELDS = ['startDate', 'endDate'] as const

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isMemberRole(value: unknown): value is 'owner' | 'editor' | 'viewer' {
  return value === 'owner' || value === 'editor' || value === 'viewer'
}

// Carries direction + amount straight from the trigger's own before/after
// doc into the notification inbox row (writeNotificationDocs) — avoids a
// second Firestore read of a settlement that may already be soft-deleted
// by the time dispatch.ts runs.
function settlementInfoOf(doc: Doc | undefined): NormalizedSettlementInfo | undefined {
  if (!doc) return undefined
  const { fromUid, toUid, amountMinor, currency } = doc
  if (!isString(fromUid) || !isString(toUid) || !isNonNegativeInteger(amountMinor) || !isString(currency)) return undefined
  return { fromUid, toUid, amountMinor, currency }
}

function isTombstoned(doc: Doc | null): boolean {
  return doc?.deletedAt != null
}

function normalizeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    return value.toMillis()
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeValue(item)]),
    )
  }
  return value
}

function equalField(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b))
}

function changedAny(before: Doc, after: Doc, fields: readonly string[]): boolean {
  return fields.some(field => !equalField(before[field], after[field]))
}

function candidateFields(doc: Doc | null, fields: readonly string[]): string[] {
  if (!doc) return []
  return fields.map(field => doc[field]).filter(isString)
}

export function resolveActorUid(
  auth: EventAuth | undefined,
  docs: readonly (Doc | null)[],
  fields: readonly string[],
): string | null {
  const candidates = docs.flatMap(doc => candidateFields(doc, fields))

  // Production Web SDK writes surface as api_key + authId(uid). Trust that
  // user context even when the actor is an owner deleting another user's
  // settlement. Admin/Worker writes do not use api_key, so they still fall
  // back to the rules-pinned document fields below.
  if (auth?.authId && auth.authType === 'api_key') return auth.authId
  if (auth?.authId && candidates.includes(auth.authId)) return auth.authId

  return candidates[0] ?? null
}

// Actor-required events (expense/booking/schedule/wish/planning/trip/settlement/
// member.joined): drop to [] when the actor can't be resolved rather than emit
// an anonymous "someone changed X". member.role_changed / member.removed are the
// only events that intentionally allow a null actor — they're built directly
// (they name the SUBJECT, not the actor) and never route through here.
function actorEvent(event: NormalizedPushEvent): NormalizedPushEvent[] {
  return event.actorUid ? [event] : []
}

export function normalizeExpenseWrite(input: {
  eventId: string
  tripId: string
  expenseId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, expenseId, auth, before, after } = input

  if (!before && after && !isTombstoned(after)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'expense',
      entityId: expenseId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['createdBy', 'updatedBy']),
      route: '/expense',
      templateKey: 'expense.created',
    })
  }

  if (before && after && !isTombstoned(before) && isTombstoned(after)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'expense',
      entityId: expenseId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'createdBy']),
      route: '/expense',
      templateKey: 'expense.deleted',
    })
  }

  if (before && after && !isTombstoned(before) && !isTombstoned(after) && changedAny(before, after, EXPENSE_MEANINGFUL_FIELDS)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'expense',
      entityId: expenseId,
      action: 'updated',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'createdBy']),
      route: '/expense',
      templateKey: 'expense.updated',
    })
  }

  return []
}

export function normalizeSettlementWrite(input: {
  eventId: string
  tripId: string
  settlementId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, settlementId, auth, before, after } = input
  const doc = after ?? before
  const partyUids = [doc?.fromUid, doc?.toUid].filter(isString)

  if (!before && after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'settlement',
      entityId: settlementId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['settledBy']),
      route: '/expense',
      templateKey: 'settlement.created',
      partyUids,
      settlement: settlementInfoOf(after),
    })
  }

  if (before && after && !isTombstoned(before) && isTombstoned(after)) {
    // Settlement cancel is now a soft-delete (Worker stamps deletedBy +
    // deletedAt instead of hard-deleting), so the canceller's uid IS
    // available here -- unlike the hard-delete fallback below, no
    // actorUnknown guess is needed.
    return actorEvent({
      eventId,
      tripId,
      entityType: 'settlement',
      entityId: settlementId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [after], ['deletedBy']),
      route: '/expense',
      templateKey: 'settlement.deleted',
      partyUids,
      settlement: settlementInfoOf(after),
    })
  }

  if (before && !after) {
    // Defensive fallback: settlement cancel is soft-delete now (see the
    // tombstone-transition branch above), so this hard-delete branch should
    // no longer fire in normal operation. Kept in case a future admin/manual
    // write hard-deletes a settlement doc directly. `before.settledBy` is
    // the RECORDER, NOT necessarily whoever performed the delete (could be
    // the trip owner removing someone else's settlement) -- so the actor is
    // unreliable here. Mark actorUnknown so selectRecipients notifies BOTH
    // parties rather than guessing wrong.
    return actorEvent({
      eventId,
      tripId,
      entityType: 'settlement',
      entityId: settlementId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [before], ['settledBy']),
      actorUnknown: true,
      route: '/expense',
      templateKey: 'settlement.deleted',
      partyUids,
      settlement: settlementInfoOf(before),
    })
  }

  return []
}

export function normalizeBookingWrite(input: {
  eventId: string
  tripId: string
  bookingId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, bookingId, auth, before, after } = input

  if (!before && after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'booking',
      entityId: bookingId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['createdBy', 'updatedBy']),
      route: '/bookings',
      templateKey: 'booking.created',
    })
  }

  if (before && !after) {
    // Bookings hard-delete (no deletedAt tombstone). Client swipe-delete
    // carries auth context, so the actor resolves from updatedBy/createdBy
    // without the actorUnknown dance settlement needs.
    return actorEvent({
      eventId,
      tripId,
      entityType: 'booking',
      entityId: bookingId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [before], ['updatedBy', 'createdBy']),
      route: '/bookings',
      templateKey: 'booking.deleted',
    })
  }

  if (before && after && changedAny(before, after, BOOKING_MEANINGFUL_FIELDS)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'booking',
      entityId: bookingId,
      action: 'updated',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'createdBy']),
      route: '/bookings',
      templateKey: 'booking.updated',
    })
  }

  return []
}

export function normalizeScheduleWrite(input: {
  eventId: string
  tripId: string
  scheduleId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, scheduleId, auth, before, after } = input

  if (!before && after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'schedule',
      entityId: scheduleId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['createdBy', 'updatedBy']),
      route: '/schedule',
      templateKey: 'schedule.created',
    })
  }

  if (before && !after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'schedule',
      entityId: scheduleId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [before], ['updatedBy', 'createdBy']),
      route: '/schedule',
      templateKey: 'schedule.deleted',
    })
  }

  if (before && after && changedAny(before, after, SCHEDULE_MEANINGFUL_FIELDS)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'schedule',
      entityId: scheduleId,
      action: 'updated',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'createdBy']),
      route: '/schedule',
      templateKey: 'schedule.updated',
    })
  }

  return []
}

export function normalizeWishWrite(input: {
  eventId: string
  tripId: string
  wishId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, wishId, auth, before, after } = input

  if (!before && after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'wish',
      entityId: wishId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['proposedBy', 'updatedBy']),
      route: '/wish',
      templateKey: 'wish.created',
    })
  }

  if (before && !after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'wish',
      entityId: wishId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [before], ['updatedBy', 'proposedBy']),
      route: '/wish',
      templateKey: 'wish.deleted',
    })
  }

  if (before && after && changedAny(before, after, WISH_MEANINGFUL_FIELDS)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'wish',
      entityId: wishId,
      action: 'updated',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'proposedBy']),
      route: '/wish',
      templateKey: 'wish.updated',
    })
  }

  // Vote toggles and audit/ACL-only updates are intentionally silent.
  return []
}

export function normalizePlanningWrite(input: {
  eventId: string
  tripId: string
  planItemId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, planItemId, auth, before, after } = input

  if (!before && after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'planning',
      entityId: planItemId,
      action: 'created',
      actorUid: resolveActorUid(auth, [after], ['createdBy', 'updatedBy']),
      route: '/planning',
      templateKey: 'planning.created',
    })
  }

  if (before && !after) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'planning',
      entityId: planItemId,
      action: 'deleted',
      actorUid: resolveActorUid(auth, [before], ['updatedBy', 'createdBy']),
      route: '/planning',
      templateKey: 'planning.deleted',
    })
  }

  // Content edit notifies. A `completedBy` toggle changes no meaningful
  // field, so it drops to [] and stays silent.
  if (before && after && changedAny(before, after, PLANNING_MEANINGFUL_FIELDS)) {
    return actorEvent({
      eventId,
      tripId,
      entityType: 'planning',
      entityId: planItemId,
      action: 'updated',
      actorUid: resolveActorUid(auth, [after, before], ['updatedBy', 'createdBy']),
      route: '/planning',
      templateKey: 'planning.updated',
    })
  }

  return []
}

export function normalizeTripRootWrite(input: {
  eventId: string
  tripId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, auth, before, after } = input
  // Only trip-doc UPDATES notify. Create (owner bootstrap) and delete
  // (cascade) are handled elsewhere / silent.
  if (!before || !after) return []

  // One notification per save, priority dates > destination > title. Icon-only
  // edits are deliberately silent, so a single edit that touches several fields
  // never fans out to 2-3 pushes.
  const base = {
    eventId,
    tripId,
    entityType: 'trip' as const,
    entityId: tripId,
    action: 'updated' as const,
    actorUid: resolveActorUid(auth, [after], []),
    route: '/schedule' as const,
  }

  if (changedAny(before, after, TRIP_DATE_FIELDS)) {
    return actorEvent({ ...base, templateKey: 'trip.dates_updated' })
  }
  if (!equalField(before.destination, after.destination)) {
    return actorEvent({ ...base, templateKey: 'trip.destination_updated' })
  }
  // Title is low-signal — inbox row only, no push. Icon-only edits are
  // decorative and fully silent.
  if (!equalField(before.title, after.title)) {
    return actorEvent({ ...base, templateKey: 'trip.title_updated', push: false })
  }

  return []
}

export function normalizeMemberWrite(input: {
  eventId: string
  tripId: string
  memberId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent[] {
  const { eventId, tripId, memberId, auth, before, after } = input

  // Join. Skip the owner bootstrap row created with the trip itself.
  if (!before && after) {
    if (after.role === 'owner') return []
    const actorUid = resolveActorUid(auth, [after], ['userId']) ?? (isString(after.userId) ? after.userId : memberId)
    return actorEvent({
      eventId,
      tripId,
      entityType: 'member',
      entityId: memberId,
      action: 'joined',
      actorUid,
      route: '/schedule',
      templateKey: 'member.joined',
    })
  }

  // Role change. Notifies only the affected member. The write is Worker/admin-
  // authored, so the actor (an owner) usually can't be resolved — we name the
  // SUBJECT instead, so a null actor is fine here.
  if (before && after) {
    if (before.role === after.role) return []
    const subjectUid = isString(after.userId) ? after.userId : memberId
    return [{
      eventId,
      tripId,
      entityType: 'member',
      entityId: memberId,
      action: 'role_changed',
      actorUid: resolveActorUid(auth, [after], []),
      actorUnknown: true,
      route: '/schedule',
      templateKey: 'member.role_changed',
      partyUids: [subjectUid],
      subjectUid,
      subjectName: isString(after.displayName) ? after.displayName : undefined,
      subjectRole: isMemberRole(after.role) ? after.role : undefined,
    }]
  }

  // Removal. The Worker stamps removalKind before deleting the member doc so
  // we can tell a kick apart from a voluntary leave:
  //   'removed' (owner kicked) → TWO notifications:
  //     1. trip-scoped → remaining members ("○○ was removed"). dispatch loads
  //        the post-strip memberIds and also drops subjectUid, so the removed
  //        person never gets this copy.
  //     2. account-scoped → the removed person ("you were removed"). They've
  //        lost trip access, so it routes to /account with a distinct eventId
  //        suffix so _pushEvents dedupe keeps both.
  //   'left' (self-leave) → ONE trip-scoped "○○ left" for remaining members;
  //        NO self-notification — the leaver chose to go.
  // A missing removalKind (legacy / trip-cascade delete) falls back to 'removed'
  // — trip-cascade deletes are suppressed by the deletingAt guard anyway.
  if (before && !after) {
    const subjectUid = isString(before.userId) ? before.userId : memberId
    const subjectName = isString(before.displayName) ? before.displayName : undefined
    const left = before.removalKind === 'left'
    // The Worker stamps removedBy = the acting caller. When present it's a
    // trusted actor → exclude it from the remaining-members fan-out (so a kick
    // never pushes the owner about their own action). Absent (legacy /
    // trip-cascade delete) → actorUnknown fallback notifies everyone remaining.
    const removedBy = isString(before.removedBy) ? before.removedBy : null
    const shared = {
      tripId,
      entityType: 'member' as const,
      entityId: memberId,
      action: 'removed' as const,
      actorUid: removedBy ?? resolveActorUid(auth, [before], []),
      actorUnknown: removedBy == null,
      subjectUid,
      subjectName,
    }
    const events: NormalizedPushEvent[] = [
      { ...shared, eventId, route: '/schedule', templateKey: left ? 'member.left' : 'member.removed' },
    ]
    if (!left) {
      events.push({
        ...shared,
        eventId: `${eventId}:self`,
        scope: 'account',
        partyUids: [subjectUid],
        route: '/account',
        templateKey: 'member.removed_self',
      })
    }
    return events
  }

  return []
}
