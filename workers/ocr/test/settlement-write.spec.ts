// Endpoint-level tests for settlement-write.ts.
//
// The pair math itself lives in `@tripmate/settlement-core` and is
// covered by the canonical fixture suite at
// `packages/settlement-core/src/index.test.ts` (8-fixture table
// that both client and Worker run through). This file stitches the
// shared math into the Worker endpoint boundary: authz gates,
// idempotency, validation rejects, REST write shapes
// (currentDocument preconditions + REQUEST_TIME transforms).
//
// Mocking strategy mirrors expense-write.spec / booking-write.spec:
// mock `runFirestoreTransaction` so tests seed tx.get + tx.runQuery
// responses per-test and capture the TxResult to assert on shape.
// No real Firestore traffic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

interface MockReadDoc {
	exists:     boolean
	fields:     Record<string, unknown>
	name:       string
	updateTime: string | null
}

const txGetResponses   = new Map<string, MockReadDoc>()
// runQuery responses keyed by `${parent}|${collection}` -- the same key
// settlement-write builds when calling tx.runQuery for active expenses /
// all settlements. Tests seed both buckets; an unseeded query defaults
// to empty array (matches "no docs" rather than "throw" because the
// algorithm tolerates empty inputs gracefully and tests focused on
// authz / validation don't care about the read fan-out).
const txQueryResponses = new Map<string, MockReadDoc[]>()
// Ordered log of every tx.get(...) path the implementation issued. Lets
// tests assert "the pair-lock was read inside the tx" without coupling
// to argument order in the Promise.all.
const txGetCalls: string[] = []
// Ordered log of every tx.runQuery(...) the implementation issued,
// including the `filters` arg -- lets tests assert the pair-scoped
// reads (paidBy IN / exact-direction equality) without coupling to argument order.
const txQueryCalls: Array<{ parent: string; collection: string; filters?: unknown }> = []
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null

interface MockFieldFilter {
	fieldPath: string
	op:        'EQUAL' | 'IN'
	value:     { stringValue?: string; arrayValue?: { values?: Array<{ stringValue?: string }> } }
}

interface MockUnaryFilter {
	fieldPath: string
	op:        'IS_NULL'
}

type MockFilter = MockFieldFilter | MockUnaryFilter

function isMockUnaryFilter(f: MockFilter): f is MockUnaryFilter {
	return f.op === 'IS_NULL'
}

function readMockStringField(doc: MockReadDoc, fieldPath: string): string | undefined {
	const raw = doc.fields[fieldPath] as { stringValue?: string } | undefined
	return raw?.stringValue
}

function matchesMockFilters(doc: MockReadDoc, filters: unknown): boolean {
	if (!Array.isArray(filters)) return true
	for (const filter of filters as MockFilter[]) {
		if (isMockUnaryFilter(filter)) {
			// Mirrors real Firestore IS_NULL semantics: matches only when the
			// field is PRESENT and holds a null value -- an absent field does
			// NOT match (settlement fixtures always carry `deletedAt` per the
			// schema, so this distinction is mostly defensive here).
			const raw = (doc.fields as Record<string, unknown>)[filter.fieldPath] as { nullValue?: null } | undefined
			const isNull = raw !== undefined && 'nullValue' in raw
			if (!isNull) return false
			continue
		}
		const value = readMockStringField(doc, filter.fieldPath)
		if (filter.op === 'EQUAL' && value !== filter.value.stringValue) return false
		if (filter.op === 'IN') {
			const allowed = new Set((filter.value.arrayValue?.values ?? []).map(v => v.stringValue))
			if (!allowed.has(value)) return false
		}
	}
	return true
}

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		const ctx = {
			get: async (path: string) => {
				txGetCalls.push(path)
				const resp = txGetResponses.get(path)
				if (!resp) throw new Error(`unexpected tx.get('${path}') -- not seeded`)
				return resp
			},
			runQuery: async (q: { parent: string; collection: string; filters?: unknown }) => {
				txQueryCalls.push({ parent: q.parent, collection: q.collection, filters: q.filters })
				return (txQueryResponses.get(`${q.parent}|${q.collection}`) ?? [])
					.filter(doc => matchesMockFilters(doc, q.filters))
			},
		}
		const result = await body(ctx)
		capturedTxResult = result
		return result.result
	}),
	docResourceName: (pid: string, path: string) =>
		`projects/${pid}/databases/(default)/documents/${path}`,
}))

vi.mock('../src/cascade', async () => {
	const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
	return {
		...actual,
		withTokenRetry: <T,>(fn: () => Promise<T>) => fn(),
	}
})

// Settlement FX (Phase 4.1 rearchitecture): foreign-mode requests
// resolve the rate via `resolveFxRate` (rate-only helper, NOT the full
// `getFxSnapshot`). The Worker now inverse-derives `sourceAmountMinor`
// from pair-remaining via at-most-target policy, then forward-converts
// for the canonical -- both via real `@tripmate/fx-core` functions
// (`estimateSourceMinorAtMostTargetHalfEven` + `convertMinorHalfEven`).
// We do NOT mock fx-core, so the test exercises the real math against
// a fixed rate.
//
// Mock returns a fixed USD→JPY '150' rate so tests don't hit
// Frankfurter / Firestore cache. Tests that exercise FxError bubbling
// override per-call via
// `vi.mocked(fxRate.resolveFxRate).mockImplementationOnce(...)`.
//
// Hoisted via `vi.hoisted` so the hoisted `vi.mock` factory can
// reference it (factories run before module-level code, so a plain
// `const` here would be in TDZ at factory time). Resetting in
// `beforeEach` lets any test use `mockImplementation` (not just
// `…Once`) without leaking into the next test.
const { defaultResolveFxRateImpl } = vi.hoisted(() => ({
	defaultResolveFxRateImpl: async (_input: import('../src/fx-rate').ResolveFxRateInput) => ({
		rateDate:    _input.requestedDate,
		rateDecimal: '150',
		fetchedAtMs: 1_700_000_000_000,
	}),
}))

vi.mock('../src/fx-rate', async () => {
	const actual = await vi.importActual<typeof import('../src/fx-rate')>('../src/fx-rate')
	return {
		...actual,
		resolveFxRate: vi.fn(defaultResolveFxRateImpl),
	}
})

import {
	settlementCreate, settlementDelete, SettlementValidationError,
	SettlementCreateRequestSchema,
} from '../src/settlement-write'
import { CascadeError } from '../src/cascade'
import * as fxRate from '../src/fx-rate'
import { FxError } from '../src/fx-rate'

const TRIP_ID       = 'trip-1'
const SETTLEMENT_ID = 'settle-1'
const FROM_UID      = 'from-uid'
const TO_UID        = 'to-uid'      // = caller for create-path tests
const OWNER_UID     = 'owner-uid'   // unrelated to from/to; for owner-delete tests

// ─── Fixture builders (REST `fields` shape) ───────────────────────

function tripReadDoc(currency = 'JPY', extra: Record<string, unknown> = {}): MockReadDoc {
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields: {
			currency: { stringValue: currency },
			...extra,
		},
	}
}

function memberReadDoc(uid: string, role: 'owner' | 'editor' | 'viewer' = 'editor'): MockReadDoc {
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${uid}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields:     { role: { stringValue: role } },
	}
}

function notFoundReadDoc(path: string): MockReadDoc {
	return {
		exists:     false,
		name:       `projects/demo/databases/(default)/documents/${path}`,
		fields:     {},
		updateTime: null,
	}
}

/** Deterministic per-unordered-pair lock path used by both create + delete.
 *  Mirrors `pairLockPath(tripId, a, b)` in settlement-write -- lexicographic
 *  min/max ordering wrapped in a length-prefixed key
 *  (`<lo.len>:<lo>:<hi.len>:<hi>`) so the encoding is injective even when
 *  UIDs contain `_` / `:`. Each create/delete tx reads this doc; tests
 *  must seed it (typically as not-found). */
function lockKey(a: string, b: string): string {
	const [lo, hi] = a < b ? [a, b] : [b, a]
	return `${lo.length}:${lo}:${hi.length}:${hi}`
}
function lockPath(fromUid: string, toUid: string): string {
	return `trips/${TRIP_ID}/settlementPairLocks/${lockKey(fromUid, toUid)}`
}

/** Seed the pair-lock doc as not-found. Almost every authz-passing test
 *  wants this; the lock contents don't drive any logic, just contention. */
function seedLock(fromUid: string, toUid: string): void {
	const path = lockPath(fromUid, toUid)
	txGetResponses.set(path, notFoundReadDoc(path))
}

