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

// Programmable transaction. Each test seeds `txGet` with a Map of
// `path → TxReadDoc` and an optional `capturedWrites` array; the body
// runs once against this fake context and we assert on what it
// returned. No actual fetch traffic.
const txGetResponses = new Map<string, { exists: boolean; fields: Record<string, unknown>; name: string; updateTime: string | null }>()
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		const ctx = {
			get: async (path: string) => {
				const resp = txGetResponses.get(path)
				if (!resp) throw new Error(`unexpected tx.get('${path}') -- not seeded`)
				return resp
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

import { expenseCreate, expenseUpdate } from '../src/expense-write'
import { ExpenseValidationError } from '../src/expense-validate'
import { CascadeError } from '../src/cascade'

const TRIP_ID    = 'trip-1'
const EXPENSE_ID = 'exp-1'
const CALLER_UID = 'editor-uid'
const BUCKET     = 'tripplanner-80a4f.firebasestorage.app'
const MEMBERS    = ['owner-uid', 'editor-uid', 'viewer-uid']

/** Standard trip doc TxReadDoc -- caller is an editor, no deletingAt. */
function tripReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-22T00:00:00Z',
		fields: {
			memberIds: { arrayValue: { values: MEMBERS.map(uid => ({ stringValue: uid })) } },
		},
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
			tripId:   { stringValue: TRIP_ID },
			amount:   { doubleValue: 1000 },
			currency: { stringValue: 'JPY' },
			paidBy:   { stringValue: 'editor-uid' },
			splits:   { arrayValue: { values: [{ mapValue: { fields: {
				memberId: { stringValue: 'editor-uid' },
				amount:   { doubleValue: 1000 },
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
		title:    'Lunch',
		amount:   1000,
		currency: 'JPY',
		category: 'food' as const,
		paidBy:   'editor-uid',
		splits:   [{ memberId: 'editor-uid', amount: 1000 }],
		date:     '2026-05-22',
		...overrides,
	}
}

beforeEach(() => {
	txGetResponses.clear()
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
				splits: [{ memberId: 'stranger-uid', amount: 1000 }],
			}) },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})

	it('rejects payload that fails schema (negative amount)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(expenseCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, expense: validExpensePayload({ amount: -100 }) },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
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
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { title: 'Lunch (renamed)' } },
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
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { receipt: null } },
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
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { title: 'Resurrect' } },
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(CascadeError)
	})

	it('REGRESSION: patch with non-updatable field is rejected BEFORE tx begins', async () => {
		// tripId / createdBy / createdAt / memberIds / deletedAt /
		// receiptPurgedAt are all owned by other layers (rules /
		// cron). The allowlist check runs BEFORE the tx starts so a
		// rejected patch costs zero Firestore reads.
		await expect(expenseUpdate(
			CALLER_UID,
			{
				tripId: TRIP_ID, expenseId: EXPENSE_ID,
				patch: { tripId: 'OTHER-TRIP' } as Record<string, unknown>,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
		// txGetResponses was never primed -- if the tx had run, the
		// `unexpected tx.get` throw would have fired instead of the
		// ExpenseValidationError.
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
				patch: { paidBy: 'stranger-uid', splits: [{ memberId: 'stranger-uid', amount: 1000 }] },
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
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { title: 'Edit' } },
			'{}', BUCKET,
		)).rejects.toThrow(/role/i)
	})
})
