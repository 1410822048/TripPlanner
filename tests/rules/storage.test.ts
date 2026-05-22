// tests/rules/storage.test.ts
// Storage rules coverage. The bug that motivated this file: cascade
// trip-delete called listAll('trips/{tripId}/...') and got 403 because
// the only rules in storage.rules covered leaf-file paths
// (/trips/{tripId}/bookings/{bookingId}/{file}, /wishes/{wishId}/{file}).
// listAll on a parent prefix needs a matching read rule on that prefix.
// We added a wildcard `match /trips/{tripId}/{allPaths=**}` to grant
// list permission to members; this test pins that fix.
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest'
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { ref, listAll, getBytes, uploadString, deleteObject } from 'firebase/storage'
import { doc, updateDoc, serverTimestamp, deleteField } from 'firebase/firestore'
import {
  setupTestEnv, teardownTestEnv, seedFixture,
  asOwner, asEditor, asViewer, asStranger, asAnon,
  TRIP_ID,
} from './helpers'
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing'

let env: RulesTestEnvironment

beforeAll(async () => { env = await setupTestEnv() })
afterAll(async () => { await teardownTestEnv() })
beforeEach(async () => {
  await env.clearStorage()
  await env.clearFirestore()
  await seedFixture(env)
  // Drop a fixture file under a booking so listAll has something to find.
  await env.withSecurityRulesDisabled(async ctx => {
    const storage = ctx.storage()
    await uploadString(
      ref(storage, `trips/${TRIP_ID}/bookings/booking-1/test.txt`),
      'fixture content',
    )
  })
})

describe('listAll under trip prefix (cascade-delete path)', () => {
  test('member can listAll trip-root prefix (the cascade entry point)', async () => {
    // This is the exact call that broke production: purgeStorageFolder
    // hits trips/{tripId}/ first, then recurses.
    await assertSucceeds(listAll(ref(asOwner(env).storage(), `trips/${TRIP_ID}`)))
  })

  test('member can listAll bookings sub-prefix', async () => {
    await assertSucceeds(listAll(ref(asEditor(env).storage(), `trips/${TRIP_ID}/bookings`)))
  })

  test('non-member CANNOT listAll trip prefix', async () => {
    await assertFails(listAll(ref(asStranger(env).storage(), `trips/${TRIP_ID}`)))
  })

  test('signed-out CANNOT listAll trip prefix', async () => {
    await assertFails(listAll(ref(asAnon(env).storage(), `trips/${TRIP_ID}`)))
  })
})

