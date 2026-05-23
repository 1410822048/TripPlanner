// Tests for the Phase 3.5 client-side upload intent primitive.
//
// Coverage focus per reviewer's pre-rules-tightening ask:
//   1. requestUploadIntents -- body shape sent to Worker /upload-intents
//      (tripId / entityType / entityId / uploads array structure).
//   2. uploadToIntent       -- metadata (contentType + customMetadata)
//      verbatim pass-through to uploadBytesResumable. This is the
//      load-bearing contract: storage.rules will verify that
//      request.resource.metadata.customMetadata exactly matches the
//      intent doc's customMetadata, so any drift here would 403 the
//      upload after rules tighten.
//   3. finalizeUploadIntents -- body has intentIds + return is the
//      raw FinalizeResponse from Worker (no client transformation).
//
// All three are pure orchestration on top of workerFetch +
// Firebase Storage SDK; tests stub the boundary calls and assert on
// arguments + return.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const workerFetchMock = vi.fn()
const uploadBytesResumableMock = vi.fn()
// Inline implementations on these two are typed deliberately loose
// (using vi.fn() with no impl gives a Mock<any[], any> that tolerates
// the `(...args: unknown[])` spread pattern below; vi.fn(typedImpl)
// would lock the param shape and break strict-mode tsc on the spread).
const refMock = vi.fn()
const uploadFileMock = vi.fn()

vi.mock('./workerBase', () => ({
	requireWorkerWriteBase: vi.fn(() => 'https://worker.example.com'),
	preflightIdToken:       vi.fn(async () => 'fake-id-token'),
	workerFetch:            (...args: unknown[]) => workerFetchMock(...args),
}))

vi.mock('./firebase', () => ({
	getFirebaseStorage: vi.fn(async () => ({
		storage:               {},
		ref:                   refMock,
		uploadBytesResumable:  uploadBytesResumableMock,
	})),
}))

vi.mock('./storageUpload', () => ({
	uploadFile:        (...args: unknown[]) => uploadFileMock(...args),
	UPLOAD_TIMEOUT_MS: 30_000,
}))

// retry pass-through so the primitive's retry wrapping is transparent
// for these unit tests. Retry semantics themselves are covered in
// src/utils/retry tests; here we want to assert the primitive's
// orchestration contract, not its retry plumbing.
vi.mock('@/utils/retry', () => ({
	retry:                   <T,>(fn: () => Promise<T>) => fn(),
	isTransientStorageError: () => false,
}))

import {
	requestUploadIntents,
	uploadToIntent,
	finalizeUploadIntents,
	type UploadIntent,
} from './uploadIntent'

beforeEach(() => {
	workerFetchMock.mockReset()
	uploadBytesResumableMock.mockReset()
	refMock.mockReset()
	uploadFileMock.mockReset()
	uploadFileMock.mockResolvedValue({ _kind: 'storage-ref' })
})

// ─── requestUploadIntents ─────────────────────────────────────────

describe('requestUploadIntents', () => {
	it('POSTs to /upload-intents with the full request body verbatim', async () => {
		workerFetchMock.mockResolvedValueOnce({
			intents: [{ intentId: 'i1', path: 'p1', metadata: { contentType: 'image/webp', customMetadata: {} }, expiresAt: 'X' }],
		})
		const req = {
			tripId:     'trip-1',
			entityType: 'expense' as const,
			entityId:   'exp-1',
			uploads:    [
				{ kind: 'full' as const,  contentType: 'image/webp', size: 1000 },
				{ kind: 'thumb' as const, contentType: 'image/webp', size: 200 },
			],
		}
		await requestUploadIntents(req)
		expect(workerFetchMock).toHaveBeenCalledTimes(1)
		// signature: (base, token, endpoint, body)
		const [base, token, endpoint, body] = workerFetchMock.mock.calls[0]!
		expect(base).toBe('https://worker.example.com')
		expect(token).toBe('fake-id-token')
		expect(endpoint).toBe('/upload-intents')
		expect(body).toEqual(req)  // full body verbatim, no extra fields
	})

	it('returns intents[] from worker response unchanged', async () => {
		const intents: UploadIntent[] = [
			{ intentId: 'a', path: 'pa', metadata: { contentType: 'image/jpeg', customMetadata: { kind: 'full' } }, expiresAt: '2026-05-23T01:00:00Z' },
			{ intentId: 'b', path: 'pb', metadata: { contentType: 'image/webp', customMetadata: { kind: 'thumb' } }, expiresAt: '2026-05-23T01:00:00Z' },
		]
		workerFetchMock.mockResolvedValueOnce({ intents })
		const result = await requestUploadIntents({
			tripId: 't', entityType: 'booking', entityId: 'b1',
			uploads: [{ kind: 'full', contentType: 'image/jpeg', size: 100 }],
		})
		expect(result).toEqual(intents)
	})

	it('propagates worker errors (e.g. 403 from /upload-intents)', async () => {
		workerFetchMock.mockRejectedValueOnce(new Error('403 not member'))
		await expect(requestUploadIntents({
			tripId: 't', entityType: 'expense', entityId: 'x',
			uploads: [{ kind: 'full', contentType: 'image/webp', size: 1 }],
		})).rejects.toThrow(/403/)
	})
})

