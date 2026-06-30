import { initializeApp } from 'firebase-admin/app'
import type { DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-functions/v2/firestore'
import {
  onDocumentCreatedWithAuthContext,
  onDocumentWrittenWithAuthContext,
} from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2/options'
import { REGION } from './model.js'
import { dispatchPushEvent } from './dispatch.js'
import {
  normalizeBookingWrite,
  normalizeExpenseWrite,
  normalizeMemberCreated,
  normalizeSettlementWrite,
} from './normalize.js'

initializeApp()

setGlobalOptions({
  region: REGION,
  maxInstances: 5,
  timeoutSeconds: 60,
  memory: '256MiB',
})

function dataOrNull(snap: DocumentSnapshot | QueryDocumentSnapshot | undefined): Record<string, unknown> | null {
  return snap?.exists ? snap.data() ?? null : null
}

function authOf(event: { authId?: string; authType?: string }) {
  return { authId: event.authId, authType: event.authType }
}

function retryingDocument<const Document extends string>(document: Document) {
  return { document, retry: true } as const
}

export const notifyExpenseWrite = onDocumentWrittenWithAuthContext(
  retryingDocument('trips/{tripId}/expenses/{expenseId}'),
  event => dispatchPushEvent(normalizeExpenseWrite({
    eventId:   event.id,
    tripId:    event.params.tripId,
    expenseId: event.params.expenseId,
    auth:      authOf(event),
    before:    dataOrNull(event.data?.before),
    after:     dataOrNull(event.data?.after),
  })),
)

export const notifySettlementWrite = onDocumentWrittenWithAuthContext(
  retryingDocument('trips/{tripId}/settlements/{settlementId}'),
  event => dispatchPushEvent(normalizeSettlementWrite({
    eventId:      event.id,
    tripId:       event.params.tripId,
    settlementId: event.params.settlementId,
    auth:         authOf(event),
    before:       dataOrNull(event.data?.before),
    after:        dataOrNull(event.data?.after),
  })),
)

export const notifyBookingWrite = onDocumentWrittenWithAuthContext(
  retryingDocument('trips/{tripId}/bookings/{bookingId}'),
  event => dispatchPushEvent(normalizeBookingWrite({
    eventId:   event.id,
    tripId:    event.params.tripId,
    bookingId: event.params.bookingId,
    auth:      authOf(event),
    before:    dataOrNull(event.data?.before),
    after:     dataOrNull(event.data?.after),
  })),
)

export const notifyMemberJoined = onDocumentCreatedWithAuthContext(
  retryingDocument('trips/{tripId}/members/{memberId}'),
  event => dispatchPushEvent(normalizeMemberCreated({
    eventId:  event.id,
    tripId:   event.params.tripId,
    memberId: event.params.memberId,
    auth:     authOf(event),
    after:    dataOrNull(event.data),
  })),
)
