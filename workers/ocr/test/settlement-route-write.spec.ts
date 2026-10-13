// Endpoint tests for routed settlement (settlement-route-write.ts) and the
// route-aware /settlement-delete.
//
// Unlike settlement-write.spec (one captured TxResult per test), these run
// against an in-memory Firestore (helpers/fake-firestore) so a test can
// create a route, create another, cancel one, and then read the LEDGER back
// through the same computePairwiseRemaining the Worker uses. The point is to
// try to break the accounting, not only to check write shapes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/firestore-tx', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore-tx')>('../src/firestore-tx')
	const { fake } = await import('./helpers/fake-firestore')
	return {
		...actual,
		runFirestoreTransaction: vi.fn(async (_t: string, _p: string, body: Parameters<typeof fake.run>[0]) => fake.run(body)),
	}
})

vi.mock('../src/cascade', async () => {
	const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
	return { ...actual, withTokenRetry: <T,>(fn: () => Promise<T>) => fn() }
})

const { defaultResolveFxRateImpl } = vi.hoisted(() => ({
	defaultResolveFxRateImpl: async (input: import('../src/fx-rate').ResolveFxRateInput) => ({
		rateDate:    input.requestedDate,
		rateDecimal: '150',
		fetchedAtMs: 1_700_000_000_000,
	}),
}))
vi.mock('../src/fx-rate', async () => {
	const actual = await vi.importActual<typeof import('../src/fx-rate')>('../src/fx-rate')
	return { ...actual, resolveFxRate: vi.fn(defaultResolveFxRateImpl) }
})

import {
	canonicalPairKey,
	computePairwiseRemaining,
	planSettlementRoutes,
	routeForPayment,
	routeLegId,
	type CoreExpense,
	type CoreSettlement,
	type SettlementRoute,
} from '@tripmate/settlement-core'
import { fake } from './helpers/fake-firestore'
import {
	settlementDelete,
	settlementRouteCreate,
	SettlementRouteCreateRequestSchema,
	type SettlementRouteCreateRequest,
} from '../src/settlement-route-write'
import * as fxRate from '../src/fx-rate'
import type { FsValue } from '../src/firestore'

const TRIP = 'trip-1'
const OWNER = 'owner'
const GHOST = 'ghost'
const SA = '{}'

type Fields = Record<string, FsValue>
const str = (v: string): FsValue => ({ stringValue: v })
const int = (n: number): FsValue => ({ integerValue: String(n) })

function seedTrip(members: string[], opts: { former?: Record<string, string>; currency?: string } = {}) {
	fake.reset()
	fake.set(`trips/${TRIP}`, {
		currency: str(opts.currency ?? 'JPY'),
		ownerId:  str(OWNER),
		formerMemberNames: { mapValue: { fields: Object.fromEntries(Object.entries(opts.former ?? {}).map(([k, v]) => [k, str(v)])) } },
	})
	for (const uid of [OWNER, ...members]) {
		fake.set(`trips/${TRIP}/members/${uid}`, { role: str(uid === OWNER ? 'owner' : 'editor') })
	}
}

/** One expense paid by `paidBy`, split as given (memberId → minor). */
function seedExpense(id: string, paidBy: string, splits: Record<string, number>, extra: Fields = {}) {
	const amount = Object.values(splits).reduce((s, n) => s + n, 0)
	fake.set(`trips/${TRIP}/expenses/${id}`, {
		title:       str(id),
		paidBy:      str(paidBy),
		amountMinor: int(amount),
		currency:    str('JPY'),
		splits: { arrayValue: { values: Object.entries(splits).map(([memberId, n]) => ({ mapValue: { fields: { memberId: str(memberId), amountMinor: int(n) } } })) } },
		createdAt:   { timestampValue: fake.tick() },
		deletedAt:   { nullValue: null },
		...extra,
	})
}

function docsIn(collection: string): Array<{ id: string; fields: Fields }> {
	const base = `trips/${TRIP}/${collection}/`
	return [...fake.docs.entries()]
		.filter(([p]) => p.startsWith(base))
		.map(([p, fields]) => ({ id: p.slice(base.length), fields }))
}

