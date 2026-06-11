// src/features/trips/services/tripService.ts
// Core CRUD + realtime subscriptions for the Trip aggregate. Two
// related concerns live in sibling files to keep this file focused:
//   - tripCascade.ts:  deleteTrip + Storage cleanup orchestration
//   - tripCopy.ts:     copyTrip (template duplication)
import type { User } from 'firebase/auth'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { captureError } from '@/services/sentry'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { CreateTripSchema, UpdateTripSchema, TripDocSchema, type CreateTripInput, type UpdateTripInput, type Trip } from '@/types'

/** Defensive cap on the trips-per-user query. Real users don't have 50+
 *  active trips; if Sentry reports a hit, the actual scaling pain is here
 *  and we should add proper pagination + a "browse trips" UI. */
const TRIPS_LIMIT = 50

/**
 * Stage 1 of "fetch all my trips": a single collection-group query on
 * /members filtered by `userId == uid`. Returns just the trip ids the user
 * belongs to. Exposed as a separate service so callers that need the ids
 * earlier than the full Trip[] (e.g. AccountPage's per-trip member fan-out)
 * can fire off downstream queries in parallel with stage 2 below.
 */
export async function getMyTripIds(uid: string): Promise<string[]> {
  const { db, collectionGroup, query, where, limit, getDocs } = await getFirebase()
  const memberSnap = await getDocs(
    query(collectionGroup(db, 'members'), where('userId', '==', uid), limit(TRIPS_LIMIT)),
  )
  if (memberSnap.size >= TRIPS_LIMIT) {
    captureError(new Error(`getMyTripIds truncated at ${TRIPS_LIMIT}`), { uid })
  }
  return memberDocsToTripIds(memberSnap.docs)
}

/** Extract unique parent trip ids from /members collection-group docs.
 *  Shared by the one-shot fetcher and the realtime listener so both
 *  produce identical output shapes.
 *
 *  Skips docs carrying `removingAt`: this CG query matches on `userId`
 *  (NOT `memberIds`), so a member doc mid-removal — the Worker stamps the
 *  marker BEFORE stripping memberIds + deleting the doc, for both kick
 *  (/member-remove) and self-leave (/member-leave) — would otherwise keep
 *  its trip id in the list until the final delete lands, and a failed
 *  delete would leave a permanent ghost. Marker present ⇒ already departed. */
function memberDocsToTripIds(
  docs: ReadonlyArray<{
    data():  Record<string, unknown> | undefined
    ref:     { parent: { parent: { id: string } | null } }
  }>,
): string[] {
  return Array.from(new Set(
    docs
      .filter(d => !d.data()?.removingAt)
      .map(d => d.ref.parent.parent?.id)
      .filter((id): id is string => !!id),
  ))
}

/**
 * Realtime variant of getMyTripIds — fires whenever a member doc owned
 * by `uid` is added or removed (the user joined or left a trip), so the
 * trip switcher surfaces new memberships without a manual reload.
 */
