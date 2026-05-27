// Smoke tests for routing + CORS + auth gating.
// These don't exercise the Gemini call (we'd need either a mock or a real
// API key + image) — they cover the layers above it so we can refactor
// auth / CORS without breaking core wiring.
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import worker from '../src/index'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

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
})
