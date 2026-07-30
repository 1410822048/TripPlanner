// Tests for the Phase 3.5 client-side upload intent primitive.
//
// Coverage focus per reviewer's pre-rules-tightening ask:
//   1. requestUploadIntents -- body shape sent to Worker /upload-intents
//      (tripId / entityType / entityId / uploads array structure).
//   2. uploadToIntent       -- raw bytes and trace headers are sent to the
//      authenticated /attachment-upload endpoint. The Worker loads the
//      intent-bound canonical path and metadata instead of trusting client
//      claims, then entity-write endpoints compare the R2 object's metadata against
//      the intent doc's stored customMetadata for exact-match
//      equality. Drift in any claimed field caught at one layer or
//      the other; verbatim pass-through is the only safe path.
//
// Both are pure orchestration on top of workerFetch; tests stub the
// boundary calls and assert on arguments
// + return.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const workerFetchMock = vi.fn()
const workerRawUploadMock = vi.fn()
// Inline implementations on these two are typed deliberately loose
// (using vi.fn() with no impl gives a Mock<any[], any> that tolerates
// the `(...args: unknown[])` spread pattern below; vi.fn(typedImpl)
// would lock the param shape and break strict-mode tsc on the spread).

vi.mock('./workerBase', () => ({
	requireWorkerWriteBase: vi.fn(() => 'https://worker.example.com'),
	preflightIdToken:       vi.fn(async () => 'fake-id-token'),
	workerFetch:            (...args: unknown[]) => workerFetchMock(...args),
	workerRawUpload:         (...args: unknown[]) => workerRawUploadMock(...args),
	WorkerAmbiguous:         class WorkerAmbiguous extends Error {},
	WORKER_FETCH_TIMEOUT_MS: 30_000,
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
	type UploadIntent,
} from './uploadIntent'

beforeEach(() => {
	workerFetchMock.mockReset()
	workerRawUploadMock.mockReset()
	workerRawUploadMock.mockResolvedValue({ path: 'server-path', replayed: false })
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

	it('forwards opts.traceId to workerFetch (header threading for upload-flow correlation)', async () => {
		// Phase 3.7 observability: the upload-flow traceId rides as the
		// 5th workerFetch arg so workerBase can set X-Upload-Trace-Id.
		// Without this hop, the mint call's Worker log line would lack
		// the trace= suffix and `wrangler tail | grep <id>` would skip
		// the /upload-intents leg of the chain.
		workerFetchMock.mockResolvedValueOnce({ intents: [] })
		await requestUploadIntents(
			{
				tripId:     't', entityType: 'wish', entityId: 'w',
				uploads:    [{ kind: 'full', contentType: 'image/webp', size: 1 }],
			},
			{ traceId: 'fixed-trace-id-1234' },
		)
		const opts = workerFetchMock.mock.calls[0]![4] as { traceId: string }
		expect(opts).toEqual({ traceId: 'fixed-trace-id-1234' })
	})

	it('omits opts when no traceId provided (back-compat for callers that never observe)', async () => {
		workerFetchMock.mockResolvedValueOnce({ intents: [] })
		await requestUploadIntents({
			tripId:     't', entityType: 'expense', entityId: 'e',
			uploads:    [{ kind: 'full', contentType: 'image/webp', size: 1 }],
		})
		// 5th arg is undefined when caller omits opts; pin so a refactor
		// that always-builds an opts object (even empty) is caught here.
		expect(workerFetchMock.mock.calls[0]![4]).toBeUndefined()
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

	it('uploads raw bytes through the Worker using intentId + trip lookup scope', async () => {
		const file = new Blob(['x'], { type: 'image/webp' })
		await uploadToIntent(sampleIntent, file, 'expense-full', { traceId: 'trace-123456789' })

		expect(workerRawUploadMock).toHaveBeenCalledWith(
			'https://worker.example.com',
			'fake-id-token',
			'/attachment-upload',
			{ tripId: 'T', intentId: 'i-x' },
			file,
			{ traceId: 'trace-123456789', timeoutMs: 30_000 },
		)
	})

	it('does not send intent.path as the upload destination', async () => {
		await uploadToIntent(
			{ ...sampleIntent, path: 'server-mandated/path.bin' },
			new Blob(['RIFFxxxxWEBP'], { type: 'image/webp' }),
			'test',
		)
		const query = workerRawUploadMock.mock.calls[0]![3]
		expect(query).toEqual({ tripId: 'T', intentId: 'i-x' })
		expect(JSON.stringify(query)).not.toContain('server-mandated')
	})

	it('propagates Worker upload errors', async () => {
		workerRawUploadMock.mockRejectedValueOnce(new Error('upload timeout'))
		await expect(uploadToIntent(sampleIntent, new Blob(['x'], { type: 'image/webp' }), 'expense-full'))
			.rejects.toThrow(/upload timeout/)
	})

	it('rejects MIME drift instead of relabelling unchanged bytes', async () => {
		await expect(uploadToIntent(
			sampleIntent,
			new Blob(['not-webp'], { type: 'image/jpeg' }),
			'expense-full',
		)).rejects.toThrow(/does not match intent/)
		expect(workerRawUploadMock).not.toHaveBeenCalled()
	})
})
