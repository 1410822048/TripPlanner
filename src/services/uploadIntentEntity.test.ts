// Tests for the Phase 3.7 shared mint+upload composer.
//
// Coverage focus: the by-kind pairing contract. Worker /upload-intents
// currently returns intents in request order, but `mintAndUploadEntityIntents`
// does NOT rely on that — it pairs by `customMetadata.kind`. These tests
// pin the contract by:
//
//   1. Mock Worker returning intents in REVERSE order ([thumb, full])
//      and assert the full File still uploads to the full intent + the
//      thumb File still uploads to the thumb intent.
//   2. Mock Worker returning intents missing the expected primary kind →
//      throw with a descriptive error (not a silent undefined).
//
// The orchestration layers above (booking/wish/expense services) all
// rely on this pairing being correct — wrong-blob-to-wrong-intent is a
// silent storage-corruption class bug that would only surface visually
// when the user opens a thumbnail-sized full image (or vice versa).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const requestUploadIntentsMock = vi.fn()
const uploadToIntentMock        = vi.fn()
const validatePdfPageLimitMock  = vi.fn()

vi.mock('./uploadIntent', () => ({
	requestUploadIntents: (...args: unknown[]) => requestUploadIntentsMock(...args),
	uploadToIntent:       (...args: unknown[]) => uploadToIntentMock(...args),
}))

vi.mock('@/utils/pdfPageLimit', () => ({
	validatePdfPageLimit: (...args: unknown[]) => validatePdfPageLimitMock(...args),
}))

import { mintAndUploadEntityIntents } from './uploadIntentEntity'
import type { UploadIntent } from './uploadIntent'

// Helper: build an intent shape with the customMetadata.kind we want.
function intent(kind: 'full' | 'thumb' | 'pdf', intentId: string, path: string): UploadIntent {
	return {
		intentId,
		path,
		metadata: {
			contentType:    kind === 'pdf' ? 'application/pdf' : 'image/webp',
			customMetadata: {
				uploadIntentId: intentId,
				uploaderUid:    'u',
				tripId:         't',
				entityType:     'expense',
				entityId:       'e',
				kind,
				schemaVersion:  'v1',
			},
		},
		expiresAt: '2026-05-28T00:00:00Z',
	}
}

beforeEach(() => {
	requestUploadIntentsMock.mockReset()
	uploadToIntentMock.mockReset()
	validatePdfPageLimitMock.mockReset()
	uploadToIntentMock.mockResolvedValue({ _kind: 'storage-ref' })
	validatePdfPageLimitMock.mockResolvedValue(undefined)
})

