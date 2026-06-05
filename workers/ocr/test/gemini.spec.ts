import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReceiptItems } from '../src/gemini'

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

function stubGeminiStatus(status: number, body = { error: { status: 'UNAVAILABLE' } }) {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch
}

function run() {
	return extractReceiptItems('abcd', 'image/jpeg', 'JPY', 'api-key')
}

describe('extractReceiptItems - upstream status mapping', () => {
	it('preserves Gemini 503 so the client can show retry-later copy', async () => {
		stubGeminiStatus(503, {
			error: {
				code: 503,
				message: 'This model is currently experiencing high demand. Please try again later.',
				status: 'UNAVAILABLE',
			},
		})

		await expect(run()).rejects.toMatchObject({ status: 503 })
	})

	it('preserves Gemini 504 as a retryable upstream timeout', async () => {
		stubGeminiStatus(504)

		await expect(run()).rejects.toMatchObject({ status: 504 })
	})

	it('keeps Gemini auth/operator failures masked from callers', async () => {
		stubGeminiStatus(403, { error: { status: 'PERMISSION_DENIED' } })

		await expect(run()).rejects.toMatchObject({ status: 502 })
	})
})
