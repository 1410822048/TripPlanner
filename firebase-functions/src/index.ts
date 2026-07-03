import { initializeApp } from 'firebase-admin/app'
import type { DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-functions/v2/firestore'
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2/options'
import { REGION, type EventAuth, type NormalizedPushEvent } from './model.js'
import { dispatchPushEvent } from './dispatch.js'
import {
  normalizeBookingWrite,
  normalizeExpenseWrite,
  normalizeMemberWrite,
  normalizePlanningWrite,
  normalizeScheduleWrite,
  normalizeSettlementWrite,
  normalizeTripRootWrite,
  normalizeWishWrite,
} from './normalize.js'

initializeApp()

setGlobalOptions({
  region: REGION,
  maxInstances: 5,
  timeoutSeconds: 60,
  memory: '256MiB',
})

type Doc = Record<string, unknown>

function dataOrNull(snap: DocumentSnapshot | QueryDocumentSnapshot | undefined): Doc | null {
  return snap?.exists ? snap.data() ?? null : null
}

function authOf(event: { authId?: string; authType?: string }): EventAuth {
  return { authId: event.authId, authType: event.authType }
}

function retryingDocument<const Document extends string>(document: Document) {
  return { document, retry: true } as const
}

// One Firestore write can normalize to more than one notification (member
// removal → the removed person + the remaining members), so every trigger
// fans the array out to dispatch. Each event carries its own eventId, so the
// `_pushEvents` dedupe/lease stays per-notification.
async function dispatchAll(events: NormalizedPushEvent[]): Promise<void> {
  await Promise.all(events.map(dispatchPushEvent))
}

interface ChildInput {
  eventId: string
  tripId: string
  docId: string
  auth?: EventAuth
  before: Doc | null
  after: Doc | null
}

// Single wildcard trigger over every trip subcollection. `collectionId`
// routes to the matching normalizer; anything not listed (invites,
// uploadIntents, future collections) is an explicit no-op, not a fallback.
function normalizeChildWrite(collectionId: string, { docId, ...rest }: ChildInput): NormalizedPushEvent[] {
  switch (collectionId) {
    case 'expenses':    return normalizeExpenseWrite({ ...rest, expenseId: docId })
    case 'settlements': return normalizeSettlementWrite({ ...rest, settlementId: docId })
    case 'bookings':    return normalizeBookingWrite({ ...rest, bookingId: docId })
    case 'schedules':   return normalizeScheduleWrite({ ...rest, scheduleId: docId })
    case 'wishes':      return normalizeWishWrite({ ...rest, wishId: docId })
    case 'planning':    return normalizePlanningWrite({ ...rest, planItemId: docId })
    case 'members':     return normalizeMemberWrite({ ...rest, memberId: docId })
    default:            return []
  }
}

export const notifyTripRootWrite = onDocumentWrittenWithAuthContext(
  retryingDocument('trips/{tripId}'),
  event => dispatchAll(normalizeTripRootWrite({
    eventId: event.id,
    tripId:  event.params.tripId,
    auth:    authOf(event),
    before:  dataOrNull(event.data?.before),
    after:   dataOrNull(event.data?.after),
  })),
)

export const notifyTripChildWrite = onDocumentWrittenWithAuthContext(
  retryingDocument('trips/{tripId}/{collectionId}/{docId}'),
  event => dispatchAll(normalizeChildWrite(event.params.collectionId, {
    eventId: event.id,
    tripId:  event.params.tripId,
    docId:   event.params.docId,
    auth:    authOf(event),
    before:  dataOrNull(event.data?.before),
    after:   dataOrNull(event.data?.after),
  })),
)
