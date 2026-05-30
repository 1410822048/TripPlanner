// Tests for the Phase 2 FX snapshot helper. We're at the wire
// boundary: admin token + projectId are mocked away (they don't add
// coverage), and `fetch` is intercepted to assert exactly what the
// helper sends to Firestore and to Frankfurter — plus what it does
// with the responses on both happy and error paths.
//
// The invariants we're locking in:
//   1. Same currency on both sides       → returns null, no network at all.
//   2. Future requestedDate              → FxError('FX_FUTURE_DATE_UNSUPPORTED'), no network.
//   3. Cache HIT                         → no provider fetch, no cache PATCH, snapshot uses cached values.
//   4. Cache MISS happy path             → provider GET, canonicalized rate, cache PATCH upsert mask present.
//   5. Provider 5xx + cache miss         → FxError('FX_PROVIDER_UNAVAILABLE').
//   6. Provider 4xx + cache miss         → FxError('FX_PROVIDER_REJECTED').
//   7. Provider weekend rateDate drift   → ACCEPT, rateDate < requestedDate is surfaced.
//   8. Provider returns zero/non-finite  → FxError('FX_PROVIDER_REJECTED') from canonicalize wrap.
//   9. Cache write Firestore failure     → swallowed (console.warn), snapshot still returned.
//
// Why mock fetch at globalThis: it's the same seam the firestore.ts
// helpers ultimately use, AND it's the documented production path for
// Frankfurter. One stub covers both, and the call list is observable
// so we can assert the order and shape of every outbound request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pin the admin layer. getAdminToken hits the OAuth metadata service
// in production; for tests we just need a stable string the helper
// will forward into Authorization headers — its content is asserted
// downstream where it matters.
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import {
	FxError,
	fxCacheKey,
	getFxSnapshot,
	toUtcDateString,
	type GetFxSnapshotInput,
} from '../src/fx-rate'

const originalFetch = globalThis.fetch

// Frozen "now" so the future-date guard is deterministic across runs.
const NOW = new Date('2026-05-30T12:00:00Z')

/** A neutral happy-path input. Tests override fields they care about. */
function input(overrides: Partial<GetFxSnapshotInput> = {}): GetFxSnapshotInput {
	return {
		requestedDate:        '2026-05-29',
		sourceCurrency:       'USD',
		tripCurrency:         'JPY',
		sourceAmountMinor:    1234,  // USD $12.34
		sourceFractionDigits: 2,
		targetFractionDigits: 0,
		...overrides,
	}
}

