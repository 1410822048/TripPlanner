// src/features/trips/services/tripService.ts
// Core CRUD + realtime subscriptions for the Trip aggregate. Two
// related concerns live in sibling files to keep this file focused:
//   - tripCascade.ts:  deleteTrip + Storage cleanup orchestration
//   - tripCopy.ts:     copyTrip (template duplication)
import type { User } from 'firebase/auth'
import { getFirebase, type FirebaseBundle } from '@/services/firebase'
import { P } from '@/services/paths'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { captureError } from '@/services/sentry'
import { normalizeMemberDisplayName } from '@/features/members/utils'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { markPerf } from '@/utils/perf'
import { CreateTripSchema, UpdateTripSchema, TripDocSchema, type CreateTripInput, type UpdateTripInput, type Trip } from '@/types/trip'

/** Defensive cap on the trips-per-user query. Real users don't have 50+
 *  active trips; if Sentry reports a hit, the actual scaling pain is here
 *  and we should add proper pagination + a "browse trips" UI. */
const TRIPS_LIMIT = 50

/** Shared query for initial fetch, refetch and live updates.
 * Limit bounds the result set; client sorting does not promise newest 50. */
function myTripsQuery({ db, collection, query, where, limit }: FirebaseBundle, uid: string) {
  return query(collection(db, ...P.trips()), where('memberIds', 'array-contains', uid), limit(TRIPS_LIMIT))
}

function sortTrips(trips: Trip[]): Trip[] {
  return trips.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
}

export async function getMyTrips(uid: string): Promise<Trip[]> {
  const bundle = await getFirebase()
  const snap = await bundle.getDocs(myTripsQuery(bundle, uid))
  if (snap.size >= TRIPS_LIMIT) {
    captureError(new Error('getMyTrips truncated at ' + TRIPS_LIMIT), { uid })
  }
  return sortTrips(parseListSnapshot(snap, d => firestoreDocFromSchema(TripDocSchema, d, 'getMyTrips')))
}

export function subscribeToMyTrips(
  uid: string,
  onData: (trips: Trip[]) => void,
  onError: (e: Error) => void,
): Promise<() => void> {
  let firstPublishMarked = false
  return subscribeToCollection<Trip>({
    buildQuery: bundle => myTripsQuery(bundle, uid),
    fromDoc: d => firestoreDocFromSchema(TripDocSchema, d, 'subscribeToMyTrips'),
    postProcess: sortTrips,
    source: 'subscribeToMyTrips',
    limit: TRIPS_LIMIT,
  }, trips => {
    onData(trips)
    if (!firstPublishMarked && trips.length > 0) {
      firstPublishMarked = true
      markPerf('mytrips-first-publish')
    }
  }, onError)
}

/** Explicit document reads for invite redemption and server-only cold boot.
 * These do not depend on the bounded trip-list query. */
export async function getTripsByIds(
  tripIds: string[],
  source: 'default' | 'server' = 'default',
): Promise<Trip[]> {
  if (tripIds.length === 0) return []
  const { db, doc, getDoc, getDocFromServer } = await getFirebase()
  const readTrip = source === 'server' ? getDocFromServer : getDoc
  const tripDocs = await Promise.all(
    tripIds.map(id => readTrip(doc(db, ...P.trip(id)))),
  )
  return tripDocs
    .filter(d => d.exists())
    .flatMap(d => parseTripSnap(d, 'getTripsByIds'))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
}

/**
 * Server-authorised fast path for the persisted current trip. Deliberately
 * bypasses IndexedDB: a cached document from another account must never be
 * rendered before the current user's membership query has reconciled.
 */
export async function getTripByIdFromServer(tripId: string): Promise<Trip | null> {
  const trips = await getTripsByIds([tripId], 'server')
  return trips[0] ?? null
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
    defaultCountryCode: data.defaultCountryCode,
    ownerId:     user.uid,
    memberIds,
    // 建立時就寫成空 map,跟 wishVotingDeadline* 一樣建立「永遠存在」的不變式。
    // rules 允許 create 時缺席(舊 client 相容),但新 client 一律帶。
    formerMemberNames: {},
    wishVotingDeadlineAt:         null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  }

  const memberPayload: Record<string, unknown> = {
    tripId:      tripRef.id,
    userId:      user.uid,
    displayName: normalizeMemberDisplayName(user.displayName),
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
    defaultCountryCode: data.defaultCountryCode,
    ownerId:     user.uid,
    memberIds,
    formerMemberNames: {},
    wishVotingDeadlineAt:         null,
    wishVotingDeadlineNotifiedAt: null,
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
  if (validated.defaultCountryCode !== undefined) patch.defaultCountryCode = validated.defaultCountryCode
  if (validated.startDate) patch.startDate = toLocalMidnightTimestamp(validated.startDate, Timestamp)
  if (validated.endDate)   patch.endDate   = toLocalMidnightTimestamp(validated.endDate,   Timestamp)
  await updateDoc(doc(db, ...P.trip(tripId)), patch)
}

/**
 * Owner-only shared Wish voting cutoff. Separate from updateTrip/
 * UpdateTripSchema (that schema is string-typed trip-metadata form fields);
 * this is a standalone Timestamp-typed toggle, closer in spirit to seeding
 * ownerId/memberIds than to editing title/dates.
 */
export async function setWishVotingDeadline(tripId: string, deadlineAt: Date | null): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp, Timestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.trip(tripId)), {
    wishVotingDeadlineAt: deadlineAt ? Timestamp.fromDate(deadlineAt) : null,
    updatedAt: serverTimestamp(),
  })
}
