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
  setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp, Timestamp,
  documentId, writeBatch,
} from 'firebase/firestore'
import {
  setupTestEnv, teardownTestEnv, seedFixture,
  asOwner, asEditor, asViewer, asStranger, asAnon,
  TRIP_ID, WISH_ID, BOOKING_ID, BOOKING_NO_VIEWER_ID,
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

  test('client cannot set deletingAt on trip update (Worker-only field)', async () => {
    // The quiesce flag is the cascade write-lock. If owners could
    // set it themselves via raw SDK they'd freeze their own trip
    // from any new creates -- and could selectively unfreeze too,
    // which would be a new form of the old `deletionStartedAt`
    // KNOWN BROKEN race. Rule pins unchanged('deletingAt') on the
    // owner-edit path so only the Worker (admin SDK) writes it.
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID),
        { deletingAt: serverTimestamp() },
      ),
    )
  })

  test('subcollection CREATE is rejected when trip.deletingAt is set', async () => {
    // The bug we're regression-guarding: an editor on device B
    // creates a new expense AFTER device A triggered cascade, in
    // the window between Worker's expense-drain and trip-doc-delete.
    // Without this gate the new doc survives the cascade and
    // becomes an orphan. With the gate every subcollection CREATE
    // checks `tripNotDeleting(tripId)` and rejects mid-cascade
    // writes at the rules layer.
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        { deletingAt: serverTimestamp() },
      )
    })
    const expensePayload = {
      tripId: TRIP_ID,
      title:  'mid-cascade race',
      amount: 100,
      currency: 'JPY',
      category: 'food',
      paidBy: EDITOR_UID,
      splits: [{ memberId: EDITOR_UID, amount: 100 }],
      date: '2026-05-21',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      deletedAt: null,
      receiptPurgedAt: null,
    }
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-race'),
        expensePayload,
      ),
    )
    // Restore the trip to non-deleting state so subsequent tests
    // in this file aren't accidentally gated (env reuses the seed).
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        { deletingAt: deleteField() },
      )
    })
  })

  test('invite redeem CREATE is rejected when trip.deletingAt is set', async () => {
    // Members create has three paths; the bootstrap path (owner
    // self-add at trip creation) intentionally skips tripNotDeleting
    // because the trip doc is created in the same batch and the
    // gate's cross-doc get would not yet see the staged write.
    // Paths 2 (owner manual-add) and 3 (invite redeem) DO get the
    // gate -- otherwise a friend redeeming an invite during the
    // owner's cascade would see "joined" then immediately get
    // wiped, plus the stray member doc could survive timing edges.
    const INVITE_TOKEN = 'invite-during-cascade'
    await env.withSecurityRulesDisabled(async ctx => {
      // Seed a valid invite and pin the trip to deleting state.
      const now = Timestamp.now()
      const future = Timestamp.fromMillis(now.toMillis() + 24 * 3600 * 1000)
      await setDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', INVITE_TOKEN), {
        tripId: TRIP_ID, tripTitle: 'Test', tripIcon: '✈️',
        role: 'editor', createdBy: OWNER_UID,
        createdAt: now, expiresAt: future,
      })
      await updateDoc(doc(ctx.firestore(), 'trips', TRIP_ID), { deletingAt: serverTimestamp() })
    })
    await assertFails(
      setDoc(
        doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'members', STRANGER_UID),
        {
          tripId:      TRIP_ID,
          userId:      STRANGER_UID,
          displayName: 'Stranger',
          role:        'editor',
          inviteToken: INVITE_TOKEN,
          joinedAt:    serverTimestamp(),
          memberIds:   [STRANGER_UID],
        },
      ),
    )
    // Restore trip state for subsequent tests.
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), 'trips', TRIP_ID), { deletingAt: deleteField() })
    })
  })

  test('owner cannot raw-SDK delete the trip doc (trip-root delete is Worker-exclusive)', async () => {
    // Post-P1-close, the only legitimate trip-delete path is
    // /cascade-trip-delete on the Worker (admin SDK, bypasses rules).
    // Allowing client-side `deleteDoc(trip)` would let an owner
    // delete just the trip doc and orphan every subcollection +
    // Storage object — strictly worse than the Worker cascade.
    await assertFails(deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID)))
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
        createdBy: VIEWER_UID, updatedBy: VIEWER_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('editor can create a booking', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b2'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        // memberIds must exactly equal trip's roster — the anti-injection
        // guard added 2026-05-19 (memberIdsMatchTrip). Honest clients
        // read the roster via getTripMemberIds() before writing.
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
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

  // Attachment-shape validation. The fileUrl / filePath / fileType etc.
  // come from the storage upload result on the honest service path, so
  // legit clients always satisfy the rule. These tests target the raw-
  // SDK forge attempts: external URL, wrong path, wrong mime.
  const VALID_ATTACHMENT = {
    fileUrl:   'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fbookings%2Fb-att%2Ffile.webp?alt=media&token=abc',
    filePath:  'trips/trip-1/bookings/b-att/file.webp',
    fileType:  'image/webp',
  }

  function bookingWithAttachment(att: object) {
    return {
      tripId: TRIP_ID, type: 'hotel', title: 'X',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      sortDate:  serverTimestamp(),
      attachment: att,
    }
  }

  test('editor can create a booking with a valid attachment', async () => {
    await assertSucceeds(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment(VALID_ATTACHMENT),
      ),
    )
  })

  test('attachment with external fileUrl is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          fileUrl: 'https://evil.example.com/tracking.png',
        }),
      ),
    )
  })

  test('attachment with filePath outside the booking folder is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          filePath: 'trips/other-trip/bookings/x/file.webp',
        }),
      ),
    )
  })

  test('attachment with non-allowlisted fileType is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          fileType: 'text/html',
        }),
      ),
    )
  })

  test('attachment with same-bucket cross-trip fileUrl is rejected', async () => {
    // Same bucket, but the encoded path inside the URL points at a
    // different trip. URL/path binding via validStorageUrlFor() catches
    // this — without it, only the bucket prefix would be checked and the
    // cross-trip URL would pass while filePath looks legit.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          fileUrl: 'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Fother-trip%2Fbookings%2Fb-att%2Ffile.webp?alt=media&token=xyz',
        }),
      ),
    )
  })

  test('attachment with fileUrl pointing at a different filename than filePath is rejected', async () => {
    // Same trip, same booking folder — but filename mismatch. Without
    // filename binding, this would create an orphan: delete purges
    // `file.webp` based on filePath, the URL'd `other.webp` stays in
    // Storage forever.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          fileUrl: 'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fbookings%2Fb-att%2Fother.webp?alt=media&token=xyz',
        }),
      ),
    )
  })

  test('attachment with thumbUrl but no thumbPath is rejected', async () => {
    // Pair invariant — preventing the "UI fetches thumb but delete has
    // nothing to purge" orphan surface.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          thumbUrl: 'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fbookings%2Fb-att%2Fthumb.webp?alt=media&token=t',
          // no thumbPath
        }),
      ),
    )
  })

  test('attachment with thumbPath but no thumbUrl is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          thumbPath: 'trips/trip-1/bookings/b-att/thumb.webp',
          // no thumbUrl
        }),
      ),
    )
  })

  test('attachment with valid paired thumb passes', async () => {
    await assertSucceeds(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'),
        bookingWithAttachment({
          ...VALID_ATTACHMENT,
          thumbUrl:  'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fbookings%2Fb-att%2Fthumb.webp?alt=media&token=t',
          thumbPath: 'trips/trip-1/bookings/b-att/thumb.webp',
        }),
      ),
    )
  })

  test('list query MUST include memberIds array-contains filter', async () => {
    // Without filter, Firestore can't prove the same-doc rule
    // (uid in resource.data.memberIds) is satisfied by all results
    // → query rejected at validation time.
    const noFilter = query(collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings'))
    await assertFails(getDocs(noFilter))
    // With filter aligned to the rule → query passes.
    const filtered = query(
      collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings'),
      where('memberIds', 'array-contains', EDITOR_UID),
    )
    await assertSucceeds(getDocs(filtered))
  })
})

