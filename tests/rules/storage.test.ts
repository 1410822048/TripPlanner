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
