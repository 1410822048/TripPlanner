// Focused unit tests for the per-route domain-error catchers in
// route-dispatch.ts. handleJsonRoute itself is tested end-to-end via
// the per-endpoint spec files (expense-write.spec, settlement-write.spec,
// ...) where the route layer is exercised through real bodies. This
// file locks down the helpers that those endpoints depend on:
//
//   - fxErrorCatcher: FxError → DomainErrorMapped with the FX layer's
//     own status + code preserved (so /expense-create + /settlement-create
//     don't silently 500 when Frankfurter is degraded or settledOn is in
//     the future).
//   - chainCatchers: first-non-null-wins composition (settlement-create
//     uses this to handle BOTH SettlementValidationError AND FxError).
//
// Why a dedicated file: when the catchers' contract changes (e.g. add
// a `field` to the FxError body, or change status mapping), this is
// where the regression should fire -- not deep inside an endpoint spec.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import {
	fxErrorCatcher, chainCatchers, validationErrorCatcher, handleJsonRoute,
} from '../src/route-dispatch'
import { FxError } from '../src/fx-rate'
import { CascadeError } from '../src/cascade'
import {
	TxRetryExhausted,
	TxCommitAmbiguous,
	PostCommitError,
	isPrecommitError,
	runFirestoreTransaction,
} from '../src/firestore-tx'
import type { ReportWorkerError } from '../src/sentry'

describe('fxErrorCatcher', () => {
	it('maps FxError → { status, body: { error, code } } using the error\'s own status', () => {
		const c = fxErrorCatcher()

		const future = c(new FxError('FX_INVALID_DATE', 400, 'settledOn must be today or earlier'))
		expect(future).toEqual({
			log:    expect.stringContaining('FX_INVALID_DATE'),
			body:   { error: 'settledOn must be today or earlier', code: 'FX_INVALID_DATE' },
			status: 400,
			// FX resolves before any write → always pre-commit (lets the
			// client roll back even on the 502 provider-down variant).
			precommit: true,
		})

		const provider = c(new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'Frankfurter down'))
		expect(provider).toEqual({
			log:    expect.stringContaining('FX_PROVIDER_UNAVAILABLE'),
			body:   { error: 'Frankfurter down', code: 'FX_PROVIDER_UNAVAILABLE' },
			status: 502,
			precommit: true,
		})
	})

	it('returns null for non-FxError throwables (falls through to other catchers / 500)', () => {
		const c = fxErrorCatcher()
		expect(c(new Error('something else'))).toBeNull()
		expect(c(new TypeError('different class'))).toBeNull()
		expect(c('string throw')).toBeNull()
	})
})

describe('chainCatchers', () => {
	// Bespoke validation error class for the test -- using a real one
	// (SettlementValidationError) would couple this spec to that file's
	// shape, defeating the "small reusable composer" point.
	class FooValidationError extends Error {
		readonly field:   string
		readonly message: string
		constructor(field: string, message: string) {
			super(message)
			this.field   = field
			this.message = message
			this.name    = 'FooValidationError'
		}
	}

	it('returns the first non-null catcher\'s mapping', () => {
		const fooCatcher = validationErrorCatcher(FooValidationError)
		const chained   = chainCatchers(fooCatcher, fxErrorCatcher())

		const fooHit = chained(new FooValidationError('amount', 'too big'))
		expect(fooHit?.status).toBe(400)
		expect(fooHit?.body).toEqual({ error: 'too big', field: 'amount' })

		const fxHit = chained(new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'down'))
		expect(fxHit?.status).toBe(502)
		expect((fxHit?.body as { code: string }).code).toBe('FX_PROVIDER_UNAVAILABLE')
	})

	it('returns null when no catcher matches', () => {
		const chained = chainCatchers(
			validationErrorCatcher(FooValidationError),
			fxErrorCatcher(),
		)
		expect(chained(new Error('unknown'))).toBeNull()
	})

	it('respects catcher order (first non-null wins)', () => {
		// Two catchers that COULD match the same throwable -- first one
		// registered wins. This is what lets settlement-create put the
		// validation catcher BEFORE the FX catcher: a hypothetical class
		// that subclasses both can't accidentally route to the wrong
		// status.
		const alwaysMatchA = (_: unknown) => ({ log: 'A', body: { tag: 'A' }, status: 418 })
		const alwaysMatchB = (_: unknown) => ({ log: 'B', body: { tag: 'B' }, status: 419 })
		const chained = chainCatchers(alwaysMatchA, alwaysMatchB)
		expect(chained(new Error('anything'))?.body).toEqual({ tag: 'A' })
	})
})

