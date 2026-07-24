// Tests for the Firestore transaction wrapper. These exercise the
// commit-retry + token-invalidation paths via global fetch mocks --
// the wrapper is what closes the stale-read race that was the
// motivating P1, so the retry-on-ABORTED behaviour is load-bearing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runFirestoreTransaction, TxCancelled, TxCommitAmbiguous } from '../src/firestore-tx'

/** A portable stand-in for the DOMException AbortSignal.timeout throws.
 *  isRpcTimeout keys on `.name`, so a plain Error tagged 'TimeoutError'
 *  exercises the exact branch without depending on DOMException ctor
 *  availability across the test runtime. */
function timeoutError(): Error {
  const e = new Error('The operation timed out.')
  e.name = 'TimeoutError'
  return e
}

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
	it.each([
		['read', ':batchGet'],
		['query', ':runQuery'],
	] as const)('external cancellation aborts an in-flight %s and never retries', async (kind, rpcPath) => {
		const controller = new AbortController()
		let beginCalls = 0
		let rpcCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes(':beginTransaction')) {
				beginCalls += 1
				return new Response(JSON.stringify({ transaction: 'tx-1' }), { status: 200 })
			}
			if (url.includes(rpcPath)) {
				rpcCalls += 1
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		const request = runFirestoreTransaction('fake-token', 'demo', async tx => {
			if (kind === 'read') await tx.get('trips/t1')
			else await tx.runQuery({ parent: 'trips/t1', collection: 'schedules' })
			return { writes: [], result: 'unreachable' }
		}, { signal: controller.signal })

		await vi.waitFor(() => expect(rpcCalls).toBe(1))
		controller.abort('preview deadline')
		await expect(request).rejects.toBeInstanceOf(TxCancelled)
		expect(beginCalls).toBe(1)
		expect(rpcCalls).toBe(1)
	})

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

	it('commit timeout → TxCommitAmbiguous, NOT retried (write may have applied)', async () => {
		// A commit RPC that overruns its per-call timeout is AMBIGUOUS:
		// the write may already be in Firestore. Blind-retrying would
		// re-run a create-only body and 409 on its own committed doc /
		// used intents -- a successful write reported as a failure, the
		// exact class this change set fixes. Assert: surfaced as
		// TxCommitAmbiguous, body + commit each ran exactly ONCE.
		let bodyCalls   = 0
		let commitCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: 'tx-1' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':batchGet')) {
				return new Response(JSON.stringify([{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }]), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':commit')) {
				commitCalls += 1
				throw timeoutError()
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		await expect(
			runFirestoreTransaction('fake-token', 'demo', async (tx) => {
				bodyCalls += 1
				await tx.get('trips/t1/expenses/e1')
				return {
					writes: [{
						document:        'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
						fields:          {},
						currentDocument: { exists: false },
					}],
					result: 'created',
				}
			}),
		).rejects.toBeInstanceOf(TxCommitAmbiguous)

		expect(bodyCalls).toBe(1)
		expect(commitCalls).toBe(1)
	})

	it('read-only commit timeout is retried because no write can be double-applied', async () => {
		let bodyCalls   = 0
		let commitCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: `tx-${bodyCalls + 1}` }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':batchGet')) {
				return new Response(JSON.stringify([{ missing: 'projects/demo/databases/(default)/documents/trips/t1' }]), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':commit')) {
				commitCalls += 1
				if (commitCalls === 1) throw timeoutError()
				return new Response(JSON.stringify({ commitTime: 't', writeResults: [] }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		const result = await runFirestoreTransaction('fake-token', 'demo', async tx => {
			bodyCalls += 1
			await tx.get('trips/t1')
			return { writes: [], result: bodyCalls }
		})

		expect(result).toBe(2)
		expect(bodyCalls).toBe(2)
		expect(commitCalls).toBe(2)
	})

	it('read (batchGet) timeout IS retried -- pre-commit, nothing written', async () => {
		// A read RPC timeout happens before any commit, so no write
		// landed -- safe to re-run from a fresh tx (unlike a commit
		// timeout). First batchGet times out, retry succeeds.
		let batchGetCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: 'tx' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':batchGet')) {
				batchGetCalls += 1
				if (batchGetCalls === 1) throw timeoutError()
				return new Response(JSON.stringify([{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }]), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':commit')) {
				return new Response(JSON.stringify({ commitTime: 't', writeResults: [{}] }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		const result = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			await tx.get('trips/t1/expenses/e1')
			return { writes: [], result: 'ok' }
		})
		expect(result).toBe('ok')
		expect(batchGetCalls).toBe(2)   // first timed out, retry succeeded
	})

	it('read (batchGet) 503 IS retried -- pre-commit transient 5xx, nothing written', async () => {
		// A Firestore 503 on a pre-commit read happens before the commit RPC,
		// so no write landed -- safe to re-run from a fresh tx, same class as
		// an ABORTED conflict / read timeout. First batchGet 503s, retry wins.
		let batchGetCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: 'tx' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':batchGet')) {
				batchGetCalls += 1
				if (batchGetCalls === 1) {
					return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), {
						status: 503, headers: { 'Content-Type': 'application/json' },
					})
				}
				return new Response(JSON.stringify([{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }]), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':commit')) {
				return new Response(JSON.stringify({ commitTime: 't', writeResults: [{}] }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		const result = await runFirestoreTransaction('fake-token', 'demo', async (tx) => {
			await tx.get('trips/t1/expenses/e1')
			return { writes: [], result: 'ok' }
		})
		expect(result).toBe('ok')
		expect(batchGetCalls).toBe(2)   // first 503'd, retry succeeded
	})

	it('commit 503 is NOT retried -- ambiguous (write may have applied)', async () => {
		// The invariant guard: a 5xx on the COMMIT phase is ambiguous (the
		// write may have landed), so it must surface (generic 5xx → client
		// WorkerAmbiguous → reconcile), NEVER blind-retry -- same contract as
		// the commit timeout. body + commit each run exactly once.
		let bodyCalls   = 0
		let commitCalls = 0
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: 'tx' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':batchGet')) {
				return new Response(JSON.stringify([{ missing: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1' }]), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes(':commit')) {
				commitCalls += 1
				return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), {
					status: 503, headers: { 'Content-Type': 'application/json' },
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch

		await expect(
			runFirestoreTransaction('fake-token', 'demo', async (tx) => {
				bodyCalls += 1
				await tx.get('trips/t1/expenses/e1')
				return {
					writes: [{
						document:        'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
						fields:          {},
						currentDocument: { exists: false },
					}],
					result: 'created',
				}
			}),
		).rejects.toThrow(/503/)
		expect(bodyCalls).toBe(1)
		expect(commitCalls).toBe(1)
	})
})
