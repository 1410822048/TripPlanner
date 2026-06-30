// tests/rules/firestore.test.ts
// Critical-path coverage for firestore.rules. Each test asserts ONE
// assumption that real bugs in this codebase have already broken at
// least once:
//   - L3 (R3) regression: list-vs-get permission gap. A user who is a
//     non-owner member of any trip got 403 when trip fetching switched to
//     a `where(documentId, 'in', ids)` query because root /trips LIST is closed.
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

  // The L3 regression: no client can list /trips, even by exact id. The
  // app lists accessible trips through the /members collection-group query.
  test('LIST: editor cannot query trips by documentId in [...] (closed root LIST)', async () => {
    const q = query(
      collection(asEditor(env).firestore(), 'trips'),
      where(documentId(), 'in', [TRIP_ID]),
    )
    await assertFails(getDocs(q))
  })

  test('LIST: owner cannot query trips with their own ownerId filter', async () => {
    const q = query(
      collection(asOwner(env).firestore(), 'trips'),
      where('ownerId', '==', OWNER_UID),
    )
    await assertFails(getDocs(q))
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
    // creates a new doc AFTER device A triggered cascade, in
    // the window between Worker's subcollection-drain and trip-
    // doc-delete. Without the tripNotDeleting gate the new doc
    // survives the cascade and becomes an orphan.
    //
    // Use BOOKING (not expense) here because expense create is
    // now Worker-only (`allow create: if false`) for splits
    // validation -- it would assertFails for the WRONG reason.
    // Booking still uses canWrite + tripNotDeleting client-side
    // so this isolates the deletingAt gate.
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        { deletingAt: serverTimestamp() },
      )
    })
    const bookingPayload = {
      tripId: TRIP_ID,
      type:   'hotel',
      title:  'mid-cascade race',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      sortDate: serverTimestamp(),
    }
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-race'),
        bookingPayload,
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

  // ─── booking files are Worker-authoritative ──────────────────────
  // Phase 3.6 commit 3: the field is forbidden on client setDoc CREATE
  // and locked to "unchanged or removed (deleteField)" on client UPDATE.
  // The Worker /booking-file-create + /booking-file-update endpoints
  // (Admin SDK, rules-bypass) are the ONLY writers of these fields — they
  // gate writes behind the upload-intent's used / expires / stale guards.
  // These tests pin the gate so a future rule edit can't silently re-
  // open the raw-SDK direct-write path that would bypass those guards.
  const BOOKING_FILE_VALUE = {
    filePath:  'trips/trip-1/bookings/b-att/file.webp',
    fileType:  'image/webp',
  }

  test('booking create WITHOUT files is allowed (happy: doc-first → Worker patches)', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-noatt'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('booking create WITH coverImage is denied (would bypass /booking-file-* intent guards)', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-att'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        coverImage: BOOKING_FILE_VALUE,
      }),
    )
  })

  test('booking create WITH document is denied (would bypass /booking-file-* intent guards)', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-doc'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        document: BOOKING_FILE_VALUE,
      }),
    )
  })

  test('booking update with file fields absent is allowed (text-only edit)', async () => {
    // The seeded BOOKING_ID has no coverImage/document; an updateDoc that doesn't
    // mention either file field should pass — `unchangedOrRemoved` returns
    // true when the field is absent on both sides (both via `unchanged()`
    // diff and via `!(field in request.resource.data)`).
    await assertSucceeds(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        title: 'Edited',
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('booking update adding coverImage (client→server forge) is denied', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        coverImage: BOOKING_FILE_VALUE,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('booking update adding document (client→server forge) is denied', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        document: BOOKING_FILE_VALUE,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  describe('with pre-attached document (seeded via rules-bypass)', () => {
    // Seed a booking that ALREADY has a document (simulating the post-
    // /booking-file-* state) so we can test the "unchanged" / "removed"
    // / "changed" branches of unchangedOrRemoved('document').
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async ctx => {
        const db = ctx.firestore()
        await setDoc(doc(db, 'trips', TRIP_ID, 'bookings', 'b-with-att'), {
          tripId: TRIP_ID, type: 'hotel', title: 'With Attachment',
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
          createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          sortDate:  serverTimestamp(),
          document: BOOKING_FILE_VALUE,
        })
      })
    })

    test('text edit with document untouched is allowed (unchanged branch)', async () => {
      await assertSucceeds(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-with-att'), {
          title: 'Renamed',
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })

    test('detach via deleteField() is allowed (removed branch — Worker storage-scan reaps blob)', async () => {
      await assertSucceeds(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-with-att'), {
          document: deleteField(),
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })

    test('changing document to a different value is denied (must route through Worker)', async () => {
      await assertFails(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-with-att'), {
          document: {
            ...BOOKING_FILE_VALUE,
            filePath: 'trips/trip-1/bookings/b-with-att/different.webp',
          },
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })
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

  // ─── hasOnly() allowlist + is-string type guards ──────────────────
  // Defense in depth: raw-SDK writers shouldn't be able to stuff
  // arbitrary extra fields ("evilField") or smuggle non-string payloads
  // into a `.size()`-capped slot (e.g. an array that satisfies size but
  // corrupts the doc shape).

  test('booking create with extra unrecognized field is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-extra'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        evilField: 'arbitrary data that should not pass',
      }),
    )
  })

  test('booking create with non-string note (array) is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-typ'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        // .size() works on lists too; without `is string` this would
        // pass the cap while corrupting the shape.
        note: ['a', 'b', 'c'],
      }),
    )
  })

  test('booking create with non-string provider (map) is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-typ2'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        provider: { key: 'value' },
      }),
    )
  })

  // SECURITY: rules string caps must stay in three-way lockstep with
  // workers/ocr/src/booking-write.ts (Worker uses admin SDK → bypasses
  // rules → looser-than-rules side becomes a real exploit) AND
  // src/types/booking.ts (UX consistency: client preview vs server
  // accept must agree). Cover the no-file path which is the ONLY
  // client-side setDoc surface for bookings now that file-create /
  // file-update are Worker-authoritative — these tests guard against
  // a raw-SDK writer slipping a 101-char title past the rules cap.
  test('booking create with title over 100 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-cap-title'), {
        tripId: TRIP_ID, type: 'hotel', title: 'x'.repeat(101),
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('booking create with address over 500 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-cap-addr'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        address: 'x'.repeat(501),
      }),
    )
  })

  // ─── booking.link http(s)-only gate ──────────────────────────────
  // link renders into an <a href>, so the rule restricts it to
  // `^https?://.+` (mirrors isHttpUrl in src/types/booking.ts +
  // workers/ocr/src/booking-write.ts). These pin the allow + deny
  // halves so a future rule edit can't silently re-open a javascript:
  // stored-XSS path on the raw-SDK client surface.
  test('booking create with a valid https link is allowed', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-link-ok'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        link: 'https://www.booking.com/hotel/jp/abc.html',
      }),
    )
  })

  test('booking create with a javascript: link is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-link-xss'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        link: 'javascript:alert(document.cookie)',
      }),
    )
  })

  test('booking create with link over 500 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-link-cap'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        link: 'https://e.com/' + 'x'.repeat(500),
      }),
    )
  })

  // The regex is intentionally lowercase-only; isHttpUrl (client + Worker)
  // matches it by rejecting uppercase schemes too, so the three layers
  // accept the same canonical set (no Worker-written value can later jam
  // a client update).
  test('booking create with an UPPERCASE scheme link is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-link-upper'), {
        tripId: TRIP_ID, type: 'hotel', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
        link: 'HTTPS://example.com',
      }),
    )
  })

  test('booking update with title over 100 chars is rejected', async () => {
    // The companion to "booking create with title over 100 chars" —
    // update path has its own size predicate block in firestore.rules
    // (lines 867-893) that previously drifted (was 200) and was tightened
    // 2026-05-27. This test pins both create + update to the same cap.
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        title:     'x'.repeat(101),
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
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

  // ─── wish.image is Worker-authoritative ──────────────────────────
  // Same Phase 3.6 commit 3 lock as booking file fields above.
  const IMAGE_VALUE = {
    path:      'trips/trip-1/wishes/w-img/file.webp',
    thumbPath: 'trips/trip-1/wishes/w-img/thumb.webp',
  }

  test('wish create WITHOUT image is allowed (happy: doc-first → Worker patches)', async () => {
    await assertSucceeds(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-noimg'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('wish create WITH image is denied (would bypass /wish-file-* intent guards)', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-img'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        image: IMAGE_VALUE,
      }),
    )
  })

  test('proposer update with image field absent is allowed (text-only edit)', async () => {
    // Seeded WISH_ID has no image; proposer (EDITOR) can edit text.
    await assertSucceeds(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        title: 'Edited',
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('proposer adding image (client→server forge) is denied', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        image: IMAGE_VALUE,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  describe('with pre-attached image (seeded via rules-bypass)', () => {
    // Wish doc that ALREADY carries an image (post-/wish-file-* state).
    // Proposer is EDITOR_UID to align with the proposer-update rule path.
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async ctx => {
        const db = ctx.firestore()
        await setDoc(doc(db, 'trips', TRIP_ID, 'wishes', 'w-with-img'), {
          tripId: TRIP_ID, category: 'place', title: 'With Image',
          proposedBy: EDITOR_UID, updatedBy: EDITOR_UID, votes: [EDITOR_UID],
          memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          image: IMAGE_VALUE,
        })
      })
    })

    test('text edit with image untouched is allowed (unchanged branch)', async () => {
      await assertSucceeds(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-with-img'), {
          title: 'Renamed',
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })

    test('detach via deleteField() is allowed (removed branch)', async () => {
      await assertSucceeds(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-with-img'), {
          image: deleteField(),
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })

    test('changing image to a different value is denied (must route through Worker)', async () => {
      await assertFails(
        updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-with-img'), {
          image: {
            ...IMAGE_VALUE,
            path:      'trips/trip-1/wishes/w-with-img/different.webp',
            thumbPath: 'trips/trip-1/wishes/w-with-img/different-thumb.webp',
          },
          updatedBy: EDITOR_UID,
          updatedAt: serverTimestamp(),
        }),
      )
    })
  })

  // ─── hasOnly() allowlist + is-string type guards ──────────────────

  test('wish create with extra unrecognized field is rejected', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-extra'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        rogueField: 'should be rejected by hasOnly()',
      }),
    )
  })

  test('wish create with non-string description (array) is rejected', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-typ'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        description: ['x', 'y'],
      }),
    )
  })

  // SECURITY: same three-way cap lockstep as booking — wish text-only
  // create/update goes through this client setDoc path (only image
  // create/update is Worker-authoritative). Rules looser than client
  // Zod (`src/types/wish.ts`) lets a raw-SDK writer bypass the form
  // cap. Tightened 2026-05-27 to match Zod: title 100, description
  // 500, address 500, link 500.
  test('wish create with title over 100 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-cap-title'), {
        tripId: TRIP_ID, category: 'place', title: 'x'.repeat(101),
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('wish create with address over 500 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-cap-addr'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        address: 'x'.repeat(501),
      }),
    )
  })

  test('wish create with link over 500 chars is rejected', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-cap-link'), {
        tripId: TRIP_ID, category: 'place', title: 'X',
        proposedBy: VIEWER_UID, updatedBy: VIEWER_UID, votes: [VIEWER_UID],
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        link: 'x'.repeat(501),
      }),
    )
  })

  test('wish update with title over 100 chars is rejected (proposer path)', async () => {
    // Seeded WISH_ID's proposer is EDITOR_UID. The proposer-path size
    // predicate (firestore.rules lines 741-753) was tightened
    // 2026-05-27 — this pins both create + update to the same cap.
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        title:     'x'.repeat(101),
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('wish update with description over 500 chars is rejected (proposer path)', async () => {
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        description: 'x'.repeat(501),
        updatedBy:   EDITOR_UID,
        updatedAt:   serverTimestamp(),
      }),
    )
  })
})

