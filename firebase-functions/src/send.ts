import { getMessaging } from 'firebase-admin/messaging'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { MAX_SEND_TOKENS, TEMPLATES, type NormalizedPushEvent } from './model.js'

export interface PushTokenRecord {
  uid: string
  tokenHash: string
  token: string
}

export interface SendResult {
  sentCount: number
  failedCount: number
  errorCodes: Record<string, number>
}

export function isRetryableSendErrorCode(code: string | undefined): boolean {
  return code === 'messaging/unavailable'
    || code === 'messaging/server-unavailable'
    || code === 'messaging/internal-error'
    || code === 'messaging/unknown-error'
}

export function hasRetryableSendError(errorCodes: Record<string, number>): boolean {
  return Object.entries(errorCodes).some(([code, count]) => count > 0 && isRetryableSendErrorCode(code))
}

export function chunk<T>(items: readonly T[], size = MAX_SEND_TOKENS): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function isInvalidTokenCode(code: string | undefined): boolean {
  return code === 'messaging/registration-token-not-registered'
    || code === 'messaging/invalid-registration-token'
    || code === 'messaging/invalid-argument'
}

function dataPayload(event: NormalizedPushEvent, targetUid: string): Record<string, string> {
  return {
    title:      'TripMate',
    body:       TEMPLATES[event.templateKey],
    url:        event.route,
    tag:        `${event.tripId}:${event.entityType}:${event.entityId}`,
    tripId:     event.tripId,
    entityType: event.entityType,
    entityId:   event.entityId,
    eventId:    event.eventId,
    targetUid,
  }
}

async function disableInvalidToken(record: PushTokenRecord): Promise<void> {
  await getFirestore()
    .doc(`users/${record.uid}/pushTokens/${record.tokenHash}`)
    .update({
      disabledAt:     FieldValue.serverTimestamp(),
      disabledReason: 'fcm-unregistered',
      updatedAt:      FieldValue.serverTimestamp(),
    })
}

export async function sendPush(event: NormalizedPushEvent, tokens: readonly PushTokenRecord[]): Promise<SendResult> {
  const errorCodes: Record<string, number> = {}
  let sentCount = 0
  let failedCount = 0
  const invalidTokens: PushTokenRecord[] = []

  for (const batch of chunk(tokens)) {
    const result = await getMessaging().sendEach(batch.map(record => ({
      token: record.token,
      data:  dataPayload(event, record.uid),
    })))

    sentCount += result.successCount
    failedCount += result.failureCount

    result.responses.forEach((response, index) => {
      if (response.success) return
      const code = response.error?.code ?? 'unknown'
      errorCodes[code] = (errorCodes[code] ?? 0) + 1
      const record = batch[index]
      if (record && isInvalidTokenCode(code)) invalidTokens.push(record)
    })
  }

  await Promise.allSettled(invalidTokens.map(disableInvalidToken))

  return { sentCount, failedCount, errorCodes }
}
