// Endpoint tests for settlement writes (settlement-route-write.ts): every
// settlement is a route stored as ONE doc with its legs inside.
//
// These run against an in-memory Firestore (helpers/fake-firestore) so a
// test can create a route, create another, cancel one, and then read the
// LEDGER back through the same computePairwiseRemaining the Worker uses.
// The point is to try to break the accounting, not only to check write
// shapes.
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
	MAX_ROUTE_APPLIED_SOURCES,
	MAX_ROUTE_LEGS,
	planSettlementRoutes,
	routeForPayment,
	type CoreExpense,
	type CoreSettlement,
	type SettlementRoute,
} from '@tripmate/settlement-core'
import { EXPENSE_LIMITS, SETTLEMENT_LIMITS } from '@tripmate/entity-contracts'
import { fake } from './helpers/fake-firestore'
import {
	SETTLEMENT_DOC_BYTES_MAX,
	settlementDelete,
	settlementRouteCreate,
	SettlementRouteCreateRequestSchema,
	type SettlementRouteCreateRequest,
} from '../src/settlement-route-write'
import { encodeAppliedSources, encodeLockedExpenses } from '../src/settlement-codec'
import { documentSize } from '../src/firestore-size'
import { encodeStringArray } from '../src/settlement-lock-write'
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
const mapsIn = (f: Fields | undefined, k: string) =>
	((f?.[k] as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []).map(v => v.mapValue!.fields!)
const isActive = (f: Fields) => 'nullValue' in (f.deletedAt ?? {})
/** A settlement doc's legs as [from, to, amount]. */
const legsOf = (f: Fields) => mapsIn(f, 'legs').map(l => [readStr(l, 'fromUid')!, readStr(l, 'toUid')!, readInt(l, 'amountMinor')] as const)
/** A settlement doc's lineage as [legIndex, expenseId, amount]. */
const sourcesOf = (f: Fields) => mapsIn(f, 'appliedSources').map(v => [readInt(v, 'legIndex'), readStr(v, 'expenseId')!, readInt(v, 'amountMinor')] as const)
const settlement = (id: string) => fake.fields(`trips/${TRIP}/settlements/${id}`)!
/** A settlement doc's lock set as [expenseId, legIndexes]. */
const lockedOf = (f: Fields) => mapsIn(f, 'lockedExpenses').map(v =>
	[readStr(v, 'expenseId')!, ((v.legIndexes as { arrayValue?: { values?: FsValue[] } }).arrayValue?.values ?? []).map(i => Number(i.integerValue))] as const)
const locksOf = (expenseId: string) => readArr(fake.fields(`trips/${TRIP}/expenses/${expenseId}`), 'settlementLockIds').sort()

/** The ledger exactly as the Worker would compute it from what's stored. */
function ledger(): Record<string, Record<string, number>> {
	const expenses: CoreExpense[] = docsIn('expenses').filter(d => isActive(d.fields)).map(({ fields }) => ({
		amountMinor: readInt(fields, 'amountMinor'),
		paidBy:      readStr(fields, 'paidBy')!,
		splits: mapsIn(fields, 'splits').map(f => ({ memberId: readStr(f, 'memberId')!, amountMinor: readInt(f, 'amountMinor') })),
	}))
	const settlements: CoreSettlement[] = docsIn('settlements').filter(d => isActive(d.fields)).flatMap(({ fields }) =>
		legsOf(fields).map(([fromUid, toUid, amountMinor]) => ({
			fromUid, toUid, amountMinor,
			createdAtMs: Date.parse((fields.createdAt as { timestampValue: string }).timestampValue),
		})))
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

	it('records A → C via B as ONE doc holding both legs', async () => {
		const [planned] = planSettlementRoutes(ledger())
		expect(planned).toMatchObject({ kind: 'TRANSFER', payerUid: 'A', receiverUid: 'C', amountMinor: 1000 })
		const result = await settlementRouteCreate('C', request('r1', planned!, { note: '晚餐' }), SA)
		expect(result).toEqual({ routeId: 'r1' })

		expect(docsIn('settlements').map(d => d.id)).toEqual(['r1'])
		const doc = settlement('r1')
		expect(legsOf(doc)).toEqual([['A', 'B', 1000], ['B', 'C', 1000]])
		expect(readStr(doc, 'tripId')).toBe(TRIP)
		expect(readStr(doc, 'kind')).toBe('TRANSFER')
		expect(readStr(doc, 'payerUid')).toBe('A')
		expect(readStr(doc, 'receiverUid')).toBe('C')
		expect(readInt(doc, 'amountMinor')).toBe(1000)
		expect(readStr(doc, 'currency')).toBe('JPY')
		expect(readStr(doc, 'settledBy')).toBe('C')
		expect(readStr(doc, 'note')).toBe('晚餐')
		expect(readArr(doc, 'participantUids')).toEqual(['A', 'B', 'C'])
		expect(doc.createdAt).toHaveProperty('timestampValue')
		expect(doc.sourceCurrency).toBeUndefined()
		expect(doc.ownerRecorded).toBeUndefined()
		// Lineage per leg: each draws from the expense behind its own edge;
		// the lock set names which legs lock each expense, and each expense
		// holds the route id once.
		expect(sourcesOf(doc)).toEqual([[0, 'e1', 1000], [1, 'e2', 1000]])
		expect(lockedOf(doc)).toEqual([['e1', [0]], ['e2', [1]]])
		expect(locksOf('e1')).toEqual(['r1'])
		expect(locksOf('e2')).toEqual(['r1'])
		// Both pair locks touched.
		expect(fake.fields(`trips/${TRIP}/settlementPairLocks/${canonicalPairKey('A', 'B')}`)).toBeDefined()
		expect(fake.fields(`trips/${TRIP}/settlementPairLocks/${canonicalPairKey('B', 'C')}`)).toBeDefined()
		expect(ledger()).toEqual({})
	})

	it('reads pair locks one at a time in sorted order', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!), SA)
		const lockReads = fake.getCalls.filter(p => p.includes('/settlementPairLocks/'))
		expect(lockReads).toEqual([...lockReads].sort())
		expect(lockReads).toHaveLength(2)
	})

	it('reads the other settlements\' legs only, never their lineage', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!), SA)
		const ledgerQuery = fake.queries.find(q => q.collection === 'settlements')
		expect(ledgerQuery?.select).toEqual(['legs', 'createdAt'])
		expect(ledgerQuery?.filters).toEqual([{ fieldPath: 'deletedAt', op: 'IS_NULL' }])
	})

	it('refuses everyone but the receiver, including the payer and the intermediate', async () => {
		const [planned] = planSettlementRoutes(ledger())
		for (const caller of ['A', 'B', OWNER]) {
			const before = snapshot()
			await expect(settlementRouteCreate(caller, request('r1', planned!), SA))
				.rejects.toMatchObject({ name: 'SettlementValidationError', field: 'receiverUid' })
			expect(snapshot()).toBe(before)
		}
	})

	it('refuses a non-member outright', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('stranger', request('r1', planned!), SA)).rejects.toMatchObject({ status: 403 })
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
		const planned = routeForPayment(ledger(), 'A', 'C', 700)!
		expect(planned.legs).toHaveLength(4)
		await settlementRouteCreate('C', request('r1', planned), SA)
		// A→D was only partly used (400 of 500): 100 is still owed to D.
		expect(ledger()).toEqual({ A: { D: 100 } })

		const rest = routeForPayment(ledger(), 'A', 'D', 100)!
		await settlementRouteCreate('D', request('r2', rest), SA)
		expect(ledger()).toEqual({})

		// The two legs on A→D together drew exactly the 500 of e2, never twice.
		const drawn = ['r1', 'r2'].flatMap(id => {
			const doc = settlement(id)
			const legs = legsOf(doc)
			return sourcesOf(doc).filter(([i]) => legs[i]![0] === 'A' && legs[i]![1] === 'D').map(([, , amount]) => amount)
		})
		expect(drawn).toEqual([400, 100])
		expect(locksOf('e2')).toEqual(['r1', 'r2'])
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
		const planned = plan.find(r => r.kind === 'TRANSFER')!
		await settlementRouteCreate(recorderOf(planned), request('r1', planned), SA)
		await expect(settlementRouteCreate(recorderOf(planned), request('r2', planned), SA))
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

	it('stores legs in canonical order whatever order the client sent', async () => {
		const [planned] = planSettlementRoutes(ledger()).filter(r => r.kind === 'TRANSFER')
		await settlementRouteCreate('C', request('r1', { ...planned!, legs: [...planned!.legs].reverse() }), SA)
		expect(legsOf(settlement('r1'))).toEqual([['A', 'B', 100], ['B', 'C', 100]])
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
		// Every leg locks its expense; an offset names no payer and no amount.
		const doc = settlement('r1')
		expect(readStr(doc, 'kind')).toBe('OFFSET')
		expect(legsOf(doc)).toHaveLength(3)
		expect(doc.payerUid).toBeUndefined()
		expect(doc.amountMinor).toBeUndefined()
		expect(locksOf('e1')).toEqual(['r1'])
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
		// The owner may cancel; so may the recorder.
		await settlementDelete(OWNER, { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(ledger()).toEqual(before)
		for (const id of ['e1', 'e2', 'e3']) expect(locksOf(id)).toEqual([])
		expect(readStr(settlement('r1'), 'deletedBy')).toBe(OWNER)
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
		const [planned] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('A', request('r1', planned!), SA)).rejects.toMatchObject({ field: 'receiverUid' })
		await settlementRouteCreate(OWNER, request('r1', planned!), SA)
		expect((settlement('r1').ownerRecorded as { booleanValue: boolean }).booleanValue).toBe(true)
		expect(readStr(settlement('r1'), 'settledBy')).toBe(OWNER)
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
		const [planned] = planSettlementRoutes(ledger())
		const req = request('r1', planned!)
		await settlementRouteCreate('C', req, SA)
		const commits = fake.commits.length
		vi.mocked(fxRate.resolveFxRate).mockRejectedValue(new Error('provider down'))
		await expect(settlementRouteCreate('C', req, SA)).resolves.toEqual({ routeId: 'r1' })
		expect(fake.commits[commits]).toEqual([])
	})

	it('a different payload under the same routeId is a collision', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!), SA)
		await expect(settlementRouteCreate('C', request('r1', planned!, { note: 'other' }), SA))
			.rejects.toMatchObject({ field: 'routeId' })
		// A different amount, legs and header alike.
		const smaller = { ...planned!, amountMinor: 999, legs: planned!.legs.map(l => ({ ...l, amountMinor: 999 })) } as SettlementRoute
		await expect(settlementRouteCreate('C', request('r1', smaller), SA)).rejects.toMatchObject({ field: 'routeId' })
	})

	it('a cancelled routeId cannot be reused', async () => {
		const [planned] = planSettlementRoutes(ledger())
		const req = request('r1', planned!)
		await settlementRouteCreate('C', req, SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)
		await expect(settlementRouteCreate('C', req, SA)).rejects.toMatchObject({ field: 'routeId', message: expect.stringContaining('cancelled') })
	})
})

