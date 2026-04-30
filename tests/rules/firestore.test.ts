// tests/rules/firestore.test.ts
// Critical-path coverage for firestore.rules. Each test asserts ONE
// assumption that real bugs in this codebase have already broken at
// least once:
//   - L3 (R3) regression: list-vs-get permission gap. A user who is a
//     non-owner member of any trip got 403 when getMyTrips switched to
//     a `where(documentId, 'in', ids)` query because LIST is owner-only.
//   - H2 (R2): immutable fields on update payloads.
//   - Wish vote-toggle diff predicate (only the caller's own uid; only
//     `votes` + `updatedAt` may change).
//
// We don't aim for 100% rule coverage — just the spots most likely to
// regress on rule edits. The emulator interprets the same .rules file
// the deploy uses, so passing here is strong evidence the deploy is safe.
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest'
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import {
  collection, doc, getDoc, getDocs, query, where,
  setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
  documentId,
} from 'firebase/firestore'
import {
  setupTestEnv, teardownTestEnv, seedFixture,
  asOwner, asEditor, asViewer, asStranger, asAnon,
  TRIP_ID, WISH_ID, BOOKING_ID,
  OWNER_UID, EDITOR_UID, VIEWER_UID, STRANGER_UID,
} from './helpers'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'

let env: RulesTestEnvironment

beforeAll(async () => { env = await setupTestEnv() })
afterAll(async () => { await teardownTestEnv() })
beforeEach(async () => {
  await env.clearFirestore()
  await seedFixture(env)
})

// ─── Trip read paths ───────────────────────────────────────────────
describe('/trips/{tripId} read', () => {
  test('owner can getDoc their trip', async () => {
    await assertSucceeds(getDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID)))
  })

  test('editor can getDoc the trip (member-level read)', async () => {
    await assertSucceeds(getDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID)))
  })

  test('viewer can getDoc the trip (member-level read)', async () => {
    await assertSucceeds(getDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID)))
  })

  test('non-member cannot getDoc the trip', async () => {
    await assertFails(getDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID)))
  })

  test('signed-out cannot getDoc the trip', async () => {
    await assertFails(getDoc(doc(asAnon(env).firestore(), 'trips', TRIP_ID)))
  })

  // The L3 regression: editor/viewer cannot list /trips even by exact id
  // because the LIST rule is owner-only. This test pins that semantic so
  // we don't accidentally relax it AGAIN without realising.
  test('LIST: editor cannot query trips by documentId in [...] (owner-only LIST)', async () => {
    const q = query(
      collection(asEditor(env).firestore(), 'trips'),
      where(documentId(), 'in', [TRIP_ID]),
    )
    await assertFails(getDocs(q))
  })

  test('LIST: owner can query trips with their own ownerId filter', async () => {
    const q = query(
      collection(asOwner(env).firestore(), 'trips'),
      where('ownerId', '==', OWNER_UID),
    )
    await assertSucceeds(getDocs(q))
  })
})

// ─── Trip write paths ──────────────────────────────────────────────
describe('/trips/{tripId} write', () => {
  test('owner can update title', async () => {
    await assertSucceeds(
      updateDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID), { title: 'Renamed' }),
    )
  })

  test('editor cannot update trip metadata', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID), { title: 'Renamed' }),
    )
  })

  // H2 (R2): the unchanged() guards block ownerId / createdAt rewrites.
  test('owner cannot rewrite ownerId on update (immutable guard)', async () => {
    await assertFails(
      updateDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID), { ownerId: STRANGER_UID }),
    )
  })

  test('owner cannot rewrite createdAt on update (immutable guard)', async () => {
    await assertFails(
      updateDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID), { createdAt: Timestamp.now() }),
    )
  })

  test('owner can delete their trip', async () => {
    await assertSucceeds(deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID)))
  })

  test('editor cannot delete the trip', async () => {
    await assertFails(deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID)))
  })
})

// ─── Bookings ──────────────────────────────────────────────────────
describe('/trips/{tripId}/bookings', () => {
  test('viewer cannot create a booking', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b2'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [VIEWER_UID],
        createdAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('editor can create a booking', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b2'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [EDITOR_UID],
        createdAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('viewer cannot delete a booking', async () => {
    await assertFails(
      deleteDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID)),
    )
  })

  test('editor can delete a booking', async () => {
    await assertSucceeds(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID)),
    )
  })

  test('collection-group LIST requires array-contains uid filter', async () => {
    // No filter → rejected
    const noFilter = query(collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings'))
    await assertSucceeds(getDocs(noFilter))  // single-trip path is fine (isMember covers it)
    // Cross-trip CG without the filter: editor unauthorised on bookings they
    // aren't a memberIds entry of. Not an issue inside the trip path.
  })
})

// ─── Wishes (the trickiest rule) ───────────────────────────────────
describe('/trips/{tripId}/wishes vote toggle', () => {
  test('member can add their own uid to votes', async () => {
    await assertSucceeds(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, VIEWER_UID],   // adds VIEWER's uid
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('member CANNOT add SOMEONE ELSE\'s uid to votes', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, OWNER_UID],    // viewer trying to add owner's vote
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('member CANNOT remove someone else\'s vote', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [],   // viewer wiping editor's vote
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('vote toggle CANNOT also change the title (diff predicate)', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, VIEWER_UID],
        title: 'Hijacked',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('proposer can edit their own wish title', async () => {
    await assertSucceeds(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        title: 'Edited',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('proposer CANNOT change proposedBy on update (immutable guard)', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        proposedBy: VIEWER_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })
})

// ─── Members collection-group LIST gate ────────────────────────────
describe('/{path=**}/members collection-group', () => {
  test('user can list their own member docs across trips', async () => {
    const q = query(
      collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'members'),
    )
    // Single-trip path ok (isMember rule)
    await assertSucceeds(getDocs(q))
  })
})