// ─── Expense create is Worker-only (allow create: if false) ────────
//
// All expense create + content-update flows go through the Worker's
// /expense-create and /expense-update endpoints. firestore.rules has
// `allow create: if false` on expense; client setDoc is REJECTED
// regardless of payload shape. Receipt-shape / paidBy-in-roster /
// splits-sum / URL-binding / DoS-cap validations live in
// workers/ocr/src/expense-validate.ts and are tested in
// workers/ocr/test/expense-validate.spec.ts.
describe('/trips/{tripId}/expenses create (Worker-only)', () => {
  function expenseShape() {
    return {
      tripId: TRIP_ID, title: 'X',
      amountMinor: 1000, currency: 'JPY',
      category: 'food',
      paidBy: EDITOR_UID,
      splits: [{ memberId: EDITOR_UID, amountMinor: 1000 }],
      date: '2026-05-19',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      deletedAt: null,
      receiptPurgedAt: null,
    }
  }

  test('client setDoc create is rejected (any role, any shape) -- Worker owns this path', async () => {
    // Even a perfectly-valid payload is rejected: rules can't
    // express splits[i] shape / member-in-roster / Σsplits=amount,
    // so the safe answer is "no client write at all". Worker
    // /expense-create owns admin SDK write after validating the
    // full payload.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-client-create'),
        expenseShape(),
      ),
    )
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-client-create-owner'),
        expenseShape(),
      ),
    )
  })
})

