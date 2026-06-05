// Endpoint-level tests for expense-write.ts. expense-validate.spec
// covers the validators in isolation and firestore-tx.spec covers
// the transaction wrapper at the wire-protocol layer; this file
// stitches them together at the endpoint boundary -- catches
// orchestration bugs that neither lower-level test would notice:
//
//   - wrong tx.get path (e.g. typo in collection segment)
//   - missing tombstone gate on update
//   - patch allowlist enforcement before tx even begins
//   - receipt-deletion via updateMask-without-fields (the post-tx
//     PATCH that used to live here was folded into the commit; this
//     test pins the encoding)
//   - currentDocument preconditions on create (exists: false) and
//     update (exists: true)
//
// Mocking strategy: mock at the `runFirestoreTransaction` boundary
// so the test programs the TxContext directly via per-test response
// maps. This trades wire-protocol coverage (already done in
// firestore-tx.spec) for sharper assertions on the TxResult shape
// that expense-write builds.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

// Phase 3.5: storage mocked so the intent-consumption path (which
// calls getObjectMetadata to verify the Storage upload landed) is
// programmable per-test. downloadUrlFromMetadata stays "real" --
// it's a pure transform on Worker-side, no external state.
vi.mock('../src/storage', () => ({
	getObjectMetadata:      vi.fn(),
	downloadUrlFromMetadata: (bucket: string, path: string, meta?: Record<string, string>) => {
		const token = meta?.firebaseStorageDownloadTokens?.split(',')[0]?.trim()
		if (!token) return null
		return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
	},
}))

// Programmable transaction. Each test seeds `txGet` with a Map of
// `path → TxReadDoc` and an optional `capturedWrites` array; the body
// runs once against this fake context and we assert on what it
// returned. No actual fetch traffic.
const txGetResponses = new Map<string, { exists: boolean; fields: Record<string, unknown>; name: string; updateTime: string | null }>()
const txQueryResponses = new Map<string, { exists: boolean; fields: Record<string, unknown>; name: string; updateTime: string | null }[]>()
const txQueryCalls: Array<{ parent: string; collection: string; filters?: unknown; limit?: number }> = []
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null

interface MockFieldFilter {
	fieldPath: string
	op:        'EQUAL' | 'ARRAY_CONTAINS'
	value:     { stringValue?: string }
}

function readMockStringField(fields: Record<string, unknown>, fieldPath: string): string | undefined {
	return (fields[fieldPath] as { stringValue?: string } | undefined)?.stringValue
}

function readMockStringArrayField(fields: Record<string, unknown>, fieldPath: string): string[] {
	const values = (fields[fieldPath] as { arrayValue?: { values?: Array<{ stringValue?: string }> } } | undefined)
		?.arrayValue?.values ?? []
	return values
		.map(v => v.stringValue)
		.filter((s): s is string => typeof s === 'string')
}

function matchesMockFilters(
	doc: { fields: Record<string, unknown> },
	filters: unknown,
): boolean {
	if (!Array.isArray(filters)) return true
	for (const filter of filters as MockFieldFilter[]) {
		if (filter.op === 'EQUAL') {
			if (readMockStringField(doc.fields, filter.fieldPath) !== filter.value.stringValue) return false
		} else if (filter.op === 'ARRAY_CONTAINS') {
			if (!readMockStringArrayField(doc.fields, filter.fieldPath).includes(filter.value.stringValue ?? '')) return false
		}
	}
	return true
}

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		const ctx = {
			get: async (path: string) => {
				const resp = txGetResponses.get(path)
				if (!resp) throw new Error(`unexpected tx.get('${path}') -- not seeded`)
				return resp
			},
			runQuery: async (q: { parent: string; collection: string; filters?: unknown; limit?: number }) => {
				txQueryCalls.push({ parent: q.parent, collection: q.collection, filters: q.filters, limit: q.limit })
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

// Pass-through: each test's mocks set up the right tx.get fan-out
// for one attempt. The token-retry layer is exercised in cascade tests.
vi.mock('../src/cascade', async () => {
	const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
	return {
		...actual,
		withTokenRetry: <T,>(fn: () => Promise<T>) => fn(),
	}
})

// Phase 3b: FX snapshot is fetched by the Worker on foreign-create and
// foreign-update (when date or money group changes). Mock the resolver
// so tests don't hit Frankfurter / Firestore cache. The fraction-digit
// lookup lives in `@tripmate/fx-core` (not mocked) — it's a pure ISO
// 4217 table the Worker uses for materializer math, mirroring it in a
// mock would just duplicate the same lookup.
vi.mock('../src/fx-rate', async () => {
	const actual = await vi.importActual<typeof import('../src/fx-rate')>('../src/fx-rate')
	return {
		...actual,
		// Fixed rate '150' (USD→JPY in tests). The mock fn signature
		// matches the real getFxSnapshot's input/output -- callers
		// override per-test via vi.mocked(...).mockImplementationOnce().
		getFxSnapshot: vi.fn(async (input: import('../src/fx-rate').GetFxSnapshotInput) => ({
			provider:             'frankfurter-v2' as const,
			baseCurrency:         input.sourceCurrency,
			quoteCurrency:        input.tripCurrency,
			requestedDate:        input.requestedDate,
			rateDate:             input.requestedDate,
			rateDecimal:          '150',
			sourceAmountMinor:    input.sourceAmountMinor,
			// 1000 cents USD * 150 / 100 = 1500 yen (JPY fraction 0).
			convertedAmountMinor: Math.round(input.sourceAmountMinor * 150 / 100),
			fetchedAtMs:          1_700_000_000_000,
		})),
	}
})

import { expenseCreate, expenseUpdate } from '../src/expense-write'
import * as storage from '../src/storage'
import * as fxRate from '../src/fx-rate'
import { ExpenseValidationError } from '../src/expense-validate'
import { CascadeError } from '../src/cascade'

const TRIP_ID    = 'trip-1'
const EXPENSE_ID = 'exp-1'
const CALLER_UID = 'editor-uid'
const BUCKET     = 'tripplanner-80a4f.firebasestorage.app'
const MEMBERS    = ['owner-uid', 'editor-uid', 'viewer-uid']

/** Standard trip doc TxReadDoc -- caller is an editor, no deletingAt.
 *  `currency` defaults to JPY to match validExpensePayload; tests that
 *  exercise the trip-currency bind pass an override (or `null` to
 *  simulate a malformed trip doc with no currency field). */
function tripReadDoc(overrides: { currency?: string | null; ownerId?: string } = {}) {
	const fields: Record<string, unknown> = {
		memberIds: { arrayValue: { values: MEMBERS.map(uid => ({ stringValue: uid })) } },
		ownerId:   { stringValue: overrides.ownerId ?? 'owner-uid' },
	}
	if (overrides.currency !== null) {
		fields.currency = { stringValue: overrides.currency ?? 'JPY' }
	}
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-22T00:00:00Z',
		fields,
	}
}

function memberReadDoc(role: 'owner' | 'editor' | 'viewer') {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${CALLER_UID}`,
		updateTime: '2026-05-22T00:00:00Z',
		fields: { role: { stringValue: role } },
	}
}

function notFoundReadDoc(path: string) {
	return {
		exists: false,
		name:   `projects/demo/databases/(default)/documents/${path}`,
		fields: {},
		updateTime: null,
	}
}

function tombstonedExpenseReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/${EXPENSE_ID}`,
		updateTime: '2026-05-22T00:00:00Z',
		fields: {
			tripId:      { stringValue: TRIP_ID },
			amountMinor: { integerValue: '1000' },
			currency:    { stringValue: 'JPY' },
			paidBy:      { stringValue: 'editor-uid' },
			date:        { stringValue: '2026-05-22' },
			splits:      { arrayValue: { values: [{ mapValue: { fields: {
				memberId:    { stringValue: 'editor-uid' },
				amountMinor: { integerValue: '1000' },
			} } }] } },
			deletedAt: { timestampValue: '2026-05-15T00:00:00Z' },
		},
	}
}