// The tx-failure taxonomy split is load-bearing for optimistic-write
// rollback semantics on the client: a DEFINITIVE failure must roll the
// optimistic row back; an AMBIGUOUS one must keep it for the realtime
// listener to reconcile. handleJsonRoute is the single place that turns
// the two tx-wrapper error classes into the HTTP statuses workerBase.ts
// classifies as WorkerRejected (rollback) vs WorkerAmbiguous (keep).
describe('handleJsonRoute — tx failure → status mapping', () => {
	const baseArgs = {
		endpoint:  'test-endpoint',
		body:      { x: 1 },
		cors:      {} as Record<string, string>,
		uid:       'uid-123456',
		report:    vi.fn<ReportWorkerError>(),
		schema:    z.object({ x: z.number() }),
		formatLog: () => 'ok',
	}

	it('maps TxRetryExhausted → 409 TX_RETRY_EXHAUSTED (definitive; client rolls back)', async () => {
		const res = await handleJsonRoute({
			...baseArgs,
			handle: async () => { throw new TxRetryExhausted(5, new Error('Too much contention')) },
		})
		expect(res.status).toBe(409)
		const body = await res.json() as { error: string; code: string }
		expect(body.code).toBe('TX_RETRY_EXHAUSTED')
		expect(body.error).toBe('伺服器忙碌，請稍後再試')
	})

	it('lets TxCommitAmbiguous fall through to 500 (ambiguous; client keeps optimistic)', async () => {
		// A commit-timeout outcome MUST NOT collapse into the same status
		// as retry-exhaustion: the write may have applied, so the client
		// keeps the optimistic row (5xx → WorkerAmbiguous) instead of
		// rolling back. Asserting 500 here guards the distinction.
		const res = await handleJsonRoute({
			...baseArgs,
			handle: async () => { throw new TxCommitAmbiguous(new Error('commit timed out')) },
		})
		expect(res.status).toBe(500)
		const body = await res.json() as { error: string; precommit?: boolean }
		expect(body.error).toBe('Internal error')
		// Generic 500 is the ambiguous default — must NOT be stamped precommit.
		expect(body.precommit).toBeUndefined()
	})
})

// The generic 500 tells the client nothing but "Internal error", so if it
// doesn't leave the Worker the failure is invisible until someone happens
// to be tailing. Every anticipated shape above must stay quiet, or the
// signal drowns in errors we already handle.
describe('handleJsonRoute — internal-error reporting', () => {
	function argsWith(report: ReturnType<typeof vi.fn<ReportWorkerError>>) {
		return {
			endpoint:  'test-endpoint',
			body:      { x: 1 },
			cors:      {} as Record<string, string>,
			uid:       'uid-123456',
			report,
			schema:    z.object({ x: z.number() }),
			formatLog: () => 'ok',
		}
	}

	it('reports an unexpected throw with its message, stack and cause chain', async () => {
		const report = vi.fn<ReportWorkerError>()
		const root = new Error('firestore 503')
		const boom = new Error('kaboom', { cause: root })
		await handleJsonRoute({
			...argsWith(report),
			handle: async () => { throw boom },
		})
		expect(report).toHaveBeenCalledTimes(1)
		const [message, extra] = report.mock.calls[0] as [string, Record<string, unknown>]
		expect(message).toBe('[test-endpoint] kaboom')
		const error = extra.error as { name: string; stack?: string; cause?: { message: string } }
		expect(error.stack).toBe(boom.stack)
		expect(error.name).toBe('Error')
		// The wrapper's stack does not contain the root cause's frames, so the
		// chain has to be carried explicitly or the report names the re-throw
		// site instead of the failure.
		expect(error.cause?.message).toBe('firestore 503')
	})

	it('reports a non-Error throw without crashing on .message', async () => {
		const report = vi.fn<ReportWorkerError>()
		await handleJsonRoute({
			...argsWith(report),
			handle: async () => { throw 'a bare string' },
		})
		expect(report).toHaveBeenCalledTimes(1)
		expect((report.mock.calls[0] as [string])[0]).toBe('[test-endpoint] a bare string')
	})

	it('stays silent on a schema failure, a domain error, TxRetryExhausted and CascadeError', async () => {
		const report = vi.fn<ReportWorkerError>()
		const base = argsWith(report)

		await handleJsonRoute({ ...base, body: { x: 'nope' }, handle: async () => 'unused' })
		await handleJsonRoute({
			...base,
			catchDomain: fxErrorCatcher(),
			handle: async () => { throw new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'down') },
		})
		await handleJsonRoute({
			...base,
			handle: async () => { throw new TxRetryExhausted(5, new Error('contention')) },
		})
		await handleJsonRoute({
			...base,
			handle: async () => { throw new CascadeError(403, 'not allowed') },
		})

		expect(report).not.toHaveBeenCalled()
	})
})

