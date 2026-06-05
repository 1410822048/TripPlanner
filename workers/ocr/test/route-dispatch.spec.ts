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
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
	fxErrorCatcher, chainCatchers, validationErrorCatcher, handleJsonRoute,
} from '../src/route-dispatch'
import { FxError } from '../src/fx-rate'
import { CascadeError } from '../src/cascade'
import { TxRetryExhausted, TxCommitAmbiguous } from '../src/firestore-tx'

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
})
