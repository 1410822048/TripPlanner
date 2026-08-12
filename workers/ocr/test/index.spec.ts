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
import { OcrError } from '../src/claude'

const runOcrProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../src/ocr-providers', async () => {
	const actual = await vi.importActual<typeof import('../src/ocr-providers')>('../src/ocr-providers')
	return { ...actual, runOcrProvider: runOcrProviderMock }
})

import worker, { ROUTES, RATE_CLASSES } from '../src/index'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>
const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
	runOcrProviderMock.mockReset()
})

// `RequestInit` here is workerd's, which is generic over the `cf`
// properties — the global DOM one the specs write is not assignable to it.
// Taking the pool's own parameter type keeps the helper honest instead of
// casting at the call.
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1]

async function call(method: string, path: string, init: IncomingRequestInit = {}): Promise<Response> {
	const req = new IncomingRequest(`http://example.com${path}`, { method, ...init })
	const ctx = createExecutionContext()
	// `env` from cloudflare:test is the generated Cloudflare.Env; the
	// Worker's own type adds the secrets, which the test runtime supplies
	// from .dev.vars but the generated type cannot know about.
	const res = await worker.fetch(req, env as Parameters<typeof worker.fetch>[1], ctx)
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
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
	})

	it('CORS preflight allows upload trace and fixed attachment locator headers', async () => {
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
					'authorization, content-type, x-upload-trace-id, x-attachment-trip-id, x-attachment-path',
			},
		})
		expect(res.status).toBe(204)
		const allow = res.headers.get('Access-Control-Allow-Headers') ?? ''
		expect(allow).toMatch(/Authorization/i)
		expect(allow).toMatch(/Content-Type/i)
		expect(allow).toMatch(/X-Upload-Trace-Id/i)
		expect(allow).toMatch(/X-Attachment-Trip-Id/i)
		expect(allow).toMatch(/X-Attachment-Path/i)
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
		runOcrProviderMock.mockRejectedValueOnce(new OcrError('provider credential detail', 502))

		const res = await route!.dispatch({
			body: { image: 'a'.repeat(128), mimeType: 'image/webp' },
			cors: {},
			uid:  'user-1',
			env:  {},
		} as never)
		const body = await res.json() as { error: string }

		expect(res.status).toBe(502)
		expect(body.error).toBe('OCR provider failed')
		expect(body.error).not.toContain('provider credential detail')
	})

	it.each([
		['/ocr', 'qwen'],
		['/ocr-fallback', 'claude'],
	] as const)('%s is permanently routed through %s', async (path, expectedProvider) => {
		const route = ROUTES.find(r => r.path === path)
		expect(route).toBeDefined()
		runOcrProviderMock.mockResolvedValueOnce({
			items:        [{ name: '咖啡', amountText: '100' }],
			adjustments:  [],
			ignoredLines: [],
			totalText:    '100',
		})

		const res = await route!.dispatch({
			body: { image: 'a'.repeat(128), mimeType: 'image/webp' },
			cors: {},
			uid:  'user-1',
			// Deliberately include the removed legacy vars with reversed values:
			// stale dashboard state must not be able to change route semantics.
			env: {
				OCR_PRIMARY_PROVIDER:  'claude',
				OCR_FALLBACK_PROVIDER: 'qwen',
			},
		} as never)

		expect(res.status).toBe(200)
		expect(runOcrProviderMock).toHaveBeenCalledTimes(1)
		expect(runOcrProviderMock.mock.calls[0]![0]).toBe(expectedProvider)
	})

	it('booking PDF extraction uses the configured Qwen deployment', async () => {
		const route = ROUTES.find(r => r.path === '/booking-pdf-extract')
		expect(route).toBeDefined()

		let rawBody = ''
		globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			rawBody = String(init?.body ?? '')
			return new Response(JSON.stringify({
				choices: [{
					finish_reason: 'stop',
					message: { content: JSON.stringify({
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
					}) },
				}],
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
				QWEN_API_KEY:  'key',
				QWEN_BASE_URL: 'https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
				QWEN_MODEL:    'qwen3.7-flash',
			},
		} as never)

		expect(res.status).toBe(200)
		const body = JSON.parse(rawBody) as {
			model?: string
			max_tokens?: number
			response_format?: { type?: string }
		}
		expect(body.model).toBe('qwen3.7-flash')
		expect(body.response_format?.type).toBe('json_object')
		expect(body.max_tokens).toBeUndefined()
	})

	it('booking PDF schema failures return 422', async () => {
		const route = ROUTES.find(r => r.path === '/booking-pdf-extract')
		expect(route).toBeDefined()
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
			choices: [{
				finish_reason: 'stop',
				message: { content: JSON.stringify({
					bookings: [{ bookingType: 'hotel', segmentRole: 'single', title: 'Hotel Sakura' }],
					warnings: [],
				}) },
			}],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

		const res = await route!.dispatch({
			body: {
				pageCount: 1,
				text:      'Hotel Sakura\nAirbnb\n2026-07-01',
				lines: [{ page: 1, text: 'Hotel Sakura', x: 10, y: 100 }],
			},
			cors: {},
			uid:  'user-1',
			env: {
				QWEN_API_KEY:  'key',
				QWEN_BASE_URL: 'https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
				QWEN_MODEL:    'qwen3.7-flash',
			},
		} as never)

		expect(globalThis.fetch).toHaveBeenCalledTimes(2)
		expect(res.status).toBe(422)
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
		'/booking-pdf-extract': { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/expense-receipt-ocr': { limiter: 'OCR_RATE_LIMITER',            scope: 'ocr',              globalLimit: 60 },
		'/expense-receipt-ocr-fallback': { limiter: 'OCR_RATE_LIMITER',    scope: 'ocr',              globalLimit: 60 },
		'/cascade-trip-delete': { limiter: 'TRIP_CASCADE_RATE_LIMITER',   scope: 'trip-cascade',     globalLimit: 2 },
		'/expense-create':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'expense',          globalLimit: 60 },
		'/expense-update':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'expense',          globalLimit: 60 },
		'/upload-intents':      { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'upload-intent',    globalLimit: 60 },
		'/wish-file-create':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
		'/wish-file-update':    { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
		'/wish-delete':         { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'wish-write',       globalLimit: 60 },
		'/booking-file-create': { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'booking-write',    globalLimit: 60 },
		'/booking-file-update': { limiter: 'EXPENSE_RATE_LIMITER',        scope: 'booking-write',    globalLimit: 60 },
		'/settlement-create':   { limiter: 'SETTLEMENT_RATE_LIMITER',     scope: 'settlement-write', globalLimit: 10 },
		'/settlement-delete':   { limiter: 'SETTLEMENT_RATE_LIMITER',     scope: 'settlement-write', globalLimit: 10 },
		'/attachment-upload':   { limiter: 'ATTACHMENT_UPLOAD_RATE_LIMITER', scope: 'attachment-upload', globalLimit: 60 },
		'/attachment-content':  { limiter: 'ATTACHMENT_CONTENT_RATE_LIMITER', scope: 'attachment-content', globalLimit: 900 },
		'/attachment-delete':   { limiter: 'ATTACHMENT_DELETE_RATE_LIMITER', scope: 'attachment-delete', globalLimit: 120 },
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
		const paths = ROUTES.map(r => `${r.method ?? 'POST'} ${r.path}`)
		expect(new Set(paths).size).toBe(paths.length)
	})

})