const readStr = (f: Fields | undefined, k: string) => (f?.[k] as { stringValue?: string } | undefined)?.stringValue
const readInt = (f: Fields | undefined, k: string) => Number((f?.[k] as { integerValue?: string } | undefined)?.integerValue)
const readArr = (f: Fields | undefined, k: string) =>
	((f?.[k] as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []).map(v => v.stringValue!)
const routeOf = (f: Fields) => (f.route as { mapValue: { fields: Fields } } | undefined)?.mapValue.fields
const isActive = (f: Fields) => 'nullValue' in (f.deletedAt ?? {})

/** The ledger exactly as the Worker would compute it from what's stored. */
function ledger(): Record<string, Record<string, number>> {
	const expenses: CoreExpense[] = docsIn('expenses').filter(d => isActive(d.fields)).map(({ fields }) => ({
		amountMinor: readInt(fields, 'amountMinor'),
		paidBy:      readStr(fields, 'paidBy')!,
		splits: ((fields.splits as { arrayValue: { values: FsValue[] } }).arrayValue.values).map(v => ({
			memberId:    readStr(v.mapValue!.fields, 'memberId')!,
			amountMinor: readInt(v.mapValue!.fields, 'amountMinor'),
		})),
	}))
	const settlements: CoreSettlement[] = docsIn('settlements').filter(d => isActive(d.fields)).map(({ fields }) => ({
		fromUid:     readStr(fields, 'fromUid')!,
		toUid:       readStr(fields, 'toUid')!,
		amountMinor: readInt(fields, 'amountMinor'),
		createdAtMs: Date.parse((fields.createdAt as { timestampValue: string }).timestampValue),
	}))
	return computePairwiseRemaining(expenses, settlements)
}

function request(routeId: string, route: SettlementRoute, extra: Partial<SettlementRouteCreateRequest> = {}): SettlementRouteCreateRequest {
	const legs = route.legs.map(l => ({ fromUid: l.fromUid, toUid: l.toUid, amountMinor: l.amountMinor, expectedRemainingMinor: l.expectedRemainingMinor }))
	const body = route.kind === 'TRANSFER'
		? { tripId: TRIP, routeId, kind: 'TRANSFER' as const, payerUid: route.payerUid, receiverUid: route.receiverUid, amountMinor: route.amountMinor, legs, ...extra }
		: { tripId: TRIP, routeId, kind: 'OFFSET' as const, legs, ...extra }
	// Every test request goes through the real wire schema first.
	return SettlementRouteCreateRequestSchema.parse(body)
}

/** Who the Worker lets record this route (receiver / first participant). */
const recorderOf = (route: SettlementRoute) => route.kind === 'TRANSFER' ? route.receiverUid : route.participantUids[0]!

function snapshot() { return JSON.stringify([...fake.docs.entries()].sort()) }

beforeEach(() => {
	vi.mocked(fxRate.resolveFxRate).mockImplementation(defaultResolveFxRateImpl)
})

describe('/settlement-route-create — basic and multi-hop', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000 })   // A owes B 1000
		seedExpense('e2', 'C', { B: 1000 })   // B owes C 1000
	})

	it('records A → C via B as two ordinary legs with one route header', async () => {
		const [route] = planSettlementRoutes(ledger())
		expect(route).toMatchObject({ kind: 'TRANSFER', payerUid: 'A', receiverUid: 'C', amountMinor: 1000 })
		const result = await settlementRouteCreate('C', request('r1', route!, { note: '晚餐' }), SA)
		expect(result).toEqual({ routeId: 'r1', settlementIds: ['r1-00', 'r1-01'] })

		const legs = docsIn('settlements')
		expect(legs.map(l => [l.id, readStr(l.fields, 'fromUid'), readStr(l.fields, 'toUid'), readInt(l.fields, 'amountMinor')]))
			.toEqual([['r1-00', 'A', 'B', 1000], ['r1-01', 'B', 'C', 1000]])
		for (const [i, leg] of legs.entries()) {
			expect(readStr(leg.fields, 'settledBy')).toBe('C')
			expect(readStr(leg.fields, 'currency')).toBe('JPY')
			const header = routeOf(leg.fields)!
			expect(readStr(header, 'id')).toBe('r1')
			expect(readInt(header, 'legIndex')).toBe(i)
			expect(readInt(header, 'legCount')).toBe(2)
			expect(readStr(header, 'kind')).toBe('TRANSFER')
			expect(readStr(header, 'payerUid')).toBe('A')
			expect(readStr(header, 'receiverUid')).toBe('C')
			expect(readInt(header, 'amountMinor')).toBe(1000)
			expect(readStr(header, 'note')).toBe('晚餐')
			expect(readArr(header, 'participantUids')).toEqual(['A', 'B', 'C'])
			// FX never lands on a leg — B did not pay anyone in foreign money.
			expect(leg.fields.sourceCurrency).toBeUndefined()
		}
		// Lineage per leg: each draws from the expense behind its own edge.
		expect(readArr(legs[0]!.fields, 'appliedExpenseIds')).toEqual(['e1'])
		expect(readArr(legs[1]!.fields, 'appliedExpenseIds')).toEqual(['e2'])
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds')).toEqual(['r1-00'])
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e2`), 'settlementLockIds')).toEqual(['r1-01'])
		// Both pair locks touched.
		expect(fake.fields(`trips/${TRIP}/settlementPairLocks/${canonicalPairKey('A', 'B')}`)).toBeDefined()
		expect(fake.fields(`trips/${TRIP}/settlementPairLocks/${canonicalPairKey('B', 'C')}`)).toBeDefined()
		expect(ledger()).toEqual({})
	})

	it('reads pair locks one at a time in sorted order', async () => {
		const [route] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', route!), SA)
		const lockReads = fake.getCalls.filter(p => p.includes('/settlementPairLocks/'))
		expect(lockReads).toEqual([...lockReads].sort())
		expect(lockReads).toHaveLength(2)
	})

	it('refuses everyone but the receiver, including the payer and the intermediate', async () => {
		const [route] = planSettlementRoutes(ledger())
		for (const caller of ['A', 'B', OWNER]) {
			const before = snapshot()
			await expect(settlementRouteCreate(caller, request('r1', route!), SA))
				.rejects.toMatchObject({ name: 'SettlementValidationError', field: 'receiverUid' })
			expect(snapshot()).toBe(before)
		}
	})

	it('refuses a non-member outright', async () => {
		const [route] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('stranger', request('r1', route!), SA)).rejects.toMatchObject({ status: 403 })
	})
})

describe('multi-path, partial and overlapping edges', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C', 'D'])
		seedExpense('e1', 'B', { A: 300 })
		seedExpense('e2', 'D', { A: 500 })
		seedExpense('e3', 'C', { B: 300 })
		seedExpense('e4', 'C', { D: 400 })
	})

	it('one logical payment over two paths, then the rest of a partially used edge', async () => {
		const route = routeForPayment(ledger(), 'A', 'C', 700)!
		expect(route.legs).toHaveLength(4)
		await settlementRouteCreate('C', request('r1', route), SA)
		// A→D was only partly used (400 of 500): 100 is still owed to D.
		expect(ledger()).toEqual({ A: { D: 100 } })

		const rest = routeForPayment(ledger(), 'A', 'D', 100)!
		await settlementRouteCreate('D', request('r2', rest), SA)
		expect(ledger()).toEqual({})

		// The two legs on A→D together drew exactly the 500 of e2, never twice.
		const onAD = docsIn('settlements').filter(d => readStr(d.fields, 'fromUid') === 'A' && readStr(d.fields, 'toUid') === 'D')
		const drawn = onAD.flatMap(d => ((d.fields.appliedSources as { arrayValue: { values: FsValue[] } }).arrayValue.values))
			.map(v => readInt(v.mapValue!.fields, 'amountMinor'))
		expect(drawn).toEqual([400, 100])
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e2`), 'settlementLockIds').sort()).toEqual(['r1-01', 'r2-00'])
	})

	it('a stale suggestion is refused (per-edge CAS) and nothing is written', async () => {
		const planned = routeForPayment(ledger(), 'A', 'C', 700)!
		await settlementRouteCreate('D', request('r0', routeForPayment(ledger(), 'A', 'D', 50)!), SA)
		const before = snapshot()
		await expect(settlementRouteCreate('C', request('r1', planned), SA))
			.rejects.toMatchObject({ status: 409, code: 'SETTLEMENT_STALE' })
		expect(snapshot()).toBe(before)
		// Replanning on the live ledger succeeds.
		await settlementRouteCreate('C', request('r1', routeForPayment(ledger(), 'A', 'C', 650)!), SA)
	})

	it('a second create racing on the same edges sees the first and is refused', async () => {
		const plan = planSettlementRoutes(ledger())
		const route = plan.find(r => r.kind === 'TRANSFER')!
		await settlementRouteCreate(recorderOf(route), request('r1', route), SA)
		await expect(settlementRouteCreate(recorderOf(route), request('r2', route), SA))
			.rejects.toMatchObject({ status: 409, code: 'SETTLEMENT_STALE' })
	})

	it('refuses an edge that does not exist even when the CAS number matches', async () => {
		const forged = { kind: 'TRANSFER' as const, payerUid: 'A', receiverUid: 'C', amountMinor: 10,
			legs: [{ fromUid: 'A', toUid: 'C', amountMinor: 10, expectedRemainingMinor: 10 }] }
		await expect(settlementRouteCreate('C', request('r1', forged), SA))
			.rejects.toMatchObject({ status: 409, code: 'SETTLEMENT_STALE' })
	})
})

