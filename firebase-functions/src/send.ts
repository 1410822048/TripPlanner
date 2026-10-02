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

export interface SendBatchResult extends SendResult {
  /** 僅含成功或永久失敗的裝置；暫時失敗留待重試。 */
  completedTokens: PushTokenRecord[]
  terminalFailedCount: number
}

export function pushTokenKey(record: Pick<PushTokenRecord, 'uid' | 'tokenHash'>): string {
  return JSON.stringify([record.uid, record.tokenHash])
}

export function isRetryableSendErrorCode(code: string | undefined): boolean {
  return code === 'messaging/unavailable'
    || code === 'messaging/server-unavailable'
    || code === 'messaging/internal-error'
    || code === 'messaging/unknown-error'
    || code === 'messaging/quota-exceeded'
    || code === 'messaging/message-rate-exceeded'
    || code === 'messaging/device-message-rate-exceeded'
    || code === 'messaging/topics-message-rate-exceeded'
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
  // invalid-argument 也可能是 payload 錯誤，不足以判定裝置失效。
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

export async function sendPush(
  event: NormalizedPushEvent,
  tokens: readonly PushTokenRecord[],
  onBatch?: (result: SendBatchResult) => Promise<void>,
): Promise<SendResult> {
  const errorCodes: Record<string, number> = {}
  let sentCount = 0
  let failedCount = 0

  for (const batch of chunk(tokens)) {
    const result = await getMessaging().sendEach(batch.map(record => ({
      token: record.token,
      data:  dataPayload(event, record.uid),
    })))

    sentCount += result.successCount
    failedCount += result.failureCount

    const completedTokens: PushTokenRecord[] = []
    const invalidTokens: PushTokenRecord[] = []
    const batchErrors: Record<string, number> = {}
    let terminalFailedCount = 0
    result.responses.forEach((response, index) => {
      const record = batch[index]!
      if (response.success) { completedTokens.push(record); return }
      const code = response.error?.code ?? 'unknown'
      errorCodes[code] = (errorCodes[code] ?? 0) + 1
      batchErrors[code] = (batchErrors[code] ?? 0) + 1
      if (!isRetryableSendErrorCode(code)) {
        completedTokens.push(record)
        terminalFailedCount++
      }
      if (isInvalidTokenCode(code)) invalidTokens.push(record)
    })
    await Promise.allSettled(invalidTokens.map(disableInvalidToken))
    // 每批落盤：後續批次中斷仍不重送已完成的裝置；不持久化原始 token。
    await onBatch?.({
      sentCount: result.successCount, failedCount: result.failureCount,
      errorCodes: batchErrors, completedTokens, terminalFailedCount,
    })
  }

  return { sentCount, failedCount, errorCodes }
}
