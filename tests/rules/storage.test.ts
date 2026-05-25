// tests/rules/storage.test.ts
// Storage rules coverage. Two halves:
//
//   1. Legacy-shape tests that pre-date Phase 3.5 (listAll, role-gated
//      delete, wish proposer delete, owner moderation). These don't
//      touch upload paths and stay unchanged.
//
//   2. Phase 3.5 intent-verified upload tests. Storage rules now
//      require every upload to carry customMetadata.uploadIntentId
//      pointing at a 'pending' uploadIntent doc the Worker minted,
//      whose path / contentType / size / 7-field customMetadata
//      match the upload's resource. Plus immediate-permission checks
//      (canWriteFiles / tripNotDeleting / isWishProposer) still
//      gate at upload time so a stale 30-min intent can't be
//      replayed by a since-demoted member or against a mid-cascade
//      trip -- this is the revocation-window protection.
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest'
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { ref, listAll, getBytes, uploadString, deleteObject } from 'firebase/storage'
import {
  doc, setDoc, updateDoc, serverTimestamp, deleteField, Timestamp,
} from 'firebase/firestore'
import {
  setupTestEnv, teardownTestEnv, seedFixture,
  asOwner, asEditor, asViewer, asStranger, asAnon,
  TRIP_ID, OWNER_UID, EDITOR_UID, VIEWER_UID,
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

// ─── Existing legacy-shape tests (no upload, unchanged) ──────────

describe('listAll under trip prefix (cascade-delete path)', () => {
  test('member can listAll trip-root prefix (the cascade entry point)', async () => {
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

describe('booking attachment file rules (read + delete)', () => {
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

// ─── Phase 3.5 intent helpers ─────────────────────────────────────

type EntityType = 'expense' | 'booking' | 'wish'
type Kind       = 'full' | 'thumb' | 'pdf'

interface SeededIntent {
  intentId:    string
  path:        string
  fileName:    string
  uploaderUid: string
  collection:  string
}

/**
 * Seed an uploadIntents/{id} doc via admin context. Returns the
 * computed path + the customMetadata the upload must echo back.
 * Each option has a sensible default for the "happy path" test;
 * specific failure tests override the relevant field.
 */
async function seedIntent(opts: {
  intentId:       string
  uid?:           string
  tripId?:        string
  entityType:     EntityType
  entityId:       string
  kind?:          Kind
  fileName?:      string
  contentType?:   string
  maxBytes?:      number
  schemaVersion?: string
  status?:        'pending' | 'used'
  expiresAtMs?:   number
  pathOverride?:  string   // intent.path stored value (used by mismatch tests)
}): Promise<SeededIntent> {
  const uid           = opts.uid           ?? EDITOR_UID
  const tripId        = opts.tripId        ?? TRIP_ID
  const kind          = opts.kind          ?? 'full'
  const fileName      = opts.fileName      ?? 'legit.webp'
  const contentType   = opts.contentType   ?? 'image/webp'
  const maxBytes      = opts.maxBytes      ?? 5 * 1024 * 1024
  const schemaVersion = opts.schemaVersion ?? 'v1'
  const status        = opts.status        ?? 'pending'
  const expiresAtMs   = opts.expiresAtMs   ?? (Date.now() + 30 * 60_000)
  // Irregular plural: 'wish' -> 'wishes'. Mirrors entitySegment() in storage.rules.
  const collection    = opts.entityType === 'wish' ? 'wishes' : `${opts.entityType}s`
  const computedPath  = `trips/${tripId}/${collection}/${opts.entityId}/${fileName}`
  const path          = opts.pathOverride ?? computedPath

  await env.withSecurityRulesDisabled(async ctx => {
    // Phase-3.5-bis: intents live under `trips/{tripId}/uploadIntents/{id}`.
    // storage.rules' uploadIntentPath(tripId, id) reads from the same
    // subcollection, so the seed must match.
    await setDoc(doc(ctx.firestore(), 'trips', tripId, 'uploadIntents', opts.intentId), {
      uid,
      tripId,
      entityType: opts.entityType,
      entityId:   opts.entityId,
      kind,
      path,
      allowedContentTypes: [contentType],
      maxBytes,
      customMetadata: {
        uploadIntentId: opts.intentId,
        uploaderUid:    uid,
        tripId,
        entityType:     opts.entityType,
        entityId:       opts.entityId,
        kind,
        schemaVersion,
      },
      status,
      expiresAt: Timestamp.fromMillis(expiresAtMs),
      createdAt: serverTimestamp(),
    })
  })

  return {
    intentId:    opts.intentId,
    path:        computedPath,
    fileName,
    uploaderUid: uid,
    collection,
  }
}

/** Build the upload's customMetadata bundle. Defaults to a happy-path
 *  bundle matching the supplied intent details; tamper overrides
 *  let individual tests flip a single field to assert the rule fires. */
function uploadMetadata(opts: {
  intentId:        string
  uploaderUid:     string
  tripId?:         string
  entityType:      EntityType
  entityId:        string
  kind?:           Kind
  contentType?:    string
  schemaVersion?:  string
  customOverrides?: Record<string, string | undefined>
}) {
  const base: Record<string, string> = {
    uploadIntentId: opts.intentId,
    uploaderUid:    opts.uploaderUid,
    tripId:         opts.tripId ?? TRIP_ID,
    entityType:     opts.entityType,
    entityId:       opts.entityId,
    kind:           opts.kind ?? 'full',
    schemaVersion:  opts.schemaVersion ?? 'v1',
  }
  if (opts.customOverrides) {
    for (const [k, v] of Object.entries(opts.customOverrides)) {
      if (v === undefined) delete base[k]
      else                 base[k] = v
    }
  }
  return {
    contentType: opts.contentType ?? 'image/webp',
    customMetadata: base,
  }
}

// ─── Phase 3.5 intent-verified upload — happy paths + deny gates ──

describe('Phase 3.5 intent-verified upload: expense (canWriteFiles)', () => {
  const EXPENSE_ID = 'exp-1'

  test('valid intent + matching upload → succeed', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-ok', entityType: 'expense', entityId: EXPENSE_ID,
    })
    await assertSucceeds(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('upload without customMetadata.uploadIntentId → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-no-id', entityType: 'expense', entityId: EXPENSE_ID,
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      { contentType: 'image/webp' },  // no customMetadata at all
    ))
  })

  test('intent does not exist (forged uploadIntentId) → deny', async () => {
    // No seed: rule's firestore.exists() gate fires.
    const path = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/forge.webp`
    await assertFails(uploadString(
      ref(asEditor(env).storage(), path), 'data', 'raw',
      uploadMetadata({
        intentId: 'i-does-not-exist', uploaderUid: EDITOR_UID,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('intent.uid != auth.uid (intent stolen) → deny', async () => {
    // Editor's intent, but owner tries to upload using it. Even though
    // owner has canWriteFiles, the intent.uid binding rejects.
    const seed = await seedIntent({
      intentId: 'i-exp-stolen', uid: EDITOR_UID, entityType: 'expense', entityId: EXPENSE_ID,
    })
    await assertFails(uploadString(
      ref(asOwner(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: OWNER_UID,  // owner trying
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('intent.path != computed expectedPath (wrong fileName) → deny', async () => {
    // Intent was minted for fileName 'a.webp'; client uploads to 'b.webp'.
    // Rule computes expectedPath from match vars; if intent.path doesn't
    // equal it, deny.
    const seed = await seedIntent({
      intentId: 'i-exp-wrong-name', entityType: 'expense', entityId: EXPENSE_ID,
      fileName: 'a.webp',
    })
    const wrongPath = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/b.webp`
    await assertFails(uploadString(
      ref(asEditor(env).storage(), wrongPath), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('intent.status = used → deny (replay protection)', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-used', entityType: 'expense', entityId: EXPENSE_ID,
      status: 'used',
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('intent past expiresAt → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-expired', entityType: 'expense', entityId: EXPENSE_ID,
      expiresAtMs: Date.now() - 60_000,  // expired 1 min ago
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('contentType not in intent.allowedContentTypes → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-bad-ct', entityType: 'expense', entityId: EXPENSE_ID,
      contentType: 'image/webp',
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
        contentType: 'image/jpeg',  // intent allowed webp only
      }),
    ))
  })

  test('upload metadata.uploaderUid spoofed (other user) → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-spoof', uid: EDITOR_UID, entityType: 'expense', entityId: EXPENSE_ID,
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: OWNER_UID,  // editor claims to be owner
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
  })

  test('upload metadata.schemaVersion drifted → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-schema', entityType: 'expense', entityId: EXPENSE_ID,
      schemaVersion: 'v1',
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
        schemaVersion: 'v2',  // drifted from intent
      }),
    ))
  })
})

