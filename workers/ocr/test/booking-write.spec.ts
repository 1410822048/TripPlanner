// Endpoint-level tests for booking-write.ts.
//
// Same mocking strategy as wish-write.spec / expense-write.spec: mock
// at the `runFirestoreTransaction` boundary so the test seeds tx.get
// responses per-test, capture the TxResult to assert on writes +
// result shape. Storage object metadata is mocked at the
// getObjectMetadata boundary for intent consumption.
//
// What this file pins down (Phase 3.7):
//   - Worker-authoritative booking create with intentIds: caller must
//     be owner/editor (NO viewer); attachment field built from consumed
//     intents (not from request body); createdBy / updatedBy / memberIds
//     all stamped from caller / trip state.
//   - Intent markUsed writes commit atomically with the booking doc
//     write (one tx, markUsed first so a booking-write 409 leaves
//     intents pending for retry).
//   - createdAt + updatedAt stamped via REQUEST_TIME transforms.
//   - sortDate invariant: `checkInTs ?? createdAt`.
//       - create with parseable checkIn  -> Timestamp from checkIn
//       - create without checkIn          -> REQUEST_TIME transform
//       - update with new parseable checkIn -> Timestamp from checkIn
//       - update clearing checkIn ('')     -> copied from existing createdAt
//   - PDF primary (kind='pdf', no thumb) supported.
//   - Stale-replace guard via attachment.filePath (mirrors wish-write).
//   - Request body cannot smuggle a client-built `attachment` object.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/storage', () => ({
	getObjectMetadata:    vi.fn(),
	// path-only: consume strips the download token fail-closed; both resolve
	// truthy by default so the happy path proceeds. Specific tests override.
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

import { bookingFileCreate, bookingFileUpdate, BookingValidationError } from '../src/booking-write'
import * as storage from '../src/storage'

const TRIP_ID    = 'trip-1'
const BOOKING_ID = 'booking-1'
const CALLER_UID = 'editor-uid'
const BUCKET     = 'tripplanner-80a4f.firebasestorage.app'
const MEMBERS    = ['owner-uid', 'editor-uid', 'viewer-uid']