describe('route shape is re-validated by the Worker', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C', 'D', 'E', 'F'])
		seedExpense('e1', 'B', { A: 100 })
		seedExpense('e2', 'C', { B: 100 })
		seedExpense('e3', 'E', { D: 50 })
		seedExpense('e4', 'F', { E: 50 })
		seedExpense('e5', 'D', { F: 50 })
	})

	it('refuses an intermediate that would not net to zero', async () => {
		const bad = { kind: 'TRANSFER' as const, payerUid: 'A', receiverUid: 'C', amountMinor: 100, legs: [
			{ fromUid: 'A', toUid: 'B', amountMinor: 100, expectedRemainingMinor: 100 },
			{ fromUid: 'B', toUid: 'C', amountMinor: 60, expectedRemainingMinor: 100 },
		] }
		await expect(settlementRouteCreate('C', request('r1', bad), SA))
			.rejects.toMatchObject({ field: 'legs', message: expect.stringContaining('NOT_CONSERVED') })
	})

	it('refuses a transfer that bundles someone else\'s debt cycle', async () => {
		const smuggled = { kind: 'TRANSFER' as const, payerUid: 'A', receiverUid: 'C', amountMinor: 100, legs: [
			{ fromUid: 'A', toUid: 'B', amountMinor: 100, expectedRemainingMinor: 100 },
			{ fromUid: 'B', toUid: 'C', amountMinor: 100, expectedRemainingMinor: 100 },
			{ fromUid: 'D', toUid: 'E', amountMinor: 50, expectedRemainingMinor: 50 },
			{ fromUid: 'E', toUid: 'F', amountMinor: 50, expectedRemainingMinor: 50 },
			{ fromUid: 'F', toUid: 'D', amountMinor: 50, expectedRemainingMinor: 50 },
		] }
		await expect(settlementRouteCreate('C', request('r1', smuggled), SA))
			.rejects.toMatchObject({ field: 'legs', message: expect.stringContaining('CYCLIC') })
		expect(docsIn('settlements')).toEqual([])
	})

	it('refuses a leg larger than the remaining it claims (schema)', () => {
		expect(SettlementRouteCreateRequestSchema.safeParse({
			tripId: TRIP, routeId: 'r1', kind: 'TRANSFER', payerUid: 'A', receiverUid: 'B', amountMinor: 200,
			legs: [{ fromUid: 'A', toUid: 'B', amountMinor: 200, expectedRemainingMinor: 100 }],
		}).success).toBe(false)
	})

	it('refuses foreign fields on an offset and half a foreign trio (schema)', () => {
		const offset = { tripId: TRIP, routeId: 'r1', kind: 'OFFSET', legs: [{ fromUid: 'D', toUid: 'E', amountMinor: 1, expectedRemainingMinor: 1 }] }
		expect(SettlementRouteCreateRequestSchema.safeParse({ ...offset, sourceCurrency: 'USD' }).success).toBe(false)
		expect(SettlementRouteCreateRequestSchema.safeParse({
			tripId: TRIP, routeId: 'r1', kind: 'TRANSFER', payerUid: 'A', receiverUid: 'B', amountMinor: 1,
			legs: [{ fromUid: 'A', toUid: 'B', amountMinor: 1, expectedRemainingMinor: 1 }], sourceCurrency: 'USD',
		}).success).toBe(false)
		expect(SettlementRouteCreateRequestSchema.safeParse({ ...offset, legs: [], routeId: 'x'.repeat(51) }).success).toBe(false)
	})
})

