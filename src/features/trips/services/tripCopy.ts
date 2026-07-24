// src/features/trips/services/tripCopy.ts
// Duplicate a trip for "I'm planning a similar one" / "fork to try a
// different version" use cases. Carved out of tripService.ts because:
//   - Decision matrix (what gets copied, what doesn't) is non-trivial
//     and lives best with the implementation it documents
//   - The two-phase atomic-then-batched commit pattern is its own
//     concern, separate from CRUD
//   - At ~150 LOC it dominated the parent file before split
//
// Copies:
//   ✅ Trip metadata (with new title + rebased dates)
//   ✅ Schedules (date-shifted to the new range)
//   ✅ Planning items (no date concept, copied as fresh uncompleted rows)
//
// Does NOT copy:
//   ❌ Bookings   — real reservations tied to original trip's
//                    confirmation numbers / dates / contracts
//   ❌ Expenses   — represent real money, not a template
//   ❌ Wishes     — votes are personal; fresh slate fits a new trip
//   ❌ Members    — privacy / permissions; user invites separately
//   ❌ Invites    — security tokens, never reusable across trips
import type { User } from 'firebase/auth'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { addDays, diffDays, toLocalDateString, toLocalMidnightTimestamp } from '@/utils/dates'
import { auditCreate } from '@/utils/audit'
import type { Trip } from '@/types'

export interface CopyTripInput {
  title:         string
  newStartDate:  string  // 'YYYY-MM-DD'
  copySchedules: boolean
  copyPlanning:  boolean
}

export interface CopyTripResult {
  trip:              Trip
  copiedSchedules:   number
  copiedPlanItems:   number
  /** Schedules whose original date fell outside the new (potentially
   *  shorter) range — they were still copied with their shifted date,
   *  but the user should know they currently sit beyond endDate. */
  orphanedSchedules: number
}

/** Skipped fields when rebuilding doc payloads from source. Planning
 *  explicitly resets per-member completion so a copied checklist starts
 *  unticked for the new trip. */
