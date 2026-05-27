// Endpoint-level tests for upload-intent.ts.
//
// What this file pins down:
//   - Static request validation (contentType allowlist, size cap,
//     kind ↔ contentType pairing, wish-only-images, duplicate kinds)
//     runs BEFORE Firestore tx -- proven by tx mock recording no
//     reads when the request is malformed.
//   - Authorization per entityType (expense/booking need editor+;
//     wish needs isMember + proposer match against the wish doc).
//   - Intent doc shape: customMetadata schemaVersion / uploaderUid /
//     all 7 keys present, path layout matches
//     `trips/{tripId}/{collection}/{entityId}/{shortId}{.thumb}.{ext}`,
//     allowedContentTypes is single-element-locked to the requested CT.
//   - Cascade-deleting trip (deletingAt set) blocks intent creation
//     even for valid auth.
//   - Response shape: { intents: [{ intentId, path, metadata, expiresAt }] }
//     in the same order as request.uploads[].
//
// Mocking strategy mirrors expense-write.spec: mock at
// `runFirestoreTransaction` boundary, seed `tx.get` responses per
// test, capture the TxResult to assert on writes + result shape.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

// `getObjectMetadata` mocked at module boundary -- entity-write
// intent consumption calls it to verify the Storage object exists
// and to read the Firebase download token from customMetadata.
vi.mock('../src/storage', () => ({
	getObjectMetadata:      vi.fn(),
	downloadUrlFromMetadata: (bucket: string, path: string, meta?: Record<string, string>) => {
		const token = meta?.firebaseStorageDownloadTokens?.split(',')[0]?.trim()
		if (!token) return null
		return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
	},
}))

const txGetResponses = new Map<string, { exists: boolean; fields: Record<string, unknown>; name: string; updateTime: string | null }>()
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null
let txGetSpy: ReturnType<typeof vi.fn> | null = null

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		txGetSpy = vi.fn(async (path: string) => {
			const resp = txGetResponses.get(path)
			if (!resp) throw new Error(`unexpected tx.get('${path}') -- not seeded`)
			return resp
		})
		const ctx = { get: txGetSpy }
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

import { createUploadIntents, type UploadIntentsRequest } from '../src/upload-intent'
import * as storage from '../src/storage'
import { CascadeError } from '../src/cascade'

const TRIP_ID    = 'trip-1'
const ENTITY_ID  = 'ent-1'
const CALLER_UID = 'editor-uid'
const OTHER_UID  = 'other-uid'

const SERVICE_ACCOUNT_JSON = '{}'

function tripDoc(opts: { deletingAt?: boolean } = {}) {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-23T00:00:00Z',
		fields: opts.deletingAt
			? { deletingAt: { timestampValue: '2026-05-23T00:00:00Z' } }
			: {},
	}
}

function memberDoc(role: 'owner' | 'editor' | 'viewer', uid = CALLER_UID) {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${uid}`,
		updateTime: '2026-05-23T00:00:00Z',
		fields: { role: { stringValue: role } },
	}
}

function wishDoc(proposedBy: string) {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/wishes/${ENTITY_ID}`,
		updateTime: '2026-05-23T00:00:00Z',
		fields: { proposedBy: { stringValue: proposedBy } },
	}
}

function notFoundDoc(path: string) {
	return {
		exists: false,
		name:   `projects/demo/databases/(default)/documents/${path}`,
		fields: {},
		updateTime: null,
	}
}

function seedAuthorizedExpense() {
	txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('editor'))
}

function seedAuthorizedWish() {
	txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('viewer'))  // wish allows any member
	txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, wishDoc(CALLER_UID))
}

function imageFullReq(overrides: Partial<UploadIntentsRequest> = {}): UploadIntentsRequest {
	return {
		tripId:     TRIP_ID,
		entityType: 'expense',
		entityId:   ENTITY_ID,
		uploads:    [{ kind: 'full', contentType: 'image/webp', size: 100_000 }],
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	txGetResponses.clear()
	capturedTxResult = null
	txGetSpy = null
})

// ─── Static request validation (tx not even entered) ──────────────