describe('/trips/{tripId}/expenses soft-delete (phase-2)', () => {
  // Seed shape mirrors what the Worker /expense-create would write
  // (including memberIds + createdAt/updatedAt = serverTimestamp).
  // The CREATE shape tests that used to live in this describe block
  // (deletedAt/receiptPurgedAt presence, forge rejection, etc.) all
  // moved to the Worker validation layer when client setDoc became
  // `allow create: if false`. Soft-delete + restore + tombstone-
  // freeze tests stay here because those go through client SDK
  // (rules-gated changedOnly([deletedAt,updatedBy,updatedAt])).
  function expenseBase(overrides: Record<string, unknown> = {}) {
    return {
      tripId: TRIP_ID, title: 'X',
      amountMinor: 1000, currency: 'JPY',
      category: 'food',
      paidBy: EDITOR_UID,
      splits: [{ memberId: EDITOR_UID, amountMinor: 1000 }],
      date: '2026-05-19',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      deletedAt: null,
      receiptPurgedAt: null,
      ...overrides,
    }
  }

  /** Admin-SDK seed (bypasses rules) -- expense client setDoc is
   *  blocked under the Worker-only contract, so tests that want a
   *  pre-existing expense to update/delete have to use this. */
  async function seedExpense(expenseId: string, overrides: Record<string, unknown> = {}) {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'expenses', expenseId),
        expenseBase(overrides),
      )
    })
  }

  test('editor can soft-delete (update with deletedAt=serverTimestamp)', async () => {
    await seedExpense('e-soft-3')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-3')
    // serverTimestamp resolves to request.time inside the rule -- the
    // transition check accepts it (null -> request.time path).
    await assertSucceeds(
      updateDoc(ref, { deletedAt: serverTimestamp(), updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('editor cannot soft-delete an expense locked by a settlement', async () => {
    await seedExpense('e-soft-locked', {
      settlementLockIds: ['settlement-1'],
    })
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-locked')
    await assertFails(
      updateDoc(ref, { deletedAt: serverTimestamp(), updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('owner can soft-delete an expense locked by a settlement', async () => {
    await seedExpense('e-soft-locked-owner', {
      settlementLockIds: ['settlement-1'],
    })
    const ref = doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-locked-owner')
    await assertSucceeds(
      updateDoc(ref, { deletedAt: serverTimestamp(), updatedBy: OWNER_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('editor CAN soft-delete an expense whose settlementLockIds is empty (size()==0 unlocks)', async () => {
    // After the last referencing settlement is deleted, the Worker leaves
    // the ref set present-but-empty. Empty ⇔ unlocked, so a normal editor
    // regains the soft-delete path — locks the `size() == 0` rule branch.
    await seedExpense('e-soft-unlocked', { settlementLockIds: [] })
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-unlocked')
    await assertSucceeds(
      updateDoc(ref, { deletedAt: serverTimestamp(), updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('soft-delete with a backdated Timestamp is rejected (no client backdate)', async () => {
    await seedExpense('e-soft-3b')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-3b')
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
    await seedExpense('e-soft-4', { deletedAt: null })
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-4')
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
    await seedExpense('e-legacy-2')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-legacy-2')
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
    await seedExpense('e-soft-5')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-5')
    await assertFails(
      updateDoc(ref, { deletedAt: 'maybe-later', updatedBy: EDITOR_UID, updatedAt: serverTimestamp() }),
    )
  })

  test('editor hard-delete (deleteDoc) is rejected -- soft-delete only', async () => {
    await seedExpense('e-soft-6')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-6')
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
    await seedExpense('e-soft-6b')
    // Pre-P1-fix this was conditionally allowed via a deletionStartedAt
    // window on the trip doc. Post-fix the rule is `allow delete: if
    // false` -- no client (including owner) can hard-delete from
    // Firestore directly. Cascade workflow runs through the Worker
    // (/cascade-trip-delete) which uses Admin SDK and bypasses rules.
    await assertFails(
      deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-6b')),
    )
  })

  test('editor cannot mutate content fields via raw SDK (Worker-only path)', async () => {
    // Pre-Worker-migration the rule's content-field type checks
    // (title.size > 0, amount > 0, etc.) were the only defense
    // against "update-as-hard-delete" vandalism. Now ALL content
    // edits are blocked at the rule layer via changedOnly([
    // deletedAt, updatedBy, updatedAt]); the Worker /expense-update
    // is the only path that can change title / amount / splits /
    // category / paidBy / note / receipt. raw-SDK content writes
    // fail regardless of the values supplied.
    await seedExpense('e-vandal-1')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-vandal-1')
    // Even a "well-formed" content edit (title='X', amount=1,
    // valid splits) is rejected -- the field isn't in the
    // changedOnly allowlist.
    await assertFails(
      updateDoc(ref, {
        title:     'X',
        amountMinor:    1,
        splits:    [{ memberId: EDITOR_UID, amountMinor: 1 }],
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
    await seedExpense('e-vandal-2')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-vandal-2')
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    await assertFails(
      updateDoc(ref, {
        amountMinor:    99999,
        splits:    [{ memberId: EDITOR_UID, amountMinor: 99999 }],
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
    await seedExpense('e-soft-7')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-7')
    // Step 1: soft-delete (this should succeed via the null -> request.time path)
    await updateDoc(ref, {
      deletedAt: serverTimestamp(),
      updatedBy: EDITOR_UID,
      updatedAt: serverTimestamp(),
    })
    // Step 2: try to mutate amount on the tombstoned doc -- must fail.
    await assertFails(
      updateDoc(ref, {
        amountMinor: 9999,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
    // Step 3: same check for splits.
    await assertFails(
      updateDoc(ref, {
        splits: [{ memberId: EDITOR_UID, amountMinor: 50 }, { memberId: VIEWER_UID, amountMinor: 950 }],
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
    await seedExpense('e-soft-9')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-9')
    await assertFails(
      updateDoc(ref, {
        deletedAt: serverTimestamp(),
        amountMinor: 9999,
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('bundling splits mutation INTO the soft-delete write is rejected', async () => {
    // Same as above but with splits -- the mutation field that most
    // directly biases settlement chronological replay (gross gets
    // computed from split.memberId / amount).
    await seedExpense('e-soft-10')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-10')
    await assertFails(
      updateDoc(ref, {
        deletedAt: serverTimestamp(),
        splits: [
          { memberId: EDITOR_UID, amountMinor: 50 },
          { memberId: VIEWER_UID, amountMinor: 950 },
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
    await seedExpense('e-soft-11')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-11')
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
    await seedExpense('e-soft-8')
    const ref = doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'expenses', 'e-soft-8')
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

// ─── Member reads are member-only ─────────────────────────────────
// Invite redeem is Worker-authoritative now; the client no longer does
// a pre-redeem self-get on /members/{uid}.
describe('/trips/{tripId}/members get with self-access', () => {
  test('non-member cannot getDoc their OWN member path', async () => {
    await assertFails(
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

// ─── Booking membership projection writes are Worker-only ─────────
// Membership changes are routed through /invite-redeem, /member-remove,
// and /member-role-update. Clients may edit booking content through the
// normal canWrite path, but cannot directly mutate denormalized memberIds.
describe('/trips/{tripId}/bookings membership projection writes are Worker-only', () => {
  test('viewer CANNOT append own uid to memberIds directly', async () => {
    await assertFails(
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

  test('direct membership projection write CANNOT piggyback other field changes', async () => {
    // Projection writes are Worker-only; this also guards against a viewer
    // editing booking titles by smuggling them through a memberIds write.
    await assertFails(
      updateDoc(
        doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_NO_VIEWER_ID),
        { memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID], title: 'Hijacked' },
      ),
    )
  })

  test('non-member CANNOT add themselves through memberIds projection', async () => {
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

  test('owner CANNOT remove members via client memberIds-only cascade', async () => {
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID),
        { memberIds: [OWNER_UID, EDITOR_UID] },  // owner removes VIEWER
      ),
    )
  })

  test('direct self-add CANNOT swap roster while adding self (P1 BOLA regression)', async () => {
    // Projection writes are closed entirely. This locks the older BOLA
    // regression shape too: viewer writes a "new" roster that adds
    // themselves plus a stranger while dropping an existing member.
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

  test('direct owner remove CANNOT swap roster while removing one (same-class fix)', async () => {
    // Same family as the self-add BOLA: size delta -1 alone would let
    // an owner remove one member and add a stranger in one write.
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

// ─── Settlement create / delete are Worker-only (M4 close) ─────────
//
// firestore.rules has `allow create: if false` and `allow delete: if false`
// on /trips/{tripId}/settlements; the domain invariant
// `amount <= pairwise[fromUid][toUid]` (sum of expense.splits for that
// uid pair minus already-applied settlements) can't be expressed in
// CEL — no array reduce, no cross-doc sum. The Worker endpoints
// /settlement-create and /settlement-delete own this path; per-payload
// validation (settledBy=token, toUid=caller, fromUid distinct + real
// member, amount int>0, currency 3-char, createdAt pinned to request
// time, recorder-or-owner delete, idempotent retry payload-match) is
// covered in workers/ocr/test/settlement-write.spec.ts.
//
// `allow read` stays open to trip members so the SettlementSummary
// realtime listener works; the read test below guards against an
// accidental over-close.
describe('/trips/{tripId}/settlements client write rejection (Worker-only)', () => {
  function settlementShape() {
    return {
      tripId:    TRIP_ID,
      settledBy: EDITOR_UID,
      toUid:     EDITOR_UID,    // receiver = caller
      fromUid:   VIEWER_UID,    // payer = distinct, real member
      amountMinor:    100,
      currency:  'JPY',
      createdAt: serverTimestamp(),
    }
  }

  test('trip member can read settlements (SettlementSummary listener path)', async () => {
    // M4 closed create / delete but read stays member-gated. Guard
    // against an accidental `allow read: if false` regression that
    // would break the realtime listener client-side.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'settlements', 's-readable'),
        {
          tripId: TRIP_ID, settledBy: EDITOR_UID, toUid: EDITOR_UID,
          fromUid: VIEWER_UID, amountMinor: 100, currency: 'JPY',
          createdAt: serverTimestamp(),
        },
      )
    })
    await assertSucceeds(
      getDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-readable')),
    )
  })

  test('client setDoc create is rejected (any role, any shape) -- Worker owns this path', async () => {
    // Even a fully valid payload is rejected: the cross-doc pairwise
    // debt check requires admin SDK reads of every expense + every
    // prior settlement under the same tx, which client rules can't do.
    await assertFails(
      setDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-client-create'),
        settlementShape(),
      ),
    )
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-client-create-owner'),
        settlementShape(),
      ),
    )
  })

  test('client deleteDoc is rejected even by the original recorder or trip owner', async () => {
    // Recorder-or-owner moderation USED to be a client-side delete
    // path (rules: `settledBy == uid() || isTripOwner(tripId)`). After
    // M4 it's Worker-only because /settlement-delete must touch the
    // per-pair lock doc inside the same tx as create -- a client-SDK
    // delete would bypass the lock and a concurrent Worker create
    // could miss the deleted row in its runQuery snapshot.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'settlements', 's-client-del'),
        {
          tripId: TRIP_ID, settledBy: EDITOR_UID, toUid: EDITOR_UID,
          fromUid: VIEWER_UID, amountMinor: 100, currency: 'JPY',
          createdAt: serverTimestamp(),
        },
      )
    })
    await assertFails(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-client-del')),
    )
    await assertFails(
      deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-client-del')),
    )
  })

  test('client updateDoc is rejected (settlements are append-only)', async () => {
    // No `allow update` ever existed on settlements — chronological
    // replay sorts by createdAt and any in-place mutation would
    // silently corrupt the orphan-reason classification. This test
    // guards against a future regression that adds an allow update.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'settlements', 's-client-upd'),
        {
          tripId: TRIP_ID, settledBy: EDITOR_UID, toUid: EDITOR_UID,
          fromUid: VIEWER_UID, amountMinor: 100, currency: 'JPY',
          createdAt: serverTimestamp(),
        },
      )
    })
    await assertFails(
      updateDoc(
        doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'settlements', 's-client-upd'),
        { amountMinor: 1 },
      ),
    )
  })
})

// ─── Planning: hasOnly() allowlist + is-string type guards ─────────
describe('/trips/{tripId}/planning shape guards', () => {
  test('planning create with extra unrecognized field is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-extra'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        done: false,
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        unwantedField: 'should be rejected by hasOnly()',
      }),
    )
  })

  test('planning create with non-string note (number) is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-typ'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        done: false,
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        note: 999,  // size() doesn't exist on number → predicate evaluates falsy
      }),
    )
  })

  test('planning create with valid optional note succeeds', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-ok'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        done: false,
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        note: 'remember the charger',
      }),
    )
  })

  // ─── Nested value-type guards (done/doneBy/doneAt) ──────────────

  test('planning create without `done` field is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-nodone'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('planning create with non-bool `done` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-strdone'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        done: 'yes',  // string, not bool
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('planning create with non-timestamp `doneAt` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-strdoneat'), {
        tripId: TRIP_ID, category: 'essentials', title: 'X',
        done: true,
        doneAt: 'tomorrow',  // string, not Timestamp
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })
})

// ─── Schedule nested shape guards (order + location.*) ─────────────
describe('/trips/{tripId}/schedules shape guards', () => {
  const baseSchedule = (overrides: Record<string, unknown> = {}) => ({
    tripId: TRIP_ID,
    date: '2026-05-22',
    order: 0,
    title: 'Tokyo Tower',
    category: 'activity' as const,
    memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
    createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  })

  test('schedule create without `order` is rejected', async () => {
    const { order: _, ...rest } = baseSchedule()
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-noorder'), rest),
    )
  })

  test('schedule create with non-number `order` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-strorder'),
        baseSchedule({ order: 'first' })),
    )
  })

  test('schedule create with non-string `location.name` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-loc1'),
        baseSchedule({ location: { name: ['evil', 'array'] } })),
    )
  })

  test('schedule create with non-number `location.lat` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-loc2'),
        baseSchedule({ location: { name: 'OK', lat: 'thirty-five' } })),
    )
  })

  test('schedule create with valid location shape succeeds', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-locok'),
        baseSchedule({
          location: { name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454 },
        })),
    )
  })

  // Money domain post-refactor: schedule budget is stored as integer
  // minor units in `estimatedCostMinor`. Rules allowlist + validator
  // were renamed in lockstep with the client schema; legacy
  // `estimatedCost` must now be rejected by the hasOnly allowlist.
  test('schedule create with valid `estimatedCostMinor` succeeds', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-cost-ok'),
        baseSchedule({ estimatedCostMinor: 12000 })),
    )
  })

  test('schedule create with non-integer `estimatedCostMinor` is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-cost-float'),
        baseSchedule({ estimatedCostMinor: 12.34 })),
    )
  })

  test('schedule create with legacy `estimatedCost` field is rejected by allowlist', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-cost-legacy'),
        baseSchedule({ estimatedCost: 100 })),
    )
  })
})

// ─── memberIdsMatchTrip create-time injection guards ───────────────
// Every collaborative entity (booking/schedule/wish/planning) uses
// `memberIdsMatchTrip(tripId)` on create to block a raw-SDK editor
// from injecting stranger uids into the new doc's memberIds[]. The
// per-entity describe blocks above test happy-path with the correct
// roster; here we pin the rejection path: a superset including any
// uid not in the trip's memberIds must fail across ALL four entities.
// Without this guard, a malicious editor could fake "stranger is on
// this trip" and surface the doc on the stranger's UI (via the
// memberIds array-contains list filter every page uses).
describe('memberIdsMatchTrip create-time injection guards', () => {
  const withStranger = [OWNER_UID, EDITOR_UID, VIEWER_UID, STRANGER_UID]

  test('booking create with stranger uid injected into memberIds is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'b-inj'), {
        tripId: TRIP_ID, type: 'hotel', title: 'Injection attempt',
        memberIds: withStranger,
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('schedule create with stranger uid injected into memberIds is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'schedules', 's-inj'), {
        tripId: TRIP_ID, date: '2026-05-22', order: 0,
        title: 'Injection attempt', category: 'activity',
        memberIds: withStranger,
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('wish create with stranger uid injected into memberIds is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'wishes', 'w-inj'), {
        tripId: TRIP_ID, category: 'place', title: 'Injection attempt',
        proposedBy: EDITOR_UID, updatedBy: EDITOR_UID, votes: [EDITOR_UID],
        memberIds: withStranger,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('planning create with stranger uid injected into memberIds is rejected', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'planning', 'p-inj'), {
        tripId: TRIP_ID, category: 'essentials', title: 'Injection attempt',
        done: false,
        memberIds: withStranger,
        createdBy: EDITOR_UID, updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
  })
})

// ─── Orphan blob purge queue (_purges) ─────────────────────────────
// Members enqueue purges when in-process Storage cleanup gave up.
// Worker cron drains. Trust boundary: members can ONLY enqueue paths
// + entityRefs that live under their own trip; rules block client
// updates/deletes so a malicious member can't rapid-delete to defeat
// cleanup.
describe('/trips/{tripId}/_purges enqueue', () => {
  const validPurge = (overrides: Record<string, unknown> = {}) => ({
    tripId:    TRIP_ID,
    entityRef: `trips/${TRIP_ID}/expenses/exp-1`,
    path:      `trips/${TRIP_ID}/expenses/exp-1/abc.webp`,
    source:    'updateExpense/purge-old-receipt',
    attempts:  0,
    createdAt: serverTimestamp(),
    ...overrides,
  })

  test('member can enqueue a purge for their own trip', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p1'),
        validPurge()),
    )
  })

  test('viewer can also enqueue (read-only role still triggers cleanup paths)', async () => {
    await assertSucceeds(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, '_purges', 'p2'),
        validPurge()),
    )
  })

  test('rejects path outside this trip', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p3'),
        validPurge({ path: 'trips/OTHER-TRIP/expenses/exp-1/abc.webp' })),
    )
  })

  test('rejects entityRef outside this trip', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p4'),
        validPurge({ entityRef: `trips/OTHER-TRIP/expenses/exp-1` })),
    )
  })

  test('rejects entityRef with bogus collection name', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p5'),
        validPurge({ entityRef: `trips/${TRIP_ID}/evil/exp-1` })),
    )
  })

  test('rejects schedule entityRef (no attachment fields -- borrow-the-blade vector)', async () => {
    // Schedule entities don't store Storage paths, so a cron processing
    // them would treat ANY path as orphan. Enqueueing schedule
    // entityRef + an arbitrary booking attachment path would mass-delete
    // legit blobs. Rules block schedule entityRef outright.
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p5b'),
        validPurge({ entityRef: `trips/${TRIP_ID}/schedules/sched-1` })),
    )
  })

  test('rejects path/entityRef cross-collection mismatch', async () => {
    // entityRef points at an expense, path points at a real booking
    // attachment folder. Without the path.matches(entityRef + ...)
    // gate, the cron would read the expense (no booking path in its
    // receipt field), confirm "orphan", and delete the booking blob.
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p5c'),
        validPurge({
          entityRef: `trips/${TRIP_ID}/expenses/exp-1`,
          path:      `trips/${TRIP_ID}/bookings/b-victim/legit-attachment.webp`,
        })),
    )
  })

  test('rejects path outside entityRef folder even within same collection', async () => {
    // entityRef: expense A, path: expense B's receipt → also rejected.
    // Same class of borrow-the-blade vector but across siblings.
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p5d'),
        validPurge({
          entityRef: `trips/${TRIP_ID}/expenses/exp-1`,
          path:      `trips/${TRIP_ID}/expenses/exp-victim/legit.webp`,
        })),
    )
  })

  test('rejects attempts != 0 on create (Worker-only state)', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p6'),
        validPurge({ attempts: 1 })),
    )
  })

  test('rejects extra unrecognized field (hasOnly allowlist)', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p7'),
        validPurge({ rogueField: 'data' })),
    )
  })

  test('rejects client update (Worker-only via admin SDK)', async () => {
    // First enqueue a purge as a baseline...
    await setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p8'),
      validPurge())
    // ...then a client attempt to bump attempts must be rejected.
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p8'),
        { attempts: 1 }),
    )
  })

  test('rejects client delete (Worker-only via admin SDK)', async () => {
    await setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p9'),
      validPurge())
    await assertFails(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p9')),
    )
  })

  test('non-member cannot enqueue', async () => {
    await assertFails(
      setDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, '_purges', 'p10'),
        validPurge()),
    )
  })

  test('even trip members cannot read _purges (write-only enqueue surface)', async () => {
    // Seed an entry via the create path (still allowed), then assert
    // no client role can read it. Ops introspection goes via Firebase
    // Console (admin auth bypasses rules), not via the client.
    await setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p-readtest'),
      validPurge())
    await assertFails(
      getDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, '_purges', 'p-readtest')),
    )
    await assertFails(
      getDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, '_purges', 'p-readtest')),
    )
    await assertFails(
      getDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, '_purges', 'p-readtest')),
    )
  })
})

