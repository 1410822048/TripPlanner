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
import {
	fxErrorCatcher, chainCatchers, validationErrorCatcher,
} from '../src/route-dispatch'
import { FxError } from '../src/fx-rate'

describe('fxErrorCatcher', () => {
	it('maps FxError → { status, body: { error, code } } using the error\'s own status', () => {
		const c = fxErrorCatcher()

		const future = c(new FxError('FX_INVALID_DATE', 400, 'settledOn must be today or earlier'))
		expect(future).toEqual({
			log:    expect.stringContaining('FX_INVALID_DATE'),
			body:   { error: 'settledOn must be today or earlier', code: 'FX_INVALID_DATE' },
			status: 400,
		})

		const provider = c(new FxError('FX_PROVIDER_UNAVAILABLE', 502, 'Frankfurter down'))
		expect(provider).toEqual({
			log:    expect.stringContaining('FX_PROVIDER_UNAVAILABLE'),
			body:   { error: 'Frankfurter down', code: 'FX_PROVIDER_UNAVAILABLE' },
			status: 502,
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
