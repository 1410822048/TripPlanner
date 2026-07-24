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

const FALLBACK_NAME = '成員'

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

// Actor-based bodies: "○○ 新增了〜". Excludes settlement (custom
// direction/amount body), the member-subject templates (role_changed /
// removed / removed_self name the SUBJECT, not the actor — which is often
// unresolvable on admin/Worker writes), and system templates (no actor at
// all — Worker-cron-triggered). TS enforces this map covers every
// remaining key.
type ActorTemplateKey = Exclude<
  NormalizedPushEvent['templateKey'],
  'settlement.created' | 'settlement.deleted' | MemberSubjectTemplateKey | SystemTemplateKey
>

// Worker-cron-triggered, no actor and no per-recipient variation — a single
// fixed copy for every recipient. Currently just the Wish voting deadline
// closing; TS enforces SYSTEM_BODY covers every key in this union.
type SystemTemplateKey = 'wish.deadline_closed'

const SYSTEM_BODY: Record<SystemTemplateKey, string> = {
  'wish.deadline_closed': '心願投票已截止，來看看結果吧',
}

function isSystemTemplate(templateKey: NormalizedPushEvent['templateKey']): templateKey is SystemTemplateKey {
  return templateKey === 'wish.deadline_closed'
}

const BODY_TEMPLATES: Record<ActorTemplateKey, (actorName: string) => string> = {
  'member.joined':            name => `${name} 加入了行程`,
  'expense.created':          name => `${name} 新增了費用`,
  'expense.updated':          name => `${name} 更新了費用`,
  'expense.deleted':          name => `${name} 刪除了費用`,
  'booking.created':          name => `${name} 新增了訂單`,
  'booking.updated':          name => `${name} 更新了訂單`,
  'booking.deleted':          name => `${name} 刪除了訂單`,
  'schedule.created':         name => `${name} 新增了行程`,
  'schedule.updated':         name => `${name} 更新了行程`,
  'schedule.deleted':         name => `${name} 刪除了行程`,
  'route.optimized':          name => `${name} 已整理行程順序`,
  'wish.created':             name => `${name} 新增了心願`,
  'wish.updated':             name => `${name} 更新了心願`,
  'wish.deleted':             name => `${name} 刪除了心願`,
  'planning.created':         name => `${name} 新增了準備項目`,
  'planning.updated':         name => `${name} 更新了準備項目`,
  'planning.deleted':         name => `${name} 刪除了準備項目`,
  'trip.title_updated':       name => `${name} 變更了行程名稱`,
  'trip.dates_updated':       name => `${name} 變更了日期`,
  'trip.destination_updated': name => `${name} 變更了目的地`,
}

const ROLE_LABEL: Record<'owner' | 'editor' | 'viewer', string> = {
  owner:  '擁有者',
  editor: '編輯者',
  viewer: '檢視者',
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
        ? `你的權限已變更為${ROLE_LABEL[subjectRole]}`
        : '你的權限已變更'
    case 'member.removed':
      return `${name} 已被移出行程`
    case 'member.removed_self':
      return '你已被移出行程'
    case 'member.left':
      return `${name} 已退出行程`
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
  const verb = action === 'deleted' ? '取消了' : '記錄了'
  return `${actorName} ${verb} ${fromName} → ${toName} 的 ${formatMoney(amountMinor, currency)}`
}

function settlementFallbackBody(actorName: string, action: PushAction): string {
  const verb = action === 'deleted' ? '取消了' : '記錄了'
  return `${actorName} ${verb}一筆清算`
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
  } else if (isSystemTemplate(event.templateKey)) {
    // Fixed copy, no actor to resolve — Worker-cron-triggered.
    body = SYSTEM_BODY[event.templateKey]
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