const FULL_INTENT_ID  = 'i-full'
const THUMB_INTENT_ID = 'i-thumb'
const PDF_INTENT_ID   = 'i-pdf'
const FULL_PATH       = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/abc123.webp`
const THUMB_PATH      = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/abc123.thumb.webp`
const PDF_PATH        = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/abc123.pdf`

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

function existingBookingReadDoc() {
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/bookings/${BOOKING_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields: {
			tripId:    { stringValue: TRIP_ID },
			type:      { stringValue: 'hotel' },
			createdBy: { stringValue: CALLER_UID },
		},
	}
}

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
}) {
	const uid         = opts.uid         ?? CALLER_UID
	const status      = opts.status      ?? 'pending'
	const entityId    = opts.entityId    ?? BOOKING_ID
	const entityType  = opts.entityType  ?? 'booking'
	const expiresAt   = new Date(opts.expiresAtMs ?? Date.now() + 30 * 60_000).toISOString()
	const contentType = opts.contentType ?? (opts.kind === 'pdf' ? 'application/pdf' : 'image/webp')
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
	kind:        'full' | 'thumb' | 'pdf'
	token?:      string
	size?:       number
	contentType?: string
}) {
	const customMetadata: Record<string, string> = {
		uploadIntentId: opts.intentId,
		uploaderUid:    CALLER_UID,
		tripId:         TRIP_ID,
		entityType:     'booking',
		entityId:       BOOKING_ID,
		kind:           opts.kind,
		schemaVersion:  'v1',
	}
	if (opts.token) customMetadata.firebaseStorageDownloadTokens = opts.token
	return {
		name:        opts.path,
		size:        opts.size ?? 50_000,
		contentType: opts.contentType ?? (opts.kind === 'pdf' ? 'application/pdf' : 'image/webp'),
		timeCreated: '2026-05-26T00:00:00Z',
		customMetadata,
	}
}

function validBookingPayload(overrides: Record<string, unknown> = {}) {
	return {
		type:  'hotel' as const,
		title: 'グランドハイアット東京',
		...overrides,
	}
}

function seedAuth(role: 'owner' | 'editor' | 'viewer' = 'editor') {
	txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc(role))
	txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`, notFoundReadDoc(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`))
}

beforeEach(() => {
	txGetResponses.clear()
	capturedTxResult = null
	vi.clearAllMocks()
	// clearAllMocks resets call history but NOT implementations, so restore
	// the strip default (the fail-closed test sets mockRejectedValue).
	vi.mocked(storage.updateObjectMetadata).mockResolvedValue(true)
	vi.mocked(storage.deleteObject).mockResolvedValue(true)
})

// ─── Happy paths ───────────────────────────────────────────────────

describe('bookingFileCreate: happy paths', () => {
	it('full + thumb intents → booking doc + attachment + markUsed in same tx, sortDate from checkIn', async () => {
		seedAuth('editor')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID,  kind: 'full',  path: FULL_PATH }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: FULL_PATH,  intentId: FULL_INTENT_ID,  kind: 'full',  token: 'tk-f' }))
			.mockResolvedValueOnce(storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk-t' }))

		const result = await bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   validBookingPayload({
					checkIn:  '2026-06-01',
					checkOut: '2026-06-03',
					address:  '東京都港区',
				}),
				intentIds: [FULL_INTENT_ID, THUMB_INTENT_ID],
			},
			'{}', BUCKET,
		)
		expect(result.bookingId).toBe(BOOKING_ID)

		const writes = capturedTxResult!.writes as Array<{
			document: string
			currentDocument?: { exists?: boolean }
			fields: Record<string, { stringValue?: string; timestampValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> }; arrayValue?: { values?: Array<{ stringValue?: string }> } }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>

		// 2 markUsed + 1 booking doc write
		expect(writes).toHaveLength(3)
		expect(writes[0].document).toContain(`/trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		expect(writes[1].fields.status?.stringValue).toBe('used')

		const bookingWrite = writes[2]!
		expect(bookingWrite.document).toContain(`/trips/${TRIP_ID}/bookings/${BOOKING_ID}`)
		expect(bookingWrite.currentDocument).toEqual({ exists: false })
		expect(bookingWrite.fields.tripId?.stringValue).toBe(TRIP_ID)
		expect(bookingWrite.fields.type?.stringValue).toBe('hotel')
		expect(bookingWrite.fields.title?.stringValue).toBe('グランドハイアット東京')
		expect(bookingWrite.fields.checkIn?.stringValue).toBe('2026-06-01')
		expect(bookingWrite.fields.checkOut?.stringValue).toBe('2026-06-03')
		expect(bookingWrite.fields.address?.stringValue).toBe('東京都港区')
		expect(bookingWrite.fields.createdBy?.stringValue).toBe(CALLER_UID)
		expect(bookingWrite.fields.updatedBy?.stringValue).toBe(CALLER_UID)

		// memberIds denormalised from trip doc.
		const memberIdValues = bookingWrite.fields.memberIds?.arrayValue?.values?.map(v => v.stringValue)
		expect(memberIdValues).toEqual(MEMBERS)

		// Attachment field built server-side (path-only BookingAttachment:
		// filePath/fileType + thumbPath; reads via getBlob + Storage
		// Rules, no bearer download URL is persisted).
		const att = bookingWrite.fields.attachment?.mapValue?.fields
		expect(att?.filePath?.stringValue).toBe(FULL_PATH)
		expect(att?.fileType?.stringValue).toBe('image/webp')
		expect(att?.thumbPath?.stringValue).toBe(THUMB_PATH)
		// token strip happened for both blobs at consume time.
		expect(vi.mocked(storage.updateObjectMetadata)).toHaveBeenCalledWith(
			expect.anything(), expect.anything(), FULL_PATH, { firebaseStorageDownloadTokens: null },
		)
		expect(vi.mocked(storage.updateObjectMetadata)).toHaveBeenCalledWith(
			expect.anything(), expect.anything(), THUMB_PATH, { firebaseStorageDownloadTokens: null },
		)

		// sortDate: parseable checkIn → Timestamp value present in fields,
		// NOT a transform.
		expect(bookingWrite.fields.sortDate?.timestampValue).toBeDefined()
		// '2026-06-01' parses to UTC midnight.
		expect(bookingWrite.fields.sortDate?.timestampValue).toBe('2026-06-01T00:00:00.000Z')

		// createdAt + updatedAt via transforms, NOT in fields map.
		expect(bookingWrite.fields.createdAt).toBeUndefined()
		expect(bookingWrite.fields.updatedAt).toBeUndefined()
		// sortDate is NOT in transforms (it was set in fields).
		const transformPaths = bookingWrite.updateTransforms?.map(t => t.fieldPath)
		expect(transformPaths).toEqual(['createdAt', 'updatedAt'])
	})

	it('create without checkIn → sortDate gets REQUEST_TIME transform alongside createdAt', async () => {
		seedAuth('owner')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   validBookingPayload({ type: 'flight', origin: 'NRT', destination: 'SFO' }),
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, { stringValue?: string; timestampValue?: string }>
			updateTransforms?: { fieldPath: string; setToServerValue: string }[]
		}>
		const bookingWrite = writes[1]!
		// sortDate NOT in fields (no checkIn).
		expect(bookingWrite.fields.sortDate).toBeUndefined()
		// sortDate IS in transforms, alongside createdAt + updatedAt.
		expect(bookingWrite.updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
			{ fieldPath: 'sortDate',  setToServerValue: 'REQUEST_TIME' },
		])
		expect(bookingWrite.fields.origin?.stringValue).toBe('NRT')
		expect(bookingWrite.fields.destination?.stringValue).toBe('SFO')
	})

	it('PDF intent (no thumb) → primary stored as PDF, attachment has no thumb fields', async () => {
		// Booking attachment supports PDFs (e-tickets, hotel confirmations).
		// kind='pdf' means primary is the PDF itself; no thumb intent.
		// buildAttachmentMapValue('booking', primary, undefined) returns
		// attachment with filePath/fileType only (no thumb*).
		seedAuth('editor')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${PDF_INTENT_ID}`,
			intentDoc({ intentId: PDF_INTENT_ID, kind: 'pdf', path: PDF_PATH, contentType: 'application/pdf' }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: PDF_PATH, intentId: PDF_INTENT_ID, kind: 'pdf', token: 'tk', contentType: 'application/pdf' }),
		)

		await bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   validBookingPayload({ type: 'train', confirmationCode: 'ABC123' }),
				intentIds: [PDF_INTENT_ID],
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, { stringValue?: string; mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		// 1 markUsed + 1 booking write.
		expect(writes).toHaveLength(2)
		const att = writes[1].fields.attachment?.mapValue?.fields
		expect(att?.filePath?.stringValue).toBe(PDF_PATH)
		expect(att?.fileType?.stringValue).toBe('application/pdf')
		// No thumb fields for PDF attachment.
		expect(att?.thumbPath).toBeUndefined()
		expect(writes[1].fields.confirmationCode?.stringValue).toBe('ABC123')
	})

	it('fail-closed: token strip fails after retry → blob deleted, ATTACHMENT_HARDENING_FAILED, no doc write', async () => {
		seedAuth('editor')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk-f' }))
		// Strip never sticks (transient GCS failure on every bounded retry).
		vi.mocked(storage.updateObjectMetadata).mockRejectedValue(new Error('GCS 503'))
		capturedTxResult = null

		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ code: 'ATTACHMENT_HARDENING_FAILED' })

		// Token-bearing blob deleted (no orphan with a live bearer URL) and
		// NO Firestore doc write captured (fail-closed: nothing committed).
		expect(storage.deleteObject).toHaveBeenCalledWith(expect.anything(), BUCKET, FULL_PATH)
		expect(capturedTxResult).toBeNull()
	})

	it('fail-closed: strip returns false (object 404 mid-write) → terminal, no doc write', async () => {
		seedAuth('editor')
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk-f' }))
		// updateObjectMetadata resolves FALSE = object 404'd between the
		// existence check and the strip PATCH. Must be treated as terminal,
		// not silently committed pointing at a missing blob.
		vi.mocked(storage.updateObjectMetadata).mockResolvedValue(false)
		capturedTxResult = null

		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ code: 'ATTACHMENT_HARDENING_FAILED' })

		expect(capturedTxResult).toBeNull()
	})
})

// ─── Authorization ────────────────────────────────────────────────

describe('bookingFileCreate: authorization', () => {
	it('trip not found → 404 CascadeError', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundReadDoc(`trips/${TRIP_ID}`))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})

	it('trip is cascade-deleting → 410 CascadeError', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, deletingAt: { timestampValue: '2026-05-26T00:00:00Z' } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 410 })
	})

	it('caller is not a trip member → 403 CascadeError', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('viewer-role caller is rejected (booking is owner/editor only, NOT viewer)', async () => {
		// Mirrors firestore.rules booking-create rule: `canWrite()` (owner
		// or editor). Reasserts the rule's semantics on the Worker path.
		// This is the key authz divergence from wish-write (any-member).
		seedAuth('viewer')
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})
})

// ─── Conflict / state ─────────────────────────────────────────────

describe('bookingFileCreate: state checks', () => {
	it('booking already exists at that id → 409 CascadeError (no overwrite)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`, existingBookingReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })
	})
})

