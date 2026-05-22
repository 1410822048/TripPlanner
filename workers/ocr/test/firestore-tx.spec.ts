// Tests for the Firestore transaction wrapper. These exercise the
// commit-retry + token-invalidation paths via global fetch mocks --
// the wrapper is what closes the stale-read race that was the
// motivating P1, so the retry-on-ABORTED behaviour is load-bearing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runFirestoreTransaction } from '../src/firestore-tx'

const originalFetch = globalThis.fetch

beforeEach(() => {
	vi.restoreAllMocks()
})

afterEach(() => {
	globalThis.fetch = originalFetch
})

/** Build a sequence of fetch responses keyed by URL substring. The
 *  wrapper calls beginTransaction / batchGet / commit in order; we
 *  hand back the next-in-line response for the matching endpoint. */
function mockFetchSequence(responses: Array<{
	matches: string
	status: number
	body:    unknown
}>) {
	const queues = new Map<string, Array<{ status: number; body: unknown }>>()
	for (const r of responses) {
		const q = queues.get(r.matches) ?? []
		q.push({ status: r.status, body: r.body })
		queues.set(r.matches, q)
	}
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		for (const [key, q] of queues) {
			if (url.includes(key)) {
				const next = q.shift()
				if (!next) throw new Error(`mockFetchSequence: exhausted queue for ${key}`)
				return new Response(JSON.stringify(next.body), {
					status: next.status,
					headers: { 'Content-Type': 'application/json' },
				})
			}
		}
		throw new Error(`mockFetchSequence: no mock matched URL ${url}`)
	}) as typeof fetch
}

describe('runFirestoreTransaction', () => {
	it('happy path: begin → batchGet → commit, returns body.result', async () => {
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':batchGet',         status: 200, body: [{ found: {
				name: 'projects/demo/databases/(default)/documents/trips/t1',
				fields: { ownerId: { stringValue: 'owner-uid' } },
				updateTime: '2026-05-21T10:00:00Z',
			} }] },
			{ matches: ':commit',           status: 200, body: { commitTime: '2026-05-21T10:00:01Z', writeResults: [{}] } },
		])

		const result = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			const trip = await tx.get('trips/t1')
			expect(trip.exists).toBe(true)
			return {
				writes: [{
					document: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
					fields:   { title: { stringValue: 'lunch' } },
				}],
				result: 'done',
			}
		})
		expect(result).toBe('done')
	})

	it('retries on 409 ABORTED -- closes the stale-read race', async () => {
		// First commit: 409 (someone wrote one of our read docs).
		// Wrapper begins a fresh tx, re-reads, commits successfully.
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-2' } },
			{ matches: ':batchGet',         status: 200, body: [{ found: {
				name: 'projects/demo/databases/(default)/documents/trips/t1',
				fields: {}, updateTime: '2026-05-21T10:00:00Z',
			} }] },
			{ matches: ':batchGet',         status: 200, body: [{ found: {
				name: 'projects/demo/databases/(default)/documents/trips/t1',
				fields: {}, updateTime: '2026-05-21T10:00:00Z',
			} }] },
			{ matches: ':commit',           status: 409, body: { error: { status: 'ABORTED', message: 'conflict' } } },
			{ matches: ':commit',           status: 200, body: { commitTime: 't', writeResults: [{}] } },
		])

		let bodyCalls = 0
		const result = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			bodyCalls += 1
			await tx.get('trips/t1')
			return {
				writes: [{
					document: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
					fields:   {},
				}],
				result: bodyCalls,
			}
		})
		// Body ran twice: once for the aborted attempt, once for the
		// retry. Result reflects the successful (second) run.
		expect(bodyCalls).toBe(2)
		expect(result).toBe(2)
	})

	it('treats 412 FAILED_PRECONDITION as a retry-eligible conflict', async () => {
		// 412 means a `currentDocument.{exists,updateTime}` precondition
		// failed -- same conflict class as ABORTED for our purposes.
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-2' } },
			{ matches: ':batchGet',         status: 200, body: [{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }] },
			{ matches: ':batchGet',         status: 200, body: [{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }] },
			{ matches: ':commit',           status: 412, body: { error: { status: 'FAILED_PRECONDITION' } } },
			{ matches: ':commit',           status: 200, body: { commitTime: 't', writeResults: [{}] } },
		])
		const result = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			const exp = await tx.get('trips/t1/expenses/e1')
			expect(exp.exists).toBe(false)
			return {
				writes: [{
					document: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
					fields:   {},
					currentDocument: { exists: false },
				}],
				result: 'created',
			}
		})
		expect(result).toBe('created')
	})

	it('propagates non-conflict errors immediately (no retry)', async () => {
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':batchGet',         status: 200, body: [{ missing: 'projects/demo/databases/(default)/documents/trips/t1' }] },
			{ matches: ':commit',           status: 500, body: { error: 'internal' } },
		])
		await expect(
			runFirestoreTransaction('fake-token', 'demo', async (tx) => {
				await tx.get('trips/t1')
				return { writes: [], result: undefined }
			}),
		).rejects.toThrow(/500/)
	})

	it('body throw propagates without retry (validation errors not retryable)', async () => {
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':batchGet',         status: 200, body: [{ missing: 'projects/demo/databases/(default)/documents/trips/t1' }] },
		])
		class ValidationFail extends Error {}
		await expect(
			runFirestoreTransaction('fake-token', 'demo', async (tx) => {
				await tx.get('trips/t1')
				throw new ValidationFail('bad payload')
			}),
		).rejects.toBeInstanceOf(ValidationFail)
	})

	it('exposes batchGet "missing" rows as exists=false (no error)', async () => {
		mockFetchSequence([
			{ matches: ':beginTransaction', status: 200, body: { transaction: 'tx-1' } },
			{ matches: ':batchGet',         status: 200, body: [{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }] },
			{ matches: ':commit',           status: 200, body: { commitTime: 't', writeResults: [{}] } },
		])
		const got = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			const doc = await tx.get('trips/t1/expenses/e1')
			return { writes: [], result: doc.exists }
		})
		expect(got).toBe(false)
	})
})