export const subscribeToMyTripIds = (
  uid:    string,
  onData: (data: string[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<string>({
  buildQuery: ({ db, collectionGroup, query, where, limit }) =>
    query(collectionGroup(db, 'members'), where('userId', '==', uid), limit(TRIPS_LIMIT)),
  // We want trip ids, not Member objects — fromDoc extracts the parent id.
  // A doc carrying `removingAt` is mid-removal (kick / self-leave); emit ''
  // so postProcess's filter(Boolean) drops it — see memberDocsToTripIds for
  // why the userId-based CG query needs this (else the trip lingers / ghosts
  // until the final member-doc delete).
  fromDoc:     d => d.data().removingAt ? '' : (d.ref.parent.parent?.id ?? ''),
  postProcess: ids => Array.from(new Set(ids.filter(Boolean))),
  source:      'subscribeToMyTripIds',
  limit:       TRIPS_LIMIT,
}, onData, onError)

/**
 * Stage 2: parallel `getDoc` per trip id, gated by the /trips/{id} `get`
 * rule (accepts any member regardless of role). Orphan ids (parent trip
 * missing) are filtered out. Each doc is validated through TripDocSchema
 * so downstream code can trust the shape.
 *
 * NOTE: A previous version tried to batch this with
 *   `where(documentId(), 'in', chunkedIds)`
 * to reduce round-trips. That refactor was reverted because the `in`
 * query routes through the /trips LIST rule (`ownerId == uid`), which
 * rejects the whole query if the user is a non-owner member of ANY trip
 * in the chunk — producing a 403 across the user's entire trip fetch.
 * Per-doc getDoc goes through the GET rule (`isMember`) and works for
 * every role. The N getDoc round-trips are acceptable because trips
 * per user is small (cap TRIPS_LIMIT = 50, real usage <10).
 */
export async function getTripsByIds(tripIds: string[]): Promise<Trip[]> {
  if (tripIds.length === 0) return []
  const { db, doc, getDoc } = await getFirebase()
  const tripDocs = await Promise.all(
    tripIds.map(id => getDoc(doc(db, ...P.trip(id)))),
  )
  return tripDocs
    .filter(d => d.exists())
    .flatMap(d => parseTripSnap(d, 'getTripsByIds'))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
}

/**
 * Parse a single trip DocumentSnapshot into a Trip, returning [] on
 * schema failure (so flatMap drops the bad doc) and [trip] on success.
 *
 * `serverTimestamps: 'estimate'` mirrors firestoreDocFromSchema's
 * default — without it, listener-pushed pending writes have null
 * Timestamps and fail validation. Keeping a per-trip parser (instead
 * of using firestoreDocFromSchema directly) preserves the "skip bad
 * doc" semantics this caller wants, since the helper throws.
 */
function parseTripSnap(
  d: { id: string; data: (opts?: { serverTimestamps: 'estimate' }) => Record<string, unknown> | undefined },
  source: string,
): Trip[] {
  const parsed = TripDocSchema.safeParse(d.data({ serverTimestamps: 'estimate' }))
  if (!parsed.success) {
    captureError(parsed.error, { source, docId: d.id })
    return []
  }
  return [{ id: d.id, ...parsed.data } as Trip]
}

/**
 * Subscribe to a single trip doc — Trip metadata (title / dates /
 * icon / etc.) pushed live so SchedulePage's header reflects owner
 * edits without a reload. Returns an unsubscribe fn.
 *
 * Snapshot results: `null` if doc was deleted, `Trip` on success.
 * Schema failures pass `null` and log to Sentry — the caller can
 * decide whether to drop the trip from its aggregate list.
 */
export async function subscribeToTrip(
  tripId:  string,
  onData:  (trip: Trip | null) => void,
  onError: (e: Error) => void,
): Promise<() => void> {
  const { db, doc, onSnapshot } = await getFirebase()
  return onSnapshot(
    doc(db, ...P.trip(tripId)),
    snap => {
      if (!snap.exists()) { onData(null); return }
      const trips = parseTripSnap(snap, 'subscribeToTrip')
      onData(trips[0] ?? null)
    },
    onError,
  )
}

/**
 * Fetch every trip the user belongs to — owner OR editor OR viewer.
 * Composes getMyTripIds + getTripsByIds so the staged services stay reusable
 * (AccountPage opts into the staged form to parallelise its member fan-out).
 *
 * Read cost: 1 query + N getDoc, where N is the number of trips the user is
 * a member of. For typical users (N < 20) this is well within budget and
 * avoids the list-rule constraint that prohibits per-doc exists() checks.
 */
export async function getMyTrips(uid: string): Promise<Trip[]> {
  const tripIds = await getMyTripIds(uid)
  return getTripsByIds(tripIds)
}

/**
 * Batch-create a trip + owner member doc. Matches firestore.rules:
 *   - trips/{id}.ownerId == uid()
 *   - trips/{id}/members/{uid}.userId == uid() && role == 'owner'
 * The two writes land atomically, so the member self-bootstrap required
 * by rules can't be skipped by a partial failure.
 */
export async function createTrip(input: CreateTripInput, user: User): Promise<Trip> {
  const data = CreateTripSchema.parse(input)
  const { db, doc, collection, writeBatch, Timestamp, serverTimestamp } = await getFirebase()

  const tripRef   = doc(collection(db, ...P.trips()))
  const memberRef = doc(db, ...P.member(tripRef.id, user.uid))

  const startTs = toLocalMidnightTimestamp(data.startDate, Timestamp)
  const endTs   = toLocalMidnightTimestamp(data.endDate,   Timestamp)
  const icon    = data.icon ?? '✈️'

  // memberIds is denormalised onto trip + every member/entity doc so
  // read rules can check `request.auth.uid in resource.data.memberIds`
  // SAME-DOC — no cross-document exists() that suffers rules-eval lag.
  // On create the roster is just the owner; Worker membership endpoints
  // extend it on invite accept / member removal.
  const memberIds = [user.uid]

  const tripPayload = {
    title:       data.title,
    destination: data.destination,
    icon,
    startDate:   startTs,
    endDate:     endTs,
    currency:    data.currency,
    ownerId:     user.uid,
    memberIds,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  }

  const memberPayload: Record<string, unknown> = {
    tripId:      tripRef.id,
    userId:      user.uid,
    displayName: user.displayName ?? 'Me',
    role:        'owner',
    joinedAt:    serverTimestamp(),
    memberIds,
  }
  // avatarUrl omitted when null — ignoreUndefinedProperties strips undefined;
  // explicit branch keeps the payload tight.
  if (user.photoURL) memberPayload.avatarUrl = user.photoURL

  const batch = writeBatch(db)
  batch.set(tripRef,   tripPayload)
  batch.set(memberRef, memberPayload)
  await batch.commit()

  // Local Timestamp as a sentinel for createdAt/updatedAt — the real server
  // values arrive on the next read via useMyTrips / getDoc.
  const nowTs = Timestamp.now()
  return {
    id:          tripRef.id,
    title:       data.title,
    destination: data.destination,
    icon,
    startDate:   startTs,
    endDate:     endTs,
    currency:    data.currency,
    ownerId:     user.uid,
    memberIds,
    createdAt:   nowTs,
    updatedAt:   nowTs,
  }
}

/**
 * Patch editable trip metadata. Only fields present in `updates` are written;
 * `ownerId` is immutable (rule-enforced) so never included. Date strings are
 * converted to local-midnight Timestamps to match createTrip.
 */
export async function updateTrip(
  tripId: string,
  updates: UpdateTripInput,
): Promise<void> {
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateTripSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateTrip', tripId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
  const { db, doc, updateDoc, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() }
  if (validated.title       !== undefined) patch.title       = validated.title
  if (validated.destination !== undefined) patch.destination = validated.destination
  if (validated.icon        !== undefined) patch.icon        = validated.icon
  if (validated.currency    !== undefined) patch.currency    = validated.currency
  if (validated.startDate) patch.startDate = toLocalMidnightTimestamp(validated.startDate, Timestamp)
  if (validated.endDate)   patch.endDate   = toLocalMidnightTimestamp(validated.endDate,   Timestamp)
  await updateDoc(doc(db, ...P.trip(tripId)), patch)
}