// ─── Body validation ──────────────────────────────────────────────

describe('bookingFileCreate: body validation', () => {
	it('rejects when booking body is missing required `type`', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   { title: 'no type field' },  // missing required `type`
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when type is not in the enum', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)
		await expect(bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   { type: 'spaceship', title: 'x' },  // not in enum
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('REGRESSION: rejects request that smuggles a client-built attachment object in body', async () => {
		// Defense-in-depth: firestore.rules block client-direct attachment
		// writes on booking-create, but the Worker layer rejects early so
		// the failure is a clear 400 instead of a rules-commit deny.
		await expect(bookingFileCreate(
			CALLER_UID,
			{
				tripId:    TRIP_ID,
				bookingId: BOOKING_ID,
				booking:   {
					type:       'hotel',
					title:      'x',
					attachment: { filePath: 'x', fileType: 'image/webp' },
				},
				intentIds: [FULL_INTENT_ID],
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'attachment' })
	})

	it('rejects when intentIds has no full/pdf intent (thumb-only)', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk' }),
		)
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [THUMB_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'intentIds' })
	})
})

// ─── Intent scope binding ─────────────────────────────────────────

describe('bookingFileCreate: intent scope binding', () => {
	it('rejects when intent.entityType is not "booking" (cross-entity intent reuse)', async () => {
		// Caller mints a wish intent and tries to consume it via
		// booking-file-create. consumeEntityIntents's `expected.entityType
		// = "booking"` check inside consumeIntentInTx must catch this.
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId:   FULL_INTENT_ID,
				kind:       'full',
				path:       FULL_PATH,
				entityType: 'wish',  // wrong entity type
				entityId:   BOOKING_ID,
			}))
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})

	it('rejects when intent.entityId targets a different booking', async () => {
		seedAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID,
				kind:     'full',
				path:     FULL_PATH,
				entityId: 'other-booking',  // different booking
			}))
		await expect(bookingFileCreate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, booking: validBookingPayload(), intentIds: [FULL_INTENT_ID] },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})
})

