// The Worker's settlement writes (workers/ocr/src/settlement-route-write.ts)
// against the real Firestore emulator. The Worker's own specs use an
// in-memory Firestore; these check what only Firestore itself can answer:
//   - a projected (`select`) query inside a transaction returns the legs and
//     nothing else, and still feeds the ledger the next write is checked on
//   - preconditions, REQUEST_TIME transforms and the commit really apply
//   - two writes racing on the same debt: one wins, the other is refused
//   - firestore-size.ts measures a document the way Firestore enforces 1 MiB
//
// The Worker talks to firestore.googleapis.com; fetch is pointed at the
// emulator, and "Bearer owner" is the emulator's admin credential.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/admin', () => ({
  getAdminToken:        vi.fn(async () => 'owner'),
  getProjectId:         vi.fn(() => 'demo-tripmate-emulator'),
  invalidateAdminToken: vi.fn(),
}))

import {
  computePairwiseRemaining,
  planSettlementRoutes,
  routeForPayment,
  type SettlementRoute,
} from '@tripmate/settlement-core'
import {
  settlementDelete,
  settlementRouteCreate,
  SettlementRouteCreateRequestSchema,
} from '../src/settlement-route-write'
import { documentSize } from '../src/firestore-size'
import type { FsValue } from '../src/firestore'

const PROJECT = 'demo-tripmate-emulator'
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const EMULATOR = `http://${HOST}/v1`
const DOCS = `${EMULATOR}/projects/${PROJECT}/databases/(default)/documents`
const TRIP = 'trip-1'
const SA = '{}'

type Fields = Record<string, FsValue>
const str = (v: string): FsValue => ({ stringValue: v })
const int = (n: number): FsValue => ({ integerValue: String(n) })

// ─── Emulator plumbing ────────────────────────────────────────────

const realFetch = globalThis.fetch
/** Every runQuery response the Worker received, for projection checks. */
const queryResponses: Array<{ request: unknown; rows: Array<{ document?: { name: string; fields?: Fields } }> }> = []

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace('https://firestore.googleapis.com/v1', EMULATOR)
    const res = await realFetch(url, init)
    if (url.endsWith(':runQuery')) {
      queryResponses.push({ request: JSON.parse(String(init?.body)), rows: await res.clone().json() })
    }
    return res
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })

const admin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

async function put(path: string, fields: Fields): Promise<void> {
  const res = await realFetch(`${DOCS}/${path}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ fields }) })
  if (!res.ok) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`)
}

async function get(path: string): Promise<Fields | undefined> {
  const res = await realFetch(`${DOCS}/${path}`, { headers: admin })
  if (res.status === 404) return undefined
  return ((await res.json()) as { fields?: Fields }).fields ?? {}
}

async function list(collection: string): Promise<Array<{ id: string; fields: Fields }>> {
  const res = await realFetch(`${DOCS}/trips/${TRIP}/${collection}?pageSize=1000`, { headers: admin })
  const body = await res.json() as { documents?: Array<{ name: string; fields?: Fields }> }
  return (body.documents ?? []).map(d => ({ id: d.name.split('/').at(-1)!, fields: d.fields ?? {} }))
}

beforeEach(async () => {
  await realFetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  queryResponses.length = 0
})

// ─── Fixtures and readers ─────────────────────────────────────────

async function seedTrip(members: string[]) {
  await put(`trips/${TRIP}`, { currency: str('JPY'), ownerId: str('owner'), formerMemberNames: { mapValue: { fields: {} } } })
  for (const uid of ['owner', ...members]) await put(`trips/${TRIP}/members/${uid}`, { role: str(uid === 'owner' ? 'owner' : 'editor') })
}

let clock = Date.UTC(2026, 9, 1)
async function seedExpense(id: string, paidBy: string, splits: Record<string, number>) {
  clock += 1000
  await put(`trips/${TRIP}/expenses/${id}`, {
    title: str(id), paidBy: str(paidBy), currency: str('JPY'),
    amountMinor: int(Object.values(splits).reduce((s, n) => s + n, 0)),
    splits: { arrayValue: { values: Object.entries(splits).map(([memberId, n]) => ({ mapValue: { fields: { memberId: str(memberId), amountMinor: int(n) } } })) } },
    createdAt: { timestampValue: new Date(clock).toISOString() },
    deletedAt: { nullValue: null },
  })
}

