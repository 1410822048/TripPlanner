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

// Actor-based bodies: "○○さんが〜しました". Excludes settlement (custom
// direction/amount body) and the member-subject templates (role_changed /
// removed / removed_self name the SUBJECT, not the actor — which is often
// unresolvable on admin/Worker writes). TS enforces this map covers every
// remaining key.
type ActorTemplateKey = Exclude<
  NormalizedPushEvent['templateKey'],
  'settlement.created' | 'settlement.deleted' | MemberSubjectTemplateKey
>

const BODY_TEMPLATES: Record<ActorTemplateKey, (actorName: string) => string> = {
  'member.joined':            name => `${name}さんが旅程に参加しました`,
  'expense.created':          name => `${name}さんが費用を追加しました`,
  'expense.updated':          name => `${name}さんが費用を更新しました`,
  'expense.deleted':          name => `${name}さんが費用を削除しました`,
  'booking.created':          name => `${name}さんが予約を追加しました`,
  'booking.updated':          name => `${name}さんが予約を更新しました`,
  'booking.deleted':          name => `${name}さんが予約を削除しました`,
  'schedule.created':         name => `${name}さんが予定を追加しました`,
  'schedule.updated':         name => `${name}さんが予定を更新しました`,
  'schedule.deleted':         name => `${name}さんが予定を削除しました`,
  'wish.created':             name => `${name}さんが行きたい場所を追加しました`,
  'wish.updated':             name => `${name}さんが行きたい場所を更新しました`,
  'wish.deleted':             name => `${name}さんが行きたい場所を削除しました`,
  'planning.created':         name => `${name}さんが準備リストを追加しました`,
  'planning.updated':         name => `${name}さんが準備リストを更新しました`,
  'planning.deleted':         name => `${name}さんが準備リストを削除しました`,
  'trip.title_updated':       name => `${name}さんが旅程名を変更しました`,
  'trip.dates_updated':       name => `${name}さんが日程を変更しました`,
  'trip.destination_updated': name => `${name}さんが目的地を変更しました`,
}

const ROLE_LABEL: Record<'owner' | 'editor' | 'viewer', string> = {
  owner:  'オーナー',
  editor: '編集者',
  viewer: '閲覧者',
}

type MemberSubjectTemplateKey = 'member.role_changed' | 'member.removed' | 'member.removed_self' | 'member.left'

function isMemberSubjectTemplate(templateKey: NormalizedPushEvent['templateKey']): templateKey is MemberSubjectTemplateKey {
  return templateKey === 'member.role_changed'
    || templateKey === 'member.removed'
    || templateKey === 'member.removed_self'
    || templateKey === 'member.left'
}

// Subject-based bodies for member lifecycle. role_changed / removed_self are
// second-person (the recipient IS the subject); removed / left are third-person
// (the remaining members read who was removed / who left).
function memberSubjectBody(
  templateKey: MemberSubjectTemplateKey,
  subjectName: string | undefined,
  subjectRole: 'owner' | 'editor' | 'viewer' | undefined,
): string {
  const name = subjectName ?? FALLBACK_NAME
  switch (templateKey) {
    case 'member.role_changed':
      return subjectRole
        ? `あなたの権限が${ROLE_LABEL[subjectRole]}に変更されました`
        : 'あなたの権限が変更されました'
    case 'member.removed':
      return `${name}さんが旅程から削除されました`
    case 'member.removed_self':
      return '旅程から削除されました'
    case 'member.left':
      return `${name}さんが旅程から退出しました`
  }
}

async function actorDisplayName(tripId: string, actorUid: string | null): Promise<string> {
  return actorUid ? loadMemberName(tripId, actorUid) : FALLBACK_NAME
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
  // Passed by dispatch from the trip snapshot it already read for recipients —
  // avoids re-fetching trips/{tripId} just for the title. Undefined only on
  // direct (test) callers, which fall back to a fresh read.
  tripTitleFromCaller?: string,
): Promise<void> {
  if (recipientUids.length === 0) return

  const tripTitle = tripTitleFromCaller ?? await loadTripTitle(event.tripId)

  let body: string
  let settlementInfo: Record<string, unknown> | undefined
  let actorName = ''
  if (isSettlementTemplate(event.templateKey)) {
    actorName = await actorDisplayName(event.tripId, event.actorUid)
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
  } else if (isMemberSubjectTemplate(event.templateKey)) {
    // Subject-based (actor is usually null on admin/Worker member writes).
    body = memberSubjectBody(event.templateKey, event.subjectName, event.subjectRole)
    actorName = event.subjectName ?? FALLBACK_NAME
  } else {
    actorName = await actorDisplayName(event.tripId, event.actorUid)
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
          // 'account' rows survive the client's trip-scoped inbox query (a
          // removed member no longer has the trip in accessibleTripIds).
          scope:         event.scope ?? 'trip',
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
