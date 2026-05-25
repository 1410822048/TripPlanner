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
		// declared would fail the storage.rules `in` check, because the
		// intent doc only allows the exact requested CT.
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
		await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?:       string[]
			fields:            Record<string, unknown>
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
			currentDocument?:  { exists?: boolean }
		}>
		expect(writes).toHaveLength(1)
		const w = writes[0]!
		expect(w.updateMask).toEqual(['status'])
		expect(Object.keys(w.fields)).toEqual(['status'])
		expect(w.updateTransforms).toEqual([
			{ fieldPath: 'usedAt', setToServerValue: 'REQUEST_TIME' },
		])
		expect(w.currentDocument).toEqual({ exists: true })
	})

	it('booking full intent → finalized; storage url built from token', async () => {
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

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result.ok).toBe(true)
		expect(result.entityType).toBe('booking')
		expect(result.tripId).toBe(TRIP_ID)
		expect(result.entityId).toBe(ENTITY_ID)
		expect(result.blobs).toHaveLength(1)
		expect(result.blobs[0]).toMatchObject({
			kind:        'full',
			path,
			contentType: 'image/webp',
			size:        100_000,
		})
		expect(result.blobs[0]!.url).toContain('token=token-abc')
	})

	it('batch full + thumb intents for same wish → both finalized', async () => {
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

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId, thumbId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result.blobs).toHaveLength(2)
		expect(result.blobs.map(b => b.kind).sort()).toEqual(['full', 'thumb'])
		// markUsed write per intent
		const writes = capturedTxResult!.writes as Array<{ document: string; fields: Record<string, { stringValue?: string }> }>
		expect(writes).toHaveLength(2)
		const docs = writes.map(w => w.document)
		expect(docs.some(d => d.endsWith(`/trips/${TRIP_ID}/uploadIntents/${fullId}`))).toBe(true)
		expect(docs.some(d => d.endsWith(`/trips/${TRIP_ID}/uploadIntents/${thumbId}`))).toBe(true)
		writes.forEach(w => expect(w.fields.status?.stringValue).toBe('used'))
	})

	it('intent not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/missing`, notFoundDoc(`trips/${TRIP_ID}/uploadIntents/missing`))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: ['missing'] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 404 })
	})

	it('intent owned by another uid → 403', async () => {
		const intentId = 'i-otheruid'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, uid: OTHER_UID, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.webp`,
		}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403 })
	})

	it('intent already used + same caller + storage still matches → idempotent replay (no 409)', async () => {
		// Recovery case: client called /upload-finalize successfully but
		// crashed BEFORE writing the booking/wish doc. Retry must succeed
		// and return the same blobs response so the client can complete
		// its setDoc/updateDoc -- otherwise the storage object becomes
		// permanent orphan (intent burnt, doc never landed, user can't
		// recover their upload). uid + storage match + customMetadata
		// re-verification all still enforced -- idempotency is scoped
		// to the original uploader, not a general replay bypass.
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

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result.ok).toBe(true)
		expect(result.blobs).toHaveLength(1)
		expect(result.blobs[0]!.path).toBe(path)
		expect(result.blobs[0]!.url).toContain('token=tk-replay')
		// No markUsed write fired -- intent was already 'used' on entry.
		const writes = capturedTxResult!.writes as Array<unknown>
		expect(writes).toHaveLength(0)
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 403 })
	})

	it('mixed batch (1 pending + 1 already-used) → both finalized, only pending gets markUsed write', async () => {
		// Half-state recovery: prior finalize crashed AFTER marking
		// intent-A used but BEFORE consuming intent-B. Retry needs to
		// handle both states in one call.
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

		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [usedId, pendingId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result.blobs).toHaveLength(2)
		// Only ONE markUsed write -- the previously-pending intent.
		const writes = capturedTxResult!.writes as Array<{ document: string }>
		expect(writes).toHaveLength(1)
		expect(writes[0]!.document).toContain(`/trips/${TRIP_ID}/uploadIntents/${pendingId}`)
	})

	it('intent expired → 410', async () => {
		const intentId = 'i-expired'
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${intentId}`, intentDoc({
			intentId, entityType: 'booking', kind: 'full',
			path: `trips/${TRIP_ID}/bookings/${ENTITY_ID}/x.webp`,
			expiresAtMs: Date.now() - 1000,  // already expired
		}))
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [fullId, thumbId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/entityId/) })
	})

	it('rejects duplicate intentIds in request', async () => {
		// Pre-tx duplicate check; never enters the runFirestoreTransaction body.
		await expect(
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: ['x', 'x'] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/duplicate/) })
	})

	it('rejects thumb-only intent set (primary blob missing)', async () => {
		// Without this guard, a caller sending only a thumb intent would
		// have it consumed + marked used, then receive a blobs response
		// with only a thumb -- which booking/wish doc shapes can't
		// assemble into a valid attachment (both require a primary
		// path + url). Equivalent to expense-write's buildReceiptFromIntents
		// "primary blob missing" check; mirrors it at the finalize layer.
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [thumbId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [a, b] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/duplicate kinds/) })
	})

	// ─── Server-side re-check vs intent contract ──────────────────────
	// Storage rules in Commit 4 will perform an equivalent intent-bound
	// check at upload time. These tests pin the defense-in-depth
	// chokepoint INSIDE consumeIntentInTx -- Worker refuses to consume
	// any object whose contentType / size / customMetadata don't match
	// the intent the path was minted for. Catches:
	//   - non-Firebase-SDK uploads (no customMetadata at all)
	//   - tampered customMetadata (e.g. spoofed uploaderUid)
	//   - oversize / wrong contentType slipping past pre-Commit-4 rules
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
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
			finalizeUploadIntents(CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET),
		).rejects.toMatchObject({
			status: 413,
			message: expect.stringMatching(/size.*maxBytes/),
		})
	})

	it('storage object exists but no download token → blob.url is null (degrade gracefully)', async () => {
		// If a future non-Firebase-SDK upload path lands an object
		// without a download token, blob.url is null and client can
		// call Storage SDK getDownloadURL itself. Doesn't fail finalize.
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
		const result = await finalizeUploadIntents(
			CALLER_UID, { tripId: TRIP_ID, intentIds: [intentId] }, SERVICE_ACCOUNT_JSON, FINALIZE_BUCKET,
		)
		expect(result.blobs[0]!.url).toBeNull()
	})
})