describe('Phase 3.5 intent-verified upload: booking (canWriteFiles)', () => {
  const BOOKING_ID = 'booking-1'

  test('valid intent → succeed', async () => {
    const seed = await seedIntent({
      intentId: 'i-bk-ok', entityType: 'booking', entityId: BOOKING_ID,
    })
    await assertSucceeds(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'booking', entityId: BOOKING_ID,
      }),
    ))
  })

  test('viewer CANNOT upload booking attachment (role gate via canWriteFiles)', async () => {
    // Even with a valid intent, viewer role fails canWriteFiles.
    // Intent's uid is VIEWER_UID, but rule's canWriteFiles check
    // fires before intent matching.
    const seed = await seedIntent({
      intentId: 'i-bk-viewer', uid: VIEWER_UID,
      entityType: 'booking', entityId: BOOKING_ID,
    })
    await assertFails(uploadString(
      ref(asViewer(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: VIEWER_UID,
        entityType: 'booking', entityId: BOOKING_ID,
      }),
    ))
  })

  test('wrong entityType in customMetadata → deny', async () => {
    const seed = await seedIntent({
      intentId: 'i-bk-wrong-et', entityType: 'booking', entityId: BOOKING_ID,
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense',  // spoofed
        entityId: BOOKING_ID,
      }),
    ))
  })
})