// ─── /booking-file-update tests ───────────────────────────────────

const NEW_FULL_PATH  = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/xyz789.webp`
const NEW_THUMB_PATH = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/xyz789.thumb.webp`
const NEW_PDF_PATH   = `trips/${TRIP_ID}/bookings/${BOOKING_ID}/xyz789.pdf`

const EXISTING_CREATED_AT = '2026-05-20T12:34:56.000Z'

/** Booking doc that exists, with attachment + a stable createdAt
 *  Timestamp (for the cleared-checkIn sortDate fallback). The Worker
 *  reads `attachment.filePath` for the stale-replace guard and
 *  `createdAt` for the cleared-checkIn fallback. */
function ownedBookingReadDoc(opts: { attachmentFilePath?: string | null } = {}) {
	const fields: Record<string, unknown> = {
		tripId:    { stringValue: TRIP_ID },
		type:      { stringValue: 'hotel' },
		title:     { stringValue: 'old title' },
		createdBy: { stringValue: CALLER_UID },
		createdAt: { timestampValue: EXISTING_CREATED_AT },
		checkIn:   { stringValue: '2026-06-01' },
		sortDate:  { timestampValue: '2026-06-01T00:00:00.000Z' },
	}
	const filePath = opts.attachmentFilePath === undefined ? FULL_PATH : opts.attachmentFilePath
	if (filePath !== null) {
		fields.attachment = {
			mapValue: {
				fields: {
					filePath:  { stringValue: filePath },
					fileType:  { stringValue: 'image/webp' },
					thumbPath: { stringValue: 'x/old-thumb' },
				},
			},
		}
	}
	return {
		exists: true,
		name:   `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/bookings/${BOOKING_ID}`,
		updateTime: '2026-05-26T00:00:00Z',
		fields,
	}
}

