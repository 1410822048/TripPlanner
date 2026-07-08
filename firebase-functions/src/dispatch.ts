import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as logger from 'firebase-functions/logger'
import { hasRetryableSendError, sendPush, type PushTokenRecord, type SendResult } from './send.js'
import { writeNotificationDocs } from './notifications.js'
import type { NormalizedPushEvent } from './model.js'

type DedupeStatus = 'pending' | 'sent' | 'partial' | 'failed'
// Three-way reservation outcome. The load-bearing split is 'done' vs 'held':
//   'done' → terminally handled (sent/partial) or attempt-capped; safe to
//            report success, nothing left to deliver.
//   'held' → another invocation owns a still-valid lease on a pending event;
//            the outcome is UNDECIDED, so the caller must throw (defer to a
//            backoff retry), NOT report success. A success here ends the
//            platform retry chain — and if the lease-holder was killed
//            mid-send (fn timeout) the lease expires with nobody left to take
//            over, silently losing the notification.
//   'reserve' → claimable now (absent doc, stale lease, non-terminal failure).
export type ReservationDecision = 'reserve' | 'done' | 'held'
export const DISPATCH_LEASE_MS = 10 * 60 * 1000
export const MAX_DISPATCH_ATTEMPTS = 3
export const MAX_TOKENS_PER_USER = 20

interface ExistingPushEventState {
  status?: unknown
  attempt?: unknown
  leaseExpiresAt?: unknown
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

function finalStatus(sentCount: number, failedCount: number): DedupeStatus {
  if (failedCount === 0) return 'sent'
  return sentCount > 0 ? 'partial' : 'failed'
}

export function shouldRetrySendResult(result: SendResult): boolean {
  return result.sentCount === 0
    && result.failedCount > 0
    && hasRetryableSendError(result.errorCodes)
}

class RetryablePushSendError extends Error {
  constructor(errorCodes: Record<string, number>) {
    super(`Retryable FCM send failure: ${Object.keys(errorCodes).join(', ')}`)
    this.name = 'RetryablePushSendError'
  }
}

function valueToMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    const ms = value.toMillis()
    return typeof ms === 'number' ? ms : null
  }
  return null
}

function attemptOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

export function reservationDecision(state: ExistingPushEventState, nowMs: number): ReservationDecision {
  if (state.status === 'sent' || state.status === 'partial') return 'done'
  if (attemptOf(state.attempt) >= MAX_DISPATCH_ATTEMPTS) return 'done'
  if (state.status !== 'pending') return 'reserve'

  const leaseExpiresAtMs = valueToMillis(state.leaseExpiresAt)
  return leaseExpiresAtMs == null || leaseExpiresAtMs <= nowMs ? 'reserve' : 'held'
}

async function reservePushEvent(event: NormalizedPushEvent): Promise<ReservationDecision> {
  const db = getFirestore()
  const ref = db.doc(`_pushEvents/${event.eventId}`)
  const nowMs = Date.now()
  const leaseExpiresAt = Timestamp.fromMillis(nowMs + DISPATCH_LEASE_MS)

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      const existing = snap.data() ?? {}
      const decision = reservationDecision(existing, nowMs)
      if (decision !== 'reserve') return decision

      tx.set(ref, {
        status:     'pending',
        attempt:    attemptOf(existing.attempt) + 1,
        updatedAt:  FieldValue.serverTimestamp(),
        leaseExpiresAt,
        lastError:  FieldValue.delete(),
        errorCodes: FieldValue.delete(),
      }, { merge: true })
      return 'reserve'
    }

    tx.create(ref, {
      eventId:       event.eventId,
      tripId:        event.tripId,
      entityType:    event.entityType,
      entityId:      event.entityId,
      action:        event.action,
      actorUid:      event.actorUid,
      recipientUids: [],
      createdAt:     FieldValue.serverTimestamp(),
      status:        'pending',
      attempt:       1,
      leaseExpiresAt,
      sentCount:     0,
      failedCount:   0,
    })
    return 'reserve'
  })
}