// ─── Phase 3.5-bis: trip-scoped uploadIntents subcollection is admin-only ─
describe('/trips/{tripId}/uploadIntents/{intentId} client deny-all (Phase 3.5-bis)', () => {
  // Worker admin SDK writes AND reads intent docs (admin SDK bypasses
  // rules); clients NEVER read or write them directly. storage.rules
  // does NOT cross-service-read this subcollection -- after the
  // 2026-05-24 race incident the storage rules layer became a STABLE
  // GATE that verifies only self-contained claimed metadata, and the
  // authoritative intent-bound check (status / expiresAt / path-
  // exactness / customMetadata equality / single-use markUsed) moved
  // to the Worker's entity-write consume paths (/booking-file-*,
  // /wish-file-*, /expense-create, /expense-update).
  // The `if false` rule below is what this suite locks in: even with
  // valid editor / owner credentials, no client SDK access path
  // touches the intent doc. Subcollection placement keeps the doc
  // under the `trips/{tripId}/` cascade-delete cone and inside the
  // existing IAM Condition scope in case a future rule legitimately
  // needs to read it (the Worker today does not need rules-layer
  // access -- admin SDK is unscoped).
  const validIntent = {
    uid:        EDITOR_UID,
    tripId:     TRIP_ID,
    entityType: 'expense',
    entityId:   'exp-1',
    kind:       'full',
    path:       `trips/${TRIP_ID}/expenses/exp-1/abcdef12.webp`,
    allowedContentTypes: ['image/webp'],
    maxBytes:   5 * 1024 * 1024,
    customMetadata: {
      uploadIntentId: 'i1',
      uploaderUid:    EDITOR_UID,
      tripId:         TRIP_ID,
      entityType:     'expense',
      entityId:       'exp-1',
      kind:           'full',
      schemaVersion:  'v1',
    },
    status:    'pending',
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000),
    createdAt: serverTimestamp(),
  }

  test('owner cannot create intent directly', async () => {
    await assertFails(
      setDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-own-c'), validIntent),
    )
  })

  test('editor cannot create intent directly', async () => {
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-edt-c'), validIntent),
    )
  })

  test('viewer cannot create intent directly', async () => {
    await assertFails(
      setDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-vw-c'), validIntent),
    )
  })

  test('stranger cannot create intent directly', async () => {
    await assertFails(
      setDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-str-c'), validIntent),
    )
  })

  test('anonymous cannot create intent directly', async () => {
    await assertFails(
      setDoc(doc(asAnon(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-anon-c'), validIntent),
    )
  })

  test('any client role cannot READ intent doc directly', async () => {
    // Seed via admin context (rules disabled) so the doc exists.
    // Then assert NO client identity can read it -- even the uid
    // recorded in the doc's `uid` field. Storage rules access via
    // server credentials when verifying; clients have zero reason
    // to ever look at this doc directly.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-read'), validIntent)
    })
    await assertFails(getDoc(doc(asOwner(env).firestore(),    'trips', TRIP_ID, 'uploadIntents', 'i-read')))
    await assertFails(getDoc(doc(asEditor(env).firestore(),   'trips', TRIP_ID, 'uploadIntents', 'i-read')))
    await assertFails(getDoc(doc(asViewer(env).firestore(),   'trips', TRIP_ID, 'uploadIntents', 'i-read')))
    await assertFails(getDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-read')))
    await assertFails(getDoc(doc(asAnon(env).firestore(),     'trips', TRIP_ID, 'uploadIntents', 'i-read')))
  })

  test('clients cannot update intent (e.g. flip status to used)', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-upd'), validIntent)
    })
    // The most plausible attack: flip status='used' to free the
    // intent for replay, or extend expiresAt. Both rejected.
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-upd'), { status: 'used' }),
    )
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-upd'),
        { expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000) }),
    )
  })

  test('clients cannot delete intent (would let attacker free path for replay)', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-del'), validIntent)
    })
    await assertFails(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'uploadIntents', 'i-del')),
    )
  })

  test('list query on uploadIntents subcollection is rejected (no enumeration)', async () => {
    await assertFails(
      getDocs(query(collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'uploadIntents'))),
    )
  })
})