const readStr = (f: Fields | undefined, k: string) => f?.[k]?.stringValue
const readInt = (f: Fields | undefined, k: string) => Number(f?.[k]?.integerValue)
const mapsIn = (f: Fields | undefined, k: string) => (f?.[k]?.arrayValue?.values ?? []).map(v => v.mapValue!.fields!)
const legsOf = (f: Fields) => mapsIn(f, 'legs').map(l => [readStr(l, 'fromUid')!, readStr(l, 'toUid')!, readInt(l, 'amountMinor')] as const)
const isActive = (f: Fields) => f.deletedAt !== undefined && 'nullValue' in f.deletedAt
const locksOf = async (expenseId: string) =>
  ((await get(`trips/${TRIP}/expenses/${expenseId}`))?.settlementLockIds?.arrayValue?.values ?? []).map(v => v.stringValue).sort()

/** The ledger as stored, through the same pair math the Worker uses. */
async function ledger() {
  const expenses = (await list('expenses')).filter(d => isActive(d.fields)).map(({ fields }) => ({
    amountMinor: readInt(fields, 'amountMinor'),
    paidBy:      readStr(fields, 'paidBy')!,
    splits:      mapsIn(fields, 'splits').map(s => ({ memberId: readStr(s, 'memberId')!, amountMinor: readInt(s, 'amountMinor') })),
  }))
  const settlements = (await list('settlements')).filter(d => isActive(d.fields)).flatMap(({ fields }) =>
    legsOf(fields).map(([fromUid, toUid, amountMinor]) => ({
      fromUid, toUid, amountMinor,
      createdAtMs: Date.parse(fields.createdAt!.timestampValue!),
    })))
  return computePairwiseRemaining(expenses, settlements)
}

function request(routeId: string, route: SettlementRoute) {
  const legs = route.legs.map(l => ({ fromUid: l.fromUid, toUid: l.toUid, amountMinor: l.amountMinor, expectedRemainingMinor: l.expectedRemainingMinor }))
  return SettlementRouteCreateRequestSchema.parse(route.kind === 'TRANSFER'
    ? { tripId: TRIP, routeId, kind: 'TRANSFER', payerUid: route.payerUid, receiverUid: route.receiverUid, amountMinor: route.amountMinor, legs }
    : { tripId: TRIP, routeId, kind: 'OFFSET', legs })
}

// ─── Tests ────────────────────────────────────────────────────────