// A 5xx is ambiguous by default, BUT some 5xx are provably pre-commit (FX
// provider down, read-cap exceeded in a single-tx endpoint). The dispatcher
// stamps `precommit: true` so workerBase.ts can roll the optimistic row
// back on those instead of keeping a phantom. The cascade endpoint, whose
// CascadeError CAN fire mid-delete, must NOT be stamped.
describe('handleJsonRoute — precommit marking', () => {
	const baseArgs = {
		endpoint:  'settlement-create',
		body:      { x: 1 },
		cors:      {} as Record<string, string>,
		uid:       'uid-123456',
		report:    vi.fn<ReportWorkerError>(),
		schema:    z.object({ x: z.number() }),
		formatLog: () => 'ok',
	}

	it('stamps precommit:true on an FxError (pre-commit domain error), keeping status + code', async () => {
		const res = await handleJsonRoute({
			...baseArgs,
			catchDomain: fxErrorCatcher(),
			handle: async () => { throw new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'Frankfurter down') },
		})
		expect(res.status).toBe(502)
		const body = await res.json() as { code: string; precommit: boolean }
		expect(body.code).toBe('FX_PROVIDER_UNAVAILABLE')
		expect(body.precommit).toBe(true)
	})

	it('stamps precommit:true on a CascadeError when cascadePrecommit is set (single-tx endpoint)', async () => {
		const res = await handleJsonRoute({
			...baseArgs,
			cascadePrecommit: true,
			handle: async () => { throw new CascadeError(503, 'too many settlements for this pair (retry later)') },
		})
		expect(res.status).toBe(503)
		const body = await res.json() as { error: string; precommit?: boolean }
		expect(body.precommit).toBe(true)
	})

	it('does NOT stamp precommit on a CascadeError without the flag (cascade endpoint may be mid-write)', async () => {
		const res = await handleJsonRoute({
			...baseArgs,
			endpoint: 'cascade-trip-delete',
			handle: async () => { throw new CascadeError(503, 'partial cascade failure') },
		})
		expect(res.status).toBe(503)
		const body = await res.json() as { error: string; precommit?: boolean }
		expect(body.precommit).toBeUndefined()
	})

	/** Minimal Firestore stub: only :beginTransaction has to succeed for the
	 *  wrapper to reach the body, which is where these tests throw. */
	function stubBeginTransaction() {
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes(':beginTransaction')) {
				return new Response(JSON.stringify({ transaction: 'tx-1' }), { status: 200 })
			}
			throw new Error(`unexpected fetch ${String(input)}`)
		}))
	}
	afterEach(() => { vi.unstubAllGlobals() })

	it('stamps precommit from the tx wrapper WITHOUT any route flag', async () => {
		stubBeginTransaction()
		// The derived half: a CascadeError thrown inside a transaction body
		// escapes carrying the wrapper's mark, because at that point the
		// commit provably had not run. Routes whose whole body is one
		// transaction get definitive rejection for free — no per-route
		// boolean to keep in sync with the code.
		const res = await handleJsonRoute({
			...baseArgs,
			endpoint: 'expense-update',
			handle: async () => {
				await runFirestoreTransaction('token', 'demo', async () => {
					throw new CascadeError(500, 'trip.memberIds is empty')
				})
				return 'unreachable'
			},
		})
		expect(res.status).toBe(500)
		const body = await res.json() as { error: string; precommit?: boolean }
		// A bare 500 here is exactly the phantom-row bug: the client would
		// treat it as ambiguous and keep an optimistic row for a write that
		// never happened.
		expect(body.precommit).toBe(true)
		expect(body.error).toBe('trip.memberIds is empty')
	})

	it('reports PostCommitError as an ambiguous 500 even though its cause is marked precommit', async () => {
		// Keeps the redeem flow honest: the request already committed and
		// only a LATER transaction failed. That later transaction
		// legitimately marks its own error precommit — true of it, false of
		// the request — so the request must NOT be reported as definitive,
		// or the client rolls back a membership that is live on the server.
		//
		// The mechanism is the wrapping itself, not a dispatcher branch:
		// PostCommitError is not a CascadeError, so it cannot reach the
		// stamp-precommit path and lands on the ambiguous generic 500. This
		// test therefore fails if anyone makes PostCommitError extend
		// CascadeError, or unwraps the cause before rethrowing.
		stubBeginTransaction()
		const report = vi.fn<ReportWorkerError>()
		let marked: unknown
		try {
			await runFirestoreTransaction('token', 'demo', async () => {
				throw new CascadeError(403, 'member is not in trip roster — cascade refused')
			})
		} catch (e) { marked = e }
		expect(isPrecommitError(marked)).toBe(true)   // precondition of this test

		const res = await handleJsonRoute({
			...baseArgs,
			endpoint: 'invite-redeem',
			report,
			handle: async () => { throw new PostCommitError(marked) },
		})
		expect(res.status).toBe(500)
		const body = await res.json() as { error: string; precommit?: boolean }
		expect(body.precommit).toBeUndefined()
		expect(body.error).toBe('Internal error')
		// A half-applied write is an operator problem, not just a user one.
		expect(report).toHaveBeenCalledOnce()
	})
})
