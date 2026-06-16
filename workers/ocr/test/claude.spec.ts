import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReceiptItems, type ClaudeConfig } from '../src/claude'

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

const CFG: ClaudeConfig = {
	apiKey:   'test-key',
	resource: 'aic-claude-eus2',
	model:    'claude-sonnet-4-6',
}

/** Stub a non-2xx upstream response. The error body shape is irrelevant —
 *  the client status mapping only reads res.status (+ logs res.text()). */
function stubStatus(status: number, body: unknown = { type: 'error', error: { type: 'api_error' } }) {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch
}

/** Stub a 200 Anthropic Messages response whose single text block holds
 *  `text` (the model's JSON string), with the given stop_reason. */
function stubMessage(text: string, stop_reason = 'end_turn') {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
		type:    'message',
		role:    'assistant',
		content: [{ type: 'text', text }],
		stop_reason,
	}), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
}

function stubMessageAndCaptureRequest(text: string) {
	let rawBody = ''
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBody = String(init?.body ?? '')
		return new Response(JSON.stringify({
			type:    'message',
			role:    'assistant',
			content: [{ type: 'text', text }],
			stop_reason: 'end_turn',
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => JSON.parse(rawBody) as {
		system?:  string
		messages: Array<{ content: Array<{ type: string; text?: string }> }>
	}
}

function run() {
	return extractReceiptItems('abcd', 'image/webp', 'JPY', CFG)
}

const VALID_RESPONSE = {
	items:        [{ name: 'コーヒー', amountText: '380' }],
	adjustments:  [],
	ignoredLines: [],
	totalText:    '380',
}

describe('extractReceiptItems — upstream status mapping', () => {
	it('passes a 429 (rate/quota) through unchanged', async () => {
		stubStatus(429)
		await expect(run()).rejects.toMatchObject({ status: 429 })
	})

	it('maps a 529 (overloaded) to a retryable 503', async () => {
		stubStatus(529)
		await expect(run()).rejects.toMatchObject({ status: 503 })
	})

	it('masks an operator auth failure (401 → 502)', async () => {
		stubStatus(401)
		await expect(run()).rejects.toMatchObject({ status: 502 })
	})

	it('masks a bad-request / bad-deployment (400/404 → 502)', async () => {
		stubStatus(400)
		await expect(run()).rejects.toMatchObject({ status: 502 })
	})
})

describe('extractReceiptItems — content handling', () => {
	it('parses a valid structured response into OcrResponse', async () => {
		stubMessage(JSON.stringify(VALID_RESPONSE))
		await expect(run()).resolves.toMatchObject({
			items:     [{ name: 'コーヒー', amountText: '380' }],
			totalText: '380',
		})
	})

	it('sends an OCR-first prompt with hard tax-disclosure and no-invented-adjustment rules', async () => {
		const readBody = stubMessageAndCaptureRequest(JSON.stringify(VALID_RESPONSE))

		await run()

		const body = readBody()
		const prompt = body.messages[0]?.content.find(part => part.type === 'text')?.text ?? ''
		expect(body.system).toContain('strict receipt OCR extraction engine')
		expect(body.system).toContain('Do not infer hidden taxes')
		expect(prompt).toContain('Do not invent taxes, discounts, tips, service charges, or refund lines')
		expect(prompt).toContain('On Japanese or Taiwanese receipts')
		expect(prompt).toContain('Japanese DUTY-FREE (免税) receipts only')
		expect(prompt).toContain('NEVER create a TAX_EXEMPT')
		expect(prompt).toContain('Never emit OTHER/EXPENSE merely to force')
	})

	it('maps an empty-items result to 422 (unreadable receipt)', async () => {
		stubMessage(JSON.stringify({ ...VALID_RESPONSE, items: [], totalText: '0' }))
		await expect(run()).rejects.toMatchObject({ status: 422 })
	})

	it('maps non-JSON content to 422', async () => {
		stubMessage('not json at all')
		await expect(run()).rejects.toMatchObject({ status: 422 })
	})

	it('maps a truncated response (stop_reason=max_tokens) to 422', async () => {
		stubMessage(JSON.stringify(VALID_RESPONSE).slice(0, 20), 'max_tokens')
		await expect(run()).rejects.toMatchObject({ status: 422 })
	})

	it('maps a safety refusal (stop_reason=refusal) to 400', async () => {
		stubMessage('', 'refusal')
		await expect(run()).rejects.toMatchObject({ status: 400 })
	})
})