function aliveExpenseReadDoc() {
	return {
		...tombstonedExpenseReadDoc(),
		fields: {
			...tombstonedExpenseReadDoc().fields,
			deletedAt: { nullValue: null },
		},
	}
}

function validExpensePayload(overrides: Record<string, unknown> = {}) {
	return {
		mode:        'TRIP_CURRENCY',
		title:       'Lunch',
		amountMinor: 1000,
		currency:    'JPY',
		category:    'food' as const,
		paidBy:      'editor-uid',
		splits:      [{ memberId: 'editor-uid', amountMinor: 1000 }],
		date:        '2026-05-22',
		adjustments: [],
		...overrides,
	}
}

beforeEach(() => {
	txGetResponses.clear()
	txQueryResponses.clear()
	txQueryCalls.length = 0
	capturedTxResult = null
})

// ─── expenseCreate ─────────────────────────────────────────────────

describe('expenseCreate endpoint', () => {
	it('happy path: writes expense + returns expenseId + currentDocument.exists=false + REQUEST_TIME transforms', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		const result = await expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)

		expect(result.expenseId).toBe(EXPENSE_ID)
		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as {
			document: string
			currentDocument?: { exists?: boolean }
			fields: Record<string, unknown>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}[]
		expect(writes).toHaveLength(1)
		expect(writes[0].currentDocument).toEqual({ exists: false })
		// Encoded field set must match doc schema (spot-check a few).
		expect(writes[0].fields.tripId).toEqual({ stringValue: TRIP_ID })
		expect(writes[0].fields.createdBy).toEqual({ stringValue: CALLER_UID })
		expect(writes[0].fields.deletedAt).toEqual({ nullValue: null })
		expect(writes[0].fields.receiptPurgedAt).toEqual({ nullValue: null })
		// REGRESSION: audit timestamps must be Firestore REQUEST_TIME
		// transforms, NOT CF Workers' Date.now() in the fields map.
		// Using CF clock would drift relative to Firestore server
		// time and break settlement engine's chronological replay
		// (see encodeExpense docstring + buildOrphanReasonMap).
		expect(writes[0].fields.createdAt).toBeUndefined()
		expect(writes[0].fields.updatedAt).toBeUndefined()
		expect(writes[0].updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('rejects create payload without explicit mode', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc({ ownerId: CALLER_UID }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		const { mode: _mode, ...payload } = validExpensePayload()

		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: payload },
			'{}', BUCKET,
		)).rejects.toThrow(/mode is required/)
	})

	it('rejects trip-currency create payload polluted by source fields', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))

		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				expenseId: EXPENSE_ID,
				expense:   validExpensePayload({ sourceCurrency: null }),
			},
			'{}', BUCKET,
		)).rejects.toThrow(/source fields require mode=FOREIGN_CURRENCY/)
	})

	it('rejects when caller is not in trip member roster (authorize)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`),
		)
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(CascadeError)
	})

	it('rejects when trip has deletingAt set (cascade-in-progress)', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, deletingAt: { timestampValue: '2026-05-22T00:00:00Z' } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)).rejects.toThrow(/being deleted/i)
	})

	it('rejects when caller is viewer (role check)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)).rejects.toThrow(/role/i)
	})

	it('rejects when expense already exists at that id (no overwrite)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(CascadeError)
	})

	it('rejects payload that fails cross-field validation (paidBy not in roster)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload({
				paidBy: 'stranger-uid',
				splits: [{ memberId: 'stranger-uid', amountMinor: 1000 }],
			}) },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects payload that fails schema (negative amountMinor)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload({ amountMinor: -100 }) },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	// Trip-currency bind: prevents a raw Worker caller from writing
	// a JPY-trip expense with currency:'USD' (amountMinor would then
	// be encoded under USD-cent semantics, silently corrupting
	// settlement/trip-total math which assume one currency per trip).
	it('rejects when expense.currency does not match trip.currency', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload({ currency: 'USD' }) },
			'{}', BUCKET,
		)).rejects.toThrowError(/expense currency USD does not match trip currency JPY/)
	})

	it('rejects when trip.currency field is missing (data-integrity guard)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc({ currency: null }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))

		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload() },
			'{}', BUCKET,
		)).rejects.toThrow(/trip\.currency is missing/)
	})
})

// ─── expenseUpdate ─────────────────────────────────────────────────