describe('cancel is all-or-nothing', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000 })
		seedExpense('e2', 'C', { B: 1000 })
	})

	it('cancelling the route cancels every leg in one write; a repeat is a no-op', async () => {
		const before = ledger()
		const [planned] = planSettlementRoutes(before)
		await settlementRouteCreate('C', request('r1', planned!), SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(isActive(settlement('r1'))).toBe(false)
		expect(ledger()).toEqual(before)
		expect(fake.commits.at(-1)!.filter(w => w.document.includes('/settlements/'))).toHaveLength(1)
		const commits = fake.commits.length
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(fake.commits[commits]).toEqual([])
	})

	it('only the recorder or the owner may cancel — not the payer or the intermediate', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!), SA)
		for (const caller of ['A', 'B']) {
			await expect(settlementDelete(caller, { tripId: TRIP, settlementId: 'r1' }, SA)).rejects.toMatchObject({ status: 403 })
		}
		expect(isActive(settlement('r1'))).toBe(true)
	})

	it('cancelling one route keeps other routes\' locks on a shared expense', async () => {
		fake.reset()
		seedTrip(['A', 'B', 'D'])
		seedExpense('e1', 'B', { A: 500, D: 500 })
		const [r1, r2] = planSettlementRoutes(ledger())
		await settlementRouteCreate('B', request('r1', r1!), SA)
		await settlementRouteCreate('B', request('r2', r2!), SA)
		expect(locksOf('e1')).toEqual(['r1', 'r2'])
		await settlementDelete('B', { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(locksOf('e1')).toEqual(['r2'])
	})
})

