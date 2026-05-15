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
})