describe('expenseUpdate endpoint', () => {
	it('happy path: writes patch with updateMask + currentDocument.exists=true + REQUEST_TIME transform for updatedAt', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', title: 'Lunch (renamed)' } },
			'{}', BUCKET,
		)

		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as {
			updateMask?: string[]
			currentDocument?: { exists?: boolean }
			fields: Record<string, unknown>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}[]
		expect(writes[0].currentDocument).toEqual({ exists: true })
		expect(writes[0].updateMask).toContain('title')
		expect(writes[0].updateMask).toContain('updatedBy')
		// updatedAt is NOT in updateMask -- it's stamped via REQUEST_TIME transform.
		expect(writes[0].updateMask).not.toContain('updatedAt')
		// receipt only appears in mask when patch.receipt === null.
		expect(writes[0].updateMask).not.toContain('receipt')
		expect(writes[0].fields.title).toEqual({ stringValue: 'Lunch (renamed)' })
		// updatedAt must be present in fields-map-NOT-stamped form
		// elsewhere -- i.e. in updateTransforms, NOT in fields.
		expect(writes[0].fields.updatedAt).toBeUndefined()
		expect(writes[0].updateTransforms).toEqual([
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('REGRESSION: receipt deletion goes via updateMask-without-fields (folded into tx commit)', async () => {
		// Headline fold: receipt=null in the patch means "delete the
		// receipt field". The Worker no longer fires a second PATCH
		// after the tx commit; instead the commit's updateMask lists
		// 'receipt' WITHOUT a corresponding 'fields.receipt' entry, and
		// Firestore REST treats that as field-delete. This test pins
		// the encoding so a future refactor can't accidentally fall
		// back to two-step semantics (which had a race with concurrent
		// receipt-swap writers).
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', receipt: null } },
			'{}', BUCKET,
		)

		const writes = capturedTxResult!.writes as { updateMask?: string[]; fields: Record<string, unknown> }[]
		expect(writes[0].updateMask).toContain('receipt')
		expect(writes[0].fields.receipt).toBeUndefined()
	})

	it('REGRESSION: rejects update on a tombstoned expense (deletedAt present)', async () => {
		// Tombstone freeze: client-side rules already block content
		// writes on soft-deleted expenses, but the Worker bypasses rules
		// via admin SDK -- needs its own gate. Without this an editor
		// could resurrect a soft-deleted expense's content via the
		// Worker even though the rules layer would have rejected the
		// equivalent client write.
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, tombstonedExpenseReadDoc())

		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', title: 'Resurrect' } },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(CascadeError)
	})

	it('rejects editor update when the expense carries a settlement lock', async () => {
		const lockedExpense = aliveExpenseReadDoc()
		lockedExpense.fields = {
			...lockedExpense.fields,
			settlementLockIds: { arrayValue: { values: [{ stringValue: 'settlement-1' }] } },
		}
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, lockedExpense)

		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', amountMinor: 1200, splits: [{ memberId: 'editor-uid', amountMinor: 1200 }] } },
			'{}', BUCKET,
		)).rejects.toThrow(/only the trip owner/i)
		expect(txQueryCalls).toHaveLength(0)
	})

	it('does NOT lock an expense that lacks settlementLockIds even if a settlement names it (single source of truth)', async () => {
		// Post-redesign: the per-expense settlementLockIds set is the SOLE
		// lock source. The old global `appliedExpenseIds ARRAY_CONTAINS`
		// fallback is gone (the set is maintained atomically on create AND
		// delete, so it can't go stale). An expense with no settlementLockIds
		// is editable by an editor regardless of any settlement's lineage —
		// and crucially the Worker runs NO settlements query for the lock.
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', title: 'Editable — not locked' } },
			'{}', BUCKET,
		)
		// No settlements ARRAY_CONTAINS scan for the lock check.
		expect(txQueryCalls.some(q => q.collection === 'settlements')).toBe(false)
	})

	it('allows owner update on a settled expense', async () => {
		const lockedExpense = aliveExpenseReadDoc()
		lockedExpense.fields = {
			...lockedExpense.fields,
			settlementLockIds: { arrayValue: { values: [{ stringValue: 'settlement-1' }] } },
		}
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc({ ownerId: CALLER_UID }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('owner'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, lockedExpense)

		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', title: 'Owner correction' } },
			'{}', BUCKET,
		)

		expect(capturedTxResult).not.toBeNull()
		expect(txQueryCalls).toHaveLength(0)
	})

	it('REGRESSION: patch with non-updatable field is rejected via ExpenseValidationError', async () => {
		// tripId / createdBy / createdAt / memberIds / deletedAt /
		// receiptPurgedAt are all owned by other layers (rules /
		// cron). Phase 3b moved the UPDATABLE_FIELDS check inside the
		// tx body (it lives in `buildTripUpdateWrite`, which is only
		// reachable after the in-tx foreign-vs-trip branch decision
		// reads the current doc). The semantic contract — random keys
		// are rejected with ExpenseValidationError — is unchanged; the
		// "before tx begins" timing pin from pre-3b is dropped.
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', tripId: 'OTHER-TRIP' } as Record<string, unknown>,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects update where post-merge fails cross-field (paidBy no longer in roster)', async () => {
		// Patch is locally legal (paidBy is an UPDATABLE_FIELDS member),
		// but post-merge cross-field check sees a stranger uid.
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', paidBy: 'stranger-uid', splits: [{ memberId: 'stranger-uid', amountMinor: 1000 }] },
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects update when caller is viewer (role check at authorize)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())
		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', title: 'Edit' } },
			'{}', BUCKET,
		)).rejects.toThrow(/role/i)
	})

	// Trip-currency bind on update: same invariant as create, but
	// applied to the post-merge value so it catches BOTH a raw
	// patch.currency divergence AND a pre-existing doc whose currency
	// somehow drifted from the trip (data-integrity guard for older
	// writes that pre-date the create-side gate).
	it('rejects update when patch.currency does not match trip.currency', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', currency: 'USD' } },
			'{}', BUCKET,
		)).rejects.toThrowError(/expense currency USD does not match trip currency JPY/)
	})
})

// ─── Phase 3.5: expense-write consumes intentIds ──────────────────