describe('cycles (OFFSET)', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C', 'D', 'E', 'F'], { former: { [GHOST]: '小鬼' } })
		seedExpense('e1', 'B', { A: 100 })
		seedExpense('e2', 'C', { B: 100 })
		seedExpense('e3', 'A', { C: 100 })
		seedExpense('e4', 'E', { D: 70 })
		seedExpense('e5', 'F', { E: 70 })
		seedExpense('e6', 'D', { F: 70 })
	})

	it('plans one offset per disconnected cycle, each recordable only by its own participants', async () => {
		const plan = planSettlementRoutes(ledger())
		expect(plan.map(r => r.kind === 'OFFSET' && r.participantUids)).toEqual([['A', 'B', 'C'], ['D', 'E', 'F']])
		const [abc, def] = plan
		// D is in a cycle, but not this one.
		await expect(settlementRouteCreate('D', request('r1', abc!), SA)).rejects.toMatchObject({ field: 'legs' })
		// The owner is not a participant and these members are all active.
		await expect(settlementRouteCreate(OWNER, request('r1', abc!), SA)).rejects.toMatchObject({ field: 'legs' })
		await settlementRouteCreate('B', request('r1', abc!), SA)
		await settlementRouteCreate('F', request('r2', def!), SA)
		expect(ledger()).toEqual({})
		// Every leg locks its expense; the offset header names no payer.
		const leg = docsIn('settlements')[0]!
		expect(readStr(routeOf(leg.fields), 'kind')).toBe('OFFSET')
		expect(routeOf(leg.fields)!.payerUid).toBeUndefined()
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds')).toHaveLength(1)
	})

	it('refuses both cycles bundled into one offset', async () => {
		const [abc, def] = planSettlementRoutes(ledger())
		const merged = { kind: 'OFFSET' as const, participantUids: [], legs: [...abc!.legs, ...def!.legs] }
		await expect(settlementRouteCreate('A', request('r1', merged), SA))
			.rejects.toMatchObject({ message: expect.stringContaining('DISCONNECTED') })
	})

	it('cancelling an offset restores every edge and releases every lock', async () => {
		const before = ledger()
		const [abc] = planSettlementRoutes(before)
		await settlementRouteCreate('C', request('r1', abc!), SA)
		// Owner may cancel; so may the recorder.
		await settlementDelete(OWNER, { tripId: TRIP, settlementId: 'r1-02' }, SA)
		expect(ledger()).toEqual(before)
		for (const id of ['e1', 'e2', 'e3']) expect(readArr(fake.fields(`trips/${TRIP}/expenses/${id}`), 'settlementLockIds')).toEqual([])
		expect(docsIn('settlements').every(d => readStr(d.fields, 'deletedBy') === OWNER)).toBe(true)
	})
})