describe('mintAndUploadEntityIntents', () => {
	it('pairs intents by customMetadata.kind even when Worker returns them in REVERSED order', async () => {
		// Worker contract is "returned in request order", but we don't
		// trust it. Reversed-order response must still upload the
		// correct file to the correct intent.
		const fullFile  = new File(['FULL_BYTES'],  'full.webp',  { type: 'image/webp' })
		const thumbFile = new File(['THUMB_BYTES'], 'thumb.webp', { type: 'image/webp' })

		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('thumb', 'i-thumb', 'p-thumb'),  // ← order swapped
			intent('full',  'i-full',  'p-full'),
		])

		await mintAndUploadEntityIntents({
			tripId:     't', entityType: 'expense', entityId: 'e',
			compressed: { full: fullFile, thumb: thumbFile },
		})

		// Each uploadToIntent call: (intent, file, label).
		expect(uploadToIntentMock).toHaveBeenCalledTimes(2)
		const calls = uploadToIntentMock.mock.calls as Array<[UploadIntent, File, string]>
		// Find by label so the test isn't sensitive to Promise.all
		// resolution ordering (functionally either order is correct).
		const fullCall  = calls.find(c => c[2] === 'expense-full')!
		const thumbCall = calls.find(c => c[2] === 'expense-thumb')!

		// Headline: full file uploads to the full intent, thumb to thumb.
		// If index-based pairing crept back in, fullCall[0] would carry
		// `i-thumb` here and the test would fail loudly.
		expect(fullCall[0].intentId).toBe('i-full')
		expect(fullCall[0].path).toBe('p-full')
		expect(fullCall[1]).toBe(fullFile)

		expect(thumbCall[0].intentId).toBe('i-thumb')
		expect(thumbCall[0].path).toBe('p-thumb')
		expect(thumbCall[1]).toBe(thumbFile)
	})

	it('uses kind=pdf as the primary when full.type is application/pdf', async () => {
		// PDF receipts skip thumb (image compression returns { full } only).
		// Pairing must look up by `pdf`, not `full`, to find the intent.
		const pdfFile = new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })

		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('pdf', 'i-pdf', 'p-pdf'),
		])

		await mintAndUploadEntityIntents({
			tripId: 't', entityType: 'expense', entityId: 'e',
			compressed: { full: pdfFile },
		})

		expect(uploadToIntentMock).toHaveBeenCalledTimes(1)
		expect(validatePdfPageLimitMock).toHaveBeenCalledWith(pdfFile)
		const [intentArg, fileArg, label] = uploadToIntentMock.mock.calls[0]! as [UploadIntent, File, string]
		expect(intentArg.intentId).toBe('i-pdf')
		expect(fileArg).toBe(pdfFile)
		expect(label).toBe('expense-pdf')
	})

	it('rejects an over-limit PDF before minting intents or uploading bytes', async () => {
		const pdfFile = new File(['%PDF-1.4'], 'too-long.pdf', { type: 'application/pdf' })
		validatePdfPageLimitMock.mockRejectedValueOnce(new Error('PDF page limit exceeded'))

		await expect(mintAndUploadEntityIntents({
			tripId: 't', entityType: 'expense', entityId: 'e',
			compressed: { full: pdfFile },
		})).rejects.toThrow(/page limit/)

		expect(requestUploadIntentsMock).not.toHaveBeenCalled()
		expect(uploadToIntentMock).not.toHaveBeenCalled()
	})

	it('throws when Worker response is missing the expected primary intent', async () => {
		// Worker bug / contract violation: returned only a thumb intent
		// when a full was requested. Must throw with a descriptive error,
		// not silently call uploadToIntent with `undefined`.
		const fullFile = new File(['x'], 'full.webp', { type: 'image/webp' })
		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('thumb', 'i-thumb', 'p-thumb'),
		])

		await expect(mintAndUploadEntityIntents({
			tripId: 't', entityType: 'expense', entityId: 'e',
			compressed: { full: fullFile },
		})).rejects.toThrow(/missing full intent/)
		expect(uploadToIntentMock).not.toHaveBeenCalled()
	})

	it('throws when caller requested a thumb but Worker returned no thumb intent', async () => {
		const fullFile  = new File(['x'], 'full.webp',  { type: 'image/webp' })
		const thumbFile = new File(['y'], 'thumb.webp', { type: 'image/webp' })
		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('full', 'i-full', 'p-full'),
		])

		await expect(mintAndUploadEntityIntents({
			tripId: 't', entityType: 'expense', entityId: 'e',
			compressed: {
				full:  fullFile,
				thumb: thumbFile,
			},
		})).rejects.toThrow(/missing thumb intent/)
		expect(uploadToIntentMock).not.toHaveBeenCalled()
	})

	it('forwards mode to requestUploadIntents (wish-only authz discriminator)', async () => {
		// mode='create' is wish-only at the Worker authz layer, but this
		// helper still has to forward it transparently — verifying with
		// expense entityType because the assertion is on the forwarded
		// body, not Worker behavior.
		const fullFile = new File(['x'], 'full.webp', { type: 'image/webp' })
		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('full', 'i-full', 'p-full'),
		])

		await mintAndUploadEntityIntents({
			tripId: 't', entityType: 'wish', entityId: 'w',
			compressed: { full: fullFile },
			mode:       'create',
		})

		const body = requestUploadIntentsMock.mock.calls[0]![0]
		expect(body).toMatchObject({
			tripId:     't',
			entityType: 'wish',
			entityId:   'w',
			mode:       'create',
		})
	})

	it('mints a per-flow traceId, forwards it to requestUploadIntents, and returns it', async () => {
		// Phase 3.7 observability contract: ONE traceId per flow, threaded
		// through both legs (intent mint + feature-service entity-write).
		// The composer mints with crypto.randomUUID(), forwards via the
		// requestUploadIntents opts arg, and surfaces the same value in
		// the return tuple so feature services can pass it to their own
		// workerFetch entity-write call.
		const fullFile = new File(['x'], 'full.webp', { type: 'image/webp' })
		requestUploadIntentsMock.mockResolvedValueOnce([
			intent('full', 'i-full', 'p-full'),
		])

		const { traceId } = await mintAndUploadEntityIntents({
			tripId: 't', entityType: 'expense', entityId: 'e',
			compressed: { full: fullFile },
		})

		// Return value carries the traceId (non-empty string).
		expect(typeof traceId).toBe('string')
		expect(traceId.length).toBeGreaterThanOrEqual(12)

		// Opts forwarded to requestUploadIntents carries the SAME id.
		// A regression that minted two separate UUIDs (one for the
		// composer return, another for the requestUploadIntents call)
		// would silently break correlation.
		const opts = requestUploadIntentsMock.mock.calls[0]![1] as { traceId: string }
		expect(opts.traceId).toBe(traceId)
	})
})
