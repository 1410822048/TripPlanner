// Endpoint-level tests for wish-write.ts.
//
// Same mocking strategy as expense-write.spec: mock at the
// `runFirestoreTransaction` boundary so the test seeds tx.get
// responses per-test, capture the TxResult to assert on writes +
// result shape. Storage object metadata is mocked at the
// getObjectMetadata boundary for intent consumption.
//
// What this file pins down:
//   - Worker-authoritative wish create with intentIds: caller must
//     be a trip member (any role); image field built from consumed
//     intents (not from request body); proposedBy / updatedBy /
//     votes / memberIds all stamped from caller / trip state.
//   - Intent markUsed writes commit atomically with the wish doc
//     write (one tx, two writes — markUsed first so a wish-write
//     409 leaves intents pending for retry).
//   - createdAt + updatedAt stamped via REQUEST_TIME transforms
//     (NOT in the fields map) — settlement chronological replay
//     parity with expense-write.
//   - Request body cannot smuggle a client-built `image` object.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/storage', () => ({
	getObjectMetadata:    vi.fn(),
	downloadObject:       vi.fn(),
	// path-only: consume strips the download token fail-closed.
	updateObjectMetadata: vi.fn(() => Promise.resolve(true)),
	deleteObject:         vi.fn(() => Promise.resolve(true)),
}))

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

vi.mock('../src/cascade', async () => {
	const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
	return {
		...actual,
		withTokenRetry: <T,>(fn: () => Promise<T>) => fn(),
	}
})

import { wishFileCreate, wishFileUpdate, WishValidationError } from '../src/wish-write'
import * as storage from '../src/storage'
import { CascadeError } from '../src/cascade'

const TRIP_ID    = 'trip-1'
const WISH_ID    = 'wish-1'
const CALLER_UID = 'viewer-uid'
const BUCKET     = 'tripplanner-80a4f.firebasestorage.app'
const MEMBERS    = ['owner-uid', 'editor-uid', 'viewer-uid']

const FULL_INTENT_ID  = 'i-full'
const THUMB_INTENT_ID = 'i-thumb'
const FULL_PATH       = `trips/${TRIP_ID}/wishes/${WISH_ID}/abc123.webp`
const THUMB_PATH      = `trips/${TRIP_ID}/wishes/${WISH_ID}/abc123.thumb.webp`

function tripReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields: {
			memberIds: { arrayValue: { values: MEMBERS.map(uid => ({ stringValue: uid })) } },
		},
	}
}

function memberReadDoc(role: 'owner' | 'editor' | 'viewer') {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${CALLER_UID}`,
		updateTime: '2026-05-26T00:00:00Z',
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

function existingWishReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/wishes/${WISH_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields: {
			tripId:     { stringValue: TRIP_ID },
			title:      { stringValue: 'already here' },
			proposedBy: { stringValue: CALLER_UID },
		},
	}
}

function intentDoc(opts: {
	intentId:    string
	uid?:        string
	kind:        'full' | 'thumb'
	path:        string
	entityType?: 'expense' | 'booking' | 'wish'
	entityId?:   string
	status?:     'pending' | 'used'
	expiresAtMs?: number
	contentType?: string
}) {
	const uid         = opts.uid         ?? CALLER_UID
	const status      = opts.status      ?? 'pending'
	const entityId    = opts.entityId    ?? WISH_ID
	const entityType  = opts.entityType  ?? 'wish'
	const expiresAt   = new Date(opts.expiresAtMs ?? Date.now() + 30 * 60_000).toISOString()
	const contentType = opts.contentType ?? 'image/webp'
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/${opts.intentId}`,
		updateTime: '2026-05-26T00:00:00Z',
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
			maxBytes: { integerValue: String(5 * 1024 * 1024) },
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
	kind:        'full' | 'thumb'
	token?:      string
	size?:       number
	contentType?: string
}) {
	const customMetadata: Record<string, string> = {
		uploadIntentId: opts.intentId,
		uploaderUid:    CALLER_UID,
		tripId:         TRIP_ID,
		entityType:     'wish',
		entityId:       WISH_ID,
		kind:           opts.kind,
		schemaVersion:  'v1',
	}
	if (opts.token) customMetadata.firebaseStorageDownloadTokens = opts.token
	return {
		name:        opts.path,
		size:        opts.size ?? 50_000,
		contentType: opts.contentType ?? 'image/webp',
		timeCreated: '2026-05-26T00:00:00Z',
		customMetadata,
	}
}