describe('departed members (ghosts)', () => {
	beforeEach(() => {
		seedTrip(['A', 'C'], { former: { [GHOST]: '小鬼', G2: '阿二', G3: '阿三' } })
	})

	it('a ghost may be the payer or an intermediate; the active receiver confirms', async () => {
		seedExpense('e1', GHOST, { A: 400 })   // A owes ghost
		seedExpense('e2', 'C', { [GHOST]: 900 }) // ghost owes C
		const plan = planSettlementRoutes(ledger())
		const viaGhost = plan.find(r => r.kind === 'TRANSFER' && r.payerUid === 'A')!
		expect(viaGhost.legs.map(l => l.toUid)).toContain(GHOST)
		await settlementRouteCreate('C', request('r1', viaGhost), SA)
		const ghostPays = planSettlementRoutes(ledger())[0]!
		expect(ghostPays).toMatchObject({ payerUid: GHOST, receiverUid: 'C' })
		await settlementRouteCreate('C', request('r2', ghostPays), SA)
		expect(ledger()).toEqual({})
	})

	it('a debt owed to a ghost can only be recorded by the owner, marked as such', async () => {
		seedExpense('e1', GHOST, { A: 400 })
		const [route] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('A', request('r1', route!), SA)).rejects.toMatchObject({ field: 'receiverUid' })
		await settlementRouteCreate(OWNER, request('r1', route!), SA)
		const leg = docsIn('settlements')[0]!
		expect((routeOf(leg.fields)!.ownerRecorded as { booleanValue: boolean }).booleanValue).toBe(true)
		expect(readStr(leg.fields, 'settledBy')).toBe(OWNER)
	})

	it('the owner may record a cycle only when everyone in it has left', async () => {
		seedExpense('e1', 'G2', { [GHOST]: 50 })
		seedExpense('e2', 'G3', { G2: 50 })
		seedExpense('e3', GHOST, { G3: 50 })
		const [cycle] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('A', request('r1', cycle!), SA)).rejects.toMatchObject({ field: 'legs' })
		await settlementRouteCreate(OWNER, request('r1', cycle!), SA)
		expect(ledger()).toEqual({})
	})

	it('a cycle with an active participant is theirs to record, not the owner\'s', async () => {
		// ghost owes A, C owes ghost, A owes C: a cycle through a departed member.
		seedExpense('x1', 'A', { [GHOST]: 30 })
		seedExpense('x2', GHOST, { C: 30 })
		seedExpense('x3', 'C', { A: 30 })
		const [cycle] = planSettlementRoutes(ledger())
		expect(cycle).toMatchObject({ kind: 'OFFSET', participantUids: ['A', 'C', GHOST] })
		await expect(settlementRouteCreate(OWNER, request('r1', cycle!), SA)).rejects.toMatchObject({ field: 'legs' })
		await settlementRouteCreate('A', request('r1', cycle!), SA)
		expect(ledger()).toEqual({})
	})
})

