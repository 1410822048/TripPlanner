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
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		const ctx = {
			get: async (path: string) => {
				txGetCalls.push(path)
				const resp = txGetResponses.get(path)
				if (!resp) throw new Error(`unexpected tx.get('${path}') -- not seeded`)
				return resp
			},
			runQuery: async (q: { parent: string; collection: string }) => {
				return txQueryResponses.get(`${q.parent}|${q.collection}`) ?? []
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

import { settlementCreate, settlementDelete, SettlementValidationError } from '../src/settlement-write'
import { CascadeError } from '../src/cascade'

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
function expenseReadDoc(opts: { id: string; paidBy: string; amountMinor: number; splits: Array<[string, number]> }): MockReadDoc {
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/${opts.id}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields: {
			paidBy:      { stringValue: opts.paidBy },
			amountMinor: { integerValue: String(opts.amountMinor) },
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
		},
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
}): MockReadDoc {
	const fields: Record<string, unknown> = {
		fromUid:     { stringValue: opts.fromUid },
		toUid:       { stringValue: opts.toUid },
		amountMinor: { integerValue: String(opts.amountMinor) },
		currency:    { stringValue: opts.currency ?? 'JPY' },
		settledBy:   { stringValue: opts.settledBy ?? opts.toUid },
		createdAt:   { timestampValue: opts.createdAt ?? '2026-05-28T00:00:00Z' },
	}
	if (opts.note !== undefined) fields.note = { stringValue: opts.note }
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/settlements/${opts.id}`,
		updateTime: '2026-05-28T00:00:00Z',
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

const baseCreatePayload = () => ({
	tripId:       TRIP_ID,
	settlementId: SETTLEMENT_ID,
	fromUid:      FROM_UID,
	toUid:        TO_UID,
	amountMinor:  100,
	currency:     'JPY',
})

beforeEach(() => {
	txGetResponses.clear()
	txQueryResponses.clear()
	txGetCalls.length = 0
	capturedTxResult = null
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
		seedDebt(FROM_UID, TO_UID, 200)  // 200 owed; settlement of 100 fits

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
		// Two writes: settlement doc + pair-lock guard doc.
		expect(writes).toHaveLength(2)
		const w = writes[0]
		expect(w.op).toBeUndefined()                // default update / upsert path
		expect(w.currentDocument).toEqual({ exists: false })
		expect(w.fields.fromUid).toEqual({ stringValue: FROM_UID })
		expect(w.fields.toUid).toEqual({ stringValue: TO_UID })
		expect(w.fields.amountMinor).toEqual({ integerValue: '100' })
		expect(w.fields.currency).toEqual({ stringValue: 'JPY' })
		expect(w.fields.settledBy).toEqual({ stringValue: TO_UID })
		expect(w.fields.tripId).toEqual({ stringValue: TRIP_ID })
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

	it('idempotent retry: existing settlement at same id (full payload match) → no writes, same id returned', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		// Existing doc: same fromUid/toUid/amountMinor/currency/settledBy/no-note.
		// The payload-match check requires ALL business fields to align;
		// see the dedicated mismatch tests below.
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100 }))
		seedLock(FROM_UID, TO_UID)
		// No need to seed debt -- the early return short-circuits before
		// the pair math runs.

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult).not.toBeNull()
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('rejects when amount exceeds remaining debt (OVERPAY)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`))
		seedLock(FROM_UID, TO_UID)
		seedDebt(FROM_UID, TO_UID, 50)  // only 50 owed; payload asks for 100

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
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
			.rejects.toThrow(/exceeds remaining debt/i)
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

	it('rejects on currency mismatch vs trip currency', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc('JPY'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))

		await expect(settlementCreate(TO_UID, {
			...baseCreatePayload(),
			currency: 'USD',
		}, '{}')).rejects.toBeInstanceOf(SettlementValidationError)
	})

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
	it('happy path: recorder deletes own settlement → op=delete + lock touch + currentDocument.exists=true', async () => {
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
			op?:              string
			document:         string
			currentDocument?: { exists?: boolean }
			fields?:          Record<string, unknown>
		}>
		// Two writes: delete settlement + touch the per-pair lock.
		expect(writes).toHaveLength(2)
		expect(writes[0].op).toBe('delete')
		expect(writes[0].currentDocument).toEqual({ exists: true })
		expect(writes[0].document).toContain(`settlements/${SETTLEMENT_ID}`)
		expect(writes[1].op).toBeUndefined()
		expect(writes[1].document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
		expect(writes[1].fields?.lastSettlementId).toEqual({ stringValue: SETTLEMENT_ID })
	})

	it('owner can delete a settlement they did not record', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`,     memberReadDoc(OWNER_UID, 'owner'))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: TO_UID }))
		seedLock(FROM_UID, TO_UID)

		const result = await settlementDelete(OWNER_UID, {
			tripId: TRIP_ID, settlementId: SETTLEMENT_ID,
		}, '{}')

		expect(result).toEqual({ ok: true })
		const writes = capturedTxResult!.writes as Array<{ op?: string; document: string }>
		expect(writes).toHaveLength(2)
		expect(writes[0].op).toBe('delete')
		expect(writes[1].document).toContain(`settlementPairLocks/${lockKey(FROM_UID, TO_UID)}`)
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
			tripId: TRIP_ID, settlementId: 's-1',
			fromUid: UID_AB, toUid: UID_C, amountMinor: 100, currency: 'JPY',
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
			tripId: TRIP_ID, settlementId: 's-2',
			fromUid: UID_A, toUid: UID_BC, amountMinor: 100, currency: 'JPY',
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
			.rejects.toThrow(/too many active expenses/i)
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
		// 500 expenses each contributing $1 of debt → total 500, which
		// fits a 100-unit settlement (the base payload). Boundary check:
		// limit itself must not trigger.
		const exact = Array.from({ length: 500 }, (_, i) => expenseReadDoc({
			id:     `exp-${i}`,
			paidBy: TO_UID,
			amountMinor: 1,
			splits: [[FROM_UID, 1]],
		}))
		txQueryResponses.set(`trips/${TRIP_ID}|expenses`,    exact)
		txQueryResponses.set(`trips/${TRIP_ID}|settlements`, [])

		const result = await settlementCreate(TO_UID, baseCreatePayload(), '{}')
		expect(result.settlementId).toBe(SETTLEMENT_ID)
	})
})

// ─── M2.7: idempotent retry requires exact payload match ──────────
//
// Original impl returned success on any existing settlementId match
// -- masking client bugs / replay attempts. Now every business field
// must align; mismatch raises SettlementValidationError so the caller
// surfaces the collision instead of silently accepting a stale write.

describe('idempotent retry payload-exact match (P2 fix)', () => {
	function setupRetry(existing: Parameters<typeof settlementReadDoc>[0]) {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${TO_UID}`,  memberReadDoc(TO_UID))
		txGetResponses.set(`trips/${TRIP_ID}/members/${FROM_UID}`, memberReadDoc(FROM_UID))
		txGetResponses.set(`trips/${TRIP_ID}/settlements/${SETTLEMENT_ID}`,
			settlementReadDoc(existing))
		seedLock(FROM_UID, TO_UID)
	}

	it('amountMinor mismatch → SettlementValidationError(settlementId)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 99 })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('fromUid mismatch → reject', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: 'someone-else', toUid: TO_UID, amountMinor: 100 })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('currency mismatch → reject (existing USD, request JPY)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, currency: 'USD' })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('settledBy mismatch → reject (existing was recorded by someone other than caller)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, settledBy: 'other-recorder' })

		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toBeInstanceOf(SettlementValidationError)
	})

	it('note mismatch → reject (existing has note, request does not)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, note: '焼肉の精算' })

		// baseCreatePayload omits note → normalized to '' → mismatch with '焼肉の精算'.
		await expect(settlementCreate(TO_UID, baseCreatePayload(), '{}'))
			.rejects.toThrowError(/id collision or replay attempt/i)
	})

	it('note normalization: existing-no-note + request-empty-note → accepted as match', async () => {
		// Edge case: existing doc was written WITHOUT note field (old client
		// path). Request explicitly sends note: ''. Both normalize to '' →
		// must be considered identical to avoid false positives on the
		// most common no-note path.
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100 })

		const result = await settlementCreate(TO_UID, { ...baseCreatePayload(), note: '' }, '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('exact match w/ matching note → accepted (no writes)', async () => {
		setupRetry({ id: SETTLEMENT_ID, fromUid: FROM_UID, toUid: TO_UID, amountMinor: 100, note: '焼肉の精算' })

		const result = await settlementCreate(TO_UID, { ...baseCreatePayload(), note: '焼肉の精算' }, '{}')

		expect(result.settlementId).toBe(SETTLEMENT_ID)
		expect(capturedTxResult!.writes).toEqual([])
	})
})