describe('expense locks', () => {
	it('an expense locked by two legs of one route gets the route id once, in one write', async () => {
		// e1 (B paid; A 1000, C 200) is A→B's source AND the reverse offset of
		// the B→C pair, so both legs of A→C via B lock it.
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 1000, C: 200 })
		seedExpense('e2', 'C', { B: 1500 })
		const planned = routeForPayment(ledger(), 'A', 'C', 1000)!
		await settlementRouteCreate('C', request('r1', planned), SA)
		const last = fake.commits.at(-1)!
		expect(last.filter(w => w.document.endsWith('/expenses/e1'))).toHaveLength(1)
		expect(locksOf('e1')).toEqual(['r1'])
		expect(lockedOf(settlement('r1'))).toEqual([['e1', [0, 1]], ['e2', [1]]])
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(locksOf('e1')).toEqual([])
	})
})

describe('lineage budget and the 1 MiB document limit', () => {
	it('keeps at most MAX_ROUTE_APPLIED_SOURCES display sources but locks every expense', async () => {
		seedTrip(['A', 'B'])
		const n = MAX_ROUTE_APPLIED_SOURCES + 50
		for (let i = 0; i < n; i++) seedExpense(`e${String(i).padStart(3, '0')}`, 'B', { A: 10 })
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('B', request('r1', planned!), SA)
		const doc = settlement('r1')
		const sources = sourcesOf(doc)
		expect(sources).toHaveLength(MAX_ROUTE_APPLIED_SOURCES)
		// The oldest sources are the ones kept; the rest of the leg is untraced, not lost.
		expect(sources[0]).toEqual([0, 'e000', 10])
		expect(lockedOf(doc)).toHaveLength(n)
		expect(locksOf('e449')).toEqual(['r1'])
		expect(ledger()).toEqual({})
	})

	it('the largest storable route stays below the limit (worst-case sizes)', () => {
		// Every field at its cap: 45 legs between 30 128-char uids, 400 sources
		// with 4-byte-character titles / item names, and 500 locked expenses
		// each locked by every leg.
		const wide = (n: number) => '𠀀'.repeat(n)   // 4 UTF-8 bytes per character
		const perLeg = Array.from({ length: MAX_ROUTE_LEGS }, () => [] as Array<{ expenseId: string; expenseTitle: string; itemId: string; itemName: string; amountMinor: number }>)
		for (let i = 0; i < MAX_ROUTE_APPLIED_SOURCES; i++) {
			perLeg[i % MAX_ROUTE_LEGS]!.push({
				expenseId: 'x'.repeat(60), expenseTitle: wide(EXPENSE_LIMITS.title + 50), itemId: 'i'.repeat(64),
				itemName: wide(EXPENSE_LIMITS.itemName), amountMinor: 999_999_999_999,
			})
		}
		const uid = (i: number) => `u${String(i).padStart(127, '0')}`
		const fields: Fields = {
			tripId: str('t'.repeat(60)), kind: str('TRANSFER'), currency: str('JPY'),
			participantUids: encodeStringArray(Array.from({ length: 30 }, (_, i) => uid(i))),
			legs: { arrayValue: { values: Array.from({ length: MAX_ROUTE_LEGS }, (_, i) => ({ mapValue: { fields: {
				fromUid: str(uid(i % 30)), toUid: str(uid((i + 1) % 30)), amountMinor: int(999_999_999_999),
			} } })) } },
			payerUid: str(uid(0)), receiverUid: str(uid(1)), amountMinor: int(999_999_999_999),
			note: str(wide(SETTLEMENT_LIMITS.note)), ownerRecorded: { booleanValue: true },
			appliedSources: encodeAppliedSources(perLeg),
			lockedExpenses: encodeLockedExpenses(Array.from({ length: MAX_ROUTE_LEGS }, () =>
				Array.from({ length: 500 }, (_, i) => `${'x'.repeat(57)}${String(i).padStart(3, '0')}`))).value,
			settledBy: str(uid(1)), deletedAt: { nullValue: null },
			sourceCurrency: str('USD'), sourceAmountMinor: int(999_999_999_999), settledOn: str('2026-10-13'),
			fxSnapshot: { mapValue: { fields: {
				provider: str('frankfurter-v2'), baseCurrency: str('USD'), quoteCurrency: str('JPY'),
				requestedDate: str('2026-10-13'), rateDate: str('2026-10-13'), rateDecimal: str('1'.repeat(40)),
				sourceAmountMinor: int(1), convertedAmountMinor: int(1),
			} } },
		}
		const bytes = documentSize(`trips/${'t'.repeat(60)}/settlements/${'r'.repeat(50)}`, fields, ['createdAt', 'fxSnapshot.fetchedAt'])
		expect(bytes).toBeLessThan(SETTLEMENT_DOC_BYTES_MAX)
	})

	it('measures stored size by Firestore\'s rules', () => {
		// name: "trips"(6) + "t"(2) + "settlements"(12) + "s"(2) + 16 = 38;
		// a: 2 + "é"(3) = 5; n: 2 + 8 = 10; m: 2 + (b: 2 + 1) = 5; l: 2 + (1 + 8) = 11;
		// createdAt (server time): 10 + 8 = 18; document overhead 32.
		expect(documentSize('trips/t/settlements/s', {
			a: str('é'), n: int(1), m: { mapValue: { fields: { b: { booleanValue: true } } } },
			l: { arrayValue: { values: [{ nullValue: null }, { timestampValue: '2026-10-13T00:00:00Z' }] } },
		}, ['createdAt'])).toBe(38 + 5 + 10 + 5 + 11 + 18 + 32)
	})
})