/** Build an expense REST-fields doc that yields the desired gross debt:
 *  payer paid `amountMinor`, single split `payerOwed → amountMinor`.
 *  Decoder reads `paidBy`, `amountMinor`, `splits[].memberId`,
 *  `splits[].amountMinor` (and ignores everything else). */
function expenseReadDoc(opts: {
	id: string
	paidBy: string
	amountMinor: number
	splits: Array<[string, number]>
	title?: string
	createdAt?: string
	items?: Array<{ id: string; name: string; amountMinor: number; allocations: Array<{ memberId: string; shares: number }> }>
	adjustments?: Array<{ id: string; label: string; kind: string; scope: string; amountMinor: number; targetItemId?: string }>
}): MockReadDoc {
	const fields: Record<string, unknown> = {
		title:       { stringValue: opts.title ?? opts.id },
		paidBy:      { stringValue: opts.paidBy },
		amountMinor: { integerValue: String(opts.amountMinor) },
		createdAt:   { timestampValue: opts.createdAt ?? '2026-05-28T00:00:00Z' },
		splits: {
			arrayValue: {
				values: opts.splits.map(([memberId, amountMinor]) => ({
					mapValue: {
						fields: {
							memberId:    { stringValue: memberId },
							amountMinor: { integerValue: String(amountMinor) },
						},
					},
				})),
			},
		},
	}
	if (opts.items !== undefined) {
		fields.items = {
			arrayValue: {
				values: opts.items.map(item => ({
					mapValue: {
						fields: {
							id:          { stringValue: item.id },
							name:        { stringValue: item.name },
							amountMinor: { integerValue: String(item.amountMinor) },
							allocations: {
								arrayValue: {
									values: item.allocations.map(allocation => ({
										mapValue: {
											fields: {
												memberId: { stringValue: allocation.memberId },
												shares:   { integerValue: String(allocation.shares) },
											},
										},
									})),
								},
							},
						},
					},
				})),
			},
		}
	}
	if (opts.adjustments !== undefined) {
		fields.adjustments = {
			arrayValue: {
				values: opts.adjustments.map(adj => {
					const aFields: Record<string, unknown> = {
						id:          { stringValue: adj.id },
						label:       { stringValue: adj.label },
						kind:        { stringValue: adj.kind },
						scope:       { stringValue: adj.scope },
						amountMinor: { integerValue: String(adj.amountMinor) },
					}
					if (adj.targetItemId !== undefined) {
						aFields.targetItemId = { stringValue: adj.targetItemId }
					}
					return { mapValue: { fields: aFields } }
				}),
			},
		}
	}
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/${opts.id}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields,
	}
}

function settlementReadDoc(opts: {
	id:           string
	fromUid:      string
	toUid:        string
	amountMinor:  number
	currency?:    string
	settledBy?:   string
	createdAt?:   string
	note?:        string
	/** ISO timestamp -> builds a soft-deleted (cancelled) fixture. Omit
	 *  (default) for an active settlement (`deletedAt: {nullValue: null}`). */
	deletedAt?:   string
	deletedBy?:   string
}): MockReadDoc {
	// No pairKey: settlement docs aren't denormalized with one (read is by
	// (fromUid,toUid) equality). Builder mirrors the real persisted shape.
	const fields: Record<string, unknown> = {
		fromUid:     { stringValue: opts.fromUid },
		toUid:       { stringValue: opts.toUid },
		amountMinor: { integerValue: String(opts.amountMinor) },
		currency:    { stringValue: opts.currency ?? 'JPY' },
		settledBy:   { stringValue: opts.settledBy ?? opts.toUid },
		createdAt:   { timestampValue: opts.createdAt ?? '2026-05-28T00:00:00Z' },
		deletedAt:   opts.deletedAt !== undefined ? { timestampValue: opts.deletedAt } : { nullValue: null },
	}
	if (opts.note !== undefined) fields.note = { stringValue: opts.note }
	if (opts.deletedBy !== undefined) fields.deletedBy = { stringValue: opts.deletedBy }
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/settlements/${opts.id}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields,
	}
}

/** Foreign-mode persisted settlement: same canonical trip-currency
 *  fields as `settlementReadDoc` PLUS the FX-group quartet (sourceCurrency,
 *  sourceAmountMinor, settledOn, fxSnapshot). Used by idempotency tests
 *  that need the Worker to take the FOREIGN comparison branch. */
