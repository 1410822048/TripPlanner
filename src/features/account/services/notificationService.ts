// src/features/account/services/notificationService.ts
// Persistent notification inbox: server-written rows, client can only
// read its own rows and mark readAt. Queries are access-aware so stale
// rows from departed/deleted trips cannot consume the 50-row inbox window.
import type { QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore'
import { getFirebase, type FirebaseBundle } from '@/services/firebase'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { NotificationDocSchema, type Notification } from '@/types/notification'

const LIST_LIMIT = 50
const FIRESTORE_IN_LIMIT = 30

function notificationFromDoc(d: QueryDocumentSnapshot): Notification {
  return firestoreDocFromSchema(NotificationDocSchema, d, 'notificationFromDoc')
}

function normaliseTripIds(tripIds: readonly string[]): string[] {
  return [...new Set(tripIds.filter(Boolean))].sort()
}

export function notificationTripIdsKey(tripIds: readonly string[]): string {
  return normaliseTripIds(tripIds).join(',')
}

export function notificationTripIdsFromKey(key: string): string[] {
  return key ? key.split(',') : []
}

function tripIdChunks(tripIds: readonly string[]): string[][] {
  const ids = normaliseTripIds(tripIds)
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += FIRESTORE_IN_LIMIT) {
    chunks.push(ids.slice(i, i + FIRESTORE_IN_LIMIT))
  }
  return chunks
}

function mergeNotifications(pages: Iterable<Notification[]>): Notification[] {
  const byId = new Map<string, Notification>()
  for (const page of pages) {
    for (const n of page) byId.set(n.id, n)
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    .slice(0, LIST_LIMIT)
}

function notificationQuery(fb: FirebaseBundle, uid: string, tripIdChunk: readonly string[]) {
  return fb.query(
    fb.collection(fb.db, 'users', uid, 'notifications'),
    // Soft-dismissed rows are filtered server-side so they never consume the
    // 50-row window — same window-hygiene motivation as the trip-access scope.
    fb.where('dismissedAt', '==', null),
    fb.where('tripId', 'in', [...tripIdChunk]),
    fb.orderBy('createdAt', 'desc'),
    fb.limit(LIST_LIMIT),
  )
}

function notificationsFromSnapshot(snap: QuerySnapshot): Notification[] {
  return parseListSnapshot(snap, notificationFromDoc)
}

export async function getNotifications(uid: string, tripIds: readonly string[]): Promise<Notification[]> {
  const chunks = tripIdChunks(tripIds)
  if (chunks.length === 0) return []

  const fb = await getFirebase()
  const pages = await Promise.all(
    chunks.map(async chunk => notificationsFromSnapshot(await fb.getDocs(notificationQuery(fb, uid, chunk)))),
  )
  return mergeNotifications(pages)
}

export const subscribeToNotifications = (
  uid: string,
  tripIds: readonly string[],
  onData: (data: Notification[]) => void,
  onError: (e: Error) => void,
) => getFirebase().then(fb => {
  const chunks = tripIdChunks(tripIds)
  if (chunks.length === 0) {
    onData([])
    return () => {}
  }

  const pages = new Map<number, Notification[]>()
  const readyChunks = new Set<number>()
  const publish = () => {
    if (readyChunks.size !== chunks.length) return
    onData(mergeNotifications(pages.values()))
  }
  const unsubs = chunks.map((chunk, index) => fb.onSnapshot(
    notificationQuery(fb, uid, chunk),
    snap => {
      pages.set(index, notificationsFromSnapshot(snap))
      readyChunks.add(index)
      publish()
    },
    onError,
  ))
  return () => unsubs.forEach(unsub => unsub())
})

export async function markNotificationRead(uid: string, notificationId: string): Promise<void> {
  const fb = await getFirebase()
  await fb.updateDoc(fb.doc(fb.db, 'users', uid, 'notifications', notificationId), {
    readAt: fb.serverTimestamp(),
  })
}

/** Soft-dismiss: hide the row from the inbox without hard-deleting (rules
 *  block client delete). Dismissing an unread row also marks it read in the
 *  same write so the bell dot clears — rules allow readAt+dismissedAt
 *  together only when both == request.time. */
export async function dismissNotification(uid: string, notification: Notification): Promise<void> {
  const fb = await getFirebase()
  const ref = fb.doc(fb.db, 'users', uid, 'notifications', notification.id)
  await fb.updateDoc(ref, notification.readAt == null
    ? { readAt: fb.serverTimestamp(), dismissedAt: fb.serverTimestamp() }
    : { dismissedAt: fb.serverTimestamp() })
}

/** Marks every currently-unread id as read in one batch. Callers filter to
 *  unread ids first to avoid paying for duplicate writes; rules still allow
 *  re-marking already-read docs so multi-tab/stale-sheet retries are
 *  idempotent. */
export async function markAllNotificationsRead(uid: string, notificationIds: readonly string[]): Promise<void> {
  if (notificationIds.length === 0) return
  const fb = await getFirebase()
  const batch = fb.writeBatch(fb.db)
  for (const id of notificationIds) {
    batch.update(fb.doc(fb.db, 'users', uid, 'notifications', id), { readAt: fb.serverTimestamp() })
  }
  await batch.commit()
}