/** Firestore REST 200 response wrapper for a cache hit. */
function firestoreHit(rateDecimal: string, rateDate: string): Response {
	return new Response(
		JSON.stringify({
			fields: {
				rateDecimal: { stringValue: rateDecimal },
				rateDate:    { stringValue: rateDate },
				cachedAt:    { timestampValue: '2026-05-29T03:00:00Z' },
			},
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	)
}

/** Firestore REST 404 response — doc absent, cache miss. */
function firestoreMiss(): Response {
	return new Response('{}', { status: 404 })
}

/** Frankfurter v2 single-quote happy response. The real endpoint wraps
 *  even single-quote responses in an array: `[{date,base,quote,rate}]`.
 *  Verified against `api.frankfurter.dev/v2/rates?...` 2026-05-30 — the
 *  earlier object-shaped mock here was a P1 false-positive that would
 *  let the production decoder break and the suite still pass. */
function frankfurterOk(date: string, base: string, quote: string, rate: number): Response {
	return new Response(
		JSON.stringify([{ date, base, quote, rate }]),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	)
}

/** Build a fetch stub that returns the given sequence of responses in
 *  order, regardless of URL. Call list is captured for assertion. */
function sequentialFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
	let i = 0
	return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
		const r = responses[i++]
		if (!r) throw new Error(`sequentialFetch ran out of responses at call ${i}`)
		return r
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('fxCacheKey', () => {
	it('composes {date}_{base}_{quote}', () => {
		expect(fxCacheKey('2026-05-29', 'USD', 'JPY')).toBe('2026-05-29_USD_JPY')
	})
})

describe('toUtcDateString', () => {
	it('emits YYYY-MM-DD in UTC regardless of host TZ', () => {
		expect(toUtcDateString(new Date('2026-05-30T23:59:59Z'))).toBe('2026-05-30')
		expect(toUtcDateString(new Date('2026-05-31T00:00:00Z'))).toBe('2026-05-31')
	})
})

describe('getFxSnapshot - degenerate path', () => {
	it('returns null when source === trip currency without any fetch', async () => {
		const fetchImpl = vi.fn(async () => new Response('unreachable', { status: 500 }))
		const result = await getFxSnapshot(
			input({ sourceCurrency: 'JPY', tripCurrency: 'JPY' }),
			'unused-service-account-json',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(result).toBeNull()
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('getFxSnapshot - future-date guard', () => {
	it('rejects requestedDate after today UTC without any fetch', async () => {
		const fetchImpl = vi.fn(async () => new Response('unreachable', { status: 500 }))
		await expect(
			getFxSnapshot(
				input({ requestedDate: '2026-05-31' }),  // NOW is 2026-05-30
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({
			name: 'FxError',
			code: 'FX_FUTURE_DATE_UNSUPPORTED',
			status: 400,
		})
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('accepts requestedDate == today UTC', async () => {
		const fetchImpl = sequentialFetch(
			firestoreHit('146.2', '2026-05-30'),
		)
		const result = await getFxSnapshot(
			input({ requestedDate: '2026-05-30' }),
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(result?.rateDate).toBe('2026-05-30')
	})
})

describe('getFxSnapshot - validation', () => {
	it('rejects malformed date', async () => {
		await expect(
			getFxSnapshot(
				input({ requestedDate: '2026-5-29' }),
				'svc',
				{ now: NOW, fetchImpl: vi.fn() as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_INVALID_DATE' })
	})

	it('rejects lowercase currency', async () => {
		await expect(
			getFxSnapshot(
				input({ sourceCurrency: 'usd' }),
				'svc',
				{ now: NOW, fetchImpl: vi.fn() as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_INVALID_CURRENCY' })
	})

	it('rejects non-integer source amount', async () => {
		await expect(
			getFxSnapshot(
				input({ sourceAmountMinor: 12.5 }),
				'svc',
				{ now: NOW, fetchImpl: vi.fn() as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_INVALID_CURRENCY' })
	})

	it('rejects out-of-range fraction digits', async () => {
		await expect(
			getFxSnapshot(
				input({ sourceFractionDigits: 7 }),
				'svc',
				{ now: NOW, fetchImpl: vi.fn() as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_INVALID_CURRENCY' })
	})
})

describe('getFxSnapshot - cache hit', () => {
	it('returns snapshot from cache without provider fetch and without cache write', async () => {
		const fetchImpl = sequentialFetch(
			firestoreHit('146.2', '2026-05-29'),
		)
		const result = await getFxSnapshot(
			input(),
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		// Single fetch: the cache read. No provider GET, no cache PATCH.
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const url = String(fetchImpl.mock.calls[0][0])
		expect(url).toContain('firestore.googleapis.com')
		expect(url).toContain('fxRates/2026-05-29_USD_JPY')

		expect(result).toMatchObject({
			provider:             'frankfurter-v2',
			baseCurrency:         'USD',
			quoteCurrency:        'JPY',
			requestedDate:        '2026-05-29',
			rateDate:             '2026-05-29',
			rateDecimal:          '146.2',
			sourceAmountMinor:    1234,
			// 1234 (USD minor, 2 dp) * 146.2 / 10^2 → 1804.108 → 1804 yen (banker's, 0 dp)
			convertedAmountMinor: 1804,
			fetchedAtMs:          NOW.getTime(),
		})
	})
})

describe('getFxSnapshot - cache miss happy path', () => {
	it('fetches provider, canonicalizes, PATCHes cache, returns snapshot', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-29', 'USD', 'JPY', 146.2),
			new Response('{}', { status: 200 }),  // cache PATCH ack
		)
		const result = await getFxSnapshot(
			input(),
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(fetchImpl).toHaveBeenCalledTimes(3)

		// Call 1: Firestore cache GET.
		expect(String(fetchImpl.mock.calls[0][0])).toContain('fxRates/2026-05-29_USD_JPY')

		// Call 2: Frankfurter — correct path + query string.
		const providerUrl = String(fetchImpl.mock.calls[1][0])
		expect(providerUrl).toContain('api.frankfurter.dev/v2/rates')
		expect(providerUrl).toContain('date=2026-05-29')
		expect(providerUrl).toContain('base=USD')
		expect(providerUrl).toContain('quotes=JPY')

		// Call 3: Firestore PATCH upsert — mask lists every field, body
		// carries the canonical rate as a stringValue (not a doubleValue).
		const patchCall = fetchImpl.mock.calls[2]
		const patchUrl  = String(patchCall[0])
		const patchInit = patchCall[1] as RequestInit
		expect(patchInit.method).toBe('PATCH')
		expect(patchUrl).toContain('fxRates/2026-05-29_USD_JPY')
		for (const fp of ['provider', 'baseCurrency', 'quoteCurrency', 'requestedDate', 'rateDate', 'rateDecimal', 'cachedAt']) {
			expect(patchUrl).toContain(`updateMask.fieldPaths=${fp}`)
		}
		// No exists guard → upsert semantics so concurrent miss races
		// resolve harmlessly (same canonical rate from same provider).
		expect(patchUrl).not.toContain('currentDocument.exists')
		const patchBody = JSON.parse(String(patchInit.body))
		expect(patchBody.fields.rateDecimal).toEqual({ stringValue: '146.2' })
		expect(patchBody.fields.provider).toEqual({ stringValue: 'frankfurter-v2' })

		expect(result).toMatchObject({
			rateDate:             '2026-05-29',
			rateDecimal:          '146.2',
			convertedAmountMinor: 1804,
		})
	})
})

describe('getFxSnapshot - provider weekend drift', () => {
	it('accepts a rateDate earlier than the requestedDate', async () => {
		// requestedDate Sunday → provider returns Friday's rate.
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-29', 'USD', 'JPY', 146.2),
			new Response('{}', { status: 200 }),
		)
		const result = await getFxSnapshot(
			input({ requestedDate: '2026-05-30' }),  // Saturday (relative to NOW)
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(result?.requestedDate).toBe('2026-05-30')
		expect(result?.rateDate).toBe('2026-05-29')
	})

	it('rejects a provider rateDate AFTER requestedDate (clock skew / publication anomaly)', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-30', 'USD', 'JPY', 146.2),  // ahead of requested
		)
		await expect(
			getFxSnapshot(
				input({ requestedDate: '2026-05-29' }),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})
})

describe('getFxSnapshot - provider error paths', () => {
	it('maps 5xx upstream to FX_PROVIDER_UNAVAILABLE', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response('upstream blew up', { status: 503 }),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_UNAVAILABLE', status: 502 })
	})

	it('maps 4xx upstream (e.g. unknown currency) to FX_PROVIDER_REJECTED', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response('not found', { status: 404 }),
		)
		await expect(
			getFxSnapshot(
				input({ sourceCurrency: 'ZZZ' }),  // valid regex, unknown to Frankfurter
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED', status: 400 })
	})

	it('maps thrown fetch error to FX_PROVIDER_UNAVAILABLE', async () => {
		let call = 0
		const fetchImpl = vi.fn(async () => {
			call++
			if (call === 1) return firestoreMiss()
			throw new TypeError('network down')
		})
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_UNAVAILABLE' })
	})

	it('rejects pair mismatch even on 200', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-29', 'EUR', 'JPY', 160.0),  // wrong base
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED', status: 502 })
	})

	it('rejects zero rate from provider (canonicalize wrap)', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-29', 'USD', 'JPY', 0),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})

	it('rejects object-shaped provider response (regression: v2 always returns an array)', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response(
				JSON.stringify({ date: '2026-05-29', base: 'USD', quote: 'JPY', rate: 146.2 }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})

	it('rejects empty-array provider response', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})

	it('rejects multi-row provider response', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response(
				JSON.stringify([
					{ date: '2026-05-29', base: 'USD', quote: 'JPY', rate: 146.2 },
					{ date: '2026-05-29', base: 'USD', quote: 'EUR', rate: 0.92 },
				]),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})

	it('rejects non-JSON provider response', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			new Response('not json at all', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
		)
		await expect(
			getFxSnapshot(
				input(),
				'svc',
				{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
			),
		).rejects.toMatchObject({ code: 'FX_PROVIDER_REJECTED' })
	})
})

describe('getFxSnapshot - cache write resilience', () => {
	it('logs but does not fail when cache PATCH errors', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			frankfurterOk('2026-05-29', 'USD', 'JPY', 146.2),
			new Response('forbidden', { status: 403 }),  // cache write fails
		)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const result = await getFxSnapshot(
			input(),
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(result?.rateDecimal).toBe('146.2')
		expect(result?.convertedAmountMinor).toBe(1804)
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0][0]).toContain('[fx] cache write failed')
		warn.mockRestore()
	})
})

describe('getFxSnapshot - canonical rate stability across decimals', () => {
	it('canonicalizes a multi-decimal provider rate before storing', async () => {
		const fetchImpl = sequentialFetch(
			firestoreMiss(),
			// Note: JS-side number, canonicalize will produce '146.234567'.
			frankfurterOk('2026-05-29', 'USD', 'JPY', 146.234567),
			new Response('{}', { status: 200 }),
		)
		const result = await getFxSnapshot(
			input(),
			'svc',
			{ now: NOW, fetchImpl: fetchImpl as typeof fetch },
		)
		expect(result?.rateDecimal).toBe('146.234567')
		const patchBody = JSON.parse(String((fetchImpl.mock.calls[2][1] as RequestInit).body))
		expect(patchBody.fields.rateDecimal).toEqual({ stringValue: '146.234567' })
	})
})

describe('FxError class', () => {
	it('carries code + status + name', () => {
		const e = new FxError('FX_PROVIDER_REJECTED', 400, 'bad')
		expect(e).toBeInstanceOf(Error)
		expect(e.name).toBe('FxError')
		expect(e.code).toBe('FX_PROVIDER_REJECTED')
		expect(e.status).toBe(400)
		expect(e.message).toBe('bad')
	})
})