function foreignSettlementReadDoc(opts: {
	id:                 string
	fromUid:            string
	toUid:              string
	amountMinor:        number   // canonical (trip currency)
	currency?:          string   // trip currency, default JPY
	sourceCurrency?:    string
	sourceAmountMinor?: number
	settledOn?:         string
	settledBy?:         string
	createdAt?:         string
	note?:              string
}): MockReadDoc {
	const sourceCurrency    = opts.sourceCurrency    ?? 'USD'
	const sourceAmountMinor = opts.sourceAmountMinor ?? 6500
	const settledOn         = opts.settledOn         ?? '2026-06-01'
	const currency          = opts.currency          ?? 'JPY'
	const fields: Record<string, unknown> = {
		fromUid:           { stringValue:  opts.fromUid },
		toUid:             { stringValue:  opts.toUid },
		amountMinor:       { integerValue: String(opts.amountMinor) },
		currency:          { stringValue:  currency },
		settledBy:         { stringValue:  opts.settledBy ?? opts.toUid },
		createdAt:         { timestampValue: opts.createdAt ?? '2026-06-01T00:00:00Z' },
		deletedAt:         { nullValue: null },
		sourceCurrency:    { stringValue:  sourceCurrency },
		sourceAmountMinor: { integerValue: String(sourceAmountMinor) },
		settledOn:         { stringValue:  settledOn },
		fxSnapshot: { mapValue: { fields: {
			provider:             { stringValue:  'frankfurter-v2' },
			baseCurrency:         { stringValue:  sourceCurrency },
			quoteCurrency:        { stringValue:  currency },
			requestedDate:        { stringValue:  settledOn },
			rateDate:             { stringValue:  settledOn },
			rateDecimal:          { stringValue:  '150' },
			sourceAmountMinor:    { integerValue: String(sourceAmountMinor) },
			convertedAmountMinor: { integerValue: String(opts.amountMinor) },
			fetchedAt:            { timestampValue: '2026-06-01T00:00:00Z' },
		} } },
	}
	if (opts.note !== undefined) fields.note = { stringValue: opts.note }
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/settlements/${opts.id}`,
		updateTime: '2026-06-01T00:00:00Z',
		fields,
	}
}

function seedDebt(fromUid: string, toUid: string, amountMinor: number): void {
	// One expense: toUid paid `amountMinor`, fromUid owes full split.
	txQueryResponses.set(`trips/${TRIP_ID}|expenses`, [
		expenseReadDoc({
			id:          `exp-${fromUid}-${toUid}`,
			paidBy:      toUid,
			amountMinor,
			splits: [[fromUid, amountMinor]],
		}),
	])
	// No prior settlements unless test overrides.
	if (!txQueryResponses.has(`trips/${TRIP_ID}|settlements`)) {
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])
	}
}

/** Trip-currency (degenerate) base payload. Stale-confirmed after Phase 4.1
 *  rearchitecture: no `amountMinor` / `currency` on the wire. Worker
 *  derives canonical from pair-remaining at tx time. */
const baseCreatePayload = (expectedRemainingMinor = 200) => ({
	mode:         'TRIP_CURRENCY' as const,
	tripId:       TRIP_ID,
	settlementId: SETTLEMENT_ID,
	fromUid:      FROM_UID,
	toUid:        TO_UID,
	expectedRemainingMinor,
})

/** Foreign-currency base payload. settledOn drives the FX-rate lookup
 *  key. After Phase 4.1: NO `sourceAmountMinor` on the wire -- Worker
 *  inverse-derives via atMost-target from pair-remaining. With the
 *  default `seedDebt(FROM, TO, 9750)` + mocked rate '150' the Worker
 *  produces source=6500 USD cents → canonical=9750 JPY (exact clear). */
const baseForeignCreatePayload = (expectedRemainingMinor = 9750) => ({
	mode:           'FOREIGN_CURRENCY' as const,
	tripId:         TRIP_ID,
	settlementId:   SETTLEMENT_ID,
	fromUid:        FROM_UID,
	toUid:          TO_UID,
	sourceCurrency: 'USD',
	settledOn:      '2026-06-01',
	expectedRemainingMinor,
})

beforeEach(() => {
	txGetResponses.clear()
	txQueryResponses.clear()
	txGetCalls.length = 0
	txQueryCalls.length = 0
	capturedTxResult = null
	// Restore the default FX impl so a per-test `mockImplementation`
	// override (round-to-zero, FxError-down) doesn't leak into the next
	// test. `mockImplementationOnce` is self-clearing; `mockImplementation`
	// is sticky -- this is the isolation seam.
	vi.mocked(fxRate.resolveFxRate).mockImplementation(defaultResolveFxRateImpl)
})

// ─── settlementCreate ─────────────────────────────────────────────

describe('settlementCreate endpoint', () => {
	it('happy path: writes settlement + lock + returns id + currentDocument.exists=false + REQUEST_TIME createdAt', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		// 200 owed → Worker writes amountMinor=200 (exact clear). The
		// request only carries expectedRemainingMinor as a stale guard;
		// the canonical IS what pair-remaining returns.
		seedDebt(FROM_UID, TO_UID, 200)

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as Array<{
			document:         string
			currentDocument?: { exists?: boolean }
			fields:           Record<string, unknown>
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			op?:              string
		}>
		// Three writes: settlement doc + pair-lock guard doc + source expense lock.
		expect(writes).toHaveLength(3)
		const w = writes[0]
		expect(w.op).toBeUndefined()                // default update / upsert path
		expect(w.currentDocument).toEqual({ exists: false })
		expect(w.fields.fromUid).toEqual({ stringValue: FROM_UID })
		expect(w.fields.toUid).toEqual({ stringValue: TO_UID })
		// Worker-derived from pair-remaining (the seeded debt).
		expect(w.fields.amountMinor).toEqual({ integerValue: '200' })
		// currency comes from trip ctx (Worker-derived), never from the
		// request (TRIP payload has no currency field).
		expect(w.fields.currency).toEqual({ stringValue: 'JPY' })
		expect(w.fields.settledBy).toEqual({ stringValue: TO_UID })
		expect(w.fields.tripId).toEqual({ stringValue: TRIP_ID })
		// Every settlement is created active -- deletedAt written explicitly
		// (not omitted), matching the now-required schema field.
		expect(w.fields.deletedAt).toEqual({ nullValue: null })
		// Settlement docs deliberately carry NO denormalized pairKey field —
		// prior settlements are read by (fromUid,toUid) equality, so there's
		// nothing to keep in sync / backfill. Asserting absence guards against
		// a future re-introduction without re-checking the migration story.
		expect(w.fields.pairKey).toBeUndefined()
		// Note must NOT be written when absent (matches client addDoc shape).
		expect(w.fields.note).toBeUndefined()
		// createdAt comes from REQUEST_TIME transform, NOT a literal value.
		expect(w.fields.createdAt).toBeUndefined()
		expect(w.updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
		])
		// Lock write: points at the unordered-pair lock path, stamps the
		// settlement id + REQUEST_TIME, no `currentDocument` precondition
		// (lazily created / persists for the life of the pair).
		const lock = writes[1]
		expect(lock.op).toBeUndefined()
		expect(lock.currentDocument).toBeUndefined()
		expect(lock.document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
		expect(lock.fields.lastSettlementId).toEqual({ stringValue: SETTLEMENT_ID })
		expect(lock.updateTransforms).toEqual([
			{ fieldPath: 'lastSettlementAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('writes appliedSources with expense/item lineage for audit after later item deletion', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`, [
			expenseReadDoc({
				id:          'exp-dinner',
				title:       'Dinner',
				paidBy:      TO_UID,
				amountMinor: 300,
				splits:      [[FROM_UID, 150], [TO_UID, 150]],
				items: [
					{ id: 'item-noodles', name: 'Noodles', amountMinor: 100, allocations: [{ memberId: FROM_UID, shares: 1 }] },
					{ id: 'item-soup',    name: 'Soup',    amountMinor: 100, allocations: [{ memberId: FROM_UID, shares: 1 }, { memberId: TO_UID, shares: 1 }] },
					{ id: 'item-tea',     name: 'Tea',     amountMinor: 100, allocations: [{ memberId: TO_UID, shares: 1 }] },
				],
				adjustments: [],
			}),
		])
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		await settlementCreate(TO_UID, baseCreatePayload(150), '{}')

		const w = capturedTxResult!.writes[0] as { fields: Record<string, { arrayValue?: { values?: Array<{ mapValue?: { fields: Record<string, unknown> }, stringValue?: string }> } }> }
		const sources = w.fields.appliedSources.arrayValue!.values!.map(v => v.mapValue!.fields)
		expect(sources).toEqual([
			{
				expenseId:    { stringValue: 'exp-dinner' },
				expenseTitle: { stringValue: 'Dinner' },
				itemId:       { stringValue: 'item-noodles' },
				itemName:     { stringValue: 'Noodles' },
				amountMinor:  { integerValue: '100' },
			},
			{
				expenseId:    { stringValue: 'exp-dinner' },
				expenseTitle: { stringValue: 'Dinner' },
				itemId:       { stringValue: 'item-soup' },
				itemName:     { stringValue: 'Soup' },
				amountMinor:  { integerValue: '50' },
			},
		])
		expect(w.fields.appliedExpenseIds).toEqual({
			arrayValue: { values: [{ stringValue: 'exp-dinner' }] },
		})
		const expenseLock = capturedTxResult!.writes[2] as {
			document: string
			fields: Record<string, unknown>
			updateMask?: string[]
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			currentDocument?: { exists?: boolean }
		}
		expect(expenseLock.document).toContain('/expenses/exp-dinner')
		// settlementLockIds union: a fresh expense (no prior lock ids) →
		// just this settlement's id. No REQUEST_TIME transform anymore (the
		// lock is a ref set, not a timestamp).
		expect(expenseLock.fields.settlementLockIds).toEqual({
			arrayValue: { values: [{ stringValue: SETTLEMENT_ID }] },
		})
		expect(expenseLock.updateMask).toEqual(['settlementLockIds'])
		expect(expenseLock.currentDocument).toEqual({ exists: true })
		expect(expenseLock.updateTransforms).toBeUndefined()
	})

	it('create: UNIONS settlementId into an applied expense that already has lock ids', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		// Pair expense already locked by a prior settlement 's-old' (e.g. a
		// different pair sharing this >2-person expense). The new settlement
		// must ADD its id, not overwrite — materialized union from the doc
		// already in the tx read set.
		const expDoc = expenseReadDoc({ id: 'exp-pre', paidBy: TO_UID, amountMinor: 200, splits: [[FROM_UID, 200]] })
		expDoc.fields.settlementLockIds = { arrayValue: { values: [{ stringValue: 's-old' }] } }
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`,    [expDoc])
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		await settlementCreate(TO_UID, baseCreatePayload(200), '{}')

		const writes = capturedTxResult!.writes as Array<{ document: string; fields?: Record<string, unknown> }>
		const lock = writes.find(w => w.document.includes('/expenses/exp-pre'))
		expect(lock).toBeDefined()
		expect(lock!.fields!.settlementLockIds).toEqual({
			arrayValue: { values: [{ stringValue: 's-old' }, { stringValue: SETTLEMENT_ID }] },
		})
	})

	it('locks reverse-offset expenses too (net settlement: forward source + reverse offset both in lock set)', async () => {
		// Net case: TO paid 100 (FROM owes 100) AND FROM paid 80 (TO owes 80)
		// → net FROM→TO = 20. The reverse expense (FROM's 80) offsets the
		// forward to produce that net, so editing it would re-open the debt.
		// It MUST be in the lock set even though only the forward expense is
		// a displayed source.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`, [
			expenseReadDoc({ id: 'exp-fwd', paidBy: TO_UID,   amountMinor: 100, splits: [[FROM_UID, 100]] }),
			expenseReadDoc({ id: 'exp-rev', paidBy: FROM_UID, amountMinor: 80,  splits: [[TO_UID, 80]] }),
		])
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		await settlementCreate(TO_UID, baseCreatePayload(20), '{}')

		const settlementWrite = capturedTxResult!.writes[0] as {
			fields: Record<string, { arrayValue?: { values?: Array<{ stringValue?: string; mapValue?: { fields: Record<string, unknown> } }> } }>
		}
		// Display sources = forward only (the reverse expense is NOT shown).
		const srcVals = settlementWrite.fields.appliedSources.arrayValue!.values!
		expect(srcVals).toHaveLength(1)
		expect(srcVals[0].mapValue!.fields.expenseId).toEqual({ stringValue: 'exp-fwd' })
		// Lock set (appliedExpenseIds) = BOTH expenses (order-agnostic).
		const lockIds = settlementWrite.fields.appliedExpenseIds.arrayValue!.values!.map(v => v.stringValue)
		expect(new Set(lockIds)).toEqual(new Set(['exp-fwd', 'exp-rev']))
		// And an expense lock write was emitted for each.
		const lockedDocs = (capturedTxResult!.writes as Array<{ document: string }>)
			.filter(w => w.document.includes('/expenses/'))
			.map(w => w.document)
		expect(lockedDocs.some(d => d.includes('/expenses/exp-fwd'))).toBe(true)
		expect(lockedDocs.some(d => d.includes('/expenses/exp-rev'))).toBe(true)
	})

	it('scopes the in-tx reads to the settling pair (paidBy IN / exact-direction equality — contention fix)', async () => {
		// Regression lock for the Phase 4.1 contention fix: the in-tx
		// reads MUST be pair-scoped so a concurrent /expense-update on an
		// unrelated expense doesn't share this tx's conflict set and time
		// out. Expenses use `IN` over [fromUid, toUid]; settlements use TWO
		// exact-DIRECTION equality reads (from→to AND to→from) — migration-
		// safe (no new pairKey field, so legacy docs still match) and
		// index-free (two `==` filters need no composite), with A→thirdParty
		// rows never counting toward this pair's read limit.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 200)

		await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		const pairValue = { arrayValue: { values: [{ stringValue: FROM_UID }, { stringValue: TO_UID }] } }
		const expQ  = txQueryCalls.find(q => q.collection === 'expenses')
		const setQs = txQueryCalls.filter(q => q.collection === 'settlements')
		expect(expQ?.filters).toEqual([{ fieldPath: 'paidBy', op: 'IN', value: pairValue }])
		// Both directions, exact equality, NO pairKey field, PLUS deletedAt
		// IS_NULL so cancelled settlements never enter the pair-remaining math.
		expect(setQs).toHaveLength(2)
		expect(setQs[0].filters).toEqual([
			{ fieldPath: 'fromUid',   op: 'EQUAL',   value: { stringValue: FROM_UID } },
			{ fieldPath: 'toUid',     op: 'EQUAL',   value: { stringValue: TO_UID } },
			{ fieldPath: 'deletedAt', op: 'IS_NULL' },
		])
		expect(setQs[1].filters).toEqual([
			{ fieldPath: 'fromUid',   op: 'EQUAL',   value: { stringValue: TO_UID } },
			{ fieldPath: 'toUid',     op: 'EQUAL',   value: { stringValue: FROM_UID } },
			{ fieldPath: 'deletedAt', op: 'IS_NULL' },
		])
	})

	it('excludes a soft-deleted (cancelled) settlement from pair-remaining -- it never applies against gross', async () => {
		// A settlement that was recorded then cancelled must count for
		// nothing: cancelling settlement 'cancelled-1' (400) must NOT reduce
		// the 1000 gross debt. Expect the Worker to write the FULL 1000, not
		// 1000-400=600 -- proving the deletedAt IS_NULL filter (simulated by
		// the mock's matchesMockFilters) actually excludes it, not just that
		// the filter object was passed.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [
			settlementReadDoc({
				id: 'cancelled-1', fromUid: FROM_UID, toUid: TO_UID, amountMinor: 400,
				deletedAt: '2026-05-29T00:00:00Z', deletedBy: TO_UID,
			}),
		])
		seedDebt(FROM_UID, TO_UID, 1000)

		await settlementCreate(TO_UID, baseCreatePayload(1000), '{}')

		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes[0].fields.amountMinor).toEqual({ integerValue: '1000' })
	})

	it('reads a prior settlement that has NO pairKey field (legacy-data regression lock)', async () => {
		// The settlement read is by (fromUid,toUid) equality precisely so
		// docs recorded before any pairKey field existed are still counted.
		// Seed: FROM owes TO 1000 (expense) minus a prior 400 settlement
		// (FROM→TO) that carries NO pairKey → remaining 600. Had the Worker
		// queried by `pairKey ==`, that prior settlement would be invisible
		// → remaining computed as 1000 → permanent 409-stale. Asserting the
		// new write clears exactly 600 proves the legacy settlement was read.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		// Prior FROM→TO settlement of 400 — settlementReadDoc emits no
		// pairKey, mirroring pre-migration data. Set BEFORE seedDebt so its
		// `if (!has)` guard doesn't clobber this.
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [
			settlementReadDoc({ id: 'legacy-1', fromUid: FROM_UID, toUid: TO_UID, amountMinor: 400 }),
		])
		seedDebt(FROM_UID, TO_UID, 1000)

		await settlementCreate(TO_UID, baseCreatePayload(600), '{}')

		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes[0].fields.amountMinor).toEqual({ integerValue: '600' })
		expect(writes[0].fields.pairKey).toBeUndefined()
	})

	it('does not let unrelated settlements consume the exact-pair read limit', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		const unrelatedUid = 'third-party-uid'
		const unrelated = Array.from({ length: 201 }, (_, i) => settlementReadDoc({
			id:          `unrelated-${i}`,
			fromUid:     FROM_UID,
			toUid:       unrelatedUid,
			amountMinor: 1,
			settledBy:   unrelatedUid,
		}))
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, unrelated)
		seedDebt(FROM_UID, TO_UID, 200)

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
	})

	it('idempotent retry: existing settlement at same id (full payload match) → no writes, same id returned', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		// Existing doc: same fromUid/toUid/amountMinor/currency/settledBy/no-note.
		// The payload-match check requires ALL business fields to align;
		// see the dedicated mismatch tests below.
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200 }))
		seedLock(FROM_UID, TO_UID)
		// No need to seed debt -- the early return short-circuits before
		// the pair math runs.

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult).not.toBeNull()
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('rejects retry when the existing doc at the same id has since been cancelled', async () => {
		// A create-retry (same settlementId, same payload) must NOT report
		// success if the original settlement was cancelled between the first
		// attempt landing and the retry arriving -- soft-delete only touches
		// deletedBy/deletedAt, so every other field still "matches" the
		// retry's payload. Silently succeeding would tell the client its
		// settlement is live when it's actually cancelled.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200,
				deletedAt: '2026-05-29T00:00:00Z', deletedBy: TO_UID,
			}))
		seedLock(FROM_UID, TO_UID)

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
		expect(capturedTxResult).toBeNull()
	})

	it('rejects when expectedRemainingMinor is stale', async () => {
		// User action means "clear the whole debt shown on screen". If
		// another settlement changed the pair while the sheet was open,
		// expectedRemainingMinor no longer matches and the Worker asks
		// the client to refresh instead of silently clearing a different
		// amount.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 50)

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/settlement suggestion is stale/i)
	})

	it('writes the full remaining debt when the stale guard matches current remaining', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 50)

		await settlementCreate(TO_UID, baseCreatePayload(50), '{}')

		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes[0].fields.amountMinor).toEqual({ integerValue: '50' })
	})

	it('rejects when pair has no debt at all', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		// No expenses, no settlements seeded -> empty results.
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`,    [])
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrow(/no remaining debt/i)
	})

	it('rejects fromUid === toUid pre-tx (self-settlement guard)', async () => {
		// No tx seeding needed -- guard fires before tx begins.
		await expect(settlementCreate(TO_UID, {
			...baseCreatePayload(),
			fromUid: TO_UID,
		}, '{}')).rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('rejects when caller is not the receiver (toUid mismatch)', async () => {
		// Pre-tx receiver-only invariant fires before any seeding matters.
		const someoneElse = 'other-uid'
		await expect(settlementCreate(someoneElse, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('rejects when fromUid is not a trip member', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${FROM_UID}`))
		// Existing-settlement probe runs in parallel with the fromMember
		// read in the idempotent-retry fast-path. notFound → take the
		// new-write path where the fromUid-membership check rejects.
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('rejects when trip has deletingAt set (cascade-in-progress)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,
			tripReadDoc('JPY', { deletingAt: { timestampValue: '2026-05-28T00:00:00Z' } }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`, memberReadDoc(TO_UID))

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(CascadeError)
	})

	it('rejects when caller is not a trip member at all', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${TO_UID}`))

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(CascadeError)
	})

	// (removed: "rejects on currency mismatch vs trip currency" — intent-
	// only payload has no `currency` field, so this drift is impossible
	// at the protocol layer. `.strict()` on the TRIP branch rejects any
	// smuggled `currency` key; the schema-level test below covers that.)

	it('writes note field when provided', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 200)

		await settlementCreate(TO_UID, { ...baseCreatePayload(), note: '焼肉の精算' }, '{}')

		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes[0].fields.note).toEqual({ stringValue: '焼肉の精算' })
	})
})