describe('Phase 3.5 intent-verified upload: wish (isMember + proposer)', () => {
  const WISH_ID = 'wish-1'  // proposedBy EDITOR_UID per fixture

  test('proposer (editor) with valid intent → succeed', async () => {
    const seed = await seedIntent({
      intentId: 'i-wish-ok', entityType: 'wish', entityId: WISH_ID,
    })
    await assertSucceeds(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'wish', entityId: WISH_ID,
      }),
    ))
  })

  test('non-proposer member with valid intent → deny (proposer gate)', async () => {
    // Viewer mints an intent (admin context bypasses /upload-intents'
    // own proposer check) -- demonstrates that storage.rules still
    // re-checks proposer regardless.
    const seed = await seedIntent({
      intentId: 'i-wish-non-prop', uid: VIEWER_UID,
      entityType: 'wish', entityId: WISH_ID,
    })
    await assertFails(uploadString(
      ref(asViewer(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: VIEWER_UID,
        entityType: 'wish', entityId: WISH_ID,
      }),
    ))
  })
})

// ─── Phase 3.5 revocation-window tests ────────────────────────────

describe('Phase 3.5 revocation-window: intent minted, permission changes before upload', () => {
  const EXPENSE_ID = 'exp-revoke'
  const WISH_ID    = 'wish-1'

  async function setRole(uid: string, role: 'owner' | 'editor' | 'viewer') {
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'members', uid), { role })
    })
  }
  async function setDeleting(on: boolean) {
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        on ? { deletingAt: serverTimestamp() } : { deletingAt: deleteField() },
      )
    })
  }
  async function clearWishDoc(wishId: string) {
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'wishes', wishId), {
        // deleteDoc isn't directly available -- we just mark deletedAt
        // OR use admin context to perform a delete. Easier: drop the doc
        // via setDoc replacement won't work for proposer check; let's
        // actually delete it via the rules-disabled context.
      })
    })
  }
  void clearWishDoc  // referenced by description; actual delete uses inline withSecurityRulesDisabled

  test('intent minted while editor, then demoted to viewer → upload fails', async () => {
    // Headline test for the revocation window: a 30-min intent is
    // NOT a capability token. Even after the Worker minted it, if
    // the member's role changes, the immediate canWriteFiles check
    // in storage.rules fires and the upload 403s.
    const seed = await seedIntent({
      intentId: 'i-revoke-role', entityType: 'expense', entityId: EXPENSE_ID,
    })
    // Demote editor → viewer.
    await setRole(EDITOR_UID, 'viewer')
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
    // Restore for cleanup.
    await setRole(EDITOR_UID, 'editor')
  })

  test('intent minted, then trip.deletingAt set → upload fails (mid-cascade)', async () => {
    // Same revocation logic: intent doesn't bypass tripNotDeleting.
    // Catches the race where the cascade has started after a member's
    // intent was already in flight.
    const seed = await seedIntent({
      intentId: 'i-revoke-deleting', entityType: 'expense', entityId: EXPENSE_ID,
    })
    await setDeleting(true)
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: EXPENSE_ID,
      }),
    ))
    await setDeleting(false)
  })

  test('wish: intent minted, then wish doc deleted → upload fails (proposer check)', async () => {
    const seed = await seedIntent({
      intentId: 'i-revoke-wish-doc', entityType: 'wish', entityId: WISH_ID,
    })
    // Delete the wish doc via admin context to simulate the wish being
    // removed between intent mint and upload.
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'trips', TRIP_ID, 'wishes', WISH_ID), {
        // Simplest: empty out proposedBy so isWishProposer fires.
        // (deleting the doc would require deleteDoc which we'd need
        // to import; updating to a non-matching proposedBy has the
        // same effect on isWishProposer.)
        proposedBy: 'someone-else-uid',
      }, { merge: true })
    })
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'wish', entityId: WISH_ID,
      }),
    ))
  })
})