describe('idempotency and cancelled ids', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000 })
		seedExpense('e2', 'C', { B: 1000 })
	})

	it('a retry of the same route succeeds without writing again, even with FX down', async () => {
		const [route] = planSettlementRoutes(ledger())
		const req = request('r1', route!)
		await settlementRouteCreate('C', req, SA)
		const commits = fake.commits.length
		vi.mocked(fxRate.resolveFxRate).mockRejectedValue(new Error('provider down'))
		await expect(settlementRouteCreate('C', req, SA)).resolves.toEqual({ routeId: 'r1', settlementIds: ['r1-00', 'r1-01'] })
		expect(fake.commits[commits]).toEqual([])
	})

	it('a different payload under the same routeId is a collision', async () => {
		const [route] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', route!), SA)
		await expect(settlementRouteCreate('C', request('r1', route!, { note: 'other' }), SA))
			.rejects.toMatchObject({ field: 'routeId' })
	})

	it('a cancelled routeId cannot be reused', async () => {
		const [route] = planSettlementRoutes(ledger())
		const req = request('r1', route!)
		await settlementRouteCreate('C', req, SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1-00' }, SA)
		await expect(settlementRouteCreate('C', req, SA)).rejects.toMatchObject({ field: 'routeId', message: expect.stringContaining('cancelled') })
	})
})

describe('cancel is all-or-nothing', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000 })
		seedExpense('e2', 'C', { B: 1000 })
	})

	it('cancelling via any one leg cancels the whole route; a repeat is a no-op', async () => {
		const before = ledger()
		const [route] = planSettlementRoutes(before)
		await settlementRouteCreate('C', request('r1', route!), SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1-01' }, SA)
		expect(docsIn('settlements').every(d => !isActive(d.fields))).toBe(true)
		expect(ledger()).toEqual(before)
		const commits = fake.commits.length
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1-00' }, SA)
		expect(fake.commits[commits]).toEqual([])
	})

	it('only the recorder or the owner may cancel — not the payer or the intermediate', async () => {
		const [route] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', route!), SA)
		for (const caller of ['A', 'B']) {
			await expect(settlementDelete(caller, { tripId: TRIP, settlementId: 'r1-00' }, SA)).rejects.toMatchObject({ status: 403 })
		}
		expect(docsIn('settlements').every(d => isActive(d.fields))).toBe(true)
	})

	it('cancelling one route keeps other routes\' locks on a shared expense', async () => {
		fake.reset()
		seedTrip(['A', 'B', 'D'])
		seedExpense('e1', 'B', { A: 500, D: 500 })
		const [r1, r2] = planSettlementRoutes(ledger())
		await settlementRouteCreate('B', request('r1', r1!), SA)
		await settlementRouteCreate('B', request('r2', r2!), SA)
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds').sort()).toEqual(['r1-00', 'r2-00'])
		await settlementDelete('B', { tripId: TRIP, settlementId: 'r1-00' }, SA)
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds')).toEqual(['r2-00'])
	})
})

describe('expense locks', () => {
	it('two legs locking the same expense produce ONE write carrying both ids', async () => {
		// e1 (B paid; A 1000, C 200) is A→B's source AND the reverse offset of
		// the B→C pair, so both legs of A→C via B lock it.
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000, C: 200 })
		seedExpense('e2', 'C', { B: 1500 })
		const route = routeForPayment(ledger(), 'A', 'C', 1000)!
		await settlementRouteCreate('C', request('r1', route), SA)
		const last = fake.commits.at(-1)!
		const e1Writes = last.filter(w => w.document.endsWith('/expenses/e1'))
		expect(e1Writes).toHaveLength(1)
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds').sort()).toEqual(['r1-00', 'r1-01'])
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1-00' }, SA)
		expect(readArr(fake.fields(`trips/${TRIP}/expenses/e1`), 'settlementLockIds')).toEqual([])
	})
})