function seedUpdateAuth(opts: {
	role?:               'owner' | 'editor' | 'viewer'
	attachmentFilePath?: string | null
} = {}) {
	txGetResponses.set(`trips/${TRIP_ID}`,                       tripReadDoc())
	txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc(opts.role ?? 'editor'))
	txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`,
		ownedBookingReadDoc({ attachmentFilePath: opts.attachmentFilePath }))
}

// ─── Happy paths ──────────────────────────────────────────────────

describe('bookingFileUpdate: happy paths', () => {
	it('text patch + new image (full+thumb) → attachment + text + markUsed in one tx', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID,  kind: 'full',  path: NEW_FULL_PATH }))
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: NEW_THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata)
			.mockResolvedValueOnce(storageMeta({ path: NEW_FULL_PATH,  intentId: FULL_INTENT_ID,  kind: 'full',  token: 'tk-f' }))
			.mockResolvedValueOnce(storageMeta({ path: NEW_THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk-t' }))

		const result = await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'new title', note: 'updated' },
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

		// 2 markUsed + 1 booking-patch
		expect(writes).toHaveLength(3)
		expect(writes[0].fields.status?.stringValue).toBe('used')
		expect(writes[1].fields.status?.stringValue).toBe('used')

		const patch = writes[2]!
		expect(patch.document).toContain(`/trips/${TRIP_ID}/bookings/${BOOKING_ID}`)
		expect(patch.currentDocument).toEqual({ exists: true })
		// attachment + updatedBy + title + note
		const maskSet = new Set(patch.updateMask)
		expect(maskSet.has('attachment')).toBe(true)
		expect(maskSet.has('updatedBy')).toBe(true)
		expect(maskSet.has('title')).toBe(true)
		expect(maskSet.has('note')).toBe(true)
		expect(maskSet.has('type')).toBe(false)
		expect(maskSet.has('checkIn')).toBe(false)

		expect(patch.fields.updatedBy?.stringValue).toBe(CALLER_UID)
		expect(patch.fields.title?.stringValue).toBe('new title')
		expect(patch.fields.note?.stringValue).toBe('updated')

		// New attachment bytes (path-only, no bearer download URL).
		const att = patch.fields.attachment?.mapValue?.fields
		expect(att?.filePath?.stringValue).toBe(NEW_FULL_PATH)
		expect(att?.fileType?.stringValue).toBe('image/webp')
		expect(att?.thumbPath?.stringValue).toBe(NEW_THUMB_PATH)

		// updatedAt via transforms; createdAt untouched.
		expect(patch.fields.updatedAt).toBeUndefined()
		expect(patch.fields.createdAt).toBeUndefined()
		expect(patch.updateTransforms).toEqual([
			{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
		])
	})

	it('empty patch + new image → attachment-only replace (mask = attachment + updatedBy)', async () => {
		// Use case: user picks a new attachment but doesn't touch any text
		// fields. mask must not include text fields, otherwise we'd
		// overwrite them with `undefined` (Firestore would treat that
		// as field-delete via mask-without-field semantics).
		seedUpdateAuth({ role: 'owner' })
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
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
		// Exactly two keys: attachment + updatedBy.
		expect(patch.updateMask).toEqual(['attachment', 'updatedBy'])
		expect(Object.keys(patch.fields)).toEqual(['attachment', 'updatedBy'])
	})

	it('PDF replace (no thumb) → attachment has no thumb fields', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${PDF_INTENT_ID}`,
			intentDoc({ intentId: PDF_INTENT_ID, kind: 'pdf', path: NEW_PDF_PATH, contentType: 'application/pdf' }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_PDF_PATH, intentId: PDF_INTENT_ID, kind: 'pdf', token: 'tk', contentType: 'application/pdf' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'pdf attachment' },
				intentIds:           [PDF_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			fields: Record<string, { mapValue?: { fields: Record<string, { stringValue?: string }> } }>
		}>
		const att = writes[1].fields.attachment?.mapValue?.fields
		expect(att?.filePath?.stringValue).toBe(NEW_PDF_PATH)
		expect(att?.fileType?.stringValue).toBe('application/pdf')
		expect(att?.thumbPath).toBeUndefined()
	})

	it('patch with new parseable checkIn → sortDate recomputed to Timestamp from checkIn', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { checkIn: '2026-07-15' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, { stringValue?: string; timestampValue?: string }>
		}>
		const patch = writes[1]!
		expect(new Set(patch.updateMask)).toContain('sortDate')
		expect(patch.fields.sortDate?.timestampValue).toBe('2026-07-15T00:00:00.000Z')
		expect(patch.fields.checkIn?.stringValue).toBe('2026-07-15')
	})

	it('patch clearing checkIn (empty string) → sortDate copied from existing createdAt', async () => {
		// Invariant verbatim: when checkIn is cleared in an update, the
		// Worker reads the current doc's createdAt (already loaded for the
		// stale-replace guard) and copies it verbatim into sortDate.
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { checkIn: '' },  // clear
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, { stringValue?: string; timestampValue?: string }>
		}>
		const patch = writes[1]!
		// checkIn is cleared (in mask but not in fields).
		expect(patch.updateMask).toContain('checkIn')
		expect(patch.fields.checkIn).toBeUndefined()
		// sortDate copied verbatim from existing createdAt.
		expect(patch.updateMask).toContain('sortDate')
		expect(patch.fields.sortDate?.timestampValue).toBe(EXISTING_CREATED_AT)
	})

	it('patch with empty-string text fields → field deletion via mask (no values in fields)', async () => {
		// CLEARABLE_BOOKING_FIELDS empty-string → omit from fields,
		// include in updateMask (REST PATCH's field-deletion convention).
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { note: '', address: '', link: '' },
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
		expect(patch.updateMask).toContain('note')
		expect(patch.updateMask).toContain('address')
		// link is CLEARABLE too: empty-string → mask entry, no field value.
		expect(patch.updateMask).toContain('link')
		expect(patch.fields.note).toBeUndefined()
		expect(patch.fields.address).toBeUndefined()
		expect(patch.fields.link).toBeUndefined()
	})

	it('patch with a valid https link → written to fields', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { link: 'https://www.booking.com/hotel/jp/abc.html' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)
		const writes = capturedTxResult!.writes as Array<{
			updateMask?: string[]
			fields: Record<string, { stringValue?: string }>
		}>
		const patch = writes[1]!
		expect(patch.updateMask).toContain('link')
		expect(patch.fields.link?.stringValue).toBe('https://www.booking.com/hotel/jp/abc.html')
	})
})