// ─── settlementDelete ─────────────────────────────────────────────

describe('settlementDelete endpoint', () => {
	it('happy path: recorder cancels own settlement → soft-delete update + lock touch + currentDocument.exists=true', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID, 'editor'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))
		seedLock(FROM_UID, TO_UID)

		const result = await settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(result).toEqual({ ok: true })
		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as Array<{
			op?:                string
			document:           string
			currentDocument?:   { exists?: boolean }
			fields?:            Record<string, unknown>
			updateMask?:        string[]
			updateTransforms?:  Array<{ fieldPath: string; setToServerValue: string }>
		}>
		// Two writes: soft-delete settlement (update) + touch the per-pair lock.
		expect(writes).toHaveLength(2)
		// NOT a hard delete: no `op`, scoped update via updateMask, deletedAt
		// via REQUEST_TIME transform. Every other field (amountMinor, fromUid,
		// toUid, ...) is preserved because updateMask only lists `deletedBy`.
		expect(writes[0].op).toBeUndefined()
		expect(writes[0].fields).toEqual({ deletedBy: { stringValue: TO_UID } })
		expect(writes[0].updateMask).toEqual(['deletedBy'])
		expect(writes[0].updateTransforms).toEqual([
			{ fieldPath: 'deletedAt', setToServerValue: 'REQUEST_TIME' },
		])
		expect(writes[0].currentDocument).toEqual({ exists: true })
		expect(writes[0].document).toContain(`settlements/${SETTLEMENT_ID}`)
		expect(writes[1].op).toBeUndefined()
		expect(writes[1].document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
		expect(writes[1].fields?.lastSettlementId).toEqual({ stringValue: SETTLEMENT_ID })
	})

	it('owner can cancel a settlement they did not record', async () => {
		// Owner is determined by trip.ownerId === callerUid (aligned with
		// expense-write), NOT members/{uid}.role — seed ownerId accordingly.
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc('JPY', { ownerId: { stringValue: OWNER_UID } }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`,     memberReadDoc(OWNER_UID, 'owner'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))
		seedLock(FROM_UID, TO_UID)

		const result = await settlementDelete(OWNER_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(result).toEqual({ ok: true })
		const writes = capturedTxResult!.writes as Array<{ op?: string; document: string; fields?: Record<string, unknown> }>
		expect(writes).toHaveLength(2)
		expect(writes[0].op).toBeUndefined()
		// deletedBy is the OWNER (the canceller), not settledBy (the recorder).
		expect(writes[0].fields).toEqual({ deletedBy: { stringValue: OWNER_UID } })
		expect(writes[1].document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
	})

	it('idempotent: cancelling an already-cancelled settlement is a no-op (checked after authz)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID,
				deletedAt: '2026-05-29T00:00:00Z', deletedBy: TO_UID,
			}))

		const result = await settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(result).toEqual({ ok: true })
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('a non-recorder non-owner cannot cancel, even when the settlement is already cancelled', async () => {
		// Idempotency check runs AFTER authz -- an unauthorized caller must
		// see the same 403 whether the settlement is active or already
		// cancelled, so cancellation state can't be probed by an outsider.
		const editorUid = 'other-editor'
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${editorUid}`,     memberReadDoc(editorUid, 'editor'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID,
				deletedAt: '2026-05-29T00:00:00Z', deletedBy: TO_UID,
			}))

		await expect(settlementDelete(editorUid, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')).rejects.toBeInstanceOf(CascadeError)
	})

	it('owner check uses trip.ownerId, NOT members.role (drift guard)', async () => {
		// A member whose role drifted to 'owner' but who is NOT the trip's
		// ownerId must NOT delete someone else's settlement. Admin SDK
		// bypasses rules, so role↔ownerId drift would otherwise be exploitable.
		const roleDriftUid = 'role-says-owner'
		txGetResponses.set(`trips/${TRIP_ID}`,                              tripReadDoc('JPY', { ownerId: { stringValue: OWNER_UID } }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${roleDriftUid}`,      memberReadDoc(roleDriftUid, 'owner'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))
		seedLock(FROM_UID, TO_UID)

		await expect(settlementDelete(roleDriftUid, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')).rejects.toBeInstanceOf(CascadeError)
	})

	it('delete: removes ONLY this settlement id from each applied expense; others keep it locked', async () => {
		// exp-shared is locked by THIS settlement AND settle-other (a
		// different pair referencing the same >2-person expense). Deleting
		// this settlement must drop only its own id; settle-other remains →
		// the expense stays locked. Cross-pair correctness with no global scan.
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		const settlementDoc = settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID })
		settlementDoc.fields.appliedExpenseIds = { arrayValue: { values: [{ stringValue: 'exp-shared' }] } }
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`, settlementDoc)
		txGetResponses.set(`trips/${TRIP_ID}/expenses/exp-shared`, {
			exists:     true,
			name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/exp-shared`,
			updateTime: '2026-06-03T00:00:00Z',
			fields:     { settlementLockIds: { arrayValue: { values: [{ stringValue: SETTLEMENT_ID }, { stringValue: 'settle-other' }] } } },
		})
		seedLock(FROM_UID, TO_UID)

		await settlementDelete(TO_UID, { tripId: TRIP_ID, settlementId: SETTLEMENT_ID }, '{}')

		const writes = capturedTxResult!.writes as Array<{ document: string; fields?: Record<string, unknown>; updateMask?: string[] }>
		const unlock = writes.find(w => w.document.includes('/expenses/exp-shared'))
		expect(unlock).toBeDefined()
		expect(unlock!.fields!.settlementLockIds).toEqual({ arrayValue: { values: [{ stringValue: 'settle-other' }] } })
		expect(unlock!.updateMask).toEqual(['settlementLockIds'])
	})

	it('delete: applied expense referenced only by this settlement → settlementLockIds emptied (unlocked)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		const settlementDoc = settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID })
		settlementDoc.fields.appliedExpenseIds = { arrayValue: { values: [{ stringValue: 'exp-solo' }] } }
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`, settlementDoc)
		txGetResponses.set(`trips/${TRIP_ID}/expenses/exp-solo`, {
			exists:     true,
			name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/exp-solo`,
			updateTime: '2026-06-03T00:00:00Z',
			fields:     { settlementLockIds: { arrayValue: { values: [{ stringValue: SETTLEMENT_ID }] } } },
		})
		seedLock(FROM_UID, TO_UID)

		await settlementDelete(TO_UID, { tripId: TRIP_ID, settlementId: SETTLEMENT_ID }, '{}')

		const writes = capturedTxResult!.writes as Array<{ document: string; fields?: Record<string, unknown> }>
		const unlock = writes.find(w => w.document.includes('/expenses/exp-solo'))
		expect(unlock).toBeDefined()
		expect(unlock!.fields!.settlementLockIds).toEqual({ arrayValue: { values: [] } })
	})

	it('rejects non-recorder non-owner editor delete', async () => {
		const editorUid = 'other-editor'
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${editorUid}`,     memberReadDoc(editorUid, 'editor'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))

		await expect(settlementDelete(editorUid, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')).rejects.toBeInstanceOf(CascadeError)
	})

	it('idempotent: missing settlement returns ok with no writes', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))

		const result = await settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(result).toEqual({ ok: true })
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('rejects when trip has deletingAt set (cascade-in-progress)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,
			tripReadDoc('JPY', { deletingAt: { timestampValue: '2026-05-28T00:00:00Z' } }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))

		await expect(settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')).rejects.toBeInstanceOf(CascadeError)
	})

	it('rejects when caller is not a trip member', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${TO_UID}`))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))

		await expect(settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')).rejects.toBeInstanceOf(CascadeError)
	})
})

// ─── M2.5: pair-lock guard ────────────────────────────────────────
//
// Concurrent same-pair creates can't be serialized just by reading
// `settlements` because each tx's runQuery snapshot doesn't include
// the OTHER tx's brand-new doc. We force a contention point by
// reading + writing a deterministic per-pair lock doc inside the same
// tx; here we prove the read happens and the write lands.

describe('pair-lock guard (P1 fix)', () => {
	const expectedLockPath = lockPath(FROM_UID, TO_UID)

	it('create: tx.get on lock path is issued + lock write returned', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 200)

		await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		expect(txGetCalls).toContain(expectedLockPath)
		const writes = capturedTxResult!.writes as Array<{ document: string; fields?: Record<string, unknown> }>
		const lockWrite = writes.find(w => w.document.includes('settlementPairLocks/'))
		expect(lockWrite).toBeDefined()
		expect(lockWrite!.document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
	})

	it('create: lock path is direction-agnostic (B→A uses same key as A→B)', async () => {
		// Caller is the receiver; receiver here is FROM_UID and the payer
		// is TO_UID -- inverted. Same lock-doc must be touched.
		const reversedCaller = FROM_UID
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${reversedCaller}`, memberReadDoc(reversedCaller))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,     memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(reversedCaller, TO_UID)
		// Debt now goes the OTHER way: TO_UID owes reversedCaller (=FROM_UID).
		seedDebt(TO_UID, reversedCaller, 200)

		await settlementCreate(reversedCaller, {
			...baseCreatePayload(),
			fromUid: TO_UID,
			toUid:   reversedCaller,
		}, '{}')

		// Same lock path -- lexicographic min_max ordering is what makes
		// the lock direction-agnostic. If the impl used `${fromUid}_${toUid}`
		// raw, this would be a *different* doc and concurrent A→B + B→A
		// creates could both commit without contention.
		expect(txGetCalls).toContain(expectedLockPath)
	})

	it('delete: tx.get on lock path is issued + lock write returned', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,        memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))
		seedLock(FROM_UID, TO_UID)

		await settlementDelete(TO_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(txGetCalls).toContain(expectedLockPath)
		const writes = capturedTxResult!.writes as Array<{ document: string }>
		const lockWrite = writes.find(w => w.document.includes('settlementPairLocks/'))
		expect(lockWrite).toBeDefined()
	})

	it('lock key is injective: distinct UID pairs do not collide even when UIDs contain `_`', async () => {
		// Firebase Auth UIDs use [A-Za-z0-9_-]; a naive `${lo}_${hi}` key
		// collapses {a, b_c} and {a_b, c} to the same string `a_b_c`.
		// Length-prefix encoding side-steps this: `1:a:3:b_c` vs
		// `3:a_b:1:c`. We don't have a way to read the helper directly
		// from the impl, so we drive two real settlement creates and
		// assert each one's tx.get hit a DIFFERENT lock path.
		const UID_AB = 'a_b'
		const UID_C  = 'c'

		// Pair {a_b, c}: caller = c (receiver), payer = a_b.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${UID_C}`,   memberReadDoc(UID_C))
		txGetResponses.set(`trips/${TRIP_ID}/members/${UID_AB}`,  memberReadDoc(UID_AB))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/s-1`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/s-1`))
		seedLock(UID_AB, UID_C)
		seedDebt(UID_AB, UID_C, 200)

		await settlementCreate(UID_C, {
			mode: 'TRIP_CURRENCY' as const,
			tripId: TRIP_ID, settlementId: 's-1',
			fromUid: UID_AB, toUid: UID_C,
		}, '{}')

		const lockPathsHit = txGetCalls.filter(p => p.includes('settlementPairLocks/'))
		expect(lockPathsHit).toHaveLength(1)
		const keyForAB_C = lockPathsHit[0]

		// Pair {a, b_c}: caller = b_c (receiver), payer = a. Under the
		// broken `${lo}_${hi}` encoding this would resolve to the same
		// `a_b_c` path → false-positive contention with the previous
		// pair. Length-prefixed encoding makes them distinct.
		const UID_A  = 'a'
		const UID_BC = 'b_c'
		txGetResponses.clear()
		txGetCalls.length = 0
		txQueryResponses.clear()
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${UID_BC}`,  memberReadDoc(UID_BC))
		txGetResponses.set(`trips/${TRIP_ID}/members/${UID_A}`,   memberReadDoc(UID_A))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/s-2`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/s-2`))
		seedLock(UID_A, UID_BC)
		seedDebt(UID_A, UID_BC, 200)

		await settlementCreate(UID_BC, {
			mode: 'TRIP_CURRENCY' as const,
			tripId: TRIP_ID, settlementId: 's-2',
			fromUid: UID_A, toUid: UID_BC,
		}, '{}')

		const keyForA_BC = txGetCalls.filter(p => p.includes('settlementPairLocks/'))[0]
		expect(keyForA_BC).toBeDefined()
		expect(keyForA_BC).not.toBe(keyForAB_C)
	})
})

// ─── M2.6: fail-closed read caps ──────────────────────────────────
//
// Either form of under-read (truncated expenses → undercount applied;
// truncated settlements → undercount applied) lets overpay slip past.
// Worker requests `limit + 1` so truncation is detectable; tests
// seed exactly limit+1 docs and assert 503.

describe('read-cap truncation fail-closed (P2 fix)', () => {
	function setupAuthz() {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
	}

	it('expense read returning limit+1 (501) → CascadeError 503', async () => {
		setupAuthz()
		// 501 expenses: each pays a tiny amount, decoder doesn't care
		// about the math -- the truncation guard fires before pair compute.
		const tooMany = Array.from({ length: 501 }, (_, i) => expenseReadDoc({
			id:     `exp-${i}`,
			paidBy: TO_UID,
			amountMinor: 1,
			splits: [[FROM_UID, 1]],
		}))
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`,    tooMany)
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(CascadeError)
		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrow(/too many expenses for this pair/i)
	})

	it('settlement read returning limit+1 (201) → CascadeError 503', async () => {
		setupAuthz()
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`, [])
		const tooMany = Array.from({ length: 201 }, (_, i) => settlementReadDoc({
			id:       `s-${i}`,
			fromUid:  FROM_UID,
			toUid:    TO_UID,
			amountMinor: 1,
			settledBy: TO_UID,
		}))
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, tooMany)

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrow(/too many settlements/i)
	})

	it('expense read at exactly limit (500) is accepted (cap is fail-CLOSED only on overflow)', async () => {
		setupAuthz()
		// Exactly 500 active expense docs must be accepted. Keep the
		// pair-remaining at the default 200 so this test only exercises
		// the read-cap boundary, not the stale-confirmation guard.
		const exact = [
			...Array.from({ length: 200 }, (_, i) => expenseReadDoc({
				id:     `exp-debt-${i}`,
				paidBy: TO_UID,
				amountMinor: 1,
				splits: [[FROM_UID, 1]],
			})),
			...Array.from({ length: 300 }, (_, i) => expenseReadDoc({
				id:     `exp-zero-${i}`,
				paidBy: TO_UID,
				amountMinor: 0,
				splits: [[FROM_UID, 0]],
			})),
		]
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`,    exact)
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')
		expect(result.settlementId).toBe(SETTLEMENT_ID)
	})
})