describe('expenseCreate with intentIds (Phase 3.5)', () => {
	const FULL_INTENT_ID  = 'i-full'
	const THUMB_INTENT_ID = 'i-thumb'
	const FULL_PATH       = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/abc123.webp`
	const THUMB_PATH      = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/abc123.thumb.webp`

	function intentDoc(opts: {
		intentId:    string
		uid?:        string
		kind:        'full' | 'thumb' | 'pdf'
		path:        string
		entityType?: 'expense' | 'booking' | 'wish'
		entityId?:   string
		status?:     'pending' | 'used'
		expiresAtMs?: number
		contentType?: string
		maxBytes?:   number
	}) {
		const uid         = opts.uid         ?? CALLER_UID
		const status      = opts.status      ?? 'pending'
		const entityId    = opts.entityId    ?? EXPENSE_ID
		const entityType  = opts.entityType  ?? 'expense'
		const expiresAt   = new Date(opts.expiresAtMs ?? Date.now() + 30 * 60_000).toISOString()
		const contentType = opts.contentType ?? 'image/webp'
		const maxBytes    = opts.maxBytes    ?? 5 * 1024 * 1024
		return {
			exists: true,
			// Phase-3.5-bis: intents live under trips/{tripId}/uploadIntents/{id}.
			name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/${opts.intentId}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields: {
				uid:        { stringValue: uid },
				tripId:     { stringValue: TRIP_ID },
				entityType: { stringValue: entityType },
				entityId:   { stringValue: entityId },
				kind:       { stringValue: opts.kind },
				path:       { stringValue: opts.path },
				status:     { stringValue: status },
				expiresAt:  { timestampValue: expiresAt },
				allowedContentTypes: {
					arrayValue: { values: [{ stringValue: contentType }] },
				},
				maxBytes:   { integerValue: String(maxBytes) },
				customMetadata: {
					mapValue: {
						fields: {
							uploadIntentId: { stringValue: opts.intentId },
							uploaderUid:    { stringValue: uid },
							tripId:         { stringValue: TRIP_ID },
							entityType:     { stringValue: entityType },
							entityId:       { stringValue: entityId },
							kind:           { stringValue: opts.kind },
							schemaVersion:  { stringValue: 'v1' },
						},
					},
				},
			},
		}
	}

	function storageMeta(opts: {
		path:        string
		intentId:    string
		kind:        'full' | 'thumb' | 'pdf'
		contentType?: string
		token?:      string
		size?:       number
		tamper?:     Partial<Record<
			'uploadIntentId' | 'uploaderUid' | 'tripId' | 'entityType' | 'entityId' | 'kind' | 'schemaVersion',
			string | undefined
		>>
		omitCustomMetadata?: boolean
	}) {
		const baseCustomMetadata: Record<string, string> = {
			uploadIntentId: opts.intentId,
			uploaderUid:    CALLER_UID,
			tripId:         TRIP_ID,
			entityType:     'expense',
			entityId:       EXPENSE_ID,
			kind:           opts.kind,
			schemaVersion:  'v1',
		}
		if (opts.tamper) {
			for (const [k, v] of Object.entries(opts.tamper)) {
				if (v === undefined) delete baseCustomMetadata[k]
				else                 baseCustomMetadata[k] = v
			}
		}
		if (opts.token) baseCustomMetadata.firebaseStorageDownloadTokens = opts.token
		return {
			name:        opts.path,
			size:        opts.size ?? 50_000,
			contentType: opts.contentType ?? 'image/webp',
			timeCreated: '2026-05-23T00:00:00Z',
			customMetadata: opts.omitCustomMetadata ? undefined : baseCustomMetadata,
		}
	}

	function seedAuth() {
		txGetResponses.set(`trips/${TRIP_ID}`,                          tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,    memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`,   notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))
	}

	it('full intent only → receipt built server-side, intent marked used in same tx', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		const result = await expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)
		expect(result.expenseId).toBe(EXPENSE_ID)

		const writes = capturedTxResult!.writes as Array<{
			document: string
			fields:   Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		// 1 intent markUsed + 1 expense write, in that order
		expect(writes).toHaveLength(2)
		expect(writes[0].document).toContain(`/trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		// Expense receipt field built from intent path + bucket-derived URL
		const receipt = writes[1].fields.receipt?.mapValue?.fields
		expect(receipt?.path?.stringValue).toBe(FULL_PATH)
		expect(receipt?.type?.stringValue).toBe('image/webp')
		expect(receipt?.url?.stringValue).toContain('token=tk')
		// No thumb fields (single full intent)
		expect(receipt?.thumbPath).toBeUndefined()
		expect(receipt?.thumbUrl).toBeUndefined()
	})

	it('full + thumb intents → both marked used + receipt has thumb fields', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full',  path: FULL_PATH }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: FULL_PATH,  intentId: FULL_INTENT_ID,  kind: 'full',  token: 'tk-f' }))
			.mockResolvedValueOnce(storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk-t' }))

		await expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID, THUMB_INTENT_ID],
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			document: string
			fields:   Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		// 2 intent markUsed + 1 expense write
		expect(writes).toHaveLength(3)
		const receipt = writes[2].fields.receipt?.mapValue?.fields
		expect(receipt?.path?.stringValue).toBe(FULL_PATH)
		expect(receipt?.thumbPath?.stringValue).toBe(THUMB_PATH)
		expect(receipt?.url?.stringValue).toContain('token=tk-f')
		expect(receipt?.thumbUrl?.stringValue).toContain('token=tk-t')
	})

	it('rejects client-supplied expense.receipt (legacy direct path closed)', async () => {
		// Phase 3.5 legacy cleanup: client may NEVER supply expense.receipt
		// directly, regardless of whether intentIds is also present.
		// Pinning this with two variants (with intentIds + without) so a
		// future weakening of the gate that re-introduces the "only check
		// when intentIds present" branch fails both assertions.
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		// Variant 1: receipt + intentIds (would have been the old
		// "mutually exclusive" branch).
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload({
					receipt: { url: 'https://x', path: 'p', type: 'image/webp' },
				}),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
		// Variant 2: receipt alone, no intentIds (the legacy "happy
		// path" Phase 3.5 closes). Auth seed already in place.
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload({
					receipt: { url: 'https://x', path: 'p', type: 'image/webp' },
				}),
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects intent owned by another uid → 403', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, uid: 'someone-else', kind: 'full', path: FULL_PATH }))
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('rejects intent already used (replay protection)', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH, status: 'used' }))
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })
	})

	it('rejects intent whose entityType is not expense → 400', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID, kind: 'full',
				entityType: 'booking',  // wrong type for /expense-create
				path: FULL_PATH,
			}))
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/entityType/) })
	})

	it('rejects intent.entityId !== request.expenseId', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID, kind: 'full',
				entityId: 'wrong-expense-id',
				path:     `trips/${TRIP_ID}/expenses/wrong-expense-id/x.webp`,
			}))
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/entityId/) })
	})

	it('rejects storage object missing at intent.path → 404', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(null)
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/storage/) })
	})

	it('rejects when intentIds only has thumb (missing primary blob)', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk' }),
		)
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validExpensePayload(),
				intentIds: [THUMB_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})
})