// ─── Invites rule guards ───────────────────────────────────────────
// /trips/{tripId}/invites/{token} — owner mints reusable invite docs
// (token is the 256-bit URL fragment, doc presence == valid). Critical
// invariants:
//   - Only owner can create (mint new tokens)
//   - expiresAt must be in the future (no backdated / pre-expired)
//   - No update path (rotation is delete+create batch)
//   - Only owner can delete (revoke)
//   - List is owner-only (management UI); get is open so any signed-in
//     user can redeem a known token
describe('/trips/{tripId}/invites rule guards', () => {
  const TOKEN = 'invite-token-1'
  const validInvite = (overrides: Record<string, unknown> = {}) => ({
    tripId:    TRIP_ID,
    createdBy: OWNER_UID,
    role:      'editor' as const,
    tripTitle: 'Test Trip',
    tripIcon:  'plane',
    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
    ...overrides,
  })

  test('client cannot create an invite directly (mint is Worker-only)', async () => {
    // invites create: if false. Minting moved to the Worker (/invite-create),
    // which mints the token, reads tripTitle/tripIcon off the trip doc, caps
    // the 7-day expiry, and rotates inviteState/current atomically — invariants
    // rules can't express. Even the OWNER (the most-privileged caller) is denied
    // at the rules layer with an otherwise well-formed payload; editor/viewer
    // follow a fortiori. Payload-shape + role-allowlist + expiry-cap coverage
    // now lives in workers/ocr/test/membership-write.spec.ts.
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'invites', TOKEN),
        validInvite(),
      ),
    )
  })

  test('invite update is rejected (no update rule = immutable, rotate via Worker)', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', 'inv-imm'),
        {
          tripId: TRIP_ID, createdBy: OWNER_UID, role: 'editor',
          tripTitle: 'Test Trip', tripIcon: 'plane',
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    // Owner attempts to extend expiry in-place — should fail; rotation
    // goes through the Worker (/invite-create), never an in-place update.
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'invites', 'inv-imm'),
        { expiresAt: Timestamp.fromMillis(Date.now() + 72 * 60 * 60_000) },
      ),
    )
  })

  test('signed-in non-member can getDoc an invite by known token (redeem happy path)', async () => {
    // The redeem flow at /invite/:tripId#token loads the invite doc
    // to render preview (tripTitle / tripIcon / role) before the user
    // accepts. The token in the URL fragment IS the auth — anyone who
    // knows it should be able to read the doc and decide whether to
    // accept. `allow get: if isSignedIn()` is the rule under test;
    // a regression to `if isTripOwner(tripId)` would break every
    // invite redeem from outside the trip.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', 'inv-redeem'),
        {
          tripId: TRIP_ID, createdBy: OWNER_UID, role: 'editor',
          tripTitle: 'Test Trip', tripIcon: 'plane',
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    await assertSucceeds(
      getDoc(doc(asStranger(env).firestore(), 'trips', TRIP_ID, 'invites', 'inv-redeem')),
    )
  })

  test('anonymous user cannot getDoc an invite (signed-in gate)', async () => {
    // Pairs with the above — get is open to signed-in users, NOT
    // anonymous. Keeps spam / unauthenticated enumeration off the
    // surface even if someone guesses a token.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', 'inv-anon'),
        {
          tripId: TRIP_ID, createdBy: OWNER_UID, role: 'editor',
          tripTitle: 'Test Trip', tripIcon: 'plane',
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    await assertFails(
      getDoc(doc(asAnon(env).firestore(), 'trips', TRIP_ID, 'invites', 'inv-anon')),
    )
  })

  test('owner cannot delete an invite directly (revoke is Worker-only)', async () => {
    // invites delete: if false. Revoke moved to the Worker (/invite-revoke),
    // which deletes the invite doc + clears inviteState/current atomically and
    // 409s a stale token. Even the owner is denied a direct client delete;
    // revoke-path coverage lives in workers/ocr/test/membership-write.spec.ts.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', 'inv-revoke'),
        {
          tripId: TRIP_ID, createdBy: OWNER_UID, role: 'editor',
          tripTitle: 'Test Trip', tripIcon: 'plane',
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    await assertFails(
      deleteDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'invites', 'inv-revoke')),
    )
  })

  test('non-owner also cannot delete an invite (whole delete surface closed)', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'invites', 'inv-del'),
        {
          tripId: TRIP_ID, createdBy: OWNER_UID, role: 'editor',
          tripTitle: 'Test Trip', tripIcon: 'plane',
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    await assertFails(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'invites', 'inv-del')),
    )
  })

  test('non-owner cannot list invites (management UI is owner-only)', async () => {
    await assertFails(
      getDocs(query(collection(asEditor(env).firestore(), 'trips', TRIP_ID, 'invites'))),
    )
  })

  test('owner can list invites (management UI happy path)', async () => {
    await assertSucceeds(
      getDocs(query(collection(asOwner(env).firestore(), 'trips', TRIP_ID, 'invites'))),
    )
  })

  // ── inviteState/current — fully Worker-only pointer ──────────────
  // { token, role, createdBy, createdAt, expiresAt }. The Worker reads +
  // writes it via the admin SDK (bypassing rules) inside the invite
  // create/revoke/redeem transactions. NO client may touch it — reading it
  // would leak the active bearer token to non-redeemers, and there is no
  // client write path. Even the owner is denied both read and write.

  test('owner cannot read inviteState/current (Worker-only pointer)', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID, 'inviteState', 'current'),
        {
          token: 'a'.repeat(64), role: 'editor', createdBy: OWNER_UID,
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      )
    })
    await assertFails(
      getDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'inviteState', 'current')),
    )
  })

  test('owner cannot write inviteState/current (Worker-only pointer)', async () => {
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'inviteState', 'current'),
        {
          token: 'b'.repeat(64), role: 'editor', createdBy: OWNER_UID,
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        },
      ),
    )
  })
})