// ─── Idempotent retry: intent-field exact match ───────────────────
//
// Post-rearchitecture the request payload is a stale-confirmed intent:
// no user-entered amount/currency crosses the wire, but
// expectedRemainingMinor DOES participate in the replay check via the
// persisted amountMinor. Comparison runs on
// {fromUid, toUid, settledBy, expectedRemainingMinor, note} for TRIP and
// {fromUid, toUid, sourceCurrency, settledOn, settledBy,
// expectedRemainingMinor, note} for FOREIGN. Persisted sourceAmountMinor
// is excluded by design because it is Worker-derived from the original
// FX snapshot.

describe('idempotent retry payload-exact match', () => {
	function setupRetry(existing: Parameters<typeof settlementReadDoc>[0]) {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc(existing))
		seedLock(FROM_UID, TO_UID)
	}

	it('fromUid mismatch → reject', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: 'someone-else', toUid: TO_UID, amountMinor: 200 })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('settledBy mismatch → reject (existing was recorded by someone other than caller)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200, settledBy: 'other-recorder' })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('note mismatch → reject (existing has note, request does not)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200, note: '焼肉の精算' })

		// baseCreatePayload omits note → normalized to '' → mismatch with '焼肉の精算'.
		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('note normalization: existing-no-note + request-empty-note → accepted as match', async () => {
		// Edge case: existing doc was written WITHOUT note field (old client
		// path). Request explicitly sends note: ''. Both normalize to '' →
		// must be considered identical to avoid false positives on the
		// most common no-note path.
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200 })

		const result = await settlementCreate(TO_UID, { ...baseCreatePayload(), note: '' }, '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('exact match w/ matching note → accepted (no writes)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 200, note: '焼肉の精算' })

		const result = await settlementCreate(TO_UID, { ...baseCreatePayload(), note: '焼肉の精算' }, '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('persisted amount divergence is a mismatch (stale-confirmed replay guard)', async () => {
		// Existing doc has amountMinor=42 while the retry still expects
		// 200. That means this settlementId no longer proves the same
		// full-clear intent, so it must not short-circuit as idempotent.
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 42 })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})
})