describe('expenseUpdate with intentIds (Phase 3.5)', () => {
	const NEW_FULL_INTENT_ID = 'i-new-full'
	const NEW_FULL_PATH      = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/replaced.webp`

	function intentDoc(intentId: string, kind: 'full' | 'thumb' | 'pdf', path: string) {
		return {
			exists: true,
			// Phase-3.5-bis: intents live under trips/{tripId}/uploadIntents/{id}.
			name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/${intentId}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields: {
				uid:        { stringValue: CALLER_UID },
				tripId:     { stringValue: TRIP_ID },
				entityType: { stringValue: 'expense' },
				entityId:   { stringValue: EXPENSE_ID },
				kind:       { stringValue: kind },
				path:       { stringValue: path },
				status:     { stringValue: 'pending' },
				expiresAt:  { timestampValue: new Date(Date.now() + 30 * 60_000).toISOString() },
				allowedContentTypes: {
					arrayValue: { values: [{ stringValue: 'image/webp' }] },
				},
				maxBytes:   { integerValue: String(5 * 1024 * 1024) },
				customMetadata: {
					mapValue: {
						fields: {
							uploadIntentId: { stringValue: intentId },
							uploaderUid:    { stringValue: CALLER_UID },
							tripId:         { stringValue: TRIP_ID },
							entityType:     { stringValue: 'expense' },
							entityId:       { stringValue: EXPENSE_ID },
							kind:           { stringValue: kind },
							schemaVersion:  { stringValue: 'v1' },
						},
					},
				},
			},
		}
	}

	function storageMeta(opts: { path: string; intentId: string; kind: 'full' | 'thumb' | 'pdf' }) {
		return {
			name:        opts.path,
			size:        50_000,
			contentType: 'image/webp',
			timeCreated: '2026-05-23T00:00:00Z',
			customMetadata: {
				uploadIntentId:                opts.intentId,
				uploaderUid:                   CALLER_UID,
				tripId:                        TRIP_ID,
				entityType:                    'expense',
				entityId:                      EXPENSE_ID,
				kind:                          opts.kind,
				schemaVersion:                 'v1',
				firebaseStorageDownloadTokens: 'tk',
			},
		}
	}

	function seedAuthAlive() {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())
	}

	it('intentIds replaces receipt → markUsed write + patch.receipt encoded in same tx', async () => {
		seedAuthAlive()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${NEW_FULL_INTENT_ID}`,
			intentDoc(NEW_FULL_INTENT_ID, 'full', NEW_FULL_PATH))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: NEW_FULL_INTENT_ID, kind: 'full' }),
		)

		await expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', title: 'Edited title' },
				intentIds: [NEW_FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			document: string
			fields:   Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		expect(writes).toHaveLength(2)
		expect(writes[0].document).toContain(`/trips/${TRIP_ID}/uploadIntents/${NEW_FULL_INTENT_ID}`)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		const receipt = writes[1].fields.receipt?.mapValue?.fields
		expect(receipt?.path?.stringValue).toBe(NEW_FULL_PATH)
	})

	it('rejects client-supplied patch.receipt object (legacy direct path closed)', async () => {
		// Phase 3.5 legacy cleanup: patch.receipt may NEVER be a non-null
		// object. Two variants pin both removed paths (with-intentIds
		// + without-intentIds) -- a single-branch gate that only
		// fired when intentIds were also present would let the
		// "no intentIds, just object receipt" variant slip through.
		// Variant 1: receipt object + intentIds (was the old mutex case).
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', receipt: { url: 'https://x', path: 'p', type: 'image/webp' } },
				intentIds: [NEW_FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
		// Variant 2: receipt object alone, no intentIds (legacy direct
		// update path Phase 3.5 closes).
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', receipt: { url: 'https://x', path: 'p', type: 'image/webp' } },
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects intentIds + patch.receipt=null in same request (contradictory ops)', async () => {
		// patch.receipt=null is the deletion sentinel; intentIds means
		// "set new receipt". These are contradictory and the gate still
		// rejects the combo. Distinct from the legacy "any non-null
		// receipt rejected" branch because null is still a legitimate
		// patch value when it's the ONLY receipt-related field.
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', receipt: null },
				intentIds: [NEW_FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})
})

// ─── Phase 3b foreign-currency endpoints ──────────────────────────
//
// Phase 3b flips the foreign path from "rejected via guard" (3a) to
// "fully supported with Worker-authoritative source-domain
// persistence + FX snapshot". These tests pin:
//
//   - Foreign-CREATE: source-domain payload accepted, Worker fetches
//     FxSnapshot via mocked getFxSnapshot, materializer derives
//     trip-currency canonical fields, sourceCurrency/Amount/Items/
//     Adjustments + fxSnapshot all land on the doc atomically;
//     fxSnapshot.fetchedAt is server-stamped via REQUEST_TIME.
//   - Explicit update mode switching:
//     `patch.mode` is required. TRIP_CURRENCY rejects source/fx keys
//     and deletes the source mirror when applied to a foreign doc;
//     FOREIGN_CURRENCY requires a source money group when applied to a
//     trip-currency doc.
//   - Foreign-UPDATE: three sub-modes — text-only (no FX touched),
//     date-only (FX re-fetched, full source mirror rewritten with
//     unchanged values for consistency), money-group (full source
//     replaced + FX re-fetched). Same-currency mode-switch via
//     sourceCurrency=trip rejected.
//
// Same-currency reject lives on BOTH the create path (prepareForeign-
// Create same-currency check) and the update path (buildForeign-
// UpdateWrite effectiveSourceCurrency check) so a foreign expense
// can never carry a degenerate fxSnapshot with no real conversion.

// Trip currency is JPY (0 fraction digits) per tripReadDoc default;
// foreign payloads use USD (2 fraction digits) so the materializer's
// fraction-digit-diff math is exercised.
function validForeignExpensePayload(overrides: Record<string, unknown> = {}) {
	return {
		mode:              'FOREIGN_CURRENCY',
		title:             'Coffee',
		sourceCurrency:    'USD',
		sourceAmountMinor: 1000,
		category:          'food' as const,
		paidBy:            'editor-uid',
		date:              '2026-05-22',
		sourceItems: [
			{
				id:                'item-1',
				name:              'Latte',
				sourceAmountMinor: 1000,
				assignees:         ['editor-uid'],
			},
		],
		sourceAdjustments: [],
		...overrides,
	}
}

/** Pre-existing foreign-currency expense doc. Trip-currency canonical
 *  fields (amountMinor=1500 = $10 * rate 150 / 100) match what the
 *  Worker would have written at create time. Used by foreign-update
 *  tests so the in-tx `tx.get(expenses/...)` returns a foreign doc and
 *  routing goes through buildForeignUpdateWrite. */
function foreignExpenseReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/expenses/${EXPENSE_ID}`,
		updateTime: '2026-05-22T00:00:00Z',
		fields: {
			tripId:      { stringValue: TRIP_ID },
			title:       { stringValue: 'Coffee' },
			amountMinor: { integerValue: '1500' },
			currency:    { stringValue: 'JPY' },
			category:    { stringValue: 'food' },
			paidBy:      { stringValue: 'editor-uid' },
			date:        { stringValue: '2026-05-22' },
			deletedAt:   { nullValue: null },
			splits: { arrayValue: { values: [
				{ mapValue: { fields: {
					memberId:    { stringValue:  'editor-uid' },
					amountMinor: { integerValue: '1500' },
				} } },
			] } },
			items: { arrayValue: { values: [
				{ mapValue: { fields: {
					id:          { stringValue:  'item-1' },
					name:        { stringValue:  'Latte' },
					amountMinor: { integerValue: '1500' },
					assignees:   { arrayValue: { values: [{ stringValue: 'editor-uid' }] } },
				} } },
			] } },
			adjustments: { arrayValue: { values: [] } },
			// Source-domain mirror
			sourceCurrency:    { stringValue:  'USD' },
			sourceAmountMinor: { integerValue: '1000' },
			sourceItems: { arrayValue: { values: [
				{ mapValue: { fields: {
					id:                { stringValue:  'item-1' },
					name:              { stringValue:  'Latte' },
					sourceAmountMinor: { integerValue: '1000' },
					assignees:         { arrayValue: { values: [{ stringValue: 'editor-uid' }] } },
				} } },
			] } },
			sourceAdjustments: { arrayValue: { values: [] } },
			fxSnapshot: { mapValue: { fields: {
				provider:             { stringValue:  'frankfurter-v2' },
				baseCurrency:         { stringValue:  'USD' },
				quoteCurrency:        { stringValue:  'JPY' },
				requestedDate:        { stringValue:  '2026-05-22' },
				rateDate:             { stringValue:  '2026-05-22' },
				rateDecimal:          { stringValue:  '150' },
				sourceAmountMinor:    { integerValue: '1000' },
				convertedAmountMinor: { integerValue: '1500' },
				fetchedAt:            { timestampValue: '2026-05-22T00:00:00Z' },
			} } },
		},
	}
}

describe('Phase 3b foreign-create endpoint', () => {
	beforeEach(() => {
		vi.mocked(fxRate.getFxSnapshot).mockClear()
	})

	it('happy path: persists sourceCurrency / sourceAmountMinor / sourceItems / sourceAdjustments / fxSnapshot + REQUEST_TIME transform for fxSnapshot.fetchedAt', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		const result = await expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validForeignExpensePayload() },
			'{}', BUCKET,
		)
		expect(result.expenseId).toBe(EXPENSE_ID)
		// FX resolver was called with the trip + source pair from the body.
		expect(vi.mocked(fxRate.getFxSnapshot)).toHaveBeenCalledTimes(1)
		const fxCall = vi.mocked(fxRate.getFxSnapshot).mock.calls[0][0]
		expect(fxCall).toMatchObject({
			requestedDate:     '2026-05-22',
			sourceCurrency:    'USD',
			tripCurrency:      'JPY',
			sourceAmountMinor: 1000,
		})

		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, {
				stringValue?:  string
				integerValue?: string
				mapValue?:     { fields: Record<string, { stringValue?: string; integerValue?: string; nullValue?: null; timestampValue?: string }> }
				arrayValue?:   { values?: unknown[] }
			}>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		expect(writes).toHaveLength(1)
		// Source-domain mirror present
		expect(writes[0].fields.sourceCurrency?.stringValue).toBe('USD')
		expect(writes[0].fields.sourceAmountMinor?.integerValue).toBe('1000')
		expect(writes[0].fields.sourceItems?.arrayValue?.values).toHaveLength(1)
		expect(writes[0].fields.sourceAdjustments?.arrayValue?.values).toHaveLength(0)
		// Trip-currency canonical derived by materializer
		expect(writes[0].fields.amountMinor?.integerValue).toBe('1500')
		expect(writes[0].fields.currency?.stringValue).toBe('JPY')
		// FxSnapshot persisted; fetchedAt placeholder is null and the
		// server transform pins commit time.
		const fx = writes[0].fields.fxSnapshot?.mapValue?.fields
		expect(fx?.provider?.stringValue).toBe('frankfurter-v2')
		expect(fx?.rateDecimal?.stringValue).toBe('150')
		expect(fx?.fetchedAt?.nullValue).toBeNull()
		expect(writes[0].updateTransforms).toEqual(expect.arrayContaining([
			{ fieldPath: 'createdAt',           setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'updatedAt',           setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' },
		]))
	})

	it('manual-total foreign create persists sourceSplits without visible items', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		await expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validForeignExpensePayload({
					sourceItems:       undefined,
					sourceAdjustments: undefined,
					sourceSplits:      [{ memberId: 'editor-uid', sourceAmountMinor: 1000 }],
				}),
			},
			'{}', BUCKET,
		)

		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, {
				stringValue?: string
				integerValue?: string
				arrayValue?: { values?: unknown[] }
			}>
		}>
		expect(writes).toHaveLength(1)
		expect(writes[0].fields.amountMinor?.integerValue).toBe('1500')
		expect(writes[0].fields.currency?.stringValue).toBe('JPY')
		expect(writes[0].fields.items?.arrayValue?.values ?? []).toHaveLength(0)
		expect(writes[0].fields.adjustments?.arrayValue?.values ?? []).toHaveLength(0)
		expect(writes[0].fields.sourceSplits?.arrayValue?.values).toHaveLength(1)
		expect(writes[0].fields).not.toHaveProperty('sourceItems')
		expect(writes[0].fields).not.toHaveProperty('sourceAdjustments')
	})

	it('rejects sourceCurrency === trip currency (degenerate foreign path)', async () => {
		// Same-currency means "no FX needed"; the foreign create would
		// produce a degenerate FxSnapshot with provider=null. Force
		// the caller to use the trip-currency expense path instead.
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validForeignExpensePayload({ sourceCurrency: 'JPY' }) },
			'{}', BUCKET,
		)).rejects.toThrowError(/equals trip currency/)
		// FX resolver should NOT have been called -- same-currency reject
		// fires before getFxSnapshot.
		expect(vi.mocked(fxRate.getFxSnapshot)).not.toHaveBeenCalled()
	})

	it('rejects foreign payload that smuggles trip-currency money keys (.strict() on foreign schema)', async () => {
		// makeForeignExpenseCreateSchema is .strict() — any top-level key
		// outside the foreign contract is a loud rejection. Critical so a
		// buggy client that adds `currency: 'JPY'` (or `amountMinor`,
		// `splits`, `fxSnapshot`) to a foreign body can't silently land a
		// half-merged write where the client lied about the conversion.
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`))

		// `currency` is a trip-currency-only key; strict() should reject.
		await expect(expenseCreate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				expense: validForeignExpensePayload({ currency: 'JPY' }),
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})
})