// ─── Wishes (the trickiest rule) ───────────────────────────────────
describe('/trips/{tripId}/wishes vote toggle', () => {
  test('member can add their own uid to votes', async () => {
    await assertSucceeds(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, VIEWER_UID],   // adds VIEWER's uid
        updatedBy: VIEWER_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('member CANNOT add SOMEONE ELSE\'s uid to votes', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, OWNER_UID],    // viewer trying to add owner's vote
        updatedBy: VIEWER_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('member CANNOT remove someone else\'s vote', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [],   // viewer wiping editor's vote
        updatedBy: VIEWER_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('vote toggle CANNOT also change the title (diff predicate)', async () => {
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, VIEWER_UID],
        updatedBy: VIEWER_UID,
        title: 'Hijacked',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('vote toggle CANNOT forge updatedBy to another uid', async () => {
    // New strict guard: vote toggle requires updatedBy == uid(); viewer
    // can't claim the write came from someone else.
    await assertFails(
      updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        votes: [EDITOR_UID, VIEWER_UID],
        updatedBy: OWNER_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('proposer can edit their own wish title', async () => {
    await assertSucceeds(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        title: 'Edited',
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('proposer CANNOT change proposedBy on update (immutable guard)', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        proposedBy: VIEWER_UID,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  // Image-shape validation (same family as booking attachment tests).
  const VALID_WISH_IMAGE = {
    url:       'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fwishes%2Fw-img%2Ffile.webp?alt=media&token=abc',
    path:      'trips/trip-1/wishes/w-img/file.webp',
    thumbUrl:  'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fwishes%2Fw-img%2Fthumb.webp?alt=media&token=def',
    thumbPath: 'trips/trip-1/wishes/w-img/thumb.webp',
  }

  function wishWithImage(image: object) {
    return {
      tripId: TRIP_ID, category: 'place', title: 'X',
      proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      image,
    }
  }

  test('viewer can create wish with valid image', async () => {
    await assertSucceeds(
      setDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-img'),
        wishWithImage(VALID_WISH_IMAGE),
      ),
    )
  })

  test('wish with external image.url is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-img'),
        wishWithImage({ ...VALID_WISH_IMAGE, url: 'https://evil.example.com/track.png' }),
      ),
    )
  })

  test('wish with cross-trip image.path is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-img'),
        wishWithImage({ ...VALID_WISH_IMAGE, path: 'trips/other-trip/wishes/y/file.webp' }),
      ),
    )
  })
})

// ─── Expense receipt shape validation ──────────────────────────────
describe('/trips/{tripId}/expenses receipt shape', () => {
  const VALID_RECEIPT = {
    url:  'https://firebasestorage.googleapis.com/v0/b/tripplanner-80a4f.firebasestorage.app/o/trips%2Ftrip-1%2Fexpenses%2Fe-rcpt%2Ffile.webp?alt=media&token=abc',
    path: 'trips/trip-1/expenses/e-rcpt/file.webp',
    type: 'image/webp',
  }

  function expenseWithReceipt(receipt: object) {
    return {
      tripId: TRIP_ID, title: 'X',
      amount: 1000, currency: 'JPY',
      category: 'food',
      paidBy: EDITOR_UID,
      splits: [{ memberId: EDITOR_UID, amount: 1000 }],
      date: '2026-05-19',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      // phase-2: create rule requires deletedAt present + null.
      deletedAt: null,
      // receipt-purge watermark: cron filter requires this be present
      // on every doc so the equality `receiptPurgedAt == null` query
      // can match. New expenses always seed it null; cron stamps a
      // Timestamp post-purge.
      receiptPurgedAt: null,
      receipt,
    }
  }

  test('editor can create expense with valid receipt', async () => {
    await assertSucceeds(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-rcpt'),
        expenseWithReceipt(VALID_RECEIPT),
      ),
    )
  })

  test('expense with external receipt.url is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-rcpt'),
        expenseWithReceipt({ ...VALID_RECEIPT, url: 'https://evil.example.com/track.png' }),
      ),
    )
  })

  test('expense with non-allowlisted receipt.type is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-rcpt'),
        expenseWithReceipt({ ...VALID_RECEIPT, type: 'text/html' }),
      ),
    )
  })
})

