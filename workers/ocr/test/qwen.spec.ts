import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReceiptItemsQwen, type QwenConfig } from '../src/qwen'

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

const CFG: QwenConfig = {
	apiKey:  'test-key',
	baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
	model:   'qwen3-vl-flash',
}

const VALID_RESPONSE = {
	items:        [{ name: 'coffee', amountText: '380' }],
	adjustments:  [],
	ignoredLines: [],
	totalText:    '380',
}

type CapturedQwenRequest = {
	messages: Array<{ role: string; content: unknown }>
}

function stubStatus(status: number, body: unknown = { error: { message: 'bad' } }) {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch
}

function stubChat(content: string, finish_reason = 'stop') {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
		choices: [{ finish_reason, message: { content } }],
	}), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
}

function stubChatAndCaptureRequest(content: string) {
	let rawBody = ''
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBody = String(init?.body ?? '')
		return new Response(JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content } }],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => JSON.parse(rawBody) as {
		model?: string
		max_tokens?: number
		enable_thinking?: boolean
		response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean } }
		messages: Array<{ role: string; content: unknown }>
	}
}

function stubChatSequence(responses: Array<{ content: string; finishReason?: string }>) {
	const rawBodies: string[] = []
	let call = 0
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBodies.push(String(init?.body ?? ''))
		const response = responses[call++]!
		return new Response(JSON.stringify({
			choices: [{
				finish_reason: response.finishReason ?? 'stop',
				message: { content: response.content },
			}],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => rawBodies.map(body => JSON.parse(body) as CapturedQwenRequest)
}

function run() {
	return extractReceiptItemsQwen('abcd', 'image/webp', 'JPY', CFG)
}

describe('extractReceiptItemsQwen', () => {
	it('uses Model Studio JSON mode and puts the schema in the prompt', async () => {
		const readBody = stubChatAndCaptureRequest(JSON.stringify(VALID_RESPONSE))

		await run()

		const body = readBody()
		expect(body.model).toBe('qwen3-vl-flash')
		expect(body.enable_thinking).toBe(false)
		expect(body.response_format).toEqual({ type: 'json_object' })
		expect(body.max_tokens).toBeUndefined()
		expect(body.messages[0]).toMatchObject({ role: 'system' })
		expect(JSON.stringify(body.messages[0])).toContain('Required JSON Schema')
		expect(JSON.stringify(body.messages[0])).toContain('totalText')
		expect(JSON.stringify(body.messages[1])).toContain('data:image/webp;base64,abcd')
	})

	it('omits enable_thinking for non-Model-Studio gateways (keeps the body OpenAI-standard)', async () => {
		const readBody = stubChatAndCaptureRequest(JSON.stringify(VALID_RESPONSE))

		await extractReceiptItemsQwen('abcd', 'image/webp', 'JPY', {
			...CFG,
			baseUrl: 'https://openrouter.ai/api/v1',
		})

		const body = readBody()
		// enable_thinking is a DashScope extension — a generic gateway must not
		// receive it (would 400 on the unknown field).
		expect(body.enable_thinking).toBeUndefined()
		expect(body.response_format?.type).toBe('json_schema')
		expect(body.response_format?.json_schema?.name).toBe('receipt_ocr')
		expect(body.response_format?.json_schema?.strict).toBe(true)
		expect(body.max_tokens).toBe(4096)
	})

	it('parses a valid response into OcrResponse', async () => {
		stubChat(JSON.stringify(VALID_RESPONSE))
		await expect(run()).resolves.toMatchObject({
			items:     [{ name: 'coffee', amountText: '380' }],
			totalText: '380',
		})
	})

	it('retries exactly one Zod schema mismatch with a correction prompt', async () => {
		const readBodies = stubChatSequence([
			{ content: JSON.stringify({ ...VALID_RESPONSE, items: 'invalid' }) },
			{ content: JSON.stringify(VALID_RESPONSE) },
		])

		await expect(run()).resolves.toMatchObject({ totalText: '380' })

		const bodies = readBodies()
		expect(bodies).toHaveLength(2)
		expect(JSON.stringify(bodies[1]?.messages[1]?.content)).toContain('Correction after validation failure')
	})

	it('accepts fenced JSON when a compatible gateway ignores response_format', async () => {
		stubChat(`\`\`\`json\n${JSON.stringify(VALID_RESPONSE)}\n\`\`\``)
		await expect(run()).resolves.toMatchObject({ totalText: '380' })
	})

	it('maps rate limits through and masks operator/config errors', async () => {
		stubStatus(429)
		await expect(run()).rejects.toMatchObject({ status: 429 })

		stubStatus(401)
		await expect(run()).rejects.toMatchObject({ status: 502 })
	})

	it('maps non-JSON and truncated output to 422', async () => {
		stubChat('not json')
		await expect(run()).rejects.toMatchObject({ status: 422 })
		expect(globalThis.fetch).toHaveBeenCalledTimes(1)

		stubChat(JSON.stringify(VALID_RESPONSE).slice(0, 12), 'length')
		await expect(run()).rejects.toMatchObject({ status: 422 })
		expect(globalThis.fetch).toHaveBeenCalledTimes(1)
	})

	it('fails fast when Qwen config is missing', async () => {
		await expect(extractReceiptItemsQwen('abcd', 'image/webp', 'JPY', {
			...CFG,
			apiKey: '',
		})).rejects.toMatchObject({ status: 502 })
	})
})