const SCHEDULE_SKIP = new Set([
  'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'memberIds', 'tripId',
  'optimizedStartTime', 'routeRevision',
])
const PLAN_SKIP     = new Set(['createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'memberIds', 'tripId', 'completedBy'])

/**
 * Build a fresh doc payload from a source doc's data: drop the named
 * skip fields, then merge in fresh identity + audit fields. Generic
 * over schedule/planning's different skip sets and overlays.
 */
function rebuildPayload(
  data:    Record<string, unknown>,
  skip:    ReadonlySet<string>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (!skip.has(k)) out[k] = v
  }
  return { ...out, ...overlay }
}

/**
 * Two-phase copy:
 *   1. createTrip-equivalent batch (trip doc + owner member) — atomic.
 *   2. Per-subcollection batches for schedules / planning — chunked to
 *      respect Firestore's 500-write limit.
 *
 * Phase 1 is atomic; phase 2 is not. If phase 2 fails partway, the new
 * trip exists but is partially populated — the user can manually delete
 * it via the same trip-delete path. Acceptable trade-off vs. trip-
 * creation rolling back across collections.
 */
export async function copyTrip(
  source: Trip,
  input:  CopyTripInput,
  user:   User,
): Promise<CopyTripResult> {
  const {
    db, doc, collection, getDocs, writeBatch, Timestamp, serverTimestamp,
  } = await getFirebase()

  // Roster on a copied trip is just the user that triggered the copy —
  // existing members of `source` aren't carried over (privacy / scope).
  // Cascaded onto every copied schedule + planning row so the read
  // rules pass via same-doc memberIds check.
  const memberIds = [user.uid]

  // Compute new endDate by shifting endDate by the same delta as
  // startDate — preserves the trip's original duration.
  const dateOffset = diffDays(
    toLocalDateString(source.startDate.toDate()),
    input.newStartDate,
  )
  const newEndDate = addDays(toLocalDateString(source.endDate.toDate()), dateOffset)
  const newStartTs = toLocalMidnightTimestamp(input.newStartDate, Timestamp)
  const newEndTs   = toLocalMidnightTimestamp(newEndDate,         Timestamp)

  // ── Phase 1: trip + owner member (atomic) ─────────────────────
  const tripRef   = doc(collection(db, ...P.trips()))
  const memberRef = doc(db, ...P.member(tripRef.id, user.uid))

  const memberPayload: Record<string, unknown> = {
    tripId:      tripRef.id,
    userId:      user.uid,
    displayName: user.displayName ?? 'Me',
    role:        'owner',
    joinedAt:    serverTimestamp(),
    memberIds,
  }
  if (user.photoURL) memberPayload.avatarUrl = user.photoURL

  const batch1 = writeBatch(db)
  batch1.set(tripRef, {
    title:       input.title,
    destination: source.destination,
    icon:        source.icon ?? '✈️',
    startDate:   newStartTs,
    endDate:     newEndTs,
    currency:    source.currency,
    defaultCountryCode: source.defaultCountryCode,
    ownerId:     user.uid,
    memberIds,
    wishVotingDeadlineAt:         null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  })
  batch1.set(memberRef, memberPayload)
  await batch1.commit()

  // ── Phase 2a: copy schedules (date-shifted) ───────────────────
  // Filter by caller's uid to satisfy the same-doc list rule
  // (allow list: if uid in resource.data.memberIds). The caller is a
  // member of the source trip, and Worker membership endpoints keep
  // memberIds aligned across every entity doc, so the filter returns
  // the full set.
  let copiedSchedules   = 0
  let orphanedSchedules = 0
  if (input.copySchedules) {
    const { query, where } = await getFirebase()
    const sourceSchedules = await getDocs(query(
      collection(db, ...P.schedules(source.id)),
      where('memberIds', 'array-contains', user.uid),
    ))

    for (let i = 0; i < sourceSchedules.docs.length; i += 500) {
      const batch = writeBatch(db)
      for (const d of sourceSchedules.docs.slice(i, i + 500)) {
        const data = d.data() as { date: string; [k: string]: unknown }
        const newDate = addDays(data.date, dateOffset)
        // YYYY-MM-DD sorts lexicographically, so string comparison is
        // exact for "outside the new range" detection.
        if (newDate < input.newStartDate || newDate > newEndDate) orphanedSchedules++
        const newRef = doc(collection(db, ...P.schedules(tripRef.id)))
        batch.set(newRef, rebuildPayload(data, SCHEDULE_SKIP, {
          date:   newDate,
          tripId: tripRef.id,
          memberIds,
          ...auditCreate(user.uid, serverTimestamp()),
        }))
        copiedSchedules++
      }
      await batch.commit()
    }
  }

  // ── Phase 2b: copy planning items (no date concept) ──────────
  let copiedPlanItems = 0
  if (input.copyPlanning) {
    const { query, where } = await getFirebase()
    const sourcePlanning = await getDocs(query(
      collection(db, ...P.planning(source.id)),
      where('memberIds', 'array-contains', user.uid),
    ))
    for (let i = 0; i < sourcePlanning.docs.length; i += 500) {
      const batch = writeBatch(db)
      for (const d of sourcePlanning.docs.slice(i, i + 500)) {
        const newRef = doc(collection(db, ...P.planning(tripRef.id)))
        // `completedBy: {}` resets the new trip's checklist — the
        // original trip's per-member progress isn't relevant here.
        batch.set(newRef, rebuildPayload(d.data(), PLAN_SKIP, {
          completedBy: {},
          tripId:      tripRef.id,
          memberIds,
          ...auditCreate(user.uid, serverTimestamp()),
        }))
        copiedPlanItems++
      }
      await batch.commit()
    }
  }

  const nowTs = Timestamp.now()
  const trip: Trip = {
    id:          tripRef.id,
    title:       input.title,
    destination: source.destination,
    icon:        source.icon ?? '✈️',
    startDate:   newStartTs,
    endDate:     newEndTs,
    currency:    source.currency,
    defaultCountryCode: source.defaultCountryCode,
    ownerId:     user.uid,
    memberIds,
    wishVotingDeadlineAt:         null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt:   nowTs,
    updatedAt:   nowTs,
  }
  return { trip, copiedSchedules, copiedPlanItems, orphanedSchedules }
}
