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
import * as storage from '../src/storage'
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
function tripReadDoc(overrides: { currency?: string | null } = {}) {
	const fields: Record<string, unknown> = {
		memberIds: { arrayValue: { values: MEMBERS.map(uid => ({ stringValue: uid })) } },
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
				patch: { paidBy: 'stranger-uid', splits: [{ memberId: 'stranger-uid', amountMinor: 1000 }] },
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
			{ tripId: TRIP_ID, expenseId: EXPENSE_ID, patch: { currency: 'USD' } },
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
				patch: { title: 'Edited title' },
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
				patch: { receipt: { url: 'https://x', path: 'p', type: 'image/webp' } },
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
				patch: { receipt: { url: 'https://x', path: 'p', type: 'image/webp' } },
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
				patch: { receipt: null },
				intentIds: [NEW_FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(ExpenseValidationError)
	})
})
