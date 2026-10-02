import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteField, doc, getDoc, getDocs, orderBy, query, serverTimestamp, updateDoc, where, writeBatch } from 'firebase/firestore'
import { TripDocSchema } from '../../src/types/trip'
import { setupTestEnv, teardownTestEnv, seedFixture, asOwner, asViewer, TRIP_ID, OWNER_UID } from './helpers'

let env: RulesTestEnvironment
beforeAll(async () => { env = await setupTestEnv() })
afterAll(async () => { await teardownTestEnv() })
beforeEach(async () => { await env.clearFirestore(); await seedFixture(env) })

describe('Rules protect required read schema', () => {
  it.each(['startDate', 'endDate', 'updatedAt'])('rejects removing required %s', async field => {
    const ref = doc(asOwner(env).firestore(), 'trips', TRIP_ID)
    expect(TripDocSchema.safeParse((await getDoc(ref)).data()).success).toBe(true)
    await assertFails(updateDoc(ref, { [field]: deleteField() }))
    expect(TripDocSchema.safeParse((await getDoc(ref)).data()).success).toBe(true)
  })
  it('rejects poisoning updatedAt through the member activity branch', async () => {
    await assertFails(updateDoc(doc(asViewer(env).firestore(), 'trips', TRIP_ID), {
      lastActivityByFeature: { expense: {} }, updatedAt: 'invalid',
    }))
  })
  it.each(['missing', 'invalid', 'valid'])('validates joinedAt in an atomic owner bootstrap: %s', async mode => {
    const db = asOwner(env).firestore()
    const id = 'test-bootstrap'
    const batch = writeBatch(db)
    batch.set(doc(db, 'trips', id), {
      title: 'Test', destination: 'Tokyo', ownerId: OWNER_UID, memberIds: [OWNER_UID],
      startDate: serverTimestamp(), endDate: serverTimestamp(), currency: 'JPY', defaultCountryCode: 'JP',
      wishVotingDeadlineAt: null, wishVotingDeadlineNotifiedAt: null,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    })
    batch.set(doc(db, 'trips', id, 'members', OWNER_UID), {
      tripId: id, userId: OWNER_UID, displayName: 'Owner', role: 'owner', memberIds: [OWNER_UID],
      ...(mode === 'missing' ? {} : { joinedAt: mode === 'valid' ? serverTimestamp() : 'invalid' }),
    })
    if (mode !== 'valid') {
      await assertFails(batch.commit())
      expect((await getDoc(doc(db, 'trips', id))).exists()).toBe(false)
      return
    }
    await assertSucceeds(batch.commit())
    const result = await getDocs(query(collection(db, 'trips', id, 'members'), where('memberIds', 'array-contains', OWNER_UID), orderBy('joinedAt')))
    expect(result.size).toBe(1)
  })
})