// ─── canWrite removal-quiesce gate (M1.8 P1) ──────────────────────
//
// When the Worker /member-remove tx starts a kick, it stamps
// `removingAt` on the target's member doc inside the authorizing tx.
// firestore.rules' canWrite(tripId) refuses subsequent writes by
// that uid -- closing the race where they could create a fresh
// subcollection doc between the cascade's listDocNames and
// deleteDoc steps that the strip list would miss. These tests
// pin the gate behavior on the rules side so a future canWrite
// edit can't accidentally re-open it.
describe('canWrite removal-quiesce (removingAt gate)', () => {
  async function markEditorRemoving(): Promise<void> {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore()
      await updateDoc(doc(db, 'trips', TRIP_ID, 'members', EDITOR_UID), {
        removingAt: Timestamp.now(),
      })
    })
  }

  test('editor can create a booking BEFORE removingAt is set (baseline)', async () => {
    await assertSucceeds(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'new-baseline'), {
        tripId:    TRIP_ID,
        type:      'hotel',
        title:     'Baseline Hotel',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID,
        updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('editor canNOT create a booking AFTER removingAt is set on their member doc', async () => {
    await markEditorRemoving()

    // The exact race the marker defends: editor still holds their
    // member doc + Firebase token, would otherwise pass canWrite.
    // After marker: canWrite returns false → create rejected.
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', 'race-booking'), {
        tripId:    TRIP_ID,
        type:      'hotel',
        title:     'Race Hotel',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: EDITOR_UID,
        updatedBy: EDITOR_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('editor canNOT update existing booking after removingAt is set', async () => {
    await markEditorRemoving()

    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        title:     'Updated title',
        updatedBy: EDITOR_UID,
        updatedAt: serverTimestamp(),
      }),
    )
  })

  test('editor canNOT delete existing booking after removingAt is set', async () => {
    await markEditorRemoving()

    await assertFails(
      deleteDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID)),
    )
  })

  test('removingAt gate is per-trip-member-doc: marker on EDITOR does not affect OWNER writes', async () => {
    await markEditorRemoving()

    // Owner's member doc has no removingAt → canWrite returns true.
    await assertSucceeds(
      setDoc(doc(asOwner(env).firestore(), 'trips', TRIP_ID, 'bookings', 'owner-can-still-write'), {
        tripId:    TRIP_ID,
        type:      'hotel',
        title:     'Owner Hotel',
        memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
        createdBy: OWNER_UID,
        updatedBy: OWNER_UID,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        sortDate:  serverTimestamp(),
      }),
    )
  })

  test('editor can still READ during removal window (marker only blocks writes)', async () => {
    await markEditorRemoving()

    // Reads are unaffected -- memberOfDoc() checks resource.data.memberIds,
    // not the member doc's removingAt. The kicked user retains read
    // until the cascade strip removes their uid from memberIds, which
    // is correct: they had access pre-kick, lose it cleanly when
    // strip completes.
    await assertSucceeds(
      getDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID)),
    )
  })

  // ─── Direct projection rewrite coverage ─────────────────────────
  // Membership projection writes are Worker-only. The kick race this
  // protects against: a Worker cascade strips the kicked uid from
  // memberIds[] on trip + subcollection docs, but the kicked member doc
  // may still exist for a few ms before final delete. A raw client write
  // must not be able to add that uid back into memberIds[].

  async function midCascadeStrip(): Promise<void> {
    // Mid-cascade state: editor uid has been stripped from trip +
    // booking memberIds[], member doc still exists, removingAt set.
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore()
      await updateDoc(doc(db, 'trips', TRIP_ID), {
        memberIds: [OWNER_UID, VIEWER_UID],
      })
      await updateDoc(doc(db, 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        memberIds: [OWNER_UID, VIEWER_UID],
      })
      await updateDoc(doc(db, 'trips', TRIP_ID, 'members', EDITOR_UID), {
        removingAt: Timestamp.now(),
      })
    })
  }

  test('direct self-add is REFUSED on trip.memberIds when removingAt is set', async () => {
    await midCascadeStrip()

    // What an attacker would try: arrayUnion themselves back into
    // trip.memberIds during the mid-cascade window. Pre-gate this
    // passes the size-delta and hasAll checks; gate now refuses.
    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID), {
        memberIds: [OWNER_UID, VIEWER_UID, EDITOR_UID],
      }),
    )
  })

  test('direct self-add is REFUSED on subcollection memberIds when removingAt is set', async () => {
    await midCascadeStrip()

    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
        memberIds: [OWNER_UID, VIEWER_UID, EDITOR_UID],
      }),
    )
  })

  test('direct self-add is REFUSED even when removingAt is NOT set', async () => {
    // Strip uid from trip.memberIds but DO NOT set removingAt. The old
    // client-side reconciliation branch would have allowed this; after
    // membership workerization, projection writes remain closed.
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), 'trips', TRIP_ID), {
        memberIds: [OWNER_UID, VIEWER_UID],
      })
    })

    await assertFails(
      updateDoc(doc(asEditor(env).firestore(), 'trips', TRIP_ID), {
        memberIds: [OWNER_UID, VIEWER_UID, EDITOR_UID],
      }),
    )
  })
})