describe('Phase 3c explicit update mode switching', () => {
	beforeEach(() => {
		vi.mocked(fxRate.getFxSnapshot).mockClear()
	})

	it('rejects update payload without explicit mode', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { title: 'No mode' } },
			'{}', BUCKET,
		)).rejects.toThrowError(/mode is required/)
	})

	// Trip-currency mode cannot carry source-money fields. This is not
	// a legacy-compat guard: it is the explicit DTO contract that keeps
	// cancelled foreign UI state from producing a half-foreign patch.
	const SOURCE_MONEY_KEYS = [
		'sourceCurrency',
		'sourceAmountMinor',
		'sourceItems',
		'sourceAdjustments',
		'sourceSplits',
	] as const

	for (const key of SOURCE_MONEY_KEYS) {
		it(`rejects patch.${key} in TRIP_CURRENCY mode → source fields require FOREIGN_CURRENCY`, async () => {
			txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
			txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
			txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

			const patch: Record<string, unknown> = { mode: 'TRIP_CURRENCY', [key]: 'USD' }
			if (key === 'sourceAmountMinor') patch[key] = 100
			if (key === 'sourceItems')        patch[key] = []
			if (key === 'sourceAdjustments')  patch[key] = []
			if (key === 'sourceSplits')       patch[key] = []

			await expect(expenseUpdate(
				CALLER_UID,
				{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch },
				'{}', BUCKET,
			)).rejects.toThrowError(/source fields require mode=FOREIGN_CURRENCY/)
		})
	}

	const FOREIGN_METADATA_KEYS = [
		'sourceFractionDigits',
		'fxSnapshot',
	] as const

	for (const key of FOREIGN_METADATA_KEYS) {
		it(`rejects patch.${key} in TRIP_CURRENCY mode → UNSUPPORTED_FOREIGN_FIELD`, async () => {
			txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
			txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
			txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

			const patch: Record<string, unknown> = { mode: 'TRIP_CURRENCY' }
			patch[key] = key === 'sourceFractionDigits'
				? 2
				: { provider: 'frankfurter-v2' }

			await expect(expenseUpdate(
				CALLER_UID,
				{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch },
				'{}', BUCKET,
			)).rejects.toThrowError(/UNSUPPORTED_FOREIGN_FIELD/)
		})
	}

	it('error path uses patch.<field> scoping', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		try {
			await expenseUpdate(
				CALLER_UID,
				{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'TRIP_CURRENCY', fxSnapshot: { provider: 'frankfurter-v2' } } },
				'{}', BUCKET,
			)
			throw new Error('expected guard to reject')
		} catch (err) {
			expect(err).toBeInstanceOf(ExpenseValidationError)
			expect((err as ExpenseValidationError).field).toBe('patch.fxSnapshot')
		}
	})

	it('switches trip-currency doc to foreign when a full source money group is present', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: {
					mode:              'FOREIGN_CURRENCY',
					title:             'USD Coffee',
					sourceCurrency:    'USD',
					sourceAmountMinor: 1000,
					sourceItems: [
						{
							id:                'item-1',
							name:              'Latte',
							sourceAmountMinor: 1000,
							assignees:         ['editor-uid'],
						},
					],
					sourceAdjustments: [],
				},
			},
			'{}', BUCKET,
		)

		expect(vi.mocked(fxRate.getFxSnapshot)).toHaveBeenCalledTimes(1)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, { stringValue?: string; integerValue?: string; mapValue?: { fields: Record<string, unknown> } }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		expect(writes[0].fields.title?.stringValue).toBe('USD Coffee')
		expect(writes[0].fields.sourceCurrency?.stringValue).toBe('USD')
		expect(writes[0].fields.sourceAmountMinor?.integerValue).toBe('1000')
		expect(writes[0].fields.amountMinor?.integerValue).toBe('1500')
		expect(writes[0].updateMask).toEqual(expect.arrayContaining([
			'title',
			'amountMinor',
			'currency',
			'splits',
			'items',
			'adjustments',
			'sourceCurrency',
			'sourceAmountMinor',
			'sourceItems',
			'sourceAdjustments',
			'fxSnapshot',
		]))
		expect(writes[0].updateTransforms).toEqual(expect.arrayContaining([
			{ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' },
		]))
	})

	it('rejects trip-currency doc foreign mode without a full source money group', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, aliveExpenseReadDoc())

		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'FOREIGN_CURRENCY', title: 'Still no source' },
			},
			'{}', BUCKET,
		)).rejects.toThrowError(/requires sourceCurrency/)
	})

	it('switches foreign doc back to trip-currency by deleting source mirror + fxSnapshot', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, foreignExpenseReadDoc())

		await expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'TRIP_CURRENCY', title: 'JPY Coffee' },
			},
			'{}', BUCKET,
		)

		expect(vi.mocked(fxRate.getFxSnapshot)).not.toHaveBeenCalled()
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, unknown>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		expect(writes[0].fields).not.toHaveProperty('sourceCurrency')
		expect(writes[0].fields).not.toHaveProperty('sourceAmountMinor')
		expect(writes[0].fields).not.toHaveProperty('sourceItems')
		expect(writes[0].fields).not.toHaveProperty('sourceAdjustments')
		expect(writes[0].fields).not.toHaveProperty('fxSnapshot')
		expect(writes[0].updateMask).toEqual(expect.arrayContaining([
			'title',
			'updatedBy',
			'sourceCurrency',
			'sourceAmountMinor',
			'sourceItems',
			'sourceAdjustments',
			'fxSnapshot',
		]))
		expect(writes[0].updateTransforms).toEqual([
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})
})