// ─── settlement FX (foreign-mode) — Phase 4.1 rearchitecture ──────
//
// Worker-authoritative FX with stale-confirmed intent payload: client
// sends expectedRemainingMinor + sourceCurrency + settledOn (NO
// sourceAmountMinor). Worker computes pair-remaining, rejects if it
// differs from expectedRemainingMinor, fetches the rate via
// `resolveFxRate`, inverse-derives the largest sourceAmountMinor whose
// forward conversion is <= remaining (atMost-target policy), then
// forward-converts to get the audit snapshot. Persists source fields
// alongside amountMinor=remaining.
//
// OVERPAY-after-convert is eliminated by construction (no client-supplied
// source amount possible). The remaining reject classes are:
//   - same-currency (use TRIP path instead)
//   - no debt at all (remaining ≤ EPS)
//   - round-to-zero (canonical falls to 0 for tiny remaining vs strong
//     source-to-trip rate)
//   - FxError bubbles
//   - retry intent-field mismatch (drops sourceAmountMinor; includes
//     expectedRemainingMinor via amountMinor)
//   - mode-flip retry

describe('settlementCreate FOREIGN_CURRENCY (Settlement FX)', () => {
	function setupForeignAuthz() {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
	}

	it('happy path: persists all 4 source fields + canonical amountMinor + fxSnapshot + REQUEST_TIME fetchedAt', async () => {
		setupForeignAuthz()
		// 9750 JPY of debt: source 6500 USD * rate 150 / 100 = 9750 JPY canonical.
		// Settlement of US$65 (=¥9750 derived) exactly clears the debt.
		seedDebt(FROM_UID, TO_UID, 9750)

		const result = await settlementCreate(TO_UID, baseForeignCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		const writes = capturedTxResult!.writes as Array<{
			document:         string
			fields:           Record<string, { stringValue?: string; integerValue?: string; mapValue?: { fields: Record<string, unknown> } }>
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			currentDocument?: { exists?: boolean }
		}>
		expect(writes).toHaveLength(3)  // settlement doc + pair lock + source expense lock
		const w = writes[0]
		expect(w.currentDocument).toEqual({ exists: false })

		// Trip-currency canonical: amountMinor = remaining (Phase 4.1
		// ledger truth). Happens to equal convertedAmountMinor here
		// because the rate produces an exact clear with no rounding
		// plateau — see the divergence test below for the decoupled case.
		expect(w.fields.amountMinor).toEqual({ integerValue: '9750' })
		// currency is Worker-derived from ctx (trip currency), NEVER from
		// the foreign request -- there's no `currency` field on the foreign
		// branch's payload schema.
		expect(w.fields.currency).toEqual({ stringValue: 'JPY' })

		// FX group quartet, all-or-none.
		expect(w.fields.sourceCurrency).toEqual({ stringValue: 'USD' })
		expect(w.fields.sourceAmountMinor).toEqual({ integerValue: '6500' })
		expect(w.fields.settledOn).toEqual({ stringValue: '2026-06-01' })

		// fxSnapshot map: every field present, fetchedAt null pending the
		// REQUEST_TIME transform below.
		const fx = w.fields.fxSnapshot.mapValue!.fields as Record<string, { stringValue?: string; integerValue?: string; nullValue?: null }>
		expect(fx.provider).toEqual({ stringValue: 'frankfurter-v2' })
		expect(fx.baseCurrency).toEqual({ stringValue: 'USD' })
		expect(fx.quoteCurrency).toEqual({ stringValue: 'JPY' })
		expect(fx.requestedDate).toEqual({ stringValue: '2026-06-01' })
		expect(fx.rateDate).toEqual({ stringValue: '2026-06-01' })
		expect(fx.rateDecimal).toEqual({ stringValue: '150' })
		expect(fx.sourceAmountMinor).toEqual({ integerValue: '6500' })
		expect(fx.convertedAmountMinor).toEqual({ integerValue: '9750' })
		expect(fx.fetchedAt).toEqual({ nullValue: null })

		// Both server-time transforms present: createdAt + the nested
		// fxSnapshot.fetchedAt. Worker Date.now() would drift relative to
		// Firestore commit; same rationale as expense-write.
		expect(w.updateTransforms).toEqual([
			{ fieldPath: 'createdAt',          setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('rejects when sourceCurrency === trip currency (use TRIP_CURRENCY path instead)', async () => {
		// Same-currency foreign path is meaningless: no rate, no snapshot
		// to persist, and a degenerate FxSnapshot with provider==null
		// would confuse the audit trail. Worker rejects with
		// SettlementValidationError(sourceCurrency).
		//
		// Post-rearchitecture: pair-remaining is computed BEFORE
		// prepareForeignSettlement, so we must seed real debt — otherwise
		// the no-remaining-debt gate would fire first and we'd never reach
		// the same-currency check. Trip currency here is USD; seedDebt
		// shape is unitless so the same fixture works.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('USD'))  // trip is USD
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		// Existing-settlement probe runs first (idempotent-retry fast-
		// path); notFound → new-write path → pair-remaining → prepareForeignSettlement's
		// same-currency reject.
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 1000)

		await expect(settlementCreate(TO_UID, {
			...baseForeignCreatePayload(1000),
			sourceCurrency: 'USD',  // same as trip
		}, '{}')).rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('amountMinor ≡ remaining even when forward(source) ≠ remaining (Phase 4.1 ledger truth)', async () => {
		// Phase 4.1 invariant: amountMinor ALWAYS equals pair-remaining
		// (full clear of the suggested debt), even when the FX forward
		// result diverges by a few minor units due to half-even rounding
		// plateaus. fxSnapshot.convertedAmountMinor stays honest about
		// the FX math; the two are intentionally decoupled.
		//
		// Setup: remaining=5003 JPY, USD→JPY rate '150' (USD fd=2, JPY fd=0).
		//   atMost(5003, '150', 2/0):
		//     s=3335: 3335·150/100 = 5002.5 → half-even rounds to 5002
		//             (5002 is even, banker's rule). ≤ 5003 ✓
		//     s=3336: 3336·150/100 = 5004 (exact). > 5003 ✗
		//   So sourceAmountMinor=3335, convertedAmountMinor=forward(3335)=5002.
		//
		// Pre-rearchitecture this would have written amountMinor=5002
		// (the FX forward), leaving a 1-JPY orphan tail. Phase 4.1 writes
		// amountMinor=5003 (remaining) — the ledger zeroes the entire pair
		// balance, 「済み」 means cleared regardless of FX artifacts.
		setupForeignAuthz()
		seedDebt(FROM_UID, TO_UID, 5003)

		await settlementCreate(TO_UID, baseForeignCreatePayload(5003), '{}')

		const w = capturedTxResult!.writes[0] as { fields: Record<string, { stringValue?: string; integerValue?: string; mapValue?: { fields: Record<string, { stringValue?: string; integerValue?: string }> } }> }
		expect(w.fields.amountMinor).toEqual({ integerValue: '5003' })
		expect(w.fields.sourceAmountMinor).toEqual({ integerValue: '3335' })
		// Decoupled: convertedAmountMinor is forward(source)=5002, NOT 5003.
		expect(w.fields.fxSnapshot.mapValue!.fields.convertedAmountMinor).toEqual({ integerValue: '5002' })
	})

	it('rejects when atMost-derived sourceAmountMinor is 0 (tiny remaining vs strong rate)', async () => {
		// Source-side round-to-zero guard (Phase 4.1). With remaining=1
		// minor unit (just above SETTLEMENT_EPS=0.5 so it passes the
		// no-debt gate) and rate '150', atMost(1, '150', 2/0 fd) = 0
		// (s=1 forward = round_half_even(1.5) = 2 > 1, so no source ≥ 1
		// fits at-most). The Worker rejects on `foreign.sourceAmountMinor
		// <= 0` BEFORE writing — SettlementDocSchema's
		// `sourceAmountMinor.positive()` would otherwise reject the row
		// on the client read parser, and a "≈ 0 USD" display is nonsense.
		// Note: amountMinor=remaining=1 would itself be writeable in
		// Phase 4.1; the rejection is purely about the source-side
		// degeneracy, not about the ledger amount.
		setupForeignAuthz()
		seedDebt(FROM_UID, TO_UID, 1)

		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(1), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(1), '{}'))
			.rejects.toThrowError(/too small to settle/i)
	})

	it('FxError bubbles up to the caller (provider unavailable / future date / etc.)', async () => {
		setupForeignAuthz()
		seedDebt(FROM_UID, TO_UID, 9750)
		// One-shot override: provider unavailable for this call only. Worker
		// has no FxError → SettlementValidationError mapping -- letting it
		// bubble keeps the error vocabulary single-source per fx-rate.ts.
		// The settlement-create route in index.ts chains fxErrorCatcher()
		// after validationErrorCatcher(SettlementValidationError) so the
		// HTTP response carries FxError.status + .code; a route-level
		// smoke for that mapping is in test/route-dispatch.spec.ts.
		vi.mocked(fxRate.resolveFxRate).mockImplementationOnce(async () => {
			throw new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'Frankfurter down')
		})

		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(FxError)

		// Ordering lock (contention fix): the FX rate is resolved BEFORE the
		// pair fan-out, so an FX failure short-circuits without ever reading
		// the pair expense/settlement docs into the tx. Had a regression
		// moved FX back to after the fan-out, those runQuery calls would
		// have fired — holding the hot pair docs in the conflict set while
		// the tx waits on (a down) Frankfurter, which is the exact window
		// this change closes.
		expect(txQueryCalls).toHaveLength(0)
	})

	it('idempotent retry FOREIGN: full intent-field match → no writes, same id', async () => {
		// Existing doc carries the same intent fields (from/to/sourceCurrency/
		// settledOn/settledBy/no-note); Worker takes the FOREIGN comparison
		// branch and short-circuits on match. Persisted source amount can
		// differ from any "fresh" derive -- it's Worker-derived, not
		// client-supplied, so it's NOT in the intent comparison.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'USD', sourceAmountMinor: 6500,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		const result = await settlementCreate(TO_UID, baseForeignCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('idempotent retry FOREIGN short-circuits BEFORE FX call (provider stays untouched)', async () => {
		// Locks down the ordering guarantee: existing-doc probe happens
		// in the fast-path BEFORE resolveFxRate. Without this guarantee
		// a Frankfurter outage would turn legitimate retries (same id,
		// same intent payload) into 502s -- the intent-comparison contract
		// is the whole reason FX runs AFTER the existing-doc check.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'USD', sourceAmountMinor: 6500,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		const fxSpy = vi.mocked(fxRate.resolveFxRate)
		fxSpy.mockClear()

		const result = await settlementCreate(TO_UID, baseForeignCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(fxSpy).not.toHaveBeenCalled()
	})

	it('idempotent retry FOREIGN succeeds even when FX provider is DOWN', async () => {
		// The whole point of the stale-confirmed idempotency contract:
		// the original commit succeeded, the client missed the response,
		// retries with the same id + same intent payload, and Frankfurter
		// happens to be 502'ing right now. We must return success
		// without ever touching FX -- which means the existing-doc check
		// has to run BEFORE prepareForeignSettlement.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'USD', sourceAmountMinor: 6500,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		// Arm an FX failure -- if the fast-path is correct, this is never
		// reached. If it IS reached, the test fails with FxError instead
		// of the expected idempotent ok.
		vi.mocked(fxRate.resolveFxRate).mockImplementation(async () => {
			throw new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'Frankfurter down')
		})

		const result = await settlementCreate(TO_UID, baseForeignCreatePayload(), '{}')
		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('mismatched FOREIGN retry rejects BEFORE FX call (payload comparison is pure stale-confirmed fields)', async () => {
		// Existing doc differs from the request on `settledOn` (one of
		// the intent fields). Comparison detects mismatch without
		// touching FX. Locks down "FX is only ever called on the
		// new-write path".
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'USD', sourceAmountMinor: 6500,
				settledOn: '2026-05-30',  // differs from request's '2026-06-01'
			}))
		seedLock(FROM_UID, TO_UID)

		const fxSpy = vi.mocked(fxRate.resolveFxRate)
		fxSpy.mockClear()

		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
		expect(fxSpy).not.toHaveBeenCalled()
	})

	it('rejects FOREIGN retry with mismatched sourceCurrency → id collision', async () => {
		// Existing doc has source EUR; request has USD. The FOREIGN
		// intent comparison includes sourceCurrency.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'EUR', sourceAmountMinor: 7000,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('persisted sourceAmountMinor divergence is NOT a mismatch (it\'s Worker-derived)', async () => {
		// Existing doc was written with source=7000 (perhaps from a
		// different remaining at that time); current request implies a
		// derive of 6500. Intent fields all match, so retry succeeds --
		// persisted source amount is excluded from comparison by design.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 9750, sourceCurrency: 'USD', sourceAmountMinor: 7000,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		const result = await settlementCreate(TO_UID, baseForeignCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('rejects mode-flip retry: existing is TRIP, request is FOREIGN → id collision', async () => {
		// Persisted doc has no sourceCurrency field → Worker treats it as
		// TRIP; FOREIGN request hits the mode-mismatch branch first. This
		// is the cross-mode replay guard.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 9750 }))
		seedLock(FROM_UID, TO_UID)

		await expect(settlementCreate(TO_UID, baseForeignCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('rejects mode-flip retry: existing is FOREIGN, request is TRIP → id collision', async () => {
		// Persisted doc has sourceCurrency → FOREIGN; TRIP request hits
		// the mode-mismatch branch. Same guard, other direction.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			foreignSettlementReadDoc({
				id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID,
				amountMinor: 200, sourceCurrency: 'USD', sourceAmountMinor: 6500,
				settledOn: '2026-06-01',
			}))
		seedLock(FROM_UID, TO_UID)

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})
})

// Discriminator + per-branch .strict() guards. The route layer
// (`SettlementCreateRequestSchema` in index.ts) is the only thing
// gating raw wire bodies before settlementCreate() sees them, so
// these schema-level tests are the analogue of expense-write's
// "smuggled trip-currency money keys" test -- different code shape
// because settlementCreate accepts a typed `SettlementCreateRequest`
// (parsing happens at the route), whereas expenseCreate parses the
// nested `expense:` field internally.
describe('SettlementCreateRequestSchema (.strict() per-branch + discriminator)', () => {
	// Post-rearchitecture stale-confirmed intent shapes.
	const TRIP_BODY = {
		mode:                   'TRIP_CURRENCY' as const,
		tripId:                 TRIP_ID,
		settlementId:           SETTLEMENT_ID,
		fromUid:                FROM_UID,
		toUid:                  TO_UID,
		expectedRemainingMinor: 200,
	}

	const FOREIGN_BODY = {
		mode:                   'FOREIGN_CURRENCY' as const,
		tripId:                 TRIP_ID,
		settlementId:           SETTLEMENT_ID,
		fromUid:                FROM_UID,
		toUid:                  TO_UID,
		expectedRemainingMinor: 9750,
		sourceCurrency:         'USD',
		settledOn:              '2026-06-01',
	}

	it('accepts a minimal TRIP_CURRENCY body', () => {
		expect(SettlementCreateRequestSchema.safeParse(TRIP_BODY).success).toBe(true)
	})

	it('accepts a minimal FOREIGN_CURRENCY body', () => {
		expect(SettlementCreateRequestSchema.safeParse(FOREIGN_BODY).success).toBe(true)
	})

	it('rejects TRIP_CURRENCY body that smuggles ANY money / FX field (.strict() on TRIP branch)', () => {
		// Stale-confirmed intent: amountMinor, currency, AND the foreign
		// quartet all belong on neither side of the TRIP branch. A buggy client that
		// re-adds any of them (regression from the pre-rearchitecture wire
		// shape, or leftover foreign UI state) must be rejected loudly
		// before any tx state is touched.
		const smuggleCases: Record<string, string | number> = {
			amountMinor:       100,
			currency:          'JPY',
			sourceCurrency:    'USD',
			sourceAmountMinor: 100,
			settledOn:         '2026-06-01',
		}
		for (const [key, value] of Object.entries(smuggleCases)) {
			const body = { ...TRIP_BODY, [key]: value }
			const r = SettlementCreateRequestSchema.safeParse(body)
			expect(r.success, `TRIP body must reject smuggled ${key}`).toBe(false)
		}
	})

	it('rejects FOREIGN_CURRENCY body that smuggles money keys or sourceAmountMinor (.strict() on FOREIGN branch)', () => {
		// Mirror of expense-write's strictness test plus the
		// rearchitecture removal: FOREIGN now derives sourceAmountMinor
		// internally, so a client that lies about it must be rejected
		// (otherwise a regressed client could re-introduce the OVERPAY
		// class by shipping a too-large source).
		const smuggleCases: Record<string, string | number> = {
			amountMinor:       100,
			currency:          'JPY',
			sourceAmountMinor: 6500,
		}
		for (const [key, value] of Object.entries(smuggleCases)) {
			const body = { ...FOREIGN_BODY, [key]: value }
			const r = SettlementCreateRequestSchema.safeParse(body)
			expect(r.success, `FOREIGN body must reject smuggled ${key}`).toBe(false)
		}
	})

	it('rejects unknown discriminator value', () => {
		const r = SettlementCreateRequestSchema.safeParse({ ...TRIP_BODY, mode: 'SOMETHING_ELSE' })
		expect(r.success).toBe(false)
	})

	it('rejects missing discriminator (no mode field)', () => {
		const { mode: _omit, ...noMode } = TRIP_BODY
		const r = SettlementCreateRequestSchema.safeParse(noMode)
		expect(r.success).toBe(false)
	})
})