describe('static validation (rejects before Firestore tx)', () => {
	it('rejects contentType not in allowlist', async () => {
		// no tx seeded -- if validation didn't reject pre-tx, the
		// transaction would throw "unexpected tx.get" and we'd see a
		// different error.
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				uploads: [{ kind: 'full', contentType: 'video/mp4', size: 100 }],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/contentType/) })
		expect(txGetSpy).toBeNull()  // proves we never entered tx
	})

	it('rejects size > MAX_BYTES (5 MB)', async () => {
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				uploads: [{ kind: 'full', contentType: 'image/webp', size: 6 * 1024 * 1024 }],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 413 })
	})

	it('rejects kind=pdf with non-PDF contentType', async () => {
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				uploads: [{ kind: 'pdf', contentType: 'image/webp', size: 100 }],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/pdf/) })
	})

	it('rejects application/pdf with non-pdf kind', async () => {
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				uploads: [{ kind: 'full', contentType: 'application/pdf', size: 100 }],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/pdf/) })
	})

	it('rejects wish + PDF combination', async () => {
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				entityType: 'wish',
				uploads:    [{ kind: 'pdf', contentType: 'application/pdf', size: 100 }],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 400 })
	})

	it('rejects duplicate kinds in uploads[]', async () => {
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({
				uploads: [
					{ kind: 'full', contentType: 'image/webp', size: 100 },
					{ kind: 'full', contentType: 'image/jpeg', size: 200 },
				],
			}), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/unique/) })
	})
})

// ─── Authorization ────────────────────────────────────────────────

