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
		response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean } }
		messages: Array<{ role: string; content: unknown }>
	}
}

function run() {
	return extractReceiptItemsQwen('abcd', 'image/webp', 'JPY', CFG)
}

describe('extractReceiptItemsQwen', () => {
	it('sends an OpenAI-compatible vision request with JSON schema response_format', async () => {
		const readBody = stubChatAndCaptureRequest(JSON.stringify(VALID_RESPONSE))

		await run()

		const body = readBody()
		expect(body.model).toBe('qwen3-vl-flash')
		expect(body.response_format?.type).toBe('json_schema')
		expect(body.response_format?.json_schema?.name).toBe('receipt_ocr')
		expect(body.response_format?.json_schema?.strict).toBe(true)
		expect(body.messages[0]).toMatchObject({ role: 'system' })
		expect(JSON.stringify(body.messages[1])).toContain('data:image/webp;base64,abcd')
	})

	it('parses a valid response into OcrResponse', async () => {
		stubChat(JSON.stringify(VALID_RESPONSE))
		await expect(run()).resolves.toMatchObject({
			items:     [{ name: 'coffee', amountText: '380' }],
			totalText: '380',
		})
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

		stubChat(JSON.stringify(VALID_RESPONSE).slice(0, 12), 'length')
		await expect(run()).rejects.toMatchObject({ status: 422 })
	})

	it('fails fast when Qwen config is missing', async () => {
		await expect(extractReceiptItemsQwen('abcd', 'image/webp', 'JPY', {
			...CFG,
			apiKey: '',
		})).rejects.toMatchObject({ status: 502 })
	})
})
