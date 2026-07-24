// Smoke tests for routing + CORS + auth gating.
// These don't exercise the OCR-model call (we'd need either a mock or a real
// API key + image) — they cover the layers above it so we can refactor
// auth / CORS without breaking core wiring.
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { afterEach, describe, it, expect, vi } from 'vitest'
import worker, { ROUTES, RATE_CLASSES } from '../src/index'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>
const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

async function call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
	const req = new IncomingRequest(`http://example.com${path}`, { method, ...init })
	const ctx = createExecutionContext()
	const res = await worker.fetch(req, env, ctx)
	await waitOnExecutionContext(ctx)
	return res
}

describe('OCR worker routing', () => {
	it('CORS preflight returns 204 with allow headers', async () => {
		const res = await call('OPTIONS', '/ocr', {
			headers: { Origin: 'http://localhost:5173' },
		})
		expect(res.status).toBe(204)
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
	})

	it('CORS preflight allows Authorization, Content-Type, and X-Upload-Trace-Id', async () => {
		// Regression pin for the upload-flow observability header:
		// mintAndUploadEntityIntents sends `X-Upload-Trace-Id` on every
		// /upload-intents + /expense-* + /booking-file-* + /wish-file-*
		// request. Custom (non-CORS-safelisted) headers trigger a
		// preflight, and the browser aborts the actual request if the
		// header isn't echoed in Access-Control-Allow-Headers — every
		// upload would 0-byte-fail in prod with no Worker log to grep.
		const res = await call('OPTIONS', '/upload-intents', {
			headers: {
				Origin:                          'http://localhost:5173',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers':
					'authorization, content-type, x-upload-trace-id',
			},
		})
		expect(res.status).toBe(204)
		const allow = res.headers.get('Access-Control-Allow-Headers') ?? ''
		expect(allow).toMatch(/Authorization/i)
		expect(allow).toMatch(/Content-Type/i)
		expect(allow).toMatch(/X-Upload-Trace-Id/i)
	})

	it('unknown path returns 404', async () => {
		const res = await call('POST', '/whatever')
		expect(res.status).toBe(404)
	})

	it('POST /ocr without Authorization returns 401', async () => {
		const res = await call('POST', '/ocr', {
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({}),
		})
		expect(res.status).toBe(401)
		const body = await res.json() as { error: string }
		expect(body.error).toContain('Authorization')
	})

	it('POST /ocr with malformed bearer returns 401', async () => {
		const res = await call('POST', '/ocr', {
			headers: {
				'Authorization': 'Bearer not-a-jwt',
				'Content-Type':  'application/json',
			},
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(401)
	})

	it('POST /ocr with Content-Length above 9MB returns 413', async () => {
		// Body size guard fires before auth, so no token is needed.
		// Content-Length is client-supplied; an honest oversized client
		// gets rejected without parsing the body.
		const res = await call('POST', '/ocr', {
			headers: {
				'Content-Type':   'application/json',
				'Content-Length': String(10 * 1024 * 1024),
			},
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(413)
		const body = await res.json() as { error: string }
		expect(body.error).toContain('Body too large')
	})

	it('normal OCR domain errors are masked in client responses', async () => {
		const route = ROUTES.find(r => r.path === '/ocr')
		expect(route).toBeDefined()

		const res = await route!.dispatch({
			body: { image: 'a'.repeat(128), mimeType: 'image/webp' },
			cors: {},
			uid:  'user-1',
			env:  { OCR_PRIMARY_PROVIDER: 'gemini' },
		} as never)
		const body = await res.json() as { error: string }

		expect(res.status).toBe(502)
		expect(body.error).toBe('OCR provider failed')
		expect(body.error).not.toContain('OCR_PRIMARY_PROVIDER')
	})

	it('booking PDF extraction uses the booking-specific Claude deployment when set', async () => {
		const route = ROUTES.find(r => r.path === '/booking-pdf-extract')
		expect(route).toBeDefined()

		let rawBody = ''
		globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			rawBody = String(init?.body ?? '')
			return new Response(JSON.stringify({
				type:        'message',
				role:        'assistant',
				content:     [{
					type:  'tool_use',
					id:    'toolu_test',
					name:  'extract_booking_pdf',
					input: {
						bookings: [{
							bookingType:      'hotel',
							segmentRole:      'single',
							title:            { value: 'Hotel Sakura', confidence: 0.9, evidence: 'Hotel Sakura' },
							provider:         { value: 'Airbnb', confidence: 0.9, evidence: 'Airbnb' },
							confirmationCode: { value: '', confidence: 0, evidence: '' },
							origin:           { value: '', confidence: 0, evidence: '' },
							destination:      { value: '', confidence: 0, evidence: '' },
							originIataCode:   { value: '', confidence: 0, evidence: '' },
							destinationIataCode: { value: '', confidence: 0, evidence: '' },
							checkIn:          { value: '2026-07-01', confidence: 0.9, evidence: '2026-07-01' },
							checkOut:         { value: '', confidence: 0, evidence: '' },
							address:          { value: '', confidence: 0, evidence: '' },
							link:             { value: '', confidence: 0, evidence: '' },
						}],
						warnings: [],
					},
				}],
				stop_reason: 'tool_use',
			}), { status: 200, headers: { 'Content-Type': 'application/json' } })
		}) as typeof fetch

		const res = await route!.dispatch({
			body: {
				pageCount: 1,
				text:      'Hotel Sakura\nAirbnb\n2026-07-01',
				lines: [
					{ page: 1, text: 'Hotel Sakura', x: 10, y: 100 },
					{ page: 1, text: 'Airbnb', x: 10, y: 90 },
					{ page: 1, text: '2026-07-01', x: 10, y: 80 },
				],
			},
			cors: {},
			uid:  'user-1',
			env:  {
				ANTHROPIC_FOUNDRY_API_KEY:  'key',
				ANTHROPIC_FOUNDRY_RESOURCE: 'aic-claude-eus2',
				CLAUDE_DEPLOYMENT:          'claude-sonnet-4-6',
				BOOKING_CLAUDE_DEPLOYMENT:  'claude-haiku-4-5-2',
			},
		} as never)

		expect(res.status).toBe(200)
		const body = JSON.parse(rawBody) as { model?: string; tool_choice?: { name?: string } }
		expect(body.model).toBe('claude-haiku-4-5-2')
		expect(body.tool_choice?.name).toBe('extract_booking_pdf')
	})
})

describe('route descriptor table (rate-limit classification)', () => {
	// Golden map: every endpoint → (L1 binding, L2 scope, L2 cap). This is
	// the security-load-bearing 1:1 the descriptor table must preserve — a
	// wrong binding / scope / cap silently weakens abuse protection, and no
	// other test exercises the dispatch path's rate classification. Derived
	// from the pre-refactor limiter/scope/globalLimit ternaries; pinned here
	// so any future table edit that re-buckets an endpoint fails loudly.
	const EXPECTED: Record<string, { limiter: string; scope: string; globalLimit: number }> = {
		'/ocr':                 { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/ocr-fallback':        { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/ocr-compare':         { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/booking-pdf-extract': { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/expense-receipt-ocr': { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/expense-receipt-ocr-fallback': { limiter: 'OCR_RATE_LIMITER',    scope: 'ocr',              globalLimit: 60 },
		'/cascade-trip-delete': { limiter: 'TRIP_CASCADE_RATE_LIMITER',   scope: 'trip-cascade',     globalLimit: 2 },
		'/expense-create':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'expense',          globalLimit: 60 },
		'/expense-update':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'expense',          globalLimit: 60 },
		'/upload-intents':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'upload-intent',    globalLimit: 60 },
		'/wish-file-create':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
		'/wish-file-update':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
		'/booking-file-create': { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'booking-write',    globalLimit: 60 },
		'/booking-file-update': { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'booking-write',    globalLimit: 60 },
		'/settlement-create':   { limiter: 'SETTLEMENT_RATE_LIMITER',     scope: 'settlement-write', globalLimit: 10 },
		'/settlement-delete':   { limiter: 'SETTLEMENT_RATE_LIMITER',     scope: 'settlement-write', globalLimit: 10 },
		'/attachment-url':      { limiter: 'ATTACHMENT_URL_RATE_LIMITER', scope: 'attachment-url',   globalLimit: 300 },
		'/invite-create':       { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/invite-revoke':       { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/invite-redeem':       { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/member-remove':       { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/member-leave':        { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/member-role-update':  { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/owner-transfer':      { limiter: 'CASCADE_RATE_LIMITER',        scope: 'cascade',          globalLimit: 10 },
		'/route-autocomplete':  { limiter: 'ROUTE_SEARCH_RATE_LIMITER',  scope: 'route-search',  globalLimit: 60 },
		'/route-resolve-place': { limiter: 'ROUTE_SEARCH_RATE_LIMITER',  scope: 'route-search',  globalLimit: 60 },
		'/route-preview':       { limiter: 'ROUTE_PREVIEW_RATE_LIMITER', scope: 'route-preview', globalLimit: 10 },
		'/route-apply':         { limiter: 'ROUTE_WRITE_RATE_LIMITER',   scope: 'route-write',   globalLimit: 10 },
		'/route-apply-status':  { limiter: 'ROUTE_WRITE_RATE_LIMITER',   scope: 'route-write',   globalLimit: 10 },
	}

	it('every route resolves to its expected (binding, scope, cap)', () => {
		for (const route of ROUTES) {
			const rc = RATE_CLASSES[route.rate]
			expect(rc, `no rate class for ${route.path}`).toBeDefined()
			expect(
				{ limiter: rc.limiter, scope: rc.scope, globalLimit: rc.globalLimit },
				`rate class mismatch for ${route.path}`,
			).toEqual(EXPECTED[route.path])
		}
	})

	it('covers exactly the expected endpoints (no missing / extra)', () => {
		expect(ROUTES.map(r => r.path).sort()).toEqual(Object.keys(EXPECTED).sort())
	})

	it('has no duplicate paths', () => {
		const paths = ROUTES.map(r => r.path)
		expect(new Set(paths).size).toBe(paths.length)
	})

})