describe('foreign currency', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 30_000 })
		seedExpense('e2', 'C', { B: 30_000 })
	})
	const fx = { sourceCurrency: 'USD', settledOn: '2026-10-10', expectedFxRate: { rateDecimal: '150', rateDate: '2026-10-10' } }

	it('stores the received currency on the route header only; legs stay in trip currency', async () => {
		const [route] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', route!, fx), SA)
		for (const leg of docsIn('settlements')) {
			expect(readStr(leg.fields, 'currency')).toBe('JPY')
			expect(readInt(leg.fields, 'amountMinor')).toBe(30_000)
			expect(leg.fields.sourceCurrency).toBeUndefined()
			const header = routeOf(leg.fields)!
			expect(readStr(header, 'sourceCurrency')).toBe('USD')
			expect(readStr(header, 'settledOn')).toBe('2026-10-10')
			// 30000 JPY at 150 → 200.00 USD exactly (at-most inverse).
			expect(readInt(header, 'sourceAmountMinor')).toBe(20_000)
			const snap = (header.fxSnapshot as { mapValue: { fields: Fields } }).mapValue.fields
			expect(readInt(snap, 'convertedAmountMinor')).toBe(30_000)
			expect((snap.fetchedAt as { timestampValue?: string }).timestampValue).toBeDefined()
		}
		expect(ledger()).toEqual({})
	})

	it('rounds the source amount at-most (never claims more than was cleared)', async () => {
		const route = routeForPayment(ledger(), 'A', 'C', 301)!
		await settlementRouteCreate('C', request('r1', route, fx), SA)
		const header = routeOf(docsIn('settlements')[0]!.fields)!
		// 301 JPY / 150 = 2.0066 USD → 2.00 USD; forward 2.00 USD = 300 JPY ≤ 301.
		expect(readInt(header, 'sourceAmountMinor')).toBe(200)
		expect(readInt((header.fxSnapshot as { mapValue: { fields: Fields } }).mapValue.fields, 'convertedAmountMinor')).toBe(300)
		// The ledger clears exactly what the route says, independent of FX rounding.
		expect(ledger()).toEqual({ A: { B: 29_699 }, B: { C: 29_699 } })
	})

	it('refuses a changed rate (FX CAS) without writing', async () => {
		const [route] = planSettlementRoutes(ledger())
		const before = snapshot()
		await expect(settlementRouteCreate('C', request('r1', route!, { ...fx, expectedFxRate: { rateDecimal: '149', rateDate: '2026-10-10' } }), SA))
			.rejects.toMatchObject({ code: 'FX_RATE_CHANGED', status: 409 })
		expect(snapshot()).toBe(before)
	})

	it('refuses an amount too small to express in the source currency', async () => {
		vi.mocked(fxRate.resolveFxRate).mockImplementation(async input => ({ rateDate: input.requestedDate, rateDecimal: '20000', fetchedAtMs: 1 }))
		const route = routeForPayment(ledger(), 'A', 'C', 50)!
		await expect(settlementRouteCreate('C', request('r1', route, { ...fx, expectedFxRate: { rateDecimal: '20000', rateDate: '2026-10-10' } }), SA))
			.rejects.toMatchObject({ field: 'sourceCurrency' })
		expect(docsIn('settlements')).toEqual([])
	})

	it('refuses paying in the trip currency through the foreign path', async () => {
		const [route] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('C', request('r1', route!, { ...fx, sourceCurrency: 'JPY' }), SA))
			.rejects.toMatchObject({ field: 'sourceCurrency' })
	})

	it('cancelling a foreign route restores the ledger', async () => {
		const before = ledger()
		const [route] = planSettlementRoutes(before)
		await settlementRouteCreate('C', request('r1', route!, fx), SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1-00' }, SA)
		expect(ledger()).toEqual(before)
	})
})

describe('fail-closed ledger reads', () => {
	it('refuses a leg pair holding an expense in another currency', async () => {
		seedTrip(['A', 'B'])
		seedExpense('e1', 'B', { A: 100 }, { currency: str('USD') })
		await expect(settlementRouteCreate('B', request('r1', {
			kind: 'TRANSFER', payerUid: 'A', receiverUid: 'B', amountMinor: 100,
			legs: [{ fromUid: 'A', toUid: 'B', amountMinor: 100, expectedRemainingMinor: 100 }],
		}), SA)).rejects.toMatchObject({ code: 'LEDGER_CURRENCY_MISMATCH' })
	})

	it('refuses when the trip has more active settlements than it can read', async () => {
		seedTrip(['A', 'B'])
		seedExpense('e1', 'B', { A: 100 })
		for (let i = 0; i < 501; i++) {
			fake.set(`trips/${TRIP}/settlements/s${i}`, { fromUid: str('X'), toUid: str('Y'), amountMinor: int(1), deletedAt: { nullValue: null }, createdAt: { timestampValue: fake.tick() } })
		}
		await expect(settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA))
			.rejects.toMatchObject({ code: 'PAIR_LEDGER_TOO_LARGE' })
	})
})