// ─── Authorization ───────────────────────────────────────────────

describe('bookingFileUpdate: authorization', () => {
	it('trip not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundReadDoc(`trips/${TRIP_ID}`))
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`, ownedBookingReadDoc())
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})

	it('trip is cascade-deleting → 410', async () => {
		const trip = tripReadDoc()
		trip.fields = { ...trip.fields, deletingAt: { timestampValue: '2026-05-26T00:00:00Z' } }
		txGetResponses.set(`trips/${TRIP_ID}`, trip)
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`, ownedBookingReadDoc())
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 410 })
	})

	it('caller is not a trip member → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${CALLER_UID}`))
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`, ownedBookingReadDoc())
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('viewer-role caller is rejected (booking-update is owner/editor only)', async () => {
		seedUpdateAuth({ role: 'viewer' })
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 403 })
	})

	it('booking doc not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${CALLER_UID}`, memberReadDoc('editor'))
		txGetResponses.set(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`,
			notFoundReadDoc(`trips/${TRIP_ID}/bookings/${BOOKING_ID}`))
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: { title: 'x' }, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 404 })
	})
})

// ─── Body validation ──────────────────────────────────────────────

describe('bookingFileUpdate: body validation', () => {
	it('rejects when patch is not an object', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: 'not-an-object', intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'patch' })
	})

	it('REGRESSION: rejects when patch tries to smuggle an attachment object', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { attachment: { filePath: 'x', fileType: 'image/webp' } },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'attachment' })
	})

	it('rejects unknown patch field (allowlist gate)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { createdBy: 'someone-else' },  // immutable; not in allowlist
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'createdBy' })
	})

	it('rejects when title is too long', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'x'.repeat(101) },  // max=100
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	// SECURITY: Worker uses admin SDK and bypasses firestore.rules, so any
	// cap rules enforce but the Worker schema omits is a real exploit
	// (caller posts megabyte payload, Worker writes via admin). These
	// caps were missing before 2026-05-27 — drift caught in a
	// post-Phase-3.7 audit. Tests pin Worker schema to the three-way
	// lockstep with firestore.rules + src/types/booking.ts.
	it('rejects when origin exceeds rules cap (60 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { origin: 'x'.repeat(61) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when destination exceeds rules cap (60 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { destination: 'x'.repeat(61) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when confirmationCode exceeds rules cap (64 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { confirmationCode: 'x'.repeat(65) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when provider exceeds rules cap (60 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { provider: 'x'.repeat(61) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when address exceeds rules cap (500 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { address: 'x'.repeat(501) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when note exceeds rules cap (2000 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { note: 'x'.repeat(2001) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when checkIn exceeds rules cap (32 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { checkIn: 'x'.repeat(33) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when checkOut exceeds rules cap (32 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { checkOut: 'x'.repeat(33) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	// SECURITY: link renders into an <a href>. The Worker bypasses
	// firestore.rules (admin SDK), so its scheme check MUST reject
	// javascript:/data: just like the client Zod refine + the rules
	// `^https?://.+` regex. A looser Worker = a real stored-XSS hole.
	it('rejects when link is not an http(s) URL (javascript: scheme)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { link: 'javascript:alert(document.cookie)' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	it('rejects when link exceeds rules cap (500 chars)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { link: 'https://e.com/' + 'x'.repeat(500) },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})

	// DRIFT GUARD: new URL() lowercases the scheme, so a naive check would
	// accept HTTPS://. The rules regex `^https?://.+` is lowercase-only —
	// admin SDK bypasses rules, so accepting it here would write an
	// uppercase-scheme link that then jams every later client update.
	it('rejects an uppercase-scheme link (rules regex is lowercase-only)', async () => {
		seedUpdateAuth()
		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { link: 'HTTPS://example.com' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,
			},
			'{}', BUCKET,
		)).rejects.toBeInstanceOf(BookingValidationError)
	})
})

