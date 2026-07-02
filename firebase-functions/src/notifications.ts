// firebase-functions/src/notifications.ts
// Persistent notification inbox (P2) — one doc per recipient per event,
// written alongside (before) the FCM send in dispatch.ts. Unlike push
// tokens/delivery, this doc exists for EVERY recipient regardless of
// whether they have push enabled — the inbox is the durable record,
// FCM is just the "you're not looking at the app" nudge.
//
// Read-only from the client except toggling readAt (see firestore.rules
// users/{uid}/notifications). This is the one deliberate exception to
// P1's "no second unread state" rule — scoped to the inbox bell only,
// the tab red dots still run on lastActivityByFeature untouched.
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { TEMPLATES, type NormalizedPushEvent, type PushAction } from './model.js'

/** How long a notification stays in the inbox before Firestore TTL drops
 *  it. Enforced by a TTL policy on this field (see
 *  docs/runbooks/firestore-ttl-notifications.md) — NOT by app code. */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 3600 * 1000

/** Firestore writes cap at 500 ops per transaction. Keep each recipient
 *  chunk under that cap while preserving create-only retry semantics. */
const MAX_BATCH_WRITES = 500

const FALLBACK_NAME = 'メンバー'

async function loadMemberName(tripId: string, uid: string): Promise<string> {
  const snap = await getFirestore().doc(`trips/${tripId}/members/${uid}`).get()
  const displayName = snap.get('displayName')
  return typeof displayName === 'string' && displayName.length > 0 ? displayName : FALLBACK_NAME
}

async function loadTripTitle(tripId: string): Promise<string> {
  const snap = await getFirestore().doc(`trips/${tripId}`).get()
  const title = snap.get('title')
  return typeof title === 'string' ? title : ''
}

// Firebase Functions deploys only the firebase-functions/ source directory
// (Cloud Build's context can't reach ../packages/fx-core), so this can't
// depend on @tripmate/fx-core the way the client/Worker do. Keep this table
// in lock-step with packages/fx-core: persisted amountMinor values for TWD /
// IDR are app-minor-units, not ISO cents.
const FRACTION_DIGITS: Record<string, number> = {
  JPY: 0, TWD: 0, KRW: 0, VND: 0, IDR: 0,
  USD: 2, EUR: 2, CNY: 2, HKD: 2, THB: 2,
  SGD: 2, GBP: 2, AUD: 2, PHP: 2, MYR: 2,
}

function currencyFractionDigits(code: string): number {
  return FRACTION_DIGITS[code] ?? 2
}

function formatMoney(amountMinor: number, currency: string): string {
  const digits = currencyFractionDigits(currency)
  const amount = amountMinor / 10 ** digits
  const formatted = amount.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return currency === 'JPY' ? `¥${formatted}` : `${currency} ${formatted}`
}

const BODY_TEMPLATES: Record<Exclude<NormalizedPushEvent['templateKey'], 'settlement.created' | 'settlement.deleted'>, (actorName: string) => string> = {
  'member.joined':   name => `${name}さんが旅程に参加しました`,
  'expense.created': name => `${name}さんが費用を追加しました`,
  'expense.updated': name => `${name}さんが費用を更新しました`,
  'expense.deleted': name => `${name}さんが費用を削除しました`,
  'booking.created': name => `${name}さんが予約を追加しました`,
  'booking.updated': name => `${name}さんが予約を更新しました`,
}

function settlementBody(
  actorName: string,
  action: PushAction,
  fromName: string,
  toName: string,
  amountMinor: number,
  currency: string,
): string {
  const verb = action === 'deleted' ? '取り消しました' : '記録しました'
  return `${actorName}さんが ${fromName}さん → ${toName}さん の ${formatMoney(amountMinor, currency)} を${verb}`
}

function settlementFallbackBody(actorName: string, action: PushAction): string {
  const verb = action === 'deleted' ? '取り消しました' : '記録しました'
  return `${actorName}さんが清算記録を${verb}`
}

function isSettlementTemplate(templateKey: NormalizedPushEvent['templateKey']): templateKey is 'settlement.created' | 'settlement.deleted' {
  return templateKey === 'settlement.created' || templateKey === 'settlement.deleted'
}

export async function writeNotificationDocs(
  event: NormalizedPushEvent,
  recipientUids: readonly string[],
): Promise<void> {
  if (recipientUids.length === 0) return

  const [tripTitle, actorName] = await Promise.all([
    loadTripTitle(event.tripId),
    loadMemberName(event.tripId, event.actorUid),
  ])

  let body: string
  let settlementInfo: Record<string, unknown> | undefined
  if (isSettlementTemplate(event.templateKey)) {
    if (!event.settlement) {
      body = settlementFallbackBody(actorName, event.action)
    } else {
      const [fromName, toName] = await Promise.all([
        loadMemberName(event.tripId, event.settlement.fromUid),
        loadMemberName(event.tripId, event.settlement.toUid),
      ])
      body = settlementBody(actorName, event.action, fromName, toName, event.settlement.amountMinor, event.settlement.currency)
      settlementInfo = {
        fromUid:     event.settlement.fromUid,
        fromName,
        toUid:       event.settlement.toUid,
        toName,
        amountMinor: event.settlement.amountMinor,
        currency:    event.settlement.currency,
      }
    }
  } else {
    body = BODY_TEMPLATES[event.templateKey](actorName)
  }

  const expiresAt = Timestamp.fromMillis(Date.now() + NOTIFICATION_RETENTION_MS)
  const db = getFirestore()

  // dispatchPushEvent can re-run this on a platform retry. Use a transaction
  // + create-only writes so a concurrent retry can never overwrite readAt:null
  // over a doc the recipient already opened between attempts.
  for (let i = 0; i < recipientUids.length; i += MAX_BATCH_WRITES) {
    const recipientChunk = recipientUids.slice(i, i + MAX_BATCH_WRITES)
    const refs = recipientChunk.map(uid => db.doc(`users/${uid}/notifications/${event.eventId}`))

    await db.runTransaction(async tx => {
      const existing = await Promise.all(refs.map(ref => tx.get(ref)))
      existing.forEach((snap, index) => {
        if (snap.exists) return
        const uid = recipientChunk[index]!
        tx.create(refs[index]!, {
          recipientUid:  uid,
          tripId:        event.tripId,
          tripTitle,
          entityType:    event.entityType,
          entityId:      event.entityId,
          action:        event.action,
          actorUid:      event.actorUid,
          actorName,
          title:         TEMPLATES[event.templateKey],
          body,
          route:         event.route,
          ...(settlementInfo ? { settlement: settlementInfo } : {}),
          createdAt:     FieldValue.serverTimestamp(),
          readAt:        null,
          dismissedAt:   null,
          expiresAt,
        })
      })
    })
  }
}