describe('property: random trips settle completely through the Worker', () => {
	/** mulberry32 — failures name the seed and replay exactly. */
	function rng(seed: number) {
		let a = seed
		return () => {
			a |= 0; a = (a + 0x6D2B79F5) | 0
			let t = Math.imul(a ^ (a >>> 15), 1 | a)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
	}

	it('pick → record → (sometimes cancel) → replan finishes, with locks and lineage consistent', async () => {
		for (let seed = 1; seed <= 25; seed++) {
			const r = rng(seed)
			const people = ['A', 'B', 'C', 'D', 'E', 'F']
			seedTrip(people.slice(0, 5), { former: { F: '阿六' } })   // F has left
			for (let i = 0; i < 12; i++) {
				const paidBy = people[Math.floor(r() * people.length)]!
				const splits: Record<string, number> = {}
				for (const p of people) if (r() < 0.5) splits[p] = 100 + Math.floor(r() * 5000)
				if (Object.keys(splits).length > 0) seedExpense(`e${i}`, paidBy, splits)
			}
			let n = 0
			for (let step = 0; step < 60 && Object.keys(ledger()).length > 0; step++) {
				const plan = planSettlementRoutes(ledger())
				const pick = plan[Math.floor(r() * plan.length)]!
				const receiverGone = pick.kind === 'TRANSFER' ? pick.receiverUid === 'F' : pick.participantUids.every(u => u === 'F')
				const caller = receiverGone ? OWNER : pick.kind === 'TRANSFER' ? pick.receiverUid : pick.participantUids.find(u => u !== 'F')!
				const id = `s${seed}r${n++}`
				await settlementRouteCreate(caller, request(id, pick), SA)
				if (r() < 0.2) await settlementDelete(caller, { tripId: TRIP, settlementId: routeLegId(id, 0) }, SA)
			}
			expect(ledger(), `seed ${seed}`).toEqual({})

			// Every lock on every expense is held by exactly the active legs
			// whose lineage names it — nothing stale, nothing missing.
			const active = docsIn('settlements').filter(d => isActive(d.fields))
			for (const { id, fields } of docsIn('expenses')) {
				const expected = active.filter(l => readArr(l.fields, 'appliedExpenseIds').includes(id)).map(l => l.id).sort()
				expect(readArr(fields, 'settlementLockIds').sort(), `seed ${seed} ${id}`).toEqual(expected)
			}
			// Lineage accounts for every leg amount, and no expense share is
			// drawn down more than it holds.
			const drawnPerShare = new Map<string, number>()
			for (const leg of active) {
				const sources = ((leg.fields.appliedSources as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? [])
				const total = sources.reduce((s, v) => s + readInt(v.mapValue!.fields, 'amountMinor'), 0)
				expect(total, `seed ${seed} ${leg.id}`).toBe(readInt(leg.fields, 'amountMinor'))
				for (const v of sources) {
					const key = `${readStr(v.mapValue!.fields, 'expenseId')}|${readStr(leg.fields, 'fromUid')}`
					drawnPerShare.set(key, (drawnPerShare.get(key) ?? 0) + readInt(v.mapValue!.fields, 'amountMinor'))
				}
			}
			for (const [key, drawn] of drawnPerShare) {
				const [expenseId, member] = key.split('|')
				const splits = (fake.fields(`trips/${TRIP}/expenses/${expenseId}`)!.splits as { arrayValue: { values: FsValue[] } }).arrayValue.values
				const share = splits.map(v => v.mapValue!.fields).filter(f => readStr(f, 'memberId') === member).reduce((s, f) => s + readInt(f, 'amountMinor'), 0)
				expect(drawn, `seed ${seed} ${key}`).toBeLessThanOrEqual(share)
			}
		}
	}, 60_000)
})

describe('/settlement-delete edge cases', () => {
	beforeEach(() => {
		seedTrip(['A', 'B'])
		seedExpense('e1', 'B', { A: 100 })
	})

	it('a missing settlement is a no-op success (double tap / lost response)', async () => {
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'nope-00' }, SA)).resolves.toEqual({ ok: true })
		expect(fake.commits.at(-1)).toEqual([])
	})

	it('a non-member cannot cancel, and a trip being deleted refuses everyone', async () => {
		await settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA)
		await expect(settlementDelete('stranger', { tripId: TRIP, settlementId: 'r1-00' }, SA)).rejects.toMatchObject({ status: 403 })
		fake.set(`trips/${TRIP}`, { ...fake.fields(`trips/${TRIP}`)!, deletingAt: { timestampValue: fake.tick() } })
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'r1-00' }, SA)).rejects.toMatchObject({ status: 410 })
		expect(docsIn('settlements').every(d => isActive(d.fields))).toBe(true)
	})

	it('refuses a settlement without a route header instead of cancelling it piecemeal', async () => {
		fake.set(`trips/${TRIP}/settlements/raw`, {
			fromUid: str('A'), toUid: str('B'), amountMinor: int(100), settledBy: str('B'),
			deletedAt: { nullValue: null }, createdAt: { timestampValue: fake.tick() },
		})
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'raw' }, SA)).rejects.toMatchObject({ status: 500 })
		expect(isActive(fake.fields(`trips/${TRIP}/settlements/raw`)!)).toBe(true)
	})
})