describe('settlement routes on the Firestore emulator', () => {
  beforeEach(async () => {
    await seedTrip(['A', 'B', 'C'])
    await seedExpense('e1', 'B', { A: 1000 })   // A owes B 1000
    await seedExpense('e2', 'C', { B: 1000 })   // B owes C 1000
  })

  it('records A → C via B as one doc, with locks, lineage and a server timestamp', async () => {
    const [route] = planSettlementRoutes(await ledger())
    await expect(settlementRouteCreate('C', request('r1', route!), SA)).resolves.toEqual({ routeId: 'r1' })

    const doc = (await get(`trips/${TRIP}/settlements/r1`))!
    expect(legsOf(doc)).toEqual([['A', 'B', 1000], ['B', 'C', 1000]])
    expect(readStr(doc, 'payerUid')).toBe('A')
    expect(readStr(doc, 'receiverUid')).toBe('C')
    expect(Date.parse(doc.createdAt!.timestampValue!)).toBeGreaterThan(0)
    expect(mapsIn(doc, 'lockedExpenses').map(l => readStr(l, 'expenseId'))).toEqual(['e1', 'e2'])
    expect(mapsIn(doc, 'appliedSources').map(s => [readInt(s, 'legIndex'), readStr(s, 'expenseId')])).toEqual([[0, 'e1'], [1, 'e2']])
    expect(await locksOf('e1')).toEqual(['r1'])
    expect(await locksOf('e2')).toEqual(['r1'])
    expect(await ledger()).toEqual({})
  })

  it('reads other settlements through a projection that returns their legs and nothing else', async () => {
    const [route] = planSettlementRoutes(await ledger())
    await settlementRouteCreate('C', request('r1', route!), SA)
    // A second write over the same pair reads r1 through the projected query.
    const again = { kind: 'TRANSFER' as const, payerUid: 'A', receiverUid: 'B', amountMinor: 1,
      legs: [{ fromUid: 'A', toUid: 'B', amountMinor: 1, expectedRemainingMinor: 1000 }] }
    await expect(settlementRouteCreate('B', request('r2', again), SA)).rejects.toMatchObject({ code: 'SETTLEMENT_STALE' })

    const ledgerReads = queryResponses.filter(q => JSON.stringify(q.request).includes('"settlements"'))
    const docs = ledgerReads.flatMap(q => q.rows.flatMap(r => (r.document ? [r.document] : [])))
    expect(docs.length).toBeGreaterThan(0)
    for (const d of docs) expect(Object.keys(d.fields ?? {}).sort()).toEqual(['createdAt', 'legs'])
    // The stale write was refused with nothing written.
    expect(await get(`trips/${TRIP}/settlements/r2`)).toBeUndefined()
  })

  it('a retry of the same payment is idempotent', async () => {
    const [route] = planSettlementRoutes(await ledger())
    const req = request('r1', route!)
    await settlementRouteCreate('C', req, SA)
    await expect(settlementRouteCreate('C', req, SA)).resolves.toEqual({ routeId: 'r1' })
    expect((await list('settlements')).map(d => d.id)).toEqual(['r1'])
  })

  it('cancelling restores the ledger and releases every lock, in one doc write', async () => {
    const before = await ledger()
    const [route] = planSettlementRoutes(before)
    await settlementRouteCreate('C', request('r1', route!), SA)
    await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)

    const doc = (await get(`trips/${TRIP}/settlements/r1`))!
    expect(isActive(doc)).toBe(false)
    expect(readStr(doc, 'deletedBy')).toBe('C')
    expect(await locksOf('e1')).toEqual([])
    expect(await locksOf('e2')).toEqual([])
    expect(await ledger()).toEqual(before)
    // The debt is open again and can be recorded under a new id.
    await settlementRouteCreate('C', request('r2', planSettlementRoutes(await ledger())[0]!), SA)
    expect(await ledger()).toEqual({})
  })

  it('two writes racing over the same debt: exactly one lands', async () => {
    const route = routeForPayment(await ledger(), 'A', 'C', 1000)!
    const results = await Promise.allSettled([
      settlementRouteCreate('C', request('race-1', route), SA),
      settlementRouteCreate('C', request('race-2', route), SA),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'SETTLEMENT_STALE' })
    expect((await list('settlements')).filter(d => isActive(d.fields))).toHaveLength(1)
    expect(await ledger()).toEqual({})
  })
})

describe('firestore-size.ts against the emulator\'s 1 MiB limit', () => {
  const MAX = 1_048_576
  const path = `trips/${TRIP}/sizeprobe/doc`
  /** A doc whose computed size is exactly `size` bytes (padding a 4-byte-
   *  character string plus a nested map, so UTF-8 and nesting both count). */
  function docOfSize(size: number): Fields {
    const base: Fields = { nested: { mapValue: { fields: { n: int(1), flag: { booleanValue: true } } } }, pad: str('') }
    const remaining = size - documentSize(path, base)
    const wide = Math.floor(remaining / 4)
    return { ...base, pad: str('𠀀'.repeat(wide) + 'x'.repeat(remaining - wide * 4)) }
  }

  it('a document of exactly 1 MiB is accepted and one byte more is refused', async () => {
    const atLimit = docOfSize(MAX)
    expect(documentSize(path, atLimit)).toBe(MAX)
    await expect(put(path, atLimit)).resolves.toBeUndefined()

    const over = docOfSize(MAX + 1)
    expect(documentSize(path, over)).toBe(MAX + 1)
    await expect(put(path, over)).rejects.toThrow(/400|INVALID_ARGUMENT|exceeds/i)
  })
})