function validWishPayload(overrides: Record<string, unknown> = {}) {
	return {
		category: 'place' as const,
		title:    '東京タワー',
		...overrides,
	}
}

function seedAuth(role: 'owner' | 'editor' | 'viewer' = 'viewer') {
	txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc(role))
	txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,     notFoundReadDoc(`trips/${TRIP_ID}/wishes/${WISH_ID}`))
}

beforeEach(() => {
	txGetResponses.clear()
	capturedTxResult = null
	vi.clearAllMocks()
})

// ─── Happy paths ───────────────────────────────────────────────────

describe('wishFileCreate: happy paths', () => {
	it('full intent only → wish doc + image (no thumb → thumbPath omitted) + markUsed in same tx', async () => {
		// HEIC/HEIF pass-through case: client couldn't canvas-decode a
		// thumb, so it sends just `full`. Worker's WishImage encoding
		// collapses thumb fields to the primary blob.
		seedAuth('viewer')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		const result = await wishFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				wishId:    WISH_ID,
				wish:      validWishPayload(),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)
		expect(result.wishId).toBe(WISH_ID)

		const writes = capturedTxResult!.writes as Array<{
			document: string
			currentDocument?: { exists?: boolean }
			fields: Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string; arrayValue?: { values?: Array<{ stringValue?: string }> } }> }; arrayValue?: { values?: Array<{ stringValue?: string }> } }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>

		// 1 markUsed + 1 wish doc write, in that order.
		expect(writes).toHaveLength(2)
		expect(writes[0].document).toContain(`/trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`)
		expect(writes[0].fields.status?.stringValue).toBe('used')

		const wishWrite = writes[1]!
		expect(wishWrite.document).toContain(`/trips/${TRIP_ID}/wishes/${WISH_ID}`)
		expect(wishWrite.currentDocument).toEqual({ exists: false })
		expect(wishWrite.fields.tripId?.stringValue).toBe(TRIP_ID)
		expect(wishWrite.fields.category?.stringValue).toBe('place')
		expect(wishWrite.fields.title?.stringValue).toBe('東京タワー')
		expect(wishWrite.fields.proposedBy?.stringValue).toBe(CALLER_UID)
		expect(wishWrite.fields.updatedBy?.stringValue).toBe(CALLER_UID)

		// votes seeded with the proposer's own +1.
		const voteValues = wishWrite.fields.votes?.arrayValue?.values?.map(v => v.stringValue)
		expect(voteValues).toEqual([CALLER_UID])

		// memberIds denormalised from trip doc.
		const memberIdValues = wishWrite.fields.memberIds?.arrayValue?.values?.map(v => v.stringValue)
		expect(memberIdValues).toEqual(MEMBERS)

		// Image field built server-side (path-only). No thumb intent → no
		// thumbPath (we deliberately do NOT collapse to the full path; the
		// card shows its placeholder). No bearer download URL is persisted.
		const image = wishWrite.fields.image?.mapValue?.fields
		expect(image?.path?.stringValue).toBe(FULL_PATH)
		expect(image?.thumbPath).toBeUndefined()   // no collapse

		// createdAt + updatedAt via transforms, NOT in fields map.
		expect(wishWrite.fields.createdAt).toBeUndefined()
		expect(wishWrite.fields.updatedAt).toBeUndefined()
		expect(wishWrite.updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('full + thumb intents → both marked used + image has distinct thumb fields', async () => {
		seedAuth('editor')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full',  path: FULL_PATH }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: FULL_PATH,  intentId: FULL_INTENT_ID,  kind: 'full',  token: 'tk-f' }))
			.mockResolvedValueOnce(storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk-t' }))

		await wishFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				wishId:    WISH_ID,
				wish:      validWishPayload({ category: 'food', title: '寿司屋', description: 'Best', link: 'https://example.com', address: 'Tokyo' }),
				intentIds: [FULL_INTENT_ID, THUMB_INTENT_ID],
			},
			'{}', BUCKET,
		)

		const writes = capturedTxResult!.writes as Array<{
			document: string
			fields: Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		// 2 markUsed + 1 wish doc write
		expect(writes).toHaveLength(3)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		expect(writes[1].fields.status?.stringValue).toBe('used')

		const wishWrite = writes[2]!
		expect(wishWrite.fields.category?.stringValue).toBe('food')
		expect(wishWrite.fields.description?.stringValue).toBe('Best')
		expect(wishWrite.fields.link?.stringValue).toBe('https://example.com')
		expect(wishWrite.fields.address?.stringValue).toBe('Tokyo')

		// Image: distinct full + thumb (no collapse). path-only.
		const image = wishWrite.fields.image?.mapValue?.fields
		expect(image?.path?.stringValue).toBe(FULL_PATH)
		expect(image?.thumbPath?.stringValue).toBe(THUMB_PATH)
	})

	it('viewer-role caller can create a wish (any-member proposer authz)', async () => {
		// Mirrors the firestore.rules wish-create rule: any member,
		// including viewer. Reasserts the rule's semantics on the
		// Worker path.
		seedAuth('viewer')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		const result = await wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)
		expect(result.wishId).toBe(WISH_ID)
	})
})