describe('foreign currency', () => {
	beforeEach(() => {
		seedTrip(['A', 'B', 'C'])
		seedExpense('e1', 'B', { A: 30_000 })
		seedExpense('e2', 'C', { B: 30_000 })
	})
	const fx = { sourceCurrency: 'USD', settledOn: '2026-10-10', expectedFxRate: { rateDecimal: '150', rateDate: '2026-10-10' } }

	it('stores the received currency on the route; legs stay in trip currency', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!, fx), SA)
		const doc = settlement('r1')
		expect(readStr(doc, 'currency')).toBe('JPY')
		expect(legsOf(doc)).toEqual([['A', 'B', 30_000], ['B', 'C', 30_000]])
		expect(readStr(doc, 'sourceCurrency')).toBe('USD')
		expect(readStr(doc, 'settledOn')).toBe('2026-10-10')
		// 30000 JPY at 150 → 200.00 USD exactly (at-most inverse).
		expect(readInt(doc, 'sourceAmountMinor')).toBe(20_000)
		const snap = (doc.fxSnapshot as { mapValue: { fields: Fields } }).mapValue.fields
		expect(readInt(snap, 'convertedAmountMinor')).toBe(30_000)
		expect((snap.fetchedAt as { timestampValue?: string }).timestampValue).toBeDefined()
		expect(ledger()).toEqual({})
	})

	it('rounds the source amount at-most (never claims more than was cleared)', async () => {
		const planned = routeForPayment(ledger(), 'A', 'C', 301)!
		await settlementRouteCreate('C', request('r1', planned, fx), SA)
		const doc = settlement('r1')
		// 301 JPY / 150 = 2.0066 USD → 2.00 USD; forward 2.00 USD = 300 JPY ≤ 301.
		expect(readInt(doc, 'sourceAmountMinor')).toBe(200)
		expect(readInt((doc.fxSnapshot as { mapValue: { fields: Fields } }).mapValue.fields, 'convertedAmountMinor')).toBe(300)
		// The ledger clears exactly what the route says, independent of FX rounding.
		expect(ledger()).toEqual({ A: { B: 29_699 }, B: { C: 29_699 } })
	})

	it('refuses a changed rate (FX CAS) without writing', async () => {
		const [planned] = planSettlementRoutes(ledger())
		const before = snapshot()
		await expect(settlementRouteCreate('C', request('r1', planned!, { ...fx, expectedFxRate: { rateDecimal: '149', rateDate: '2026-10-10' } }), SA))
			.rejects.toMatchObject({ code: 'FX_RATE_CHANGED', status: 409 })
		expect(snapshot()).toBe(before)
	})

	it('refuses an amount too small to express in the source currency', async () => {
		vi.mocked(fxRate.resolveFxRate).mockImplementation(async input => ({ rateDate: input.requestedDate, rateDecimal: '20000', fetchedAtMs: 1 }))
		const planned = routeForPayment(ledger(), 'A', 'C', 50)!
		await expect(settlementRouteCreate('C', request('r1', planned, { ...fx, expectedFxRate: { rateDecimal: '20000', rateDate: '2026-10-10' } }), SA))
			.rejects.toMatchObject({ field: 'sourceCurrency' })
		expect(docsIn('settlements')).toEqual([])
	})

	it('refuses paying in the trip currency through the foreign path', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await expect(settlementRouteCreate('C', request('r1', planned!, { ...fx, sourceCurrency: 'JPY' }), SA))
			.rejects.toMatchObject({ field: 'sourceCurrency' })
	})

	it('a retry of a foreign route is recognised as the same payment', async () => {
		const [planned] = planSettlementRoutes(ledger())
		await settlementRouteCreate('C', request('r1', planned!, fx), SA)
		await expect(settlementRouteCreate('C', request('r1', planned!, fx), SA)).resolves.toEqual({ routeId: 'r1' })
		await expect(settlementRouteCreate('C', request('r1', planned!), SA)).rejects.toMatchObject({ field: 'routeId' })
	})

	it('cancelling a foreign route restores the ledger', async () => {
		const before = ledger()
		const [planned] = planSettlementRoutes(before)
		await settlementRouteCreate('C', request('r1', planned!, fx), SA)
		await settlementDelete('C', { tripId: TRIP, settlementId: 'r1' }, SA)
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
			fake.set(`trips/${TRIP}/settlements/s${i}`, {
				legs: { arrayValue: { values: [{ mapValue: { fields: { fromUid: str('X'), toUid: str('Y'), amountMinor: int(1) } } }] } },
				deletedAt: { nullValue: null }, createdAt: { timestampValue: fake.tick() },
			})
		}
		await expect(settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA))
			.rejects.toMatchObject({ code: 'PAIR_LEDGER_TOO_LARGE' })
	})

	it('refuses to compute a ledger when another settlement\'s legs are unreadable', async () => {
		seedTrip(['A', 'B'])
		seedExpense('e1', 'B', { A: 100 })
		fake.set(`trips/${TRIP}/settlements/broken`, { deletedAt: { nullValue: null }, createdAt: { timestampValue: fake.tick() } })
		const before = snapshot()
		await expect(settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA))
			.rejects.toMatchObject({ status: 500 })
		expect(snapshot()).toBe(before)
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
				if (r() < 0.2) await settlementDelete(caller, { tripId: TRIP, settlementId: id }, SA)
			}
			expect(ledger(), `seed ${seed}`).toEqual({})

			// Every lock on every expense is held by exactly the active routes
			// whose lock set names it — nothing stale, nothing missing.
			const active = docsIn('settlements').filter(d => isActive(d.fields))
			for (const { id } of docsIn('expenses')) {
				const expected = active.filter(d => lockedOf(d.fields).some(([e]) => e === id)).map(d => d.id).sort()
				expect(locksOf(id), `seed ${seed} ${id}`).toEqual(expected)
			}
			// Lineage accounts for every leg amount, and no expense share is
			// drawn down more than it holds.
			const drawnPerShare = new Map<string, number>()
			for (const { id, fields } of active) {
				const legs = legsOf(fields)
				const sources = sourcesOf(fields)
				legs.forEach(([from, , amount], i) => {
					const mine = sources.filter(([legIndex]) => legIndex === i)
					expect(mine.reduce((s, [, , a]) => s + a, 0), `seed ${seed} ${id}#${i}`).toBe(amount)
					for (const [, expenseId, a] of mine) {
						const key = `${expenseId}|${from}`
						drawnPerShare.set(key, (drawnPerShare.get(key) ?? 0) + a)
					}
				})
			}
			for (const [key, drawn] of drawnPerShare) {
				const [expenseId, member] = key.split('|')
				const share = mapsIn(fake.fields(`trips/${TRIP}/expenses/${expenseId}`), 'splits')
					.filter(f => readStr(f, 'memberId') === member).reduce((s, f) => s + readInt(f, 'amountMinor'), 0)
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
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'nope' }, SA)).resolves.toEqual({ ok: true })
		expect(fake.commits.at(-1)).toEqual([])
	})

	it('a non-member cannot cancel, and a trip being deleted refuses everyone', async () => {
		await settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA)
		await expect(settlementDelete('stranger', { tripId: TRIP, settlementId: 'r1' }, SA)).rejects.toMatchObject({ status: 403 })
		fake.set(`trips/${TRIP}`, { ...fake.fields(`trips/${TRIP}`)!, deletingAt: { timestampValue: fake.tick() } })
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'r1' }, SA)).rejects.toMatchObject({ status: 410 })
		expect(isActive(settlement('r1'))).toBe(true)
	})

	it('refuses a settlement without legs instead of cancelling it blind', async () => {
		fake.set(`trips/${TRIP}/settlements/raw`, {
			settledBy: str('B'), deletedAt: { nullValue: null }, createdAt: { timestampValue: fake.tick() },
		})
		await expect(settlementDelete('B', { tripId: TRIP, settlementId: 'raw' }, SA)).rejects.toMatchObject({ status: 500 })
		expect(isActive(fake.fields(`trips/${TRIP}/settlements/raw`)!)).toBe(true)
	})

	it('skips a lock id the expense no longer holds and an expense that is gone', async () => {
		await settlementRouteCreate('B', request('r1', planSettlementRoutes(ledger())[0]!), SA)
		fake.set(`trips/${TRIP}/expenses/e1`, { ...fake.fields(`trips/${TRIP}/expenses/e1`)!, settlementLockIds: encodeStringArray(['other']) })
		await settlementDelete('B', { tripId: TRIP, settlementId: 'r1' }, SA)
		expect(locksOf('e1')).toEqual(['other'])
		expect(fake.commits.at(-1)!.some(w => w.document.endsWith('/expenses/e1'))).toBe(false)
	})
})