describe('authorization (expense/booking: editor+; wish: proposer)', () => {
	it('trip not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundDoc(`trips/${TRIP_ID}`))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 404 })
	})

	it('trip deletingAt set → 410', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc({ deletingAt: true }))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 410 })
	})

	it('caller not a member → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, notFoundDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/member/) })
	})

	it('expense: viewer role → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('viewer'))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/owner\/editor/) })
	})

	it('booking: viewer role → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('viewer'))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({ entityType: 'booking' }), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 403 })
	})

	it('wish: viewer is allowed if they are the proposer', async () => {
		seedAuthorizedWish()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({ entityType: 'wish' }),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(1)
	})

	it('wish: non-proposer is rejected even as a member → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, wishDoc(OTHER_UID))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({ entityType: 'wish' }), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/proposer/) })
	})

	it('wish: doc not found → 404 (doc-first flow violated)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, notFoundDoc(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`))
		await expect(
			createUploadIntents(CALLER_UID, imageFullReq({ entityType: 'wish' }), SERVICE_ACCOUNT_JSON),
		).rejects.toMatchObject({ status: 404 })
	})

	// ─── Phase 3.7 mode='create' (upload-first wish flow) ──────────
	// The wish doc legitimately doesn't exist yet at intent-mint time;
	// Worker /wish-file-create creates it in the same tx that consumes
	// these intents. authorizeUpload must skip the wish-doc-exists +
	// proposer check on mode='create' (proposer identity is callerUid
	// by construction). Trip + membership gates still fire.
	it("mode='create' wish: skips wish-doc-exists check (viewer member, no wish doc seeded → allowed)", async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('viewer'))
		// Intentionally do NOT seed the wish doc — authorizeUpload must
		// not even read it on mode='create'. If it did, the tx mock
		// would throw "unexpected tx.get" and this test would fail.
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({ entityType: 'wish', mode: 'create' }),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(1)
		// Verify the wish doc path was NOT read in the tx.
		const wishCalls = txGetSpy!.mock.calls.filter(
			(c) => c[0] === `trips/${TRIP_ID}/wishes/${ENTITY_ID}`,
		)
		expect(wishCalls).toHaveLength(0)
	})

	it("mode='create' wish: still rejects non-member → 403", async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`),
		)
		await expect(
			createUploadIntents(
				CALLER_UID,
				imageFullReq({ entityType: 'wish', mode: 'create' }),
				SERVICE_ACCOUNT_JSON,
			),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/member/) })
	})

	it("mode='create' wish: still rejects cascade-deleting trip → 410", async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc({ deletingAt: true }))
		await expect(
			createUploadIntents(
				CALLER_UID,
				imageFullReq({ entityType: 'wish', mode: 'create' }),
				SERVICE_ACCOUNT_JSON,
			),
		).rejects.toMatchObject({ status: 410 })
	})

	it("mode='update' wish (explicit): behaves like default (proposer required)", async () => {
		// Mirrors the default-mode wish proposer test above but with
		// mode='update' explicit. Catches regressions where the
		// explicit-vs-default branch diverges.
		seedAuthorizedWish()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({ entityType: 'wish', mode: 'update' }),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(1)
	})

	it("mode='create' expense: no behavior change (no wish-doc read regardless)", async () => {
		// Sanity-check: mode is a no-op for expense / booking authz.
		seedAuthorizedExpense()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({ mode: 'create' }),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(1)
	})

	it('expense + owner role → allowed', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('owner'))
		const result = await createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON)
		expect(result.intents).toHaveLength(1)
	})
})

// ─── Intent shape + response ──────────────────────────────────────

describe('intent doc + response shape', () => {
	it('single full upload → 1 intent with correct path + metadata', async () => {
		seedAuthorizedExpense()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq(),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(1)
		const intent = result.intents[0]!
		// Path layout: trips/{tripId}/expenses/{entityId}/{fileId}.{ext}
		// fileId = full UUID hex (32 chars). 8-char truncation was
		// removed to close the birthday-paradox collision risk on
		// the globally-scoped Firestore doc id + Storage path.
		expect(intent.path).toMatch(new RegExp(
			`^trips/${TRIP_ID}/expenses/${ENTITY_ID}/[a-f0-9]{32}\\.webp$`,
		))
		expect(intent.metadata.contentType).toBe('image/webp')
		// customMetadata has all 7 keys with correct values
		expect(intent.metadata.customMetadata).toMatchObject({
			uploadIntentId: intent.intentId,
			uploaderUid:    CALLER_UID,
			tripId:         TRIP_ID,
			entityType:     'expense',
			entityId:       ENTITY_ID,
			kind:           'full',
			schemaVersion:  'v1',
		})
		// expiresAt ≈ now + 30 min
		const expiresMs = Date.parse(intent.expiresAt)
		const targetMs  = Date.now() + 30 * 60 * 1000
		expect(Math.abs(expiresMs - targetMs)).toBeLessThan(5_000)
	})

	it('batch full + thumb → 2 intents in order with .thumb. infix', async () => {
		seedAuthorizedExpense()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({
				uploads: [
					{ kind: 'full',  contentType: 'image/webp', size: 100_000 },
					{ kind: 'thumb', contentType: 'image/webp', size: 5_000   },
				],
			}),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents).toHaveLength(2)
		expect(result.intents[0]!.path).toMatch(/[a-f0-9]{32}\.webp$/)        // full: no .thumb. infix
		expect(result.intents[0]!.path).not.toMatch(/\.thumb\./)
		expect(result.intents[1]!.path).toMatch(/[a-f0-9]{32}\.thumb\.webp$/) // thumb: .thumb. infix
		// Distinct intentIds.
		expect(result.intents[0]!.intentId).not.toBe(result.intents[1]!.intentId)
		// Both metadata pin the correct kind.
		expect(result.intents[0]!.metadata.customMetadata.kind).toBe('full')
		expect(result.intents[1]!.metadata.customMetadata.kind).toBe('thumb')
	})

	it('writes Firestore doc with allowedContentTypes single-element-locked', async () => {
		// Locks in: client uploading with a DIFFERENT contentType than
		// declared will fail at the Worker entity-write endpoints
		// when consumeIntentInTx checks the uploaded object's contentType
		// against intent.allowedContentTypes -- the single-element array
		// makes that an exact-match. storage.rules can't enforce this
		// because it doesn't read the intent doc (STABLE GATE only).
		seedAuthorizedExpense()
		await createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON)
		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes).toHaveLength(1)
		const intentFields = writes[0]!.fields
		const allowed = intentFields.allowedContentTypes as { arrayValue: { values: Array<{ stringValue: string }> } }
		expect(allowed.arrayValue.values).toHaveLength(1)
		expect(allowed.arrayValue.values[0]!.stringValue).toBe('image/webp')
	})

	it('writes Firestore doc with status=pending + create-only precondition', async () => {
		seedAuthorizedExpense()
		await createUploadIntents(CALLER_UID, imageFullReq(), SERVICE_ACCOUNT_JSON)
		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown>; currentDocument?: { exists?: boolean }; updateTransforms?: unknown[] }>
		expect((writes[0]!.fields.status as { stringValue: string }).stringValue).toBe('pending')
		expect(writes[0]!.currentDocument).toEqual({ exists: false })
		// createdAt via REQUEST_TIME transform (not in fields map)
		expect(writes[0]!.updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('booking entityType → path uses /bookings/ collection segment', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('editor'))
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({ entityType: 'booking' }),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents[0]!.path).toMatch(new RegExp(
			`^trips/${TRIP_ID}/bookings/${ENTITY_ID}/`,
		))
	})

	it('PDF kind → path ends with .pdf, contentType=application/pdf', async () => {
		seedAuthorizedExpense()
		const result = await createUploadIntents(
			CALLER_UID,
			imageFullReq({
				uploads: [{ kind: 'pdf', contentType: 'application/pdf', size: 200_000 }],
			}),
			SERVICE_ACCOUNT_JSON,
		)
		expect(result.intents[0]!.path).toMatch(/\.pdf$/)
		expect(result.intents[0]!.metadata.contentType).toBe('application/pdf')
		expect(result.intents[0]!.metadata.customMetadata.kind).toBe('pdf')
	})
})