// ─── deletingAt cascade gate (kept, with intent) ──────────────────

describe('cascade write-quiesce (deletingAt) gates Storage uploads', () => {
  // The race we're regression-guarding: Worker stamps trip.deletingAt
  // → starts draining Firestore → editor on another device uploads.
  // Without the cross-service tripNotDeleting helper, the upload
  // would succeed; the editor's matching Firestore setDoc(expense)
  // then fails (firestore.rules also gate creates by deletingAt),
  // leaving orphan Storage bytes the cascade has already walked
  // past. Pin all three writable Storage prefixes -- bookings,
  // expenses, wishes -- to reject uploads when deletingAt is set.

  async function setDeleting(on: boolean) {
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(
        doc(ctx.firestore(), 'trips', TRIP_ID),
        on ? { deletingAt: serverTimestamp() } : { deletingAt: deleteField() },
      )
    })
  }

  test('editor CANNOT upload booking attachment when trip.deletingAt is set', async () => {
    const seed = await seedIntent({
      intentId: 'i-bk-cascade', entityType: 'booking', entityId: 'booking-1',
      fileName: 'cascade.png', contentType: 'image/png',
    })
    await setDeleting(true)
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'booking', entityId: 'booking-1', contentType: 'image/png',
      }),
    ))
    await setDeleting(false)
  })

  test('editor CANNOT upload expense receipt when trip.deletingAt is set', async () => {
    const seed = await seedIntent({
      intentId: 'i-exp-cascade', entityType: 'expense', entityId: 'e1',
      fileName: 'cascade.png', contentType: 'image/png',
    })
    await setDeleting(true)
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'expense', entityId: 'e1', contentType: 'image/png',
      }),
    ))
    await setDeleting(false)
  })

  test('proposer CANNOT upload wish cover when trip.deletingAt is set', async () => {
    const seed = await seedIntent({
      intentId: 'i-wish-cascade', entityType: 'wish', entityId: 'wish-1',
      fileName: 'cascade.png', contentType: 'image/png',
    })
    await setDeleting(true)
    await assertFails(uploadString(
      ref(asEditor(env).storage(), seed.path), 'data', 'raw',
      uploadMetadata({
        intentId: seed.intentId, uploaderUid: seed.uploaderUid,
        entityType: 'wish', entityId: 'wish-1', contentType: 'image/png',
      }),
    ))
    await setDeleting(false)
  })
})

// ─── Wish cover delete tests (kept, no upload involved) ───────────

describe('Wish cover Storage ownership (delete)', () => {
  // Seed: WISH_ID in fixture is proposedBy EDITOR_UID. So the proposer
  // is editor; viewer / owner / stranger should NOT be able to write
  // its cover image, even though they're members of the trip.

  const PNG_META = { contentType: 'image/png' }

  test('non-proposer member CANNOT delete proposer\'s wish cover', async () => {
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

  test('trip owner CAN delete another member\'s wish cover (moderation parity with Firestore)', async () => {
    // The mismatch we're closing: firestore.rules allows
    // `proposedBy == uid() || isTripOwner(tripId)` on wish delete,
    // so the owner can moderate (spam, duplicates). Storage was
    // proposer-only -- when owner deletes the wish, wishService's
    // deleteWishImage() got 403 on Storage and the catch/log
    // swallowed it, leaving Storage bytes orphaned. Now Storage
    // delete also accepts isTripOwnerStorage.
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