describe('booking attachment file rules', () => {
  test('member can read individual file', async () => {
    await assertSucceeds(
      getBytes(ref(asViewer(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/test.txt`)),
    )
  })

  test('viewer CANNOT delete booking attachment (role gate)', async () => {
    await assertFails(
      deleteObject(ref(asViewer(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/test.txt`)),
    )
  })

  test('editor CAN delete booking attachment', async () => {
    await assertSucceeds(
      deleteObject(ref(asEditor(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/test.txt`)),
    )
  })

  test('non-member CANNOT read file', async () => {
    await assertFails(
      getBytes(ref(asStranger(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/test.txt`)),
    )
  })
})

describe('cascade write-quiesce (deletingAt) gates Storage uploads', () => {
  // The race we're regression-guarding: Worker stamps trip.deletingAt
  // → starts draining Firestore → editor on another device uploads a
  // new receipt to Storage. Without the cross-service tripNotDeleting
  // helper, the upload would succeed; the editor's matching Firestore
  // setDoc(expense) then fails (firestore.rules also gate creates by
  // deletingAt), leaving orphan Storage bytes the cascade has already
  // walked past. Pin all three writable Storage prefixes -- bookings,
  // expenses, wishes -- to reject uploads when deletingAt is set.

  // Helper: toggle trip.deletingAt server-side without going through
  // the rules-gated client path (the trip update rule's owner-edit
  // branch pins unchanged('deletingAt'), so even the owner can't
  // write it -- only the Worker can via admin SDK).
  async function setDeleting(on: boolean) {
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        on ? { deletingAt: serverTimestamp() } : { deletingAt: deleteField() },
      )
    })
  }

  // storage.rules checks `request.resource.contentType` against an
  // image/* | application/pdf allowlist. uploadString's default is
  // application/octet-stream, which would fail the content rule
  // unconditionally -- defeating these tests' ability to isolate
  // the deletingAt gate. Explicit image/png keeps the content-type
  // check out of the way so the assertion targets deletingAt alone.
  const PNG_META = { contentType: 'image/png' }

  test('editor CANNOT upload booking attachment when trip.deletingAt is set', async () => {
    await setDeleting(true)
    await assertFails(
      uploadString(
        ref(asEditor(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/new.png`),
        'mid-cascade upload', 'raw', PNG_META,
      ),
    )
    await setDeleting(false)
  })

  test('editor CANNOT upload expense receipt when trip.deletingAt is set', async () => {
    await setDeleting(true)
    await assertFails(
      uploadString(
        ref(asEditor(env).storage(), `trips/${TRIP_ID}/expenses/e1/receipt.png`),
        'mid-cascade receipt', 'raw', PNG_META,
      ),
    )
    await setDeleting(false)
  })

  test('member CANNOT upload wish cover when trip.deletingAt is set', async () => {
    await setDeleting(true)
    await assertFails(
      uploadString(
        ref(asViewer(env).storage(), `trips/${TRIP_ID}/wishes/w1/cover.png`),
        'mid-cascade cover', 'raw', PNG_META,
      ),
    )
    await setDeleting(false)
  })

  test('editor CAN upload when trip is NOT deleting (sanity / no false positives)', async () => {
    // Without this positive case, a typo that always-rejects (e.g.
    // accidentally inverting the helper) would still pass the three
    // negative tests above. This locks the normal-state behavior.
    await assertSucceeds(
      uploadString(
        ref(asEditor(env).storage(), `trips/${TRIP_ID}/bookings/booking-1/sanity.png`),
        'normal upload', 'raw', PNG_META,
      ),
    )
  })
})

// ─── Wish cover proposer ownership ────────────────────────────────
describe('Wish cover Storage ownership', () => {
  // Seed: WISH_ID in fixture is proposedBy EDITOR_UID. So the proposer
  // is editor; viewer / owner / stranger should NOT be able to write
  // its cover image, even though they're members of the trip.

  const PNG_META = { contentType: 'image/png' }

  test('non-proposer member CANNOT replace existing wish cover (defacement)', async () => {
    // The defacement risk pre-fix: any member (read/write/delete on
    // every wish cover via storage.rules). Now writes need to match
    // the wish doc's proposedBy.
    await assertFails(
      uploadString(
        ref(asViewer(env).storage(), `trips/${TRIP_ID}/wishes/wish-1/replaced.png`),
        'defacement attempt', 'raw', PNG_META,
      ),
    )
  })

  test('non-proposer member CANNOT delete proposer\'s wish cover', async () => {
    // Need a file to delete first -- seed one via admin context.
    await env.withSecurityRulesDisabled(async ctx => {
      await uploadString(
        ref(ctx.storage(), `trips/${TRIP_ID}/wishes/wish-1/proposer-cover.png`),
        'proposer file', 'raw', PNG_META,
      )
    })
    await assertFails(
      deleteObject(ref(asViewer(env).storage(), `trips/${TRIP_ID}/wishes/wish-1/proposer-cover.png`)),
    )
  })

  test('proposer CAN write their own wish cover (no regression)', async () => {
    // Editor is the proposer of wish-1 (seeded that way in helpers).
    await assertSucceeds(
      uploadString(
        ref(asEditor(env).storage(), `trips/${TRIP_ID}/wishes/wish-1/legit.png`),
        'proposer upload', 'raw', PNG_META,
      ),
    )
  })

  test('upload against yet-to-be-created wish doc is REJECTED (doc-first contract)', async () => {
    // Post-refactor (2026-05-21), wishService.createWish is
    // doc-first: setDoc the wish (without image), THEN upload,
    // THEN updateDoc to patch the image field in. By the time
    // Storage write fires, the wish doc exists and the rule's
    // isWishProposer check has a real doc to read. The earlier
    // upload-before-setDoc flow needed a `!exists` exception
    // here; removing that closes the race where any member
    // could pre-write bytes against a not-yet-created wishId.
    await assertFails(
      uploadString(
        ref(asEditor(env).storage(), `trips/${TRIP_ID}/wishes/never-existed-yet/first.png`),
        'pre-doc upload attempt', 'raw', PNG_META,
      ),
    )
  })

  test('trip owner CAN delete another member\'s wish cover (moderation parity with Firestore)', async () => {
    // The mismatch we're closing: firestore.rules allows
    // `proposedBy == uid() || isTripOwner(tripId)` on wish delete,
    // so the owner can moderate (spam, duplicates). Storage was
    // proposer-only -- when owner deletes the wish, wishService's
    // deleteWishImage() got 403 on Storage and the catch/log
    // swallowed it, leaving Storage bytes orphaned. Now Storage
    // delete also accepts isTripOwnerStorage.
    //
    // Setup: editor (proposer of wish-1) uploads a cover; owner
    // moderates by deleting it.
    await env.withSecurityRulesDisabled(async ctx => {
      await uploadString(
        ref(ctx.storage(), `trips/${TRIP_ID}/wishes/wish-1/moderated.png`),
        'cover to moderate', 'raw', PNG_META,
      )
    })
    await assertSucceeds(
      deleteObject(ref(asOwner(env).storage(), `trips/${TRIP_ID}/wishes/wish-1/moderated.png`)),
    )
  })

  test('trip owner CANNOT delete wish blob when wish doc is missing (strict)', async () => {
    // Inverse of the legacy "owner can clean orphans" branch. With
    // an empty pre-launch DB there are no legacy orphans; the
    // orphan-purge cron + trip-cascade Worker handle any future
    // orphan via `_purges` queue. The owner branch now requires
    // the wish doc to still exist, matching the firestore.rules
    // wish delete invariant.
    await env.withSecurityRulesDisabled(async ctx => {
      await uploadString(
        ref(ctx.storage(), `trips/${TRIP_ID}/wishes/wish-gone/orphan.png`),
        'orphan blob', 'raw', PNG_META,
      )
    })
    // wish-gone has no Firestore doc → owner delete now rejected.
    // Emergency manual cleanup still possible via Firebase Console
    // (admin auth bypasses rules entirely).
    await assertFails(
      deleteObject(ref(asOwner(env).storage(), `trips/${TRIP_ID}/wishes/wish-gone/orphan.png`)),
    )
  })

  test('stranger CANNOT delete wish cover even after owner-branch added', async () => {
    // Belt-and-suspenders: confirm the owner-branch addition didn't
    // accidentally widen access. Non-member is still rejected.
    await env.withSecurityRulesDisabled(async ctx => {
      await uploadString(
        ref(ctx.storage(), `trips/${TRIP_ID}/wishes/wish-1/protected.png`),
        'should stay', 'raw', PNG_META,
      )
    })
    await assertFails(
      deleteObject(ref(asStranger(env).storage(), `trips/${TRIP_ID}/wishes/wish-1/protected.png`)),
    )
  })
})