describe('/trips/{tripId}/expenses soft-delete (phase-2)', () => {
  function expenseBase(overrides: Record<string, unknown> = {}) {
    return {
      tripId: TRIP_ID, title: 'X',
      amount: 1000, currency: 'JPY',
      category: 'food',
      paidBy: EDITOR_UID,
      splits: [{ memberId: EDITOR_UID, amount: 1000 }],
      date: '2026-05-19',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      // Default to alive-on-create (deletedAt MUST be present + null).
      deletedAt: null,
      // receipt-purge marker also required by create rule.
      receiptPurgedAt: null,
      ...overrides,
    }
  }

  test('create with deletedAt=null succeeds (alive expense)', async () => {
    await assertSucceeds(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-1'),
        expenseBase(),
      ),
    )
  })

  test('create WITHOUT deletedAt field is rejected (field is required)', async () => {
    const { deletedAt: _omit, ...withoutField } = expenseBase()
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-1b'),
        withoutField,
      ),
    )
  })

  test('create with deletedAt set to a Timestamp is rejected (no pre-deleted)', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-2'),
        expenseBase({ deletedAt: serverTimestamp() }),
      ),
    )
  })

  test('create WITHOUT receiptPurgedAt is rejected (field is required)', async () => {
    // The cron's purge candidate filter is
    // `receiptPurgedAt == null AND deletedAt < cutoff`. Firestore
    // equality on null does NOT match missing-field docs, so an
    // expense created without this field would NEVER be visited
    // by the cron -- its receipt would leak. Schema contract
    // enforces presence on create.
    const { receiptPurgedAt: _drop, ...withoutMarker } = expenseBase()
    void _drop
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-no-marker'),
        withoutMarker,
      ),
    )
  })

  test('create with receiptPurgedAt forged to a Timestamp is rejected', async () => {
    // Only the Worker cron (Admin SDK, bypasses rules) is allowed
    // to write a Timestamp into receiptPurgedAt. A client doing so
    // on create would skip the candidate set forever -- receipt
    // bytes leak. Only null is acceptable from clients.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-forge-1'),
        expenseBase({ receiptPurgedAt: serverTimestamp() }),
      ),
    )
  })

  test('editor can soft-delete (update with deletedAt=serverTimestamp)', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-3')
    await setDoc(ref, expenseBase())
    // serverTimestamp resolves to request.time inside the rule -- the
    // transition check accepts it (null -> request.time path).
    await assertSucceeds(
      updateDoc(ref, { deletedAt: serverTimestamp(), updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('soft-delete with a backdated Timestamp is rejected (no client backdate)', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-3b')
    await setDoc(ref, expenseBase())
    // Client supplies a constant Timestamp instead of serverTimestamp().
    // The rule requires deletedAt == request.time on the null -> Timestamp
    // transition, so this backdated value fails.
    await assertFails(
      updateDoc(ref, {
        deletedAt: Timestamp.fromMillis(1_000_000),
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('editor can clear deletedAt to null (alive→alive no-op restore path neutrally allowed)', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-4')
    await setDoc(ref, expenseBase({ deletedAt: null }))
    // The interesting branches (true restore from tombstone) are
    // covered by the two backdated-tombstone tests further down; this
    // one only pins the trivial alive→alive case (writing deletedAt:
    // null over an already-null value, e.g. a `restore` UI no-op on
    // a not-yet-tombstoned doc).
    await assertSucceeds(
      updateDoc(ref, { deletedAt: null, updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('editor can restore a tombstoned expense INSIDE the 10-day window', async () => {
    // Seed a doc whose tombstone is 5 days old. We bypass rules for the
    // seed because the rule-respecting path would force deletedAt ==
    // request.time, defeating the backdate test.
    const FIVE_DAYS_AGO = Timestamp.fromMillis(Date.now() - 5 * 24 * 3600 * 1000)
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'expenses', 'e-restore-fresh'),
        expenseBase({ deletedAt: FIVE_DAYS_AGO }),
      )
    })
    // 5 days < 10 days → restore allowed. The receipt-purge cron only
    // touches docs older than 10 days, so the restored expense is
    // guaranteed to still have its receipt intact.
    await assertSucceeds(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-restore-fresh'),
        { deletedAt: null, updatedBy: EDITOR_UID, updatedAt: serverTimestamp() },
      ),
    )
  })

  test('client CANNOT forge receiptPurgedAt to a Timestamp on update (would hide doc from cron)', async () => {
    // The whole point of the marker: only the admin-SDK cron should
    // be able to write a real Timestamp into receiptPurgedAt. A
    // client forging a Timestamp here would make the doc invisible
    // to the cron's `receiptPurgedAt == null` filter -> receipt
    // bytes leak. Rule pins `unchanged('receiptPurgedAt')` on the
    // expense update path so clients can't touch it at all.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-legacy-2')
    await setDoc(ref, expenseBase())
    await assertFails(
      updateDoc(ref, {
        receiptPurgedAt: serverTimestamp(),
        updatedBy:       EDITOR_UID,
        updatedAt:       serverTimestamp(),
      }),
    )
  })

  test('editor CANNOT restore a tombstoned expense AFTER the 10-day window', async () => {
    // Seed a tombstone 11 days old. By that point the cron has purged
    // the receipt; allowing restore would resurrect an expense pointing
    // at a deleted Storage object → broken invariant + 404s in UI.
    const ELEVEN_DAYS_AGO = Timestamp.fromMillis(Date.now() - 11 * 24 * 3600 * 1000)
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'expenses', 'e-restore-stale'),
        expenseBase({ deletedAt: ELEVEN_DAYS_AGO }),
      )
    })
    await assertFails(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-restore-stale'),
        { deletedAt: null, updatedBy: EDITOR_UID, updatedAt: serverTimestamp() },
      ),
    )
  })

  test('non-timestamp deletedAt is rejected on update', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-5')
    await setDoc(ref, expenseBase())
    await assertFails(
      updateDoc(ref, { deletedAt: 'maybe-later', updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('editor hard-delete (deleteDoc) is rejected -- soft-delete only', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-6')
    await setDoc(ref, expenseBase())
    // Non-owner editors must go through soft-delete (deletedAt update).
    // Direct deleteDoc bypasses the tombstone -- blocked.
    await assertFails(deleteDoc(ref))
  })

  // ─────────────────────────────────────────────────────────────
  // P1 closure (cascade Worker migration shipped 2026-05-20):
  // hard-delete is rejected for ALL clients including the owner.
  // The trip cascade workflow now goes through the Worker's
  // /cascade-trip-delete endpoint which uses Admin SDK to bypass
  // rules entirely. The result is that the chronological-replay
  // tombstone invariant is no longer bypassable by any client
  // path; settlement orphan classification is sound for every
  // soft-deleted expense.
  //
  // Tests below cover:
  //   - owner cannot hard-delete via raw SDK (closed P1)
  //   - editor vandalism via update is permitted (collaboration
  //     model), but tombstone freeze still blocks vandalism on
  //     already-tombstoned docs (settlement replay integrity)
  // ─────────────────────────────────────────────────────────────

  test('owner hard-delete is rejected (P1 closed; all clients must go through Worker cascade)', async () => {
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-6b')
    await setDoc(ref, expenseBase())
    // Pre-P1-fix this was conditionally allowed via a deletionStartedAt
    // window on the trip doc. Post-fix the rule is `allow delete: if
    // false` -- no client (including owner) can hard-delete from
    // Firestore directly. Cascade workflow runs through the Worker
    // (/cascade-trip-delete) which uses Admin SDK and bypasses rules.
    await assertFails(
      deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-6b')),
    )
  })

  test('editor vandalism via update is permitted but content fields must still validate', async () => {
    // Collaboration model: editors CAN edit each other's expenses.
    // What they can't do is effectively erase the doc by clearing
    // required fields -- amount/title/splits validation rejects the
    // "set everything to zero" attack. This codifies the existing
    // type/value guards as a positive invariant in case anyone ever
    // relaxes them.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-vandal-1')
    await setDoc(ref, expenseBase())
    // Plausible vandalism: rename title to '.', set amount to 1, point
    // splits at self. All fields still satisfy the schema, so the rule
    // accepts it. This is "vandalism not erasure" -- recoverable via
    // edit history, owner-can-kick-editor, etc.
    await assertSucceeds(
      updateDoc(ref, {
        title:     '.',
        amount:    1,
        splits:    [{ memberId: EDITOR_UID, amount: 1 }],
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
    // Erasure attempt: zero amount, empty title. Rejected by the
    // amount > 0 / title.size() > 0 validators -- closes the
    // "update-as-hard-delete" backdoor that #4 reviewer flagged.
    await assertFails(
      updateDoc(ref, {
        title:     '',
        amount:    0,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('content mutation on a tombstoned expense is rejected even if values look valid', async () => {
    // Once tombstoned, the doc is frozen at audit + deletedAt fields.
    // Bundling a "valid-looking" content edit with the soft-delete
    // would otherwise let an attacker do: soft-delete + rewrite
    // splits/amount, then later restore -> settlement replay sees
    // fabricated history. The tombstone-freeze clause
    // (changedOnly(['deletedAt','updatedBy','updatedAt']))
    // blocks this.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-vandal-2')
    await setDoc(ref, expenseBase())
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    await assertFails(
      updateDoc(ref, {
        amount:    99999,
        splits:    [{ memberId: EDITOR_UID, amount: 99999 }],
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('editing amount / splits on a tombstoned expense is rejected', async () => {
    // Tombstone-freeze regression: once an expense is soft-deleted, the
    // settlement chronological replay must be able to trust the historic
    // amount / splits values. Allowing post-tombstone mutation would
    // permit a malicious sequence: soft-delete -> edit splits to a
    // different shape -> restore -> classifier now sees fabricated
    // numbers. Rules limit post-tombstone edits to audit + deletedAt.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-7')
    await setDoc(ref, expenseBase())
    // Step 1: soft-delete (this should succeed via the null -> request.time path)
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    // Step 2: try to mutate amount on the tombstoned doc -- must fail.
    await assertFails(
      updateDoc(ref, {
        amount: 9999,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
    // Step 3: same check for splits.
    await assertFails(
      updateDoc(ref, {
        splits: [{ memberId: EDITOR_UID, amount: 50 }, { memberId: VIEWER_UID, amount: 950 }],
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('bundling amount mutation INTO the soft-delete write is rejected', async () => {
    // Attack shape: same updateDoc carries both the soft-delete
    // transition AND a fabricated amount. The earlier freeze only
    // covered AFTER-tombstoned edits; this case slips through if the
    // freeze isn't widened to "either end-state tombstoned".
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-9')
    await setDoc(ref, expenseBase())
    await assertFails(
      updateDoc(ref, {
        deletedAt: serverTimestamp(),
        amount: 9999,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('bundling splits mutation INTO the soft-delete write is rejected', async () => {
    // Same as above but with splits -- the mutation field that most
    // directly biases settlement chronological replay (gross gets
    // computed from split.memberId / amount).
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-10')
    await setDoc(ref, expenseBase())
    await assertFails(
      updateDoc(ref, {
        deletedAt: serverTimestamp(),
        splits: [
          { memberId: EDITOR_UID, amount: 50 },
          { memberId: VIEWER_UID, amount: 950 },
        ],
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('using deleteField() to drop the deletedAt field is rejected', async () => {
    // Schema invariant: once `deletedAt` is on the doc (forced at create),
    // it must stay. Allowing deleteField() would let a client erase the
    // field, sidestep the transition / freeze checks (both keyed off
    // 'deletedAt' in request.resource.data), and remove the doc from a
    // future where('deletedAt','==',null) server-side filter -- breaking
    // the query contract. Block at the rule level regardless of whether
    // the doc is currently alive or tombstoned.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-11')
    await setDoc(ref, expenseBase())
    // Try on alive doc.
    await assertFails(
      updateDoc(ref, {
        deletedAt: deleteField(),
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
    // Soft-delete, then try again on the tombstoned doc.
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    await assertFails(
      updateDoc(ref, {
        deletedAt: deleteField(),
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('clearing deletedAt to null (restore) still works after tombstone-freeze rule', async () => {
    // The freeze allows mutating ONLY the audit + deletedAt fields. A
    // pure restore (set deletedAt=null + bump updatedBy/updatedAt) must
    // still succeed even with the new diff-hasOnly clause in place.
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-8')
    await setDoc(ref, expenseBase())
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    await assertSucceeds(
      updateDoc(ref, {
        deletedAt: null,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })
})

// ─── Trip cascade-delete list queries (production 403 regression) ─
// `tripCascade.ts` lists each subcollection before delete-batching.
// Under same-doc memberIds rules the list query MUST include
// `where('memberIds', 'array-contains', uid)` — without it Firestore
// rejects the query at validation time. This test pins that the
// filtered list query succeeds for the trip owner (who owns every doc
// in the trip's subcollections).
describe('cascade-delete list queries (must include memberIds filter)', () => {
  test('owner can list each subcollection with memberIds filter (cascade prep)', async () => {
    const db = asOwner(env).firestore()
    for (const sub of ['schedules', 'expenses', 'bookings', 'wishes', 'planning', 'members'] as const) {
      const q = query(
        collection(db, 'trips', TRIP_ID, sub),
        where('memberIds', 'array-contains', OWNER_UID),
      )
      await assertSucceeds(getDocs(q))
    }
  })
})

// ─── Orphan trip-doc graceful read (Console-delete artefact) ──────
// When a trip doc is deleted (via Console without cascade, or via
// mid-cascade race) but member docs in the collection-group still
// reference its id, useMyTrips opens a tripDoc listener that points
// at a non-existent doc. Without the `resource == null` clause this
// would fire permission-denied (rule eval throws on null resource).
// We want listeners to receive snap.exists()=false cleanly instead.
describe('trip doc get on non-existent doc', () => {
  test('signed-in user gets snap.exists()=false on a never-existed tripId (no 403)', async () => {
    await assertSucceeds(
      getDoc(doc(asEditor(env).firestore(), 'trips', 'never-existed')),
    )
  })
})

// ─── Fresh-trip post-create listener path (the production 403 bug) ─
// Pins the user-reported regression where the OWNER created a brand
// new trip, then 7 listeners (useMyTrips/tripDoc + 5 useFeatureBadges +
// useSchedules + useMembers) all 403'd within milliseconds. The
// common predicate on all of them is `isMember(tripId)` which does
// `exists(/trips/{tripId}/members/{uid})`.
//
// If the emulator (which has no propagation lag) shows these passing
// here, the production bug is genuine rules-eval lag in cross-doc
// reads (a known Firebase quirk) — and the client-side retry fix is
// the right shape. If any of these FAIL here, the rule has a real bug.
describe('fresh trip — immediate listener attach (post-batch-commit)', () => {
  test('owner can batch.commit(trip + owner-member) then read every subcollection immediately', async () => {
    const NEW_TRIP_ID = 'fresh-trip'
    const ctx = asOwner(env)
    const db  = ctx.firestore()

    // Same write shape as production createTrip — atomic batch. Trip
    // doc seeds memberIds: [OWNER_UID]; owner member doc carries the
    // same roster (each member doc holds the full list so the
    // members-list rule can use same-doc check).
    const batch = writeBatch(db)
    batch.set(doc(db, 'trips', NEW_TRIP_ID), {
      title:       'Fresh',
      destination: 'Tokyo',
      ownerId:     OWNER_UID,
      memberIds:   [OWNER_UID],
      currency:    'JPY',
      startDate:   serverTimestamp(),
      endDate:     serverTimestamp(),
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    })
    batch.set(doc(db, 'trips', NEW_TRIP_ID, 'members', OWNER_UID), {
      tripId:      NEW_TRIP_ID,
      userId:      OWNER_UID,
      displayName: 'Owner',
      role:        'owner',
      memberIds:   [OWNER_UID],
      joinedAt:    serverTimestamp(),
    })
    await batch.commit()

    // All 7 listener queries that fire post-create. Single-doc reads
    // use the same-doc memberIds check (allow get: if uid in
    // resource.data.memberIds). List queries align with the rule via
    // `where('memberIds', 'array-contains', uid)`.
    await assertSucceeds(getDoc(doc(db, 'trips', NEW_TRIP_ID)))                                  // useMyTrips/tripDoc
    const filtered = (sub: string) => query(
      collection(db, 'trips', NEW_TRIP_ID, sub),
      where('memberIds', 'array-contains', OWNER_UID),
    )
    await assertSucceeds(getDocs(filtered('schedules')))                                         // useSchedules
    await assertSucceeds(getDocs(filtered('expenses')))                                          // useExpenses
    await assertSucceeds(getDocs(filtered('bookings')))                                          // useBookings
    await assertSucceeds(getDocs(filtered('wishes')))                                            // useWishes
    await assertSucceeds(getDocs(filtered('planning')))                                          // usePlanning
    await assertSucceeds(getDocs(filtered('members')))                                           // useMembers
  })

  test('stranger CANNOT bootstrap an owner-role member doc against an existing trip (BOLA)', async () => {
    // The vulnerability we're guarding: pre-fix, the bootstrap
    // branch only checked the new member doc's shape (memberId ==
    // uid, role == owner, memberIds == [uid]) without binding it
    // to a same-batch trip create. Anyone who knew a victim's
    // tripId could `setDoc(/trips/{tripId}/members/{attackerUid},
    // { role: 'owner', ... })` standalone — that would pass the
    // shape-only check, and canWrite()/canWriteFiles() would then
    // trust the forged member doc → cross-trip data access.
    //
    // Fix: bootstrap branch now requires
    //   !exists(tripPath(tripId))                      ← trip not yet committed
    //   && getAfter(tripPath(tripId)).data.ownerId == uid()
    //   && getAfter(tripPath(tripId)).data.memberIds == [uid()]
    // The first clause rejects writes against existing trips; the
    // last two anchor to the trip-create rule's own ownerId
    // enforcement, so an attacker can't fake their way through
    // even with a same-batch trip rewrite (trip create requires
    // ownerId == uid()).
    await assertFails(
      setDoc(
        doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'members', STRANGER_UID),
        {
          tripId:      TRIP_ID,
          userId:      STRANGER_UID,
          displayName: 'attacker',
          role:        'owner',
          memberIds:   [STRANGER_UID],
          joinedAt:    serverTimestamp(),
        },
      ),
    )
  })

  test('attacker CANNOT batch.commit(victim-tripId + own-owner-member) to forge ownership', async () => {
    // Defence-in-depth: even with a batch that tries to ALSO write
    // the trip doc, the trip-create rule independently rejects
    // because the target tripId already exists (existing-doc
    // writes go through update rule, which doesn't allow path-1
    // for non-owner) AND because trip-create's
    // `ownerId == uid()` check would force ownerId to attacker.
    // The combined effect of bootstrap !exists + trip create rule
    // makes the BOLA unreachable via any write shape.
    // Bind to a single Firestore instance so writeBatch + doc refs
    // share the same context (each asStranger() call mints a fresh
    // context; rules-unit-testing rejects cross-instance refs).
    const strangerDb = asStranger(env).firestore()
    const batch = writeBatch(strangerDb)
    batch.set(doc(strangerDb, 'trips', TRIP_ID), {
      title:       'pwn',
      destination: 'X',
      ownerId:     STRANGER_UID,
      memberIds:   [STRANGER_UID],
      currency:    'JPY',
      startDate:   serverTimestamp(),
      endDate:     serverTimestamp(),
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    })
    batch.set(doc(strangerDb, 'trips', TRIP_ID, 'members', STRANGER_UID), {
      tripId:      TRIP_ID,
      userId:      STRANGER_UID,
      displayName: 'attacker',
      role:        'owner',
      memberIds:   [STRANGER_UID],
      joinedAt:    serverTimestamp(),
    })
    await assertFails(batch.commit())
  })
})

// ─── Members collection-group LIST gate ────────────────────────────
describe('/{path=**}/members collection-group', () => {
  test('member can list a trip\'s member roster (filter aligned with same-doc rule)', async () => {
    // Path-specific list query now must align with the same-doc rule
    // (uid in resource.data.memberIds) via array-contains filter.
    const q = query(
      collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'members'),
      where('memberIds', 'array-contains', EDITOR_UID),
    )
    await assertSucceeds(getDocs(q))
  })
})

// ─── Member self-read (invite redeem path) ─────────────────────────
// Pins the May-2026 regression where acceptInvite's idempotency check
// (getDoc on own member path) returned 403 because the rule required
// isMember(tripId) — but the redeemer hasn't joined yet at that point.
// The fix: self-read is allowed independent of membership.
describe('/trips/{tripId}/members get with self-access', () => {
  test('non-member can getDoc their OWN member path (used by acceptInvite)', async () => {
    // STRANGER is not a member of TRIP_ID, but must be able to read
    // /trips/TRIP_ID/members/STRANGER_UID (returns "not found") so the
    // invite redeem flow can ask "am I already a member?" before writing.
    await assertSucceeds(
      getDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'members', STRANGER_UID)),
    )
  })

  test('non-member CANNOT getDoc someone else\'s member path', async () => {
    await assertFails(
      getDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'members', OWNER_UID)),
    )
  })

  test('member can getDoc any member doc in the trip (roster view)', async () => {
    await assertSucceeds(
      getDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'members', OWNER_UID)),
    )
  })

  test('signed-out CANNOT getDoc any member path', async () => {
    await assertFails(
      getDoc(doc(asAnon(env).firestore(), 'trips', TRIP_ID, 'members', OWNER_UID)),
    )
  })
})

// ─── Booking memberSync path (member self-add to memberIds) ────────
// Defence-in-depth rule path: any member can append THEIR OWN uid to
// memberIds, exactly once, with no piggybacking. The accept-invite
// cascade now runs server-side (workers/ocr/src/cascade.ts, admin SDK),
// so this rule path is rarely exercised in production — but kept as a
// safety net should the worker be unreachable. These tests check both
// the positive path and every escape hatch a malicious member might try.
describe('/trips/{tripId}/bookings memberSync (self-add path)', () => {
  test('viewer can append OWN uid to memberIds (acceptInvite sync)', async () => {
    await assertSucceeds(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID] },
      ),
    )
  })

  test('viewer CANNOT append SOMEONE ELSE\'s uid (no granting access via side door)', async () => {
    await assertFails(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, STRANGER_UID] },
      ),
    )
  })

  test('viewer CANNOT bulk-add multiple uids in one update', async () => {
    await assertFails(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID, STRANGER_UID] },
      ),
    )
  })

  test('memberSync path CANNOT piggyback other field changes', async () => {
    // The changedOnly(['memberIds']) clause must reject any extra field
    // touched in the same update — otherwise a viewer could edit booking
    // titles by smuggling them through the self-add path.
    await assertFails(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID], title: 'Hijacked' },
      ),
    )
  })

  test('non-member CANNOT use memberSync path to add themselves', async () => {
    await assertFails(
      updateDoc(
        doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, STRANGER_UID] },
      ),
    )
  })

  test('editor can still update booking content via canWrite path (no regression)', async () => {
    await assertSucceeds(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        { title: 'Renamed Hotel', updatedBy: EDITOR_UID, updatedAt: serverTimestamp() },
      ),
    )
  })

  test('editor CANNOT smuggle memberIds change through content-edit path', async () => {
    // Tightened May-2026 rule: the content path requires unchanged('memberIds'),
    // so an editor can't quietly add a stranger to the access roster while
    // editing the booking title.
    await assertFails(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        {
          title:     'Renamed',
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID, STRANGER_UID],
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        },
      ),
    )
  })

  test('editor CANNOT remove members via memberIds-only path (owner-only)', async () => {
    // The cascade branch is restricted to isTripOwner — an editor doing
    // arrayRemove on memberIds is rejected, even though the diff is
    // memberIds-only.
    await assertFails(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        { memberIds: [OWNER_UID, EDITOR_UID] },  // attempting to remove VIEWER
      ),
    )
  })

  test('owner CAN remove members via memberIds-only cascade', async () => {
    await assertSucceeds(
      updateDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        { memberIds: [OWNER_UID, EDITOR_UID] },  // owner removes VIEWER
      ),
    )
  })

  test('memberSyncSelfAdd CANNOT swap roster while adding self (P1 BOLA regression)', async () => {
    // Attack the size-delta-only version permitted: viewer (not yet
    // in BOOKING_NO_VIEWER's memberIds) writes a "new" roster that
    // adds themselves PLUS a stranger, dropping one existing member.
    // Old check: size +1, uid in new, uid not in old → all pass.
    // Fix: hasAll(old) forces new ⊇ old, so dropping an existing
    // uid AND adding a stranger in the same write is rejected.
    //
    // BOOKING_NO_VIEWER_ID seeded with memberIds=[OWNER_UID,EDITOR_UID].
    // Attack write: [OWNER_UID, VIEWER_UID, STRANGER_UID] -- size +1
    // but drops EDITOR_UID and inserts STRANGER_UID.
    await assertFails(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, VIEWER_UID, STRANGER_UID] },
      ),
    )
  })

  test('ownerSyncRemove CANNOT swap roster while removing one (same-class fix)', async () => {
    // Same family as the memberSyncSelfAdd BOLA: size delta -1
    // alone would let an owner remove one member AND add a
    // stranger in one write. hasAll(new) forces new ⊆ old.
    //
    // BOOKING_ID seeded with [OWNER_UID, EDITOR_UID, VIEWER_UID].
    // Attack: [OWNER_UID, EDITOR_UID, STRANGER_UID] -- size 3→3
    // actually fails size check; try size 3→2: [OWNER_UID, STRANGER_UID]
    // drops EDITOR + VIEWER and adds STRANGER (size delta -1 ish).
    // Simpler: same size, different shape would fail size check
    // alone, so test the "drop one + add stranger" both at -1.
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        // size 3 → 2, dropping EDITOR + VIEWER, adding STRANGER.
        { memberIds: [OWNER_UID, STRANGER_UID] },
      ),
    )
  })
})

// ─── Settlement / expense financial integrity (engine input gates) ─
describe('expense + settlement create: settlement-engine input validation', () => {
  test('expense create with paidBy NOT in memberIds is rejected', async () => {
    // computeBalancesFull reads paidBy directly into gross[from][to]
    // tables. A raw-SDK writer pointing paidBy at a non-member uid
    // would create dangling debt edges -- the rule now requires
    // paidBy be in the doc's own memberIds.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-bad-paidby'),
        {
          tripId: TRIP_ID, title: 'x',
          amount: 100, currency: 'JPY', category: 'food',
          paidBy: STRANGER_UID,            // <-- not in memberIds
          splits: [{ memberId: EDITOR_UID, amount: 100 }],
          date: '2026-05-21',
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
          createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          deletedAt: null, receiptPurgedAt: null,
        },
      ),
    )
  })

  test('expense create with non-3-char currency is rejected', async () => {
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-bad-ccy'),
        {
          tripId: TRIP_ID, title: 'x',
          amount: 100, currency: 'JapaneseYen',   // <-- not 3 chars
          category: 'food',
          paidBy: EDITOR_UID,
          splits: [{ memberId: EDITOR_UID, amount: 100 }],
          date: '2026-05-21',
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
          createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          deletedAt: null, receiptPurgedAt: null,
        },
      ),
    )
  })

  test('expense create with backdated createdAt is rejected', async () => {
    // Settlement chronological replay sorts expenses by createdAt.
    // A raw-SDK writer backdating an expense before an existing
    // settlement would silently re-classify orphans (e.g.
    // OVERPAYMENT → EXPENSE_DELETED), corrupting the audit log.
    // Rule pins createdAt == request.time on create.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-backdate'),
        {
          tripId: TRIP_ID, title: 'x',
          amount: 100, currency: 'JPY', category: 'food',
          paidBy: EDITOR_UID,
          splits: [{ memberId: EDITOR_UID, amount: 100 }],
          date: '2026-05-21',
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
          createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
          createdAt: Timestamp.fromMillis(1_000_000),  // <-- 1970
          updatedAt: serverTimestamp(),
          deletedAt: null, receiptPurgedAt: null,
        },
      ),
    )
  })

  test('settlement create with backdated createdAt is rejected', async () => {
    // Same chronological-replay attack vector but on settlements:
    // backdating a settlement before an expense would flip the
    // orphan reason classification.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-backdate'),
        {
          tripId:    TRIP_ID,
          settledBy: EDITOR_UID,
          toUid:     EDITOR_UID,
          fromUid:   VIEWER_UID,
          amount:    100,
          currency:  'JPY',
          createdAt: Timestamp.fromMillis(1_000_000),  // <-- backdate
        },
      ),
    )
  })
})
