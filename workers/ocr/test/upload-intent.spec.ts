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

// `getObjectMetadata` mocked at module boundary -- finalize + expense-
// write intent consumption call it to verify the Storage object exists
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

import { createUploadIntents, finalizeUploadIntents, type UploadIntentsRequest } from '../src/upload-intent'
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
		// declared will fail at Worker /upload-finalize (or /expense-*)
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

// ─── /upload-finalize ─────────────────────────────────────────────

describe('finalizeUploadIntents (booking/wish only)', () => {
	const FINALIZE_BUCKET = 'demo.firebasestorage.app'

	/** Phase 3.6 stale-finalize guard input. `null` = expect doc has
	 *  no attachment/image (first-attach or post-detach replace flow). */
	function applyToDocPatch(expectedCurrentPath: string | null = null) {
		return { mode: 'patch' as const, expectedCurrentPath }
	}

	/** Seed minimal booking-side authorization (no entity doc yet --
	 *  see bookingDocClean / bookingDocWithAttachment to seed that). */
	function seedFinalizeBookingAuth(role: 'owner' | 'editor' = 'editor') {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc(role))
	}

	function seedFinalizeWishAuth(role: 'owner' | 'editor' | 'viewer' = 'viewer') {
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc(role))
	}

	function bookingDocClean() {
		return {
			exists: true,
			name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields: {},
		}
	}

	function bookingDocWithAttachment(filePath: string, thumbPath?: string) {
		const attachmentFields: Record<string, unknown> = {
			fileUrl:  { stringValue: 'https://example.com/file' },
			filePath: { stringValue: filePath },
			fileType: { stringValue: 'image/webp' },
		}
		if (thumbPath) {
			attachmentFields.thumbUrl  = { stringValue: 'https://example.com/thumb' }
			attachmentFields.thumbPath = { stringValue: thumbPath }
		}
		return {
			exists: true,
			name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields: { attachment: { mapValue: { fields: attachmentFields } } },
		}
	}

	function wishDocFinalize(opts: { proposedBy?: string; imagePath?: string; thumbPath?: string } = {}) {
		const proposedBy = opts.proposedBy ?? CALLER_UID
		const fields: Record<string, unknown> = { proposedBy: { stringValue: proposedBy } }
		if (opts.imagePath) {
			const imageFields: Record<string, unknown> = {
				url:       { stringValue: 'https://example.com/file' },
				path:      { stringValue: opts.imagePath },
				thumbUrl:  { stringValue: 'https://example.com/thumb' },
				thumbPath: { stringValue: opts.thumbPath ?? opts.imagePath + '.thumb' },
			}
			fields.image = { mapValue: { fields: imageFields } }
		}
		return {
			exists: true,
			name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/wishes/${ENTITY_ID}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields,
		}
	}

	/** Build a Firestore-shape intent doc TxReadDoc with all the binding
	 *  fields the Worker mints in /upload-intents (path, customMetadata,
	 *  allowedContentTypes, maxBytes). Defaults produce a happy-path
	 *  intent whose server-side re-check will pass when paired with a
	 *  matching storageObjectMeta. */
	function intentDoc(opts: {
		intentId:    string
		uid?:        string
		tripId?:     string
		entityType:  'expense' | 'booking' | 'wish'
		entityId?:   string
		kind:        'full' | 'thumb' | 'pdf'
		path:        string
		status?:     'pending' | 'used'
		expiresAtMs?: number  // defaults to now + 30 min
		contentType?: string
		maxBytes?:   number
		schemaVersion?: string
	}) {
		const uid           = opts.uid           ?? CALLER_UID
		const tripId        = opts.tripId        ?? TRIP_ID
		const entityId      = opts.entityId      ?? ENTITY_ID
		const status        = opts.status        ?? 'pending'
		const expiresAt     = new Date(opts.expiresAtMs ?? Date.now() + 30 * 60_000).toISOString()
		const contentType   = opts.contentType   ?? 'image/webp'
		const maxBytes      = opts.maxBytes      ?? 5 * 1024 * 1024
		const schemaVersion = opts.schemaVersion ?? 'v1'
		return {
			exists: true,
			// Phase-3.5-bis: intents live under trips/{tripId}/uploadIntents/{id}.
			name:   `projects/demo/databases/(default)/documents/trips/${tripId}/uploadIntents/${opts.intentId}`,
			updateTime: '2026-05-23T00:00:00Z',
			fields: {
				uid:        { stringValue: uid },
				tripId:     { stringValue: tripId },
				entityType: { stringValue: opts.entityType },
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
							tripId:         { stringValue: tripId },
							entityType:     { stringValue: opts.entityType },
							entityId:       { stringValue: entityId },
							kind:           { stringValue: opts.kind },
							schemaVersion:  { stringValue: schemaVersion },
						},
					},
				},
			},
		}
	}

	/** Build a storage-object metadata response. By default builds a
	 *  customMetadata bundle that MATCHES the intent's binding fields
	 *  (uploaderUid/tripId/entityType/entityId/kind/uploadIntentId/
	 *  schemaVersion). Pass `tamper` to override specific keys for
	 *  re-check rejection tests, or `omitCustomMetadata: true` to
	 *  simulate non-Firebase-SDK uploads with no metadata at all. */
	function storageObjectMeta(opts: {
		name:           string
		intentId:       string
		entityType:     'expense' | 'booking' | 'wish'
		entityId:       string
		kind:           'full' | 'thumb' | 'pdf'
		size?:          number
		contentType?:   string
		downloadToken?: string
		uploaderUid?:   string
		tripId?:        string
		schemaVersion?: string
		tamper?:        Partial<Record<
			'uploadIntentId' | 'uploaderUid' | 'tripId' | 'entityType' | 'entityId' | 'kind' | 'schemaVersion',
			string | undefined  // string overrides; undefined drops the key
		>>
		omitCustomMetadata?: boolean
	}) {
		const baseCustomMetadata: Record<string, string> = {
			uploadIntentId: opts.intentId,
			uploaderUid:    opts.uploaderUid    ?? CALLER_UID,
			tripId:         opts.tripId         ?? TRIP_ID,
			entityType:     opts.entityType,
			entityId:       opts.entityId,
			kind:           opts.kind,
			schemaVersion:  opts.schemaVersion  ?? 'v1',
		}
		// Apply tamper overrides (string → set, undefined → delete)
		if (opts.tamper) {
			for (const [k, v] of Object.entries(opts.tamper)) {
				if (v === undefined) {
					delete baseCustomMetadata[k]
				} else {
					baseCustomMetadata[k] = v
				}
			}
		}
		if (opts.downloadToken) {
			baseCustomMetadata.firebaseStorageDownloadTokens = opts.downloadToken
		}
		return {
			name:        opts.name,
			size:        opts.size ?? 100_000,
			contentType: opts.contentType ?? 'image/webp',
			timeCreated: '2026-05-23T00:00:00Z',
			customMetadata: opts.omitCustomMetadata ? undefined : baseCustomMetadata,
		}
	}

	it('markUsed write: updateMask=[status] only, usedAt via REQUEST_TIME transform', async () => {
		// Regression for a real bug: updateMask used to contain 'usedAt'
		// alongside 'status'. Firestore REST treats "field in mask, NOT
		// in fields" as DELETE -- the mask listed `usedAt` AND
		// updateTransforms set usedAt = REQUEST_TIME, so the commit
		// sequence was delete-then-transform-write. Wasted churn at
		// best, semantically wrong at worst. Pin the correct shape:
		// updateMask must contain ONLY fields actually present in
		// `fields`; transforms own audit timestamps separately.
		const intentId = 'i-mask-shape'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/mask.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`, bookingDocClean())
		await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			document:          string
			updateMask?:       string[]
			fields:            Record<string, unknown>
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			currentDocument?:  { exists?: boolean }
		}>
		// Two writes: markUsed for the intent + entity-doc patch
		expect(writes).toHaveLength(2)
		const markUsed = writes.find(w => w.document.includes('/uploadIntents/'))!
		expect(markUsed.updateMask).toEqual(['status'])
		expect(Object.keys(markUsed.fields)).toEqual(['status'])
		expect(markUsed.updateTransforms).toEqual([
			{ fieldPath: 'usedAt', setToServerValue: 'REQUEST_TIME' },
		])
		expect(markUsed.currentDocument).toEqual({ exists: true })
	})

	it('booking full intent → patches booking.attachment + returns { ok: true }', async () => {
		const intentId = 'b-full-1'
		const path     = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/abc123.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'token-abc',
			}),
		)
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`, bookingDocClean())

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		// Phase 3.6: response is narrow. Source of truth = entity doc.
		expect(result).toEqual({ ok: true })

		// Entity patch write asserts: attachment map shape + updatedBy +
		// updatedAt transform + updateMask + currentDocument.exists.
		const writes = capturedTxResult!.writes as Array<{
			document:          string
			updateMask?:       string[]
			fields:            Record<string, unknown>
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			currentDocument?:  { exists?: boolean }
		}>
		const patch = writes.find(w => w.document.endsWith(`/trips/${TRIP_ID}/bookings/${ENTITY_ID}`))!
		expect(patch).toBeDefined()
		expect(patch.updateMask).toEqual(['attachment', 'updatedBy'])
		expect(patch.currentDocument).toEqual({ exists: true })
		expect(patch.updateTransforms).toEqual([
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
		const attachment = patch.fields.attachment as { mapValue: { fields: Record<string, { stringValue: string }> } }
		expect(attachment.mapValue.fields.fileUrl.stringValue).toContain('token=token-abc')
		expect(attachment.mapValue.fields.filePath.stringValue).toBe(path)
		expect(attachment.mapValue.fields.fileType.stringValue).toBe('image/webp')
		// No thumb intent in this batch → no thumbUrl/thumbPath in the map.
		expect(attachment.mapValue.fields.thumbUrl).toBeUndefined()
		expect(attachment.mapValue.fields.thumbPath).toBeUndefined()
		expect((patch.fields.updatedBy as { stringValue: string }).stringValue).toBe(CALLER_UID)
	})

	it('booking full + thumb → patches attachment with both thumbUrl + thumbPath', async () => {
		const fullId   = 'b-full-2'
		const thumbId  = 'b-thumb-2'
		const fullPath  = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.webp`
		const thumbPath = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.thumb.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${fullId}`,  intentDoc({ intentId: fullId,  entityType: 'booking', kind: 'full',  path: fullPath  }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${thumbId}`, intentDoc({ intentId: thumbId, entityType: 'booking', kind: 'thumb', path: thumbPath }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({
				name: fullPath,  intentId: fullId,  entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-f',
			}))
			.mockResolvedValueOnce(storageObjectMeta({
				name: thumbPath, intentId: thumbId, entityType: 'booking', entityId: ENTITY_ID, kind: 'thumb',
				downloadToken: 'tk-t',
			}))
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`, bookingDocClean())

		await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId, thumbId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{ document: string; fields: Record<string, unknown> }>
		// 2 markUsed + 1 entity patch
		expect(writes).toHaveLength(3)
		const patch = writes.find(w => w.document.endsWith(`/trips/${TRIP_ID}/bookings/${ENTITY_ID}`))!
		const attachment = patch.fields.attachment as { mapValue: { fields: Record<string, { stringValue: string }> } }
		expect(attachment.mapValue.fields.thumbPath.stringValue).toBe(thumbPath)
		expect(attachment.mapValue.fields.thumbUrl.stringValue).toContain('token=tk-t')
	})

	it('batch full + thumb intents for same wish → patches wish.image (all 4 fields required)', async () => {
		const fullId  = 'w-full-1'
		const thumbId = 'w-thumb-1'
		const fullPath  = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/aaa.webp`
		const thumbPath = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/aaa.thumb.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${fullId}`,  intentDoc({ intentId: fullId,  entityType: 'wish', kind: 'full',  path: fullPath  }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${thumbId}`, intentDoc({ intentId: thumbId, entityType: 'wish', kind: 'thumb', path: thumbPath }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({
				name: fullPath,  intentId: fullId,  entityType: 'wish', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-f',
			}))
			.mockResolvedValueOnce(storageObjectMeta({
				name: thumbPath, intentId: thumbId, entityType: 'wish', entityId: ENTITY_ID, kind: 'thumb',
				downloadToken: 'tk-t',
			}))
		seedFinalizeWishAuth()
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, wishDocFinalize())

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId, thumbId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{ document: string; fields: Record<string, unknown>; updateMask?: string[] }>
		// 2 markUsed + 1 wish patch
		expect(writes).toHaveLength(3)
		const patch = writes.find(w => w.document.endsWith(`/trips/${TRIP_ID}/wishes/${ENTITY_ID}`))!
		expect(patch.updateMask).toEqual(['image', 'updatedBy'])
		const image = patch.fields.image as { mapValue: { fields: Record<string, { stringValue: string }> } }
		// WishImage schema requires ALL 4 fields (url + path + thumbUrl + thumbPath).
		expect(image.mapValue.fields.url.stringValue).toContain('token=tk-f')
		expect(image.mapValue.fields.path.stringValue).toBe(fullPath)
		expect(image.mapValue.fields.thumbUrl.stringValue).toContain('token=tk-t')
		expect(image.mapValue.fields.thumbPath.stringValue).toBe(thumbPath)
	})

	it('intent not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/missing`, notFoundDoc(`trips/${TRIP_ID}/uploadIntents/missing`))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: ['missing'], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 404 })
	})

	it('intent owned by another uid → 403', async () => {
		const intentId = 'i-otheruid'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, uid: OTHER_UID, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.webp`,
		}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403 })
	})

	it('intent already used + doc still points at intent path → idempotent replay OK (no writes)', async () => {
		// Recovery case (Phase 3.6 semantics): client called /upload-finalize
		// successfully (Worker patched the doc + marked intent used) but
		// crashed BEFORE getting the 200 response. Retry must succeed --
		// otherwise the storage object becomes permanent orphan. Stricter
		// than Phase 3.5: the entity doc MUST still reflect THIS intent's
		// path exactly. If the user has since detached or replaced the
		// attachment, the intent's blob is dead bytes and we MUST NOT
		// resurrect it (separate test below pins that rejection).
		const intentId = 'i-used-replay'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/replay.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
			status: 'used',
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-replay',
			}),
		)
		seedFinalizeBookingAuth()
		// Doc already reflects this intent's blob path → idempotent OK.
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`, bookingDocWithAttachment(path))

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result).toEqual({ ok: true })
		// No writes at all -- intent already 'used' (no markUsed) and doc
		// already reflects the intent's blob (no patch).
		const writes = capturedTxResult!.writes as Array<unknown>
		expect(writes).toHaveLength(0)
	})

	it('intent already used but doc points elsewhere → 409 (idempotent-replay denied)', async () => {
		// Stale-finalize-on-used: prior finalize wrote attachment, user
		// then replaced attachment with a different intent. Late retry
		// of the SUPERSEDED intent must not resurrect dead bytes.
		const intentId = 'i-used-stale'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/old.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
			status: 'used',
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-old',
			}),
		)
		seedFinalizeBookingAuth()
		// Doc now points at a DIFFERENT (newer) blob.
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			bookingDocWithAttachment(`trips/${TRIP_ID}/bookings/${ENTITY_ID}/newer.webp`))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/idempotent-replay denied/),
		})
	})

	it('intent used by ANOTHER uid → 403 (idempotency is per-uploader)', async () => {
		// Attacker who knows another user's intentId cannot finalize it
		// to exfiltrate the blob URL -- uid check fires before any
		// storage / metadata work. Locks the idempotency window to the
		// original uploader.
		const intentId = 'i-used-other'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/other.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, uid: OTHER_UID, entityType: 'booking', kind: 'full', path,
			status: 'used',
		}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403 })
	})

	it('mixed batch (1 pending + 1 already-used) → 409 (no atomic half-state)', async () => {
		// Phase 3.6: rejecting mixed states is safer than the Phase 3.5
		// behaviour ("finalize both, one markUsed"). Under single-tx
		// semantics the only way to land mixed is a client double-submit
		// that minted a NEW intent on top of a previously finalized one
		// -- guessing which is "the real one" is unsafe.
		const usedId    = 'mix-used'
		const pendingId = 'mix-pending'
		const usedPath    = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/used.webp`
		const pendingPath = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/pending.thumb.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${usedId}`,    intentDoc({
			intentId: usedId,    entityType: 'wish', kind: 'full',  path: usedPath,    status: 'used',
		}))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${pendingId}`, intentDoc({
			intentId: pendingId, entityType: 'wish', kind: 'thumb', path: pendingPath, status: 'pending',
		}))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({
				name: usedPath,    intentId: usedId,    entityType: 'wish', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 't-u',
			}))
			.mockResolvedValueOnce(storageObjectMeta({
				name: pendingPath, intentId: pendingId, entityType: 'wish', entityId: ENTITY_ID, kind: 'thumb',
				downloadToken: 't-p',
			}))

		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [usedId, pendingId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/mixed intent states/) })
	})

	it('intent expired → 410', async () => {
		const intentId = 'i-expired'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.webp`,
			expiresAtMs: Date.now() - 1000,  // already expired
		}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 410 })
	})

	it('storage object missing at intent.path → 404', async () => {
		const intentId = 'i-storage-missing'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/missing.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(null)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/storage/) })
	})

	it('rejects expense intent — must use /expense-create instead', async () => {
		const intentId = 'i-expense'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'expense', kind: 'full',
			path: `trips/${TRIP_ID}/expenses/${ENTITY_ID}/x.webp`,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: `trips/${TRIP_ID}/expenses/${ENTITY_ID}/x.webp`,
				intentId, entityType: 'expense', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/expense.*expense-create/) })
	})

	it('rejects intentIds spanning different entities → 400', async () => {
		const fullId  = 'f-1'
		const thumbId = 't-1'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${fullId}`, intentDoc({
			intentId: fullId, entityType: 'booking', entityId: 'booking-A', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/booking-A/a.webp`,
		}))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${thumbId}`, intentDoc({
			intentId: thumbId, entityType: 'booking', entityId: 'booking-B', kind: 'thumb',
			path: `trips/${TRIP_ID}/bookings/booking-B/b.webp`,
		}))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({
				name: `trips/${TRIP_ID}/bookings/booking-A/a.webp`,
				intentId: fullId, entityType: 'booking', entityId: 'booking-A', kind: 'full',
				downloadToken: 'tk-a',
			}))
			.mockResolvedValueOnce(storageObjectMeta({
				name: `trips/${TRIP_ID}/bookings/booking-B/b.webp`,
				intentId: thumbId, entityType: 'booking', entityId: 'booking-B', kind: 'thumb',
				downloadToken: 'tk-b',
			}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId, thumbId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/entityId/) })
	})

	it('rejects duplicate intentIds in request', async () => {
		// Pre-tx duplicate check; never enters the runFirestoreTransaction body.
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: ['x', 'x'], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/duplicate/) })
	})

	it('rejects thumb-only intent set (primary blob missing)', async () => {
		// Without this guard, a caller sending only a thumb intent would
		// have it consumed + marked used, then receive a no-primary
		// patch -- which booking/wish doc shapes can't assemble into a
		// valid attachment (both require a primary path + url).
		const thumbId = 'i-thumb-only'
		const thumbPath = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/thumb-only.thumb.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${thumbId}`, intentDoc({
			intentId: thumbId, entityType: 'booking', kind: 'thumb', path: thumbPath,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: thumbPath, intentId: thumbId, entityType: 'booking', entityId: ENTITY_ID, kind: 'thumb',
				downloadToken: 'tk',
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [thumbId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/primary blob|full or pdf/),
		})
	})

	it('rejects duplicate kinds across set (two fulls for same entity)', async () => {
		const a = 'f-A'
		const b = 'f-B'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${a}`, intentDoc({
			intentId: a, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/a.webp`,
		}))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${b}`, intentDoc({
			intentId: b, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/b.webp`,
		}))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({
				name: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/a.webp`,
				intentId: a, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 't1',
			}))
			.mockResolvedValueOnce(storageObjectMeta({
				name: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/b.webp`,
				intentId: b, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 't2',
			}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [a, b], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/duplicate kinds/) })
	})

	it('wish finalize WITHOUT thumb intent (HEIC pass-through) → thumb fields collapse to primary', async () => {
		// HEIC / HEIF + decode-failure paths in src/utils/image.ts return
		// primary-only (PASSTHROUGH_TYPES). The Worker allowlist accepts
		// image/heic + image/heif for wish uploads, so refusing finalize
		// here would orphan the upload + roll the wish doc back. Fall
		// back to the primary blob for thumbUrl/thumbPath (matches the
		// pre-Phase-3.6 client-side ?? fallback). WishImage schema is
		// still satisfied (all 4 fields populated as required strings).
		const fullId = 'w-heic-full-only'
		const path = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/heic-only.heic`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${fullId}`, intentDoc({
			intentId: fullId, entityType: 'wish', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId: fullId, entityType: 'wish', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-heic',
			}),
		)
		seedFinalizeWishAuth()
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, wishDocFinalize())

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{ document: string; fields: Record<string, unknown>; updateMask?: string[] }>
		const patch = writes.find(w => w.document.endsWith(`/trips/${TRIP_ID}/wishes/${ENTITY_ID}`))!
		const image = patch.fields.image as { mapValue: { fields: Record<string, { stringValue: string }> } }
		// All 4 fields present; thumb fields collapsed to primary.
		expect(image.mapValue.fields.url.stringValue).toContain('token=tk-heic')
		expect(image.mapValue.fields.path.stringValue).toBe(path)
		expect(image.mapValue.fields.thumbUrl.stringValue).toBe(image.mapValue.fields.url.stringValue)
		expect(image.mapValue.fields.thumbPath.stringValue).toBe(path)
	})

	it('rejects wish finalize with kind=pdf primary (PDF not allowed for wish)', async () => {
		// The wish-only kind=full guard survives: WishImage is image-
		// only and the form UI doesn't surface PDF uploads for wish
		// covers. Pin the rejection so a future regression that opens
		// the wish allowlist to PDF doesn't slip through.
		const pdfId = 'w-pdf-only'
		const path = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/doc.pdf`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${pdfId}`, intentDoc({
			intentId: pdfId, entityType: 'wish', kind: 'pdf', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId: pdfId, entityType: 'wish', entityId: ENTITY_ID, kind: 'pdf',
				downloadToken: 'tk-pdf',
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [pdfId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/wish primary must be kind=full/),
		})
	})

	// ─── Server-side re-check vs intent contract ──────────────────────
	// storage.rules is a STABLE GATE -- it never reads the intent doc
	// (cross-service-read race, see storage.rules incident note), so
	// the intent-bound contract (allowedContentTypes / maxBytes /
	// customMetadata equality) is enforced HERE, inside consumeIntentInTx,
	// as the SOLE authoritative check. Worker refuses to consume any
	// object whose contentType / size / customMetadata don't match
	// the intent the path was minted for. Catches:
	//   - non-Firebase-SDK uploads (no customMetadata at all)
	//   - tampered customMetadata (e.g. spoofed uploaderUid)
	//   - oversize / wrong contentType slipping past the static
	//     allowlist + 5MB cap that storage.rules enforces
	it('rejects upload with missing customMetadata (e.g. raw GCS upload, no Firebase SDK)', async () => {
		const intentId = 'i-no-meta'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/no-meta.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				omitCustomMetadata: true,  // simulates non-Firebase-SDK upload
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/customMetadata.*mismatch/),
		})
	})

	it('rejects upload with tampered customMetadata.uploaderUid (forged attribution)', async () => {
		const intentId = 'i-spoof-uid'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/spoof.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
				tamper: { uploaderUid: OTHER_UID },  // forged
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/uploaderUid/),
		})
	})

	it('rejects upload with mismatched customMetadata.uploadIntentId (cross-intent path hijack)', async () => {
		const intentId = 'i-mismatched'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/mis.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
				tamper: { uploadIntentId: 'i-some-other-intent' },  // claims a different intent
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/uploadIntentId/),
		})
	})

	it('rejects upload with wrong contentType (intent allowed webp, storage shows pdf)', async () => {
		const intentId = 'i-wrong-ct'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/ct.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				contentType: 'application/pdf',  // intent expected image/webp
				downloadToken: 'tk',
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/contentType/),
		})
	})

	it('rejects upload exceeding intent maxBytes', async () => {
		const intentId = 'i-too-big'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/big.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				size: 6 * 1024 * 1024,  // intent maxBytes = 5MB
				downloadToken: 'tk',
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 413,
			message: expect.stringMatching(/size.*maxBytes/),
		})
	})

	it('storage object exists but no download token → 500 (refuse to write malformed doc)', async () => {
		// Phase 3.6: Worker IS the authoritative writer of
		// BookingAttachment.fileUrl / WishImage.url -- both required by
		// Zod schema. A null download URL would mean writing an invalid
		// doc that clients would reject downstream. Reject explicitly
		// rather than degrading gracefully (previous Phase 3.5 behaviour).
		const intentId = 'i-no-token'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/no-token.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				// no downloadToken
			}),
		)
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 500,
			message: expect.stringMatching(/download token/),
		})
	})

	// ─── Phase 3.6: re-verify CURRENT entity write permission ──────────
	// Intent was minted up to 30 min ago. By finalize time the caller's
	// role / membership / the trip's deletingAt state may have changed.
	// The intent system can't see those changes -- re-check inside the
	// same tx as the doc patch so a stale-permission capability token
	// can't slip through.

	it('caller demoted from editor to viewer between mint and finalize → 403', async () => {
		const intentId = 'demote-uid'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/d.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		// Intent was minted as editor; current state is viewer.
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('viewer'))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/owner\/editor/) })
	})

	it('trip entered cascade-delete between mint and finalize → 410', async () => {
		const intentId = 'cascade-uid'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/c.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc({ deletingAt: true }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberDoc('editor'))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 410, message: expect.stringMatching(/being deleted/) })
	})

	it('caller removed from trip between mint and finalize → 403', async () => {
		const intentId = 'removed-uid'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/r.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not a trip member/) })
	})

	it('booking entity doc gone between mint and finalize → 410', async () => {
		// User deleted the booking after the upload but before finalize
		// landed. The blob is now an orphan (will be reaped by
		// orphan-storage-scan) but Worker shouldn't synthesise a new
		// doc for a booking the user clearly intended to remove.
		const intentId = 'b-gone'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/g.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			notFoundDoc(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 410, message: expect.stringMatching(/booking.*not found/) })
	})

	it('wish: caller was the proposer at mint, but wish doc now points to different proposer → 403', async () => {
		// Defense-in-depth: even though intent-mint already enforced
		// proposer match, the wish doc state at finalize time is the
		// authoritative source. Theoretically the proposedBy can't
		// change without deleting+recreating the wish, but pin the check.
		const intentId = 'w-not-proposer'
		const fullPath  = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/np.webp`
		const thumbPath = `trips/${TRIP_ID}/wishes/${ENTITY_ID}/np.thumb.webp`
		const thumbId = 'w-not-proposer-thumb'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({ intentId,  entityType: 'wish', kind: 'full',  path: fullPath  }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${thumbId}`,  intentDoc({ intentId: thumbId, entityType: 'wish', kind: 'thumb', path: thumbPath }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageObjectMeta({ name: fullPath,  intentId,        entityType: 'wish', entityId: ENTITY_ID, kind: 'full',  downloadToken: 'tk-f' }))
			.mockResolvedValueOnce(storageObjectMeta({ name: thumbPath, intentId: thumbId, entityType: 'wish', entityId: ENTITY_ID, kind: 'thumb', downloadToken: 'tk-t' }))
		seedFinalizeWishAuth()
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${ENTITY_ID}`, wishDocFinalize({ proposedBy: OTHER_UID }))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId, thumbId], applyToDoc: applyToDocPatch(null) }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/wish proposer/) })
	})

	// ─── Phase 3.6: stale-finalize guard (allPending path) ─────────────
	// Closes the race where Tab A's slow finalize would overwrite Tab B's
	// already-committed replacement blob.

	it('stale-finalize: expectedCurrentPath=null but doc already has an attachment → 409', async () => {
		const intentId = 'stale-1'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/late.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		seedFinalizeBookingAuth()
		// Doc has a DIFFERENT attachment (Tab B beat us to it).
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			bookingDocWithAttachment(`trips/${TRIP_ID}/bookings/${ENTITY_ID}/tab-b.webp`))
		await expect(
			finalizeUploadIntents(CALLER_UID, {
				tripId: TRIP_ID, intentIds: [intentId],
				applyToDoc: applyToDocPatch(null),  // client thought doc was clean
			}, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/stale-finalize.*replaced or detached/),
		})
	})

	it('stale-finalize: expectedCurrentPath=A but doc has path B → 409', async () => {
		const intentId = 'stale-2'
		const path = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/new.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: path, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk',
			}),
		)
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`,
			bookingDocWithAttachment(`trips/${TRIP_ID}/bookings/${ENTITY_ID}/path-C.webp`))
		await expect(
			finalizeUploadIntents(CALLER_UID, {
				tripId: TRIP_ID, intentIds: [intentId],
				applyToDoc: applyToDocPatch(`trips/${TRIP_ID}/bookings/${ENTITY_ID}/path-A.webp`),
			}, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/stale-finalize/),
		})
	})

	it('replace flow: expectedCurrentPath=A, doc has A → finalize OK, attachment replaced with new blob', async () => {
		// Happy path of replace: client knows the doc has attachment at
		// path A, uploads B + finalizes with expectedCurrentPath=A. Worker
		// confirms the doc still points at A → patches in B.
		const intentId = 'replace-ok'
		const newPath = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/new-b.webp`
		const oldPath = `trips/${TRIP_ID}/bookings/${ENTITY_ID}/old-a.webp`
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full', path: newPath,
		}))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageObjectMeta({
				name: newPath, intentId, entityType: 'booking', entityId: ENTITY_ID, kind: 'full',
				downloadToken: 'tk-b',
			}),
		)
		seedFinalizeBookingAuth()
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${ENTITY_ID}`, bookingDocWithAttachment(oldPath))
		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId], applyToDoc: applyToDocPatch(oldPath) },
			SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result).toEqual({ ok: true })
		const writes = capturedTxResult!.writes as Array<{ document: string; fields: Record<string, unknown> }>
		const patch = writes.find(w => w.document.endsWith(`/trips/${TRIP_ID}/bookings/${ENTITY_ID}`))!
		const attachment = patch.fields.attachment as { mapValue: { fields: Record<string, { stringValue: string }> } }
		expect(attachment.mapValue.fields.filePath.stringValue).toBe(newPath)
	})
})