// ─── Push notifications: tokens / _pushEvents ──────────────────────
// Tokens are private to the owning user; the only writer of the
// server-origin disable reasons (fcm-unregistered/send-failed) and the
// _pushEvents dedupe collection is the Firebase Functions admin SDK
// (rules-bypass). These tests pin the own-read/write allow paths and the
// cross-user / forge / arbitrary-field deny paths.
describe('push notifications rules', () => {
  // 64-char hex (sha256 of the FCM token). Doc id MUST equal this.
  const TOKEN_HASH = 'a'.repeat(64)

  function tokenDoc(overrides: Record<string, unknown> = {}) {
    return {
      token:      'fcm-token-' + 'x'.repeat(30),  // > 20 chars
      tokenHash:  TOKEN_HASH,
      platform:   'web',
      provider:   'fcm',
      permission: 'granted',
      swScope:    '/',
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      disabledAt: null,
      ...overrides,
    }
  }

  /** Admin-SDK seed of an existing (enabled) token to test update paths. */
  async function seedToken(uid: string, overrides: Record<string, unknown> = {}) {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(
        doc(ctx.firestore(), 'users', uid, 'pushTokens', TOKEN_HASH),
        {
          ...tokenDoc(),
          createdAt:  Timestamp.now(),
          updatedAt:  Timestamp.now(),
          lastSeenAt: Timestamp.now(),
          ...overrides,
        },
      )
    })
  }

  // ─── pushTokens create ───────────────────────────────────────────
  test('self user can create own valid push token', async () => {
    await assertSucceeds(
      setDoc(doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH), tokenDoc()),
    )
  })

  test('cannot create a token under another user uid', async () => {
    // editor (uid=editor) writing into owner's pushTokens → isSelfUser fails.
    await assertFails(
      setDoc(doc(asEditor(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH), tokenDoc()),
    )
  })

  test('cannot create a token whose doc id != tokenHash', async () => {
    await assertFails(
      setDoc(doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', 'wrong-id'), tokenDoc()),
    )
  })

  test('cannot set a server-origin disabledReason on create', async () => {
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        tokenDoc({ disabledReason: 'fcm-unregistered' }),
      ),
    )
  })

  test('cannot create a token with disabledAt already set (non-null)', async () => {
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        tokenDoc({ disabledAt: serverTimestamp() }),
      ),
    )
  })

  test('cannot create a token with an extra unrecognized field', async () => {
    await assertFails(
      setDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        tokenDoc({ evilField: 'x' }),
      ),
    )
  })

  // ─── pushTokens update ───────────────────────────────────────────
  test('self user can refresh own lastSeenAt/updatedAt', async () => {
    await seedToken(OWNER_UID)
    await assertSucceeds(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        { lastSeenAt: serverTimestamp(), updatedAt: serverTimestamp() },
      ),
    )
  })

  test('cannot refresh with an oversized appVersion', async () => {
    await seedToken(OWNER_UID)
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        {
          lastSeenAt: serverTimestamp(),
          updatedAt:  serverTimestamp(),
          appVersion: 'x'.repeat(65),
        },
      ),
    )
  })

  test('cannot mutate the token string after create', async () => {
    await seedToken(OWNER_UID)
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        { token: 'hijacked-token-' + 'y'.repeat(30), updatedAt: serverTimestamp(), lastSeenAt: serverTimestamp() },
      ),
    )
  })

  test('self user can user-disable own token', async () => {
    await seedToken(OWNER_UID)
    await assertSucceeds(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        { disabledAt: serverTimestamp(), disabledReason: 'user-disabled', updatedAt: serverTimestamp() },
      ),
    )
  })

  test('self user can re-enable a previously disabled same-device token', async () => {
    await seedToken(OWNER_UID, {
      disabledAt:     Timestamp.now(),
      disabledReason: 'user-disabled',
    })
    await assertSucceeds(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        {
          disabledAt:     null,
          disabledReason: deleteField(),
          lastSeenAt:     serverTimestamp(),
          updatedAt:      serverTimestamp(),
          appVersion:     'test',
        },
      ),
    )
  })

  test('cannot re-enable a server-disabled invalid token', async () => {
    await seedToken(OWNER_UID, {
      disabledAt:     Timestamp.now(),
      disabledReason: 'fcm-unregistered',
    })
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        {
          disabledAt:     null,
          disabledReason: deleteField(),
          lastSeenAt:     serverTimestamp(),
          updatedAt:      serverTimestamp(),
        },
      ),
    )
  })

  test('cannot re-enable with a non-string appVersion', async () => {
    await seedToken(OWNER_UID, {
      disabledAt:     Timestamp.now(),
      disabledReason: 'user-disabled',
    })
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        {
          disabledAt:     null,
          disabledReason: deleteField(),
          lastSeenAt:     serverTimestamp(),
          updatedAt:      serverTimestamp(),
          appVersion:     123,
        },
      ),
    )
  })

  test('cannot forge a server-origin disabledReason on update', async () => {
    await seedToken(OWNER_UID)
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        { disabledAt: serverTimestamp(), disabledReason: 'fcm-unregistered', updatedAt: serverTimestamp() },
      ),
    )
  })

  // Laundering guard: a server-disabled (fcm-unregistered) token must not be
  // re-stampable as user-disabled — that would be the first hop of
  // fcm-unregistered → user-disabled → re-enable, washing out the server's
  // tombstone. The re-enable hop itself is already denied above; this pins
  // the user-disable hop closed too (only enterable from enabled state).
  test('cannot user-disable a server-disabled token (launder hop 1)', async () => {
    await seedToken(OWNER_UID, {
      disabledAt:     Timestamp.now(),
      disabledReason: 'fcm-unregistered',
    })
    await assertFails(
      updateDoc(
        doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH),
        { disabledAt: serverTimestamp(), disabledReason: 'user-disabled', updatedAt: serverTimestamp() },
      ),
    )
  })

  // ─── pushTokens read ─────────────────────────────────────────────
  test('cannot read another user\'s token', async () => {
    await seedToken(OWNER_UID)
    await assertFails(
      getDoc(doc(asStranger(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH)),
    )
  })

  test('self user can read own token', async () => {
    await seedToken(OWNER_UID)
    await assertSucceeds(
      getDoc(doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH)),
    )
  })

  test('client cannot delete own token doc', async () => {
    await seedToken(OWNER_UID)
    await assertFails(
      deleteDoc(doc(asOwner(env).firestore(), 'users', OWNER_UID, 'pushTokens', TOKEN_HASH)),
    )
  })

  // ─── _pushEvents (server-only) ───────────────────────────────────
  test('client cannot read _pushEvents', async () => {
    await assertFails(getDoc(doc(asOwner(env).firestore(), '_pushEvents', 'evt-1')))
  })

  test('client cannot write _pushEvents', async () => {
    await assertFails(
      setDoc(doc(asOwner(env).firestore(), '_pushEvents', 'evt-1'), { tripId: TRIP_ID, status: 'pending' }),
    )
  })
})
