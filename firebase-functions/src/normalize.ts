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

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
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

function makeEvent(input: Omit<NormalizedPushEvent, 'actorUid'> & { actorUid: string | null }): NormalizedPushEvent | null {
  if (!input.actorUid) return null
  return { ...input, actorUid: input.actorUid }
}

export function normalizeExpenseWrite(input: {
  eventId: string
  tripId: string
  expenseId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent | null {
  const { eventId, tripId, expenseId, auth, before, after } = input

  if (!before && after && !isTombstoned(after)) {
    return makeEvent({
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
    return makeEvent({
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
    return makeEvent({
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

  return null
}

export function normalizeSettlementWrite(input: {
  eventId: string
  tripId: string
  settlementId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent | null {
  const { eventId, tripId, settlementId, auth, before, after } = input
  const doc = after ?? before
  const partyUids = [doc?.fromUid, doc?.toUid].filter(isString)

  if (!before && after) {
    return makeEvent({
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
    return makeEvent({
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
    return makeEvent({
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

  return null
}

export function normalizeBookingWrite(input: {
  eventId: string
  tripId: string
  bookingId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}): NormalizedPushEvent | null {
  const { eventId, tripId, bookingId, auth, before, after } = input

  if (!before && after) {
    return makeEvent({
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

  if (before && after && changedAny(before, after, BOOKING_MEANINGFUL_FIELDS)) {
    return makeEvent({
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

  return null
}

export function normalizeMemberCreated(input: {
  eventId: string
  tripId: string
  memberId: string
  auth?: EventAuth
  after: Doc | null
}): NormalizedPushEvent | null {
  const { eventId, tripId, memberId, auth, after } = input
  if (!after || after.role === 'owner') return null

  const actorUid = resolveActorUid(auth, [after], ['userId']) ?? (isString(after.userId) ? after.userId : memberId)
  return makeEvent({
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