// ─── Authorization ────────────────────────────────────────────────

describe('wishFileCreate: authorization', () => {
	it('trip not found → 404 CascadeError', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundReadDoc(`trips/${TRIP_ID}`))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})

	it('trip is cascade-deleting → 410 CascadeError', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, deletingAt: { timestampValue: '2026-05-26T00:00:00Z' } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 410 })
	})

	it('caller is not a trip member → 403 CascadeError', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('REGRESSION: non-member probing an expired-deadline trip gets "not a member", not the deadline message (no state leak)', async () => {
		// Membership must be checked before the deadline gate -- otherwise a
		// non-member could distinguish "deadline passed" from "not a member"
		// via the error message alone, leaking a trip's Wish-deadline state
		// to someone who was never a member.
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(Date.now() - 60_000).toISOString() } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('not a trip member') })
	})

	it('wish voting deadline has passed → 403 CascadeError (Admin SDK bypasses rules, so this Worker gate is the only enforcement on this path)', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(Date.now() - 60_000).toISOString() } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('wish voting deadline in the future → allowed (no false-positive lock)', async () => {
		seedAuth('viewer')
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		const result = await wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)
		expect(result.wishId).toBe(WISH_ID)
	})

	it('wish voting deadline exactly equal to now → 403 (boundary is closed, not open)', async () => {
		// Fake timers pin Date.now() so the deadline and "now" are the exact
		// same instant with no test/network timing gap -- assertWishVotingOpen
		// uses `deadlineMs <= Date.now()`, so this asserts the boundary itself
		// (not just "1 minute past") is treated as closed.
		vi.useFakeTimers()
		try {
			const nowMs = Date.now()
			const trip = tripReadDoc()
			trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(nowMs).toISOString() } }
			txGetResponses.set(`trips/${TRIP_ID}`, trip)
			txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
			await expect(wishFileCreate(
				CALLER_UID,
				{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
				'{}', BUCKET,
			)).rejects.toMatchObject({ status: 403 })
		} finally {
			vi.useRealTimers()
		}
	})
})

// ─── Conflict / state ─────────────────────────────────────────────

describe('wishFileCreate: state checks', () => {
	it('wish already exists at that id → 409 CascadeError (no overwrite)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,     existingWishReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })
	})
})

// ─── Body validation ──────────────────────────────────────────────