// ─── uploadToIntent ───────────────────────────────────────────────

describe('uploadToIntent', () => {
	const sampleIntent: UploadIntent = {
		intentId: 'i-x',
		path:     'trips/T/expenses/E/file.webp',
		metadata: {
			contentType:    'image/webp',
			customMetadata: {
				uploadIntentId: 'i-x',
				uploaderUid:    'user-1',
				tripId:         'T',
				entityType:     'expense',
				entityId:       'E',
				kind:           'full',
				schemaVersion:  'v1',
			},
		},
		expiresAt: '2026-05-23T01:00:00Z',
	}

	it('uploads to intent.path with intent.metadata verbatim', async () => {
		// Headline assertion: customMetadata passed to uploadBytesResumable
		// MUST be byte-identical to intent.metadata.customMetadata. Once
		// storage.rules tighten, any drift (extra key, missing key,
		// different value) makes the upload 403.
		const file = new Blob(['x'], { type: 'image/webp' })
		await uploadToIntent(sampleIntent, file, 'expense-full')

		expect(refMock).toHaveBeenCalledWith({}, 'trips/T/expenses/E/file.webp')
		expect(uploadBytesResumableMock).toHaveBeenCalledTimes(1)
		const [_ref, payload, metadata] = uploadBytesResumableMock.mock.calls[0]!
		expect(payload).toBe(file)
		expect(metadata).toEqual({
			contentType:    'image/webp',
			customMetadata: sampleIntent.metadata.customMetadata,
		})
	})

	it('uses the intent\'s path for ref(), not any caller-supplied path', async () => {
		// Pin the server-owned-path contract: no parameter overrides path.
		await uploadToIntent(
			{ ...sampleIntent, path: 'server-mandated/path.bin' },
			new Blob(['y']),
			'test',
		)
		expect(refMock).toHaveBeenCalledWith({}, 'server-mandated/path.bin')
	})

	it('propagates uploadFile errors (timeout / transient SDK error)', async () => {
		uploadFileMock.mockRejectedValueOnce(new Error('upload timeout'))
		await expect(uploadToIntent(sampleIntent, new Blob(['x']), 'expense-full'))
			.rejects.toThrow(/upload timeout/)
	})
})

// ─── finalizeUploadIntents ────────────────────────────────────────

describe('finalizeUploadIntents', () => {
	it('POSTs to /upload-finalize with { intentIds }', async () => {
		workerFetchMock.mockResolvedValueOnce({
			ok: true, entityType: 'booking', tripId: 'T', entityId: 'B', blobs: [],
		})
		await finalizeUploadIntents(['i1', 'i2'])

		expect(workerFetchMock).toHaveBeenCalledTimes(1)
		const [base, token, endpoint, body] = workerFetchMock.mock.calls[0]!
		expect(base).toBe('https://worker.example.com')
		expect(token).toBe('fake-id-token')
		expect(endpoint).toBe('/upload-finalize')
		expect(body).toEqual({ intentIds: ['i1', 'i2'] })
	})

	it('returns FinalizeResponse from worker unchanged', async () => {
		const response = {
			ok:         true as const,
			entityType: 'wish' as const,
			tripId:     'T-2',
			entityId:   'W-3',
			blobs: [
				{ kind: 'full'  as const, path: 'p1', url: 'https://x?token=a', contentType: 'image/webp', size: 1000 },
				{ kind: 'thumb' as const, path: 'p2', url: 'https://y?token=b', contentType: 'image/webp', size: 100  },
			],
		}
		workerFetchMock.mockResolvedValueOnce(response)
		const result = await finalizeUploadIntents(['a', 'b'])
		expect(result).toEqual(response)
	})

	it('propagates worker errors (e.g. 409 used)', async () => {
		workerFetchMock.mockRejectedValueOnce(new Error('409 already used'))
		await expect(finalizeUploadIntents(['i-x'])).rejects.toThrow(/409/)
	})
})