// ─── Intent scope binding ─────────────────────────────────────────

describe('bookingFileUpdate: intent scope binding', () => {
	it('rejects thumb-only intent set (no primary)', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${THUMB_INTENT_ID}`,
			intentDoc({ intentId: THUMB_INTENT_ID, kind: 'thumb', path: NEW_THUMB_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValue(
			storageMeta({ path: NEW_THUMB_PATH, intentId: THUMB_INTENT_ID, kind: 'thumb', token: 'tk' }),
		)
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: {}, intentIds: [THUMB_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ name: 'BookingValidationError', field: 'intentIds' })
	})

	it('rejects when intent.entityType is not "booking"', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId:   FULL_INTENT_ID,
				kind:       'full',
				path:       NEW_FULL_PATH,
				entityType: 'wish',
				entityId:   BOOKING_ID,
			}))
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: {}, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})

	it('rejects when intent.entityId targets a different booking', async () => {
		seedUpdateAuth()
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({
				intentId: FULL_INTENT_ID,
				kind:     'full',
				path:     NEW_FULL_PATH,
				entityId: 'other-booking',
			}))
		await expect(bookingFileUpdate(
			CALLER_UID,
			{ tripId: TRIP_ID, bookingId: BOOKING_ID, patch: {}, intentIds: [FULL_INTENT_ID], expectedCurrentPath: FULL_PATH },
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 400 })
	})
})

// ─── Stale-replace guard ──────────────────────────────────────────
//
// Closes the Tab A overwrites Tab B race via attachment.filePath. Same
// shape as wish-file-update's guard (uniform error mode across Worker
// endpoints) but reads `attachment.filePath` instead of `image.path`.

describe('bookingFileUpdate: stale-replace guard', () => {
	it('expectedCurrentPath is a STALE string (Tab B replaced) → 409', async () => {
		// Doc says attachment.filePath = FULL_PATH, caller sends a
		// different path (the one they saw on load, before Tab B's replace
		// landed).
		seedUpdateAuth()  // ownedBookingReadDoc sets attachment.filePath = FULL_PATH
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: `trips/${TRIP_ID}/bookings/${BOOKING_ID}/stale-old.webp`,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		// No writes should have been captured — tx aborted on the stale
		// check, before consumeEntityIntents had a chance to run.
		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=null but doc.attachment exists (Tab B attached) → 409', async () => {
		// Caller's editor loaded with no attachment. While the form was
		// open, Tab B attached a file. Caller's upload would silently
		// overwrite Tab B's commit — reject so the editor reconciles.
		seedUpdateAuth()  // ownedBookingReadDoc HAS attachment.filePath = FULL_PATH
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: null,
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=string but doc.attachment absent (Tab B detached) → 409', async () => {
		// Caller's editor loaded with attachment P1. While the form was
		// open, Tab B detached the attachment (field removed). Caller's
		// upload would resurrect a dead reference; safePurge would target
		// an already-deleted blob — reject so the editor sees the detach.
		seedUpdateAuth({ attachmentFilePath: null })  // doc has no attachment
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		await expect(bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'x' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: FULL_PATH,  // editor saw P1; doc has no attachment now
			},
			'{}', BUCKET,
		)).rejects.toMatchObject({ status: 409 })

		expect(capturedTxResult).toBeNull()
	})

	it('expectedCurrentPath=null AND doc.attachment absent (first-attach happy path) → ok', async () => {
		// Symmetry check: a true first-attach (no concurrent edit) commits
		// cleanly. The guard normalises absent attachment to `null`, so
		// this comparison matches and the tx proceeds.
		seedUpdateAuth({ attachmentFilePath: null })
		txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${FULL_INTENT_ID}`,
			intentDoc({ intentId: FULL_INTENT_ID, kind: 'full', path: NEW_FULL_PATH }))
		vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce(
			storageMeta({ path: NEW_FULL_PATH, intentId: FULL_INTENT_ID, kind: 'full', token: 'tk' }),
		)

		const result = await bookingFileUpdate(
			CALLER_UID,
			{
				tripId:              TRIP_ID,
				bookingId:           BOOKING_ID,
				patch:               { title: 'first attach' },
				intentIds:           [FULL_INTENT_ID],
				expectedCurrentPath: null,
			},
			'{}', BUCKET,
		)
		expect(result).toEqual({ ok: true })

		// 1 markUsed + 1 booking patch — same shape as the canonical happy
		// path, just with attachment landing for the first time.
		const writes = capturedTxResult!.writes as Array<{ fields: Record<string, unknown> }>
		expect(writes).toHaveLength(2)
	})
})