describe('wishFileCreate: body validation', () => {
	it('rejects when wish body is missing title', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(wishFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				wishId:    WISH_ID,
				wish:      { category: 'place' },  // missing title
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(WishValidationError)
	})

	it('rejects when category is invalid', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(wishFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				wishId:    WISH_ID,
				wish:      { category: 'activity', title: 'x' },  // 'activity' removed in 2-cat model
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(WishValidationError)
	})

	it('REGRESSION: rejects request that smuggles a client-built image object in body', async () => {
		// Defense-in-depth: even though firestore.rules tightens to
		// `allow create: if image-absent` (Commit 4), Worker layer must
		// reject early so the failure is a clear 400 instead of a rules-
		// commit deny burying the reason.
		await expect(wishFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				wishId:    WISH_ID,
				wish:      {
					category: 'place',
					title:    'x',
					image:    { path: 'x', thumbPath: 'x' },
				},
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'image' })
	})

	it('rejects when intentIds has no full intent (thumb-only)', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk' }),
		)
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [THUMB_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'intentIds' })
	})
})

// ─── Intent scope binding ─────────────────────────────────────────

describe('wishFileCreate: intent scope binding', () => {
	it('rejects when intent.entityType is not "wish" (cross-entity intent reuse)', async () => {
		// Caller mints an expense intent and tries to consume it via
		// wish-file-create. consumeEntityIntents's `expected.entityType
		// = "wish"` check inside consumeIntentInTx must catch this.
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId:   FULL_INTENT_ID,
				kind:       'full',
				path:       FULL_PATH,
				entityType: 'expense',  // wrong entity type
				entityId:   WISH_ID,
			}))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})

	it('rejects when intent.entityId targets a different wish', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID,
				kind:     'full',
				path:     FULL_PATH,
				entityId: 'other-wish',  // different wish
			}))
		await expect(wishFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, wish: validWishPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})
})

// ─── /wish-file-update tests ──────────────────────────────────────

const NEW_FULL_PATH  = `trips/${TRIP_ID}/wishes/${WISH_ID}/xyz789.webp`
const NEW_THUMB_PATH = `trips/${TRIP_ID}/wishes/${WISH_ID}/xyz789.thumb.webp`

/** Wish doc that exists and is proposed by `proposedBy` (defaults to
 *  CALLER_UID so the happy-path tests don't need to spell it). Has
 *  enough fields to look like a real wish; the Worker only reads
 *  `proposedBy` for the authz check. */
function ownedWishReadDoc(proposedBy: string = CALLER_UID) {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/wishes/${WISH_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields: {
			tripId:     { stringValue: TRIP_ID },
			category:   { stringValue: 'place' },
			title:      { stringValue: 'old title' },
			proposedBy: { stringValue: proposedBy },
			image: {
				mapValue: {
					fields: {
						path:      { stringValue: FULL_PATH },
						thumbPath: { stringValue: FULL_PATH },
					},
				},
			},
		},
	}
}

function seedUpdateAuth(opts: {
	role?:       'owner' | 'editor' | 'viewer'
	proposedBy?: string
} = {}) {
	txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc(opts.role ?? 'viewer'))
	txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,     ownedWishReadDoc(opts.proposedBy ?? CALLER_UID))
}

// ─── Happy paths ──────────────────────────────────────────────────

