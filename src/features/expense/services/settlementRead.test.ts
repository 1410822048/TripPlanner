import { beforeEach, expect, it, vi } from 'vitest'
import type { QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore'

const fb = vi.hoisted(() => ({
  db: {}, collection: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
  query: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(), onSnapshot: vi.fn(),
}))
vi.mock('@/services/firebase', () => ({ getFirebase: async () => fb }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))
vi.mock('@/services/firestoreDocFromSchema', () => ({
  firestoreDocFromSchema: (_schema: unknown, doc: QueryDocumentSnapshot) => {
    if (doc.id === 'bad') throw new Error('invalid settlement')
    return { id: doc.id }
  },
}))
import { getSettlementsByTrip, getSettlementsByTripFromServer, subscribeToSettlements } from './settlementService'

function snapshot(size: number, invalid = false): QuerySnapshot {
  return { size, docs: Array.from({ length: size }, (_, index) => ({ id: invalid && index === 0 ? 'bad' : String(index) })) } as unknown as QuerySnapshot
}
beforeEach(() => vi.clearAllMocks())

it('allows exactly 200 settlements and probes 201 on cache/server reads', async () => {
  fb.getDocs.mockResolvedValue(snapshot(200))
  fb.getDocsFromServer.mockResolvedValue(snapshot(200))
  expect(await getSettlementsByTrip('t')).toHaveLength(200)
  expect(await getSettlementsByTripFromServer('t')).toHaveLength(200)
  expect(fb.limit.mock.calls).toEqual([[201], [201]])
})
it.each([[201, false], [1, true]])('refuses incomplete settlement reads (%i, %s)', async (size, invalid) => {
  fb.getDocs.mockResolvedValue(snapshot(size, invalid))
  fb.getDocsFromServer.mockResolvedValue(snapshot(size, invalid))
  await expect(getSettlementsByTrip('t')).rejects.toThrow('無法計算完整餘額')
  await expect(getSettlementsByTripFromServer('t')).rejects.toThrow('無法計算完整餘額')
})
it('applies the same strict policy to the settlement listener', async () => {
  const onData = vi.fn()
  const onError = vi.fn()
  await subscribeToSettlements('t', onData, onError)
  const callback = fb.onSnapshot.mock.calls[0]![1] as (snap: QuerySnapshot) => void
  callback(snapshot(201))
  callback(snapshot(1, true))
  expect(onError).toHaveBeenCalledTimes(2)
  expect(onData).not.toHaveBeenCalled()
  expect(fb.limit).toHaveBeenCalledWith(201)
})