async function updateEvent(eventId: string, patch: Record<string, unknown>): Promise<void> {
  await getFirestore().doc(`_pushEvents/${eventId}`).set({
    ...patch,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message.slice(0, 500)
    : String(err).slice(0, 500)
}

interface TripRecipientState {
  // True once the /cascade-trip-delete Worker has stamped deletingAt (or the
  // trip doc is already gone). While a trip is tearing down, its subcollection
  // + member deletes each fire this trigger — suppress them all so one trip
  // deletion never spams every member with dozens of ".deleted" notifications.
  deleting: boolean
  memberIds: string[]
  // Read from the same trip snapshot so writeNotificationDocs doesn't re-fetch
  // trips/{tripId} just for the inbox title. '' when the trip is deleting/gone
  // (recipients are then empty, so it's unused) or — degenerately — a live trip
  // whose title field is missing/non-string. TripDocSchema requires title, so
  // real trips always carry one; a '' here only yields a blank inbox label,
  // exactly as the prior per-doc loadTripTitle already did for the same input.
  title: string
}

async function loadTripRecipientState(tripId: string): Promise<TripRecipientState> {
  const snap = await getFirestore().doc(`trips/${tripId}`).get()
  if (!snap.exists || snap.get('deletingAt') != null) return { deleting: true, memberIds: [], title: '' }
  const memberIds = snap.get('memberIds')
  const title = snap.get('title')
  return {
    deleting: false,
    memberIds: Array.isArray(memberIds) ? memberIds.filter((uid): uid is string => typeof uid === 'string') : [],
    title: typeof title === 'string' ? title : '',
  }
}

// Pick who to notify. Normally the actor is excluded (you don't get pushed
// for your own action). But when the actor can't be reliably resolved
// (`actorUnknown` — e.g. a settlement HARD-delete, whose `before.settledBy`
// is the RECORDER, not the deleter that lives on the Worker side), excluding
// the best-guess actor would silence the very party who should be told and
// could even push the real deleter. In that case notify all candidates —
// a redundant push to the actor beats a missing one to the right party.
export function selectRecipients(
  candidates: readonly string[],
  actorUid: string | null,
  actorUnknown: boolean,
  includeActor = false,
): string[] {
  const deduped = unique(candidates)
  // A null actor (admin/Worker write with no resolvable author) is treated
  // exactly like actorUnknown: nobody is excluded, since excluding a
  // best-guess actor could silence the very party who should be told.
  return actorUnknown || actorUid == null || includeActor ? deduped : deduped.filter(uid => uid !== actorUid)
}

// Pure recipient resolution given the trip state + the event. Exported for
// testing; the live path is candidateRecipients (loadTripRecipientState + this,
// which also reuses the same snapshot's title for the inbox docs).
export function resolveRecipients(
  trip: TripRecipientState,
  event: Pick<NormalizedPushEvent, 'partyUids' | 'actorUid' | 'actorUnknown' | 'subjectUid' | 'includeActor'>,
): string[] {
  // Trip teardown suppresses everything, trip- AND account-scoped.
  if (trip.deleting) return []

  // Explicit partyUids (settlement parties, role-change subject, account-scope
  // target) are the recipient set as-is — don't second-guess them.
  if (event.partyUids?.length) {
    return selectRecipients(event.partyUids, event.actorUid, event.actorUnknown ?? false, event.includeActor ?? false)
  }

  const selected = selectRecipients(trip.memberIds, event.actorUid, event.actorUnknown ?? false, event.includeActor ?? false)
  // Trip-scoped member removal loads the (post-strip) member list; drop the
  // removed person so they never get the "○○ was removed" copy — they receive
  // the account-scoped member.removed_self notification instead. subjectUid is
  // only ever set on member.* events, so this is a no-op elsewhere.
  return event.subjectUid ? selected.filter(uid => uid !== event.subjectUid) : selected
}

async function candidateRecipients(event: NormalizedPushEvent): Promise<{ recipientUids: string[]; tripTitle: string }> {
  const trip = await loadTripRecipientState(event.tripId)
  return { recipientUids: resolveRecipients(trip, event), tripTitle: trip.title }
}

export function selectPushRecipients(
  event: Pick<NormalizedPushEvent, 'actorUid' | 'pushActor'>,
  recipientUids: readonly string[],
): string[] {
  if (event.pushActor === false && event.actorUid != null) {
    return recipientUids.filter(uid => uid !== event.actorUid)
  }
  return [...recipientUids]
}

export async function loadEnabledTokens(uid: string): Promise<PushTokenRecord[]> {
  const snap = await getFirestore()
    .collection(`users/${uid}/pushTokens`)
    .where('disabledAt', '==', null)
    .orderBy('lastSeenAt', 'desc')
    .limit(MAX_TOKENS_PER_USER)
    .get()

  return snap.docs.flatMap(doc => {
    const token = doc.get('token')
    return typeof token === 'string' && token.length > 20
      ? [{ uid, tokenHash: doc.id, token }]
      : []
  })
}

async function loadTokens(recipientUids: readonly string[]): Promise<PushTokenRecord[]> {
  const nested = await Promise.all(recipientUids.map(loadEnabledTokens))
  return nested.flat()
}

export async function dispatchPushEvent(event: NormalizedPushEvent | null): Promise<void> {
  if (!event) return

  const decision = await reservePushEvent(event)
  if (decision === 'done') {
    logger.info('push event reservation skipped (already handled)', { eventId: event.eventId })
    return
  }
  if (decision === 'held') {
    // Another invocation owns a live lease. Defer to a platform retry rather
    // than returning success: a success would end the retry chain, and if the
    // lease-holder died mid-dispatch the lease would expire with nobody left
    // to take over (notification silently lost). The throw doesn't bump
    // `attempt` — only an actual reserve does — so this backs off harmlessly
    // until the holder finishes or its lease expires and a retry takes over.
    logger.info('push event held by an active lease; deferring to retry', { eventId: event.eventId })
    throw new Error(`push event ${event.eventId} is held by an active lease`)
  }

  try {
    const { recipientUids, tripTitle } = await candidateRecipients(event)
    await updateEvent(event.eventId, { recipientUids })

    // Inbox row exists for every recipient regardless of push-token state —
    // written before the FCM send so a signed-in-but-push-disabled member
    // still sees it. Uses the same lease/retry as the send below: if this
    // throws, dispatchPushEvent's catch marks the event failed and a
    // platform retry re-runs the whole reservation. writeNotificationDocs
    // uses transaction create-only writes, so a retry never re-writes (and
    // can't clobber readAt on) a doc the recipient already opened between
    // attempts.
    await writeNotificationDocs(event, recipientUids, tripTitle)

    // Inbox-only events (currently trip title updates): the durable row is
    // written above, but we skip token load + FCM entirely — no push nudge.
    if (event.push === false) {
      await updateEvent(event.eventId, {
        status:         'sent',
        sentCount:      0,
        failedCount:    0,
        leaseExpiresAt: FieldValue.delete(),
        lastError:      FieldValue.delete(),
        errorCodes:     FieldValue.delete(),
      })
      return
    }

    const pushRecipientUids = selectPushRecipients(event, recipientUids)
    const tokens = await loadTokens(pushRecipientUids)
    if (tokens.length === 0) {
      await updateEvent(event.eventId, {
        status:         'sent',
        sentCount:      0,
        failedCount:    0,
        leaseExpiresAt: FieldValue.delete(),
        lastError:      FieldValue.delete(),
        errorCodes:     FieldValue.delete(),
      })
      return
    }

    const result = await sendPush(event, tokens)
    const retryableFailure = shouldRetrySendResult(result)
    await updateEvent(event.eventId, {
      status: finalStatus(result.sentCount, result.failedCount),
      sentCount: result.sentCount,
      failedCount: result.failedCount,
      errorCodes: result.errorCodes,
      lastError: retryableFailure
        ? 'All FCM sends failed with a retryable error'
        : FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    })
    if (retryableFailure) throw new RetryablePushSendError(result.errorCodes)
  } catch (err) {
    logger.error('push dispatch failed', { eventId: event.eventId, err })
    if (err instanceof RetryablePushSendError) throw err
    await updateEvent(event.eventId, {
      status: 'failed',
      errorCodes: { dispatch: 1 },
      lastError: errorMessage(err),
      leaseExpiresAt: FieldValue.delete(),
    }).catch(updateErr => {
      logger.error('push dispatch failure status update failed', { eventId: event.eventId, updateErr })
    })
    throw err
  }
}