describe('wishFileUpdate: happy paths', () => {
	it('text patch + new image (full+thumb) → image + text + markUsed in one tx', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID,  kind: 'full',  path: NEW_FULL_PATH }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: NEW_THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: NEW_FULL_PATH,  intentId: FULL_INTENT_ID,  kind: 'full',  token: 'tk-f' }))
			.mockResolvedValueOnce(storageMeta({ path: NEW_THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk-t' }))

		const result = await wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'new title', description: 'updated' },
				intentIds:           [FULL_INTENT_ID, THUMB_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{
			document:   string
			updateMask?: string[]
			currentDocument?: { exists?: boolean }
			fields: Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>

		// 2 markUsed + 1 wish-patch
		expect(writes).toHaveLength(3)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		expect(writes[1].fields.status?.stringValue).toBe('used')

		const patch = writes[2]!
		expect(patch.document).toContain(`/trips/${TRIP_ID}/wishes/${WISH_ID}`)
		expect(patch.currentDocument).toEqual({ exists: true })
		// image + updatedBy + title + description (no category/link/address)
		const maskSet = new Set(patch.updateMask)
		expect(maskSet.has('image')).toBe(true)
		expect(maskSet.has('updatedBy')).toBe(true)
		expect(maskSet.has('title')).toBe(true)
		expect(maskSet.has('description')).toBe(true)
		expect(maskSet.has('category')).toBe(false)
		expect(maskSet.has('link')).toBe(false)
		expect(maskSet.has('address')).toBe(false)

		expect(patch.fields.updatedBy?.stringValue).toBe(CALLER_UID)
		expect(patch.fields.title?.stringValue).toBe('new title')
		expect(patch.fields.description?.stringValue).toBe('updated')

		// New image bytes (not the old FULL_PATH from ownedWishReadDoc). path-only.
		const image = patch.fields.image?.mapValue?.fields
		expect(image?.path?.stringValue).toBe(NEW_FULL_PATH)
		expect(image?.thumbPath?.stringValue).toBe(NEW_THUMB_PATH)

		// updatedAt via transforms, NOT in fields map; createdAt untouched.
		expect(patch.fields.updatedAt).toBeUndefined()
		expect(patch.fields.createdAt).toBeUndefined()
		expect(patch.updateTransforms).toEqual([
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('empty patch + new image → image-only replace (mask = image + updatedBy)', async () => {
		// Use case: user picks a new image but doesn't touch any text
		// fields. mask must not include text fields, otherwise we'd
		// overwrite them with `undefined` (Firestore would treat that
		// as field-delete via mask-without-field semantics).
		seedUpdateAuth({ role: 'editor' })
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               {},
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, unknown>
		}>
		const patch = writes[1]!
		// Exactly two keys: image + updatedBy.
		expect(patch.updateMask).toEqual(['image', 'updatedBy'])
		expect(Object.keys(patch.fields)).toEqual(['image', 'updatedBy'])
	})

	it('full-only new image → thumbPath omitted (HEIC pass-through case, no collapse)', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, { mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		const image = writes[1].fields.image?.mapValue?.fields
		expect(image?.path?.stringValue).toBe(NEW_FULL_PATH)
		expect(image?.thumbPath).toBeUndefined()   // no collapse to full path
	})
})

// ─── Authorization ───────────────────────────────────────────────

describe('wishFileUpdate: authorization', () => {
	it('trip not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundReadDoc(`trips/${TRIP_ID}`))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`, ownedWishReadDoc())
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})

	it('trip is cascade-deleting → 410', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, deletingAt: { timestampValue: '2026-05-26T00:00:00Z' } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`, ownedWishReadDoc())
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 410 })
	})

	it('caller is not a trip member → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`, ownedWishReadDoc())
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('REGRESSION: non-member probing an expired-deadline trip gets "not a member", not the deadline message (no state leak)', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(Date.now() - 60_000).toISOString() } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`, ownedWishReadDoc())
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('not a trip member') })
	})

	it('wish doc not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/wishes/${WISH_ID}`))
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})

	it('wish voting deadline has passed → 403 (blocks image-replace via Worker even for the proposer)', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, wishVotingDeadlineAt: { timestampValue: new Date(Date.now() - 60_000).toISOString() } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`, ownedWishReadDoc())
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('caller is not the wish proposer → 403 (rules-parity)', async () => {
		// Mirrors firestore.rules' proposer-only update path. Non-proposer
		// must NOT be able to mutate text or image via this Worker
		// endpoint, even if they're a trip member.
		seedUpdateAuth({ proposedBy: 'other-uid' })
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})
})

// ─── Body validation ──────────────────────────────────────────────

describe('wishFileUpdate: body validation', () => {
	it('rejects when patch is not an object', async () => {
		seedUpdateAuth()
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: 'not-an-object', intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'patch' })
	})

	it('REGRESSION: rejects when patch tries to smuggle an image object', async () => {
		seedUpdateAuth()
		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { image: { path: 'x', thumbPath: 'x' } },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'image' })
	})

	it('rejects unknown patch field (allowlist gate)', async () => {
		seedUpdateAuth()
		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { proposedBy: 'someone-else' },  // immutable; not in allowlist
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'proposedBy' })
	})

	it('rejects when title is too long', async () => {
		seedUpdateAuth()
		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'x'.repeat(101) },  // max=100
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(WishValidationError)
	})
})

// ─── Intent scope binding ─────────────────────────────────────────

describe('wishFileUpdate: intent scope binding', () => {
	it('rejects thumb-only intent set (no primary)', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: NEW_THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: NEW_THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk' }),
		)
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: {}, intentIds: [THUMB_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'WishValidationError', field: 'intentIds' })
	})

	it('rejects when intent.entityType is not "wish"', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId:   FULL_INTENT_ID,
				kind:       'full',
				path:       NEW_FULL_PATH,
				entityType: 'expense',
				entityId:   WISH_ID,
			}))
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: {}, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})

	it('rejects when intent.entityId targets a different wish', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID,
				kind:     'full',
				path:     NEW_FULL_PATH,
				entityId: 'other-wish',
			}))
		await expect(wishFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, wishId: WISH_ID, patch: {}, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})
})

// ─── Stale-replace guard ──────────────────────────────────────────
//
// Closes the Tab A overwrites Tab B race: A loaded with image P1, B
// replaced with P2, A uploads P3 and finalizes. Without this guard,
// P3 silently replaces B's P2 AND A's safePurgeWithEnqueueFallback
// deletes the stale P1 it knows about, leaving B's P2 orphaned. With
// the guard, A's finalize hits 409 — client surfaces the error,
// re-loads the wish, and the editor reconciles. Mirrors the
// /booking-file-update stale-replace contract (same shape on purpose).

/** Wish doc with NO `image` field. Used to test the
 *  `expectedCurrentPath=string but doc.image absent` race (Tab B
 *  detached while Tab A was open). */
function imagelessWishReadDoc(proposedBy: string = CALLER_UID) {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/wishes/${WISH_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields: {
			tripId:     { stringValue: TRIP_ID },
			category:   { stringValue: 'place' },
			title:      { stringValue: 'no image yet' },
			proposedBy: { stringValue: proposedBy },
		},
	}
}

describe('wishFileUpdate: stale-replace guard', () => {
	it('expectedCurrentPath is a STALE string (Tab B replaced) → 409', async () => {
		// Doc says image.path = FULL_PATH, caller sends a different path
		// (the one they saw on load, before Tab B's replace landed).
		seedUpdateAuth()  // ownedWishReadDoc sets image.path = FULL_PATH
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		// storage mock not strictly needed (auth throws before intent
		// consumption) but seed it for symmetry with happy-path tests.
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: `trips/${TRIP_ID}/wishes/${WISH_ID}/stale-old.webp`,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		// No writes should have been captured — tx aborted on the stale
		// check, before consumeEntityIntents had a chance to run.
		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=null but doc.image exists (Tab B attached) → 409', async () => {
		// Caller's editor loaded with no image. While the form was open,
		// Tab B attached an image. Caller's upload would silently
		// overwrite Tab B's commit — reject so the editor reconciles.
		seedUpdateAuth()  // ownedWishReadDoc HAS image.path = FULL_PATH
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: null,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=string but doc.image absent (Tab B detached) → 409', async () => {
		// Caller's editor loaded with image P1. While the form was open,
		// Tab B detached the image (image field removed). Caller's
		// upload would resurrect a dead reference and the
		// safePurgeWithEnqueueFallback would target an already-deleted
		// blob — reject so the editor sees the detach.
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,     imagelessWishReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,  // editor saw P1; doc has no image now
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=null AND doc.image absent (first-attach happy path) → ok', async () => {
		// Symmetry check: a true first-attach (no concurrent edit)
		// commits cleanly. The guard normalises absent image to `null`,
		// so this comparison matches and the tx proceeds.
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('viewer'))
		txGetResponses.set(`trips/${TRIP_ID}/wishes/${WISH_ID}`,     imagelessWishReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		const result = await wishFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				wishId:              WISH_ID,
				patch:               { title: 'first attach' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: null,
			},
			'{}', BUCKET,
		)
		expect(result).toEqual({ ok: true })

		// 1 markUsed + 1 wish patch — same shape as the canonical happy
		// path, just with image landing for the first time.
		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes).toHaveLength(2)
	})
})