describe('Phase 3b foreign-update endpoint', () => {
	beforeEach(() => {
		vi.mocked(fxRate.getFxSnapshot).mockClear()
	})

	function seedForeignAlive() {
		txGetResponses.set(`trips/${TRIP_ID}`,                        tripReadDoc({ currency: 'JPY' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,  memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/expenses/${EXPENSE_ID}`, foreignExpenseReadDoc())
	}

		it('text-only patch on foreign doc → no FX fetch, no recompute, no source mirror in mask', async () => {
			seedForeignAlive()
		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'FOREIGN_CURRENCY', title: 'Renamed Coffee' } },
			'{}', BUCKET,
		)
		// FX resolver MUST stay untouched on text-only -- a foreign-update
		// that re-fetched FX on every rename would (a) waste Frankfurter
		// quota and (b) overwrite a historical rate with a possibly-
		// different cache hit on a backdated edit.
		expect(vi.mocked(fxRate.getFxSnapshot)).not.toHaveBeenCalled()

		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, { stringValue?: string }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		expect(writes).toHaveLength(1)
		// Text fields + updatedBy only -- source mirror NOT in the mask.
		expect(writes[0].updateMask).toContain('title')
		expect(writes[0].updateMask).toContain('updatedBy')
		expect(writes[0].updateMask).not.toContain('amountMinor')
		expect(writes[0].updateMask).not.toContain('sourceCurrency')
		expect(writes[0].updateMask).not.toContain('sourceAmountMinor')
		expect(writes[0].updateMask).not.toContain('sourceItems')
		expect(writes[0].updateMask).not.toContain('sourceAdjustments')
		expect(writes[0].updateMask).not.toContain('fxSnapshot')
		// fxSnapshot.fetchedAt transform NOT applied (snapshot wasn't
		// rewritten). updatedAt always is.
			expect(writes[0].updateTransforms).toEqual([
				{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
			])
		})

		it('rejects text-only paidBy patch on foreign doc when payer is not a trip member', async () => {
			seedForeignAlive()
			await expect(expenseUpdate(
				CALLER_UID,
				{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'FOREIGN_CURRENCY', paidBy: 'stranger-uid' } },
				'{}', BUCKET,
			)).rejects.toBeInstanceOf(ExpenseValidationError)
			expect(vi.mocked(fxRate.getFxSnapshot)).not.toHaveBeenCalled()
		})

		it('date-only patch on foreign doc → FX re-fetched, full source mirror + fxSnapshot rewritten', async () => {
			// Date change on a foreign doc means the FX rate snapshot is no
			// longer authoritative -- the Worker re-resolves for the new
		// date using the persisted sourceItems/Adjustments. The source
		// mirror is rewritten with the SAME values (date didn't change
		// source-domain amounts), but the rewrite is still in the
		// updateMask so the doc's source-fields/trip-fields stay byte-
		// consistent post-write (any partial rewrite would risk a
		// 5-tuple superRefine violation on a future read).
		seedForeignAlive()
		await expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'FOREIGN_CURRENCY', date: '2026-05-23' } },
			'{}', BUCKET,
		)
		expect(vi.mocked(fxRate.getFxSnapshot)).toHaveBeenCalledTimes(1)
		// Re-resolved with the NEW date but the PERSISTED sourceAmountMinor
		// (date-only mode doesn't change the source-domain amount).
		const fxCall = vi.mocked(fxRate.getFxSnapshot).mock.calls[0][0]
		expect(fxCall.requestedDate).toBe('2026-05-23')
		expect(fxCall.sourceCurrency).toBe('USD')
		expect(fxCall.tripCurrency).toBe('JPY')
		expect(fxCall.sourceAmountMinor).toBe(1000)

		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, {
				stringValue?:  string
				integerValue?: string
				mapValue?:     { fields: Record<string, { stringValue?: string; nullValue?: null }> }
				arrayValue?:   { values?: unknown[] }
			}>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		expect(writes[0].updateMask).toContain('date')
		expect(writes[0].updateMask).toContain('amountMinor')
		expect(writes[0].updateMask).toContain('splits')
		expect(writes[0].updateMask).toContain('items')
		expect(writes[0].updateMask).toContain('adjustments')
		expect(writes[0].updateMask).toContain('sourceCurrency')
		expect(writes[0].updateMask).toContain('sourceAmountMinor')
		expect(writes[0].updateMask).toContain('sourceItems')
		expect(writes[0].updateMask).toContain('sourceAdjustments')
		expect(writes[0].updateMask).toContain('fxSnapshot')
		// fxSnapshot encoded with fetchedAt=null + REQUEST_TIME transform.
		const fx = writes[0].fields.fxSnapshot?.mapValue?.fields
		expect(fx?.requestedDate?.stringValue).toBe('2026-05-23')
		expect(fx?.fetchedAt?.nullValue).toBeNull()
		expect(writes[0].updateTransforms).toEqual(expect.arrayContaining([
			{ fieldPath: 'updatedAt',           setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' },
		]))
	})

	it('money-group patch on foreign doc → FX re-fetched with new source amount + full mirror rewritten', async () => {
		seedForeignAlive()
		// Swap to a larger lunch item.
		await expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: {
					mode:              'FOREIGN_CURRENCY',
					sourceCurrency:    'USD',
					sourceAmountMinor: 2000,
					sourceItems: [
						{
							id:                'item-1',
							name:              'Big Lunch',
							sourceAmountMinor: 2000,
							assignees:         ['editor-uid'],
						},
					],
					sourceAdjustments: [],
				},
			},
			'{}', BUCKET,
		)
		// FX call sees the new sourceAmountMinor + original date.
		expect(vi.mocked(fxRate.getFxSnapshot)).toHaveBeenCalledTimes(1)
		const fxCall = vi.mocked(fxRate.getFxSnapshot).mock.calls[0][0]
		expect(fxCall.sourceAmountMinor).toBe(2000)
		expect(fxCall.requestedDate).toBe('2026-05-22')   // unchanged (no date patch)

		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, {
				stringValue?:  string
				integerValue?: string
				mapValue?:     { fields: Record<string, unknown> }
				arrayValue?:   { values?: unknown[] }
			}>
		}>
		expect(writes[0].fields.sourceAmountMinor?.integerValue).toBe('2000')
		// 2000 cents USD * 150 / 100 = 3000 yen (JPY 0 frac).
		expect(writes[0].fields.amountMinor?.integerValue).toBe('3000')
	})

	it('rejects money-group patch with sourceCurrency === trip currency (use TRIP_CURRENCY mode)', async () => {
		// Mirror of the foreign-CREATE same-currency reject, this time
		// inside buildForeignUpdateWrite. Forces delete-recreate
		// semantics for any currency switch -- a foreign expense
		// can't morph into a trip-currency one mid-doc.
		seedForeignAlive()
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: {
					mode:              'FOREIGN_CURRENCY',
					sourceCurrency:    'JPY',
					sourceAmountMinor: 1500,
					sourceItems: [
						{
							id:                'item-1',
							name:              'Latte',
							sourceAmountMinor: 1500,
							assignees:         ['editor-uid'],
						},
					],
					sourceAdjustments: [],
				},
			},
			'{}', BUCKET,
		)).rejects.toThrowError(/use TRIP_CURRENCY mode/)
		// Same-currency reject fires BEFORE FX fetch.
		expect(vi.mocked(fxRate.getFxSnapshot)).not.toHaveBeenCalled()
	})

	it('rejects partial source-money patch (all-or-none group invariant)', async () => {
		// makeForeignExpenseUpdateSchema superRefine: the source-money
		// 4-tuple must be present together or not at all. A partial
		// patch (e.g. sourceAmountMinor alone) can't be soundly
		// reconciled against the current doc's per-line breakdown.
		seedForeignAlive()
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { mode: 'FOREIGN_CURRENCY', sourceAmountMinor: 2000 },   // missing the other three
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects foreign-update patch that smuggles trip-currency money keys (.strict() on foreign-update schema)', async () => {
		// Foreign-update schema is built from makeForeignExpenseCreateSchema()
		// .partial() which preserves .strict() — a patch carrying
		// `currency` / `amountMinor` / `splits` / `items` / `adjustments`
		// against a foreign doc is rejected at parse time.
		seedForeignAlive()
		await expect(expenseUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { mode: 'FOREIGN_CURRENCY', currency: 'EUR' } },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})
})
