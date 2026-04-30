// tests/rules/helpers.ts
// Shared bootstrap for Firestore + Storage rules tests.
//
// Pattern: each test gets its own RulesTestEnvironment via beforeAll, then
// per-test we ask the env for an authenticated context (or unauthenticated)
// and run real SDK calls against it. The emulator interprets firestore.rules
// / storage.rules byte-for-byte the same as production, so a test that
// asserts "viewer can't delete a booking" is the closest thing we have to
// proof short of staging.
//
// Why a custom helper file:
//   - Reading the rule files once at suite startup beats re-reading per test.
//   - `assertSucceeds` / `assertFails` get tedious to import everywhere.
//   - The seed helper centralises "make a trip with an owner + editor +
//     viewer + a booking + a wish" so each test starts from a known fixture.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type RulesTestContext,
} from '@firebase/rules-unit-testing'
import {
  doc, setDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// "demo-" prefix is recognised by Firebase emulators as a no-credentials
// test project. Using a fixed name (not .firebaserc default) keeps tests
// isolated from any real project state.
export const PROJECT_ID = 'demo-tripmate-rules'

export const OWNER_UID  = 'owner-uid'
export const EDITOR_UID = 'editor-uid'
export const VIEWER_UID = 'viewer-uid'
export const STRANGER_UID = 'stranger-uid'

export const TRIP_ID    = 'trip-1'
export const BOOKING_ID = 'booking-1'
export const WISH_ID    = 'wish-1'

let cachedEnv: RulesTestEnvironment | null = null

/** Create one env per test file. Reusing across files is fine, but vitest's
 *  isolated worker model means each .test.ts gets its own anyway. */
export async function setupTestEnv(): Promise<RulesTestEnvironment> {
  if (cachedEnv) return cachedEnv
  cachedEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host:  '127.0.0.1',
      port:  8080,
    },
    storage: {
      rules: readFileSync(resolve(__dirname, '../../storage.rules'), 'utf8'),
      host:  '127.0.0.1',
      port:  9199,
    },
  })
  return cachedEnv
}

export async function teardownTestEnv(): Promise<void> {
  if (!cachedEnv) return
  await cachedEnv.cleanup()
  cachedEnv = null
}

/**
 * Seed a trip with three members (owner / editor / viewer) plus one
 * booking and one wish. Uses `withSecurityRulesDisabled` so the seed
 * itself doesn't have to satisfy the create rules — we're testing the
 * runtime gate, not the bootstrap path.
 */
export async function seedFixture(env: RulesTestEnvironment): Promise<void> {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    const now = Timestamp.now()
    await setDoc(doc(db, 'trips', TRIP_ID), {
      title:       'Test Trip',
      destination: 'Tokyo',
      startDate:   now,
      endDate:     now,
      currency:    'JPY',
      ownerId:     OWNER_UID,
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    })
    for (const [uid, role] of [
      [OWNER_UID,  'owner'],
      [EDITOR_UID, 'editor'],
      [VIEWER_UID, 'viewer'],
    ] as const) {
      await setDoc(doc(db, 'trips', TRIP_ID, 'members', uid), {
        tripId: TRIP_ID, userId: uid, displayName: uid, role,
        joinedAt: serverTimestamp(),
      })
    }
    await setDoc(doc(db, 'trips', TRIP_ID, 'bookings', BOOKING_ID), {
      tripId: TRIP_ID, type: 'hotel', title: 'Test Hotel',
      memberIds: [OWNER_UID, EDITOR_UID, VIEWER_UID],
      createdAt: serverTimestamp(),
      sortDate:  serverTimestamp(),
    })
    await setDoc(doc(db, 'trips', TRIP_ID, 'wishes', WISH_ID), {
      tripId: TRIP_ID, title: 'Test Wish', category: 'place',
      proposedBy: EDITOR_UID, votes: [EDITOR_UID],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  })
}

/** Convenience accessors for the three member roles + an outsider. */
export function asOwner(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(OWNER_UID)
}
export function asEditor(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(EDITOR_UID)
}
export function asViewer(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(VIEWER_UID)
}
export function asStranger(env: RulesTestEnvironment): RulesTestContext {
  return env.authenticatedContext(STRANGER_UID)
}
export function asAnon(env: RulesTestEnvironment): RulesTestContext {
  return env.unauthenticatedContext()
}
