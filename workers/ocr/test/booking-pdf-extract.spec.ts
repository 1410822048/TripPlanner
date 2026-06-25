import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKING_PDF_LINE_MAX_CHARS } from '@tripmate/pdf-page-limit'
import {
	BOOKING_PDF_EXTRACT_JSON_SCHEMA,
	BOOKING_PDF_MAX_TOKENS,
	BookingPdfExtractRequestSchema,
	BookingPdfExtractResponseSchema,
	extractBookingPdfFields,
	type BookingPdfExtractRequest,
} from '../src/booking-pdf-extract'
import type { ClaudeConfig } from '../src/claude'

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

const CFG: ClaudeConfig = {
	apiKey:   'test-key',
	resource: 'aic-claude-eus2',
	model:    'claude-sonnet-4-6',
}

const VALID_RESULT = {
	bookings: [{
		bookingType:      'hotel',
		segmentRole:      'single',
		title:            { value: 'Airbnb Sakura House', confidence: 0.92, evidence: 'Airbnb Sakura House' },
		provider:         { value: 'Airbnb', confidence: 0.95, evidence: 'Airbnb' },
		confirmationCode: { value: 'HM12345', confidence: 0.9, evidence: '確認コード HM12345' },
		origin:           { value: '', confidence: 0, evidence: '' },
		destination:      { value: '', confidence: 0, evidence: '' },
		originIataCode:   { value: '', confidence: 0, evidence: '' },
		destinationIataCode: { value: '', confidence: 0, evidence: '' },
		checkIn:          { value: '2026-07-01', confidence: 0.9, evidence: '2026/7/1' },
		checkOut:         { value: '2026-07-03', confidence: 0.9, evidence: '2026/7/3' },
		address:          { value: '東京都台東区浅草1-1-1', confidence: 0.86, evidence: '前往房源 東京都台東区浅草1-1-1' },
		link:             { value: '', confidence: 0, evidence: '' },
	}],
	warnings: [],
}

function request(over: Partial<BookingPdfExtractRequest> = {}): BookingPdfExtractRequest {
	return {
		fileName:  'airbnb.pdf',
		pageCount: 2,
		text:      'Airbnb Sakura House\n確認コード HM12345\n前往房源 東京都台東区浅草1-1-1',
		lines: [
			{ page: 1, text: 'Airbnb Sakura House', x: 100, y: 700 },
			{ page: 1, text: '確認コード HM12345', x: 100, y: 650 },
			{ page: 1, text: '如何前往 最近駅から徒歩5分', x: 100, y: 600 },
			{ page: 1, text: '前往房源 東京都台東区浅草1-1-1', x: 100, y: 560 },
		],
		...over,
	}
}

type CapturedClaudeRequest = {
	system?: string
	max_tokens?: number
	output_config?: { format?: { type?: string; schema?: unknown } }
	tools?: Array<{
		name?: string
		description?: string
		input_schema?: unknown
		strict?: boolean
		cache_control?: { type?: string }
	}>
	tool_choice?: { type?: string; name?: string }
	messages: Array<{ content: Array<{ type: string; text?: string }> }>
}

function stubToolUseAndCaptureRequest(input: unknown) {
	let rawBody = ''
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBody = String(init?.body ?? '')
		return new Response(JSON.stringify({
			type:        'message',
			role:        'assistant',
			content:     [{ type: 'tool_use', id: 'toolu_test', name: 'extract_booking_pdf', input }],
			stop_reason: 'tool_use',
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => JSON.parse(rawBody) as CapturedClaudeRequest
}

function collectSchemaKeys(value: unknown, keys = new Set<string>()): Set<string> {
	if (!value || typeof value !== 'object') return keys
	for (const [key, child] of Object.entries(value)) {
		keys.add(key)
		collectSchemaKeys(child, keys)
	}
	return keys
}

function collectSchemaKeywordKeys(value: unknown, keys = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const child of value) collectSchemaKeywordKeys(child, keys)
		return keys
	}
	if (!value || typeof value !== 'object') return keys
	for (const [key, child] of Object.entries(value)) {
		keys.add(key)
		if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
			for (const propertySchema of Object.values(child)) {
				collectSchemaKeywordKeys(propertySchema, keys)
			}
			continue
		}
		collectSchemaKeywordKeys(child, keys)
	}
	return keys
}

describe('BookingPdfExtractRequestSchema', () => {
	it('caps forged page counts and payload size before Claude is called', () => {
		expect(BookingPdfExtractRequestSchema.safeParse(request({ pageCount: 11 })).success).toBe(false)
		expect(BookingPdfExtractRequestSchema.safeParse(request({ text: 'x'.repeat(24_001) })).success).toBe(false)
		expect(BookingPdfExtractRequestSchema.safeParse(request({
			lines: Array.from({ length: 49 }, () => ({ page: 1, text: 'x'.repeat(BOOKING_PDF_LINE_MAX_CHARS), x: 0, y: 0 })),
		})).success).toBe(false)
		expect(BookingPdfExtractRequestSchema.safeParse(request({
			lines: [{ page: 1, text: 'x'.repeat(BOOKING_PDF_LINE_MAX_CHARS + 1), x: 0, y: 0 }],
		})).success).toBe(false)
	})
})

describe('extractBookingPdfFields', () => {
	it('keeps the Foundry JSON schema fields aligned with the Zod response schema', () => {
		const zodKeys = Object.keys(BookingPdfExtractResponseSchema.shape).sort()

		expect(Object.keys(BOOKING_PDF_EXTRACT_JSON_SCHEMA.properties).sort()).toEqual(zodKeys)
		expect([...BOOKING_PDF_EXTRACT_JSON_SCHEMA.required].sort()).toEqual(zodKeys)
	})

	it('sends a strict tool-use request with the conservative Zod-generated schema', async () => {
		const readBody = stubToolUseAndCaptureRequest(VALID_RESULT)

		await extractBookingPdfFields(request(), CFG)

		const body = readBody()
		const tool = body.tools?.[0]
		expect(body.output_config).toBeUndefined()
		expect(body.tool_choice).toEqual({ type: 'tool', name: 'extract_booking_pdf' })
		expect(tool?.name).toBe('extract_booking_pdf')
		expect(tool?.strict).toBe(true)
		expect(tool?.cache_control).toEqual({ type: 'ephemeral' })
		expect(tool?.input_schema).toEqual(BOOKING_PDF_EXTRACT_JSON_SCHEMA)
		expect(body.max_tokens).toBe(BOOKING_PDF_MAX_TOKENS)
		expect(body.system).toContain('Call the extract_booking_pdf tool')
		expect(BOOKING_PDF_EXTRACT_JSON_SCHEMA).toMatchObject({
			additionalProperties: false,
			properties: {
				bookings: {
					items: {
						additionalProperties: false,
						properties: {
							bookingType: { enum: ['flight', 'hotel', 'train', 'bus', 'other'] },
							segmentRole: { enum: ['single', 'outbound', 'return', 'connection', 'unknown'] },
							originIataCode: {
								additionalProperties: false,
								properties: {
									value: { type: 'string' },
								},
							},
							title: {
								additionalProperties: false,
								properties: {
									value: { type: 'string' },
								},
							},
						},
					},
				},
				warnings: { items: { type: 'string' } },
			},
		})
		expect(Array.from(collectSchemaKeys(BOOKING_PDF_EXTRACT_JSON_SCHEMA))).not.toEqual(
			expect.arrayContaining(['$schema', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'maxItems']),
		)
		expect(Array.from(collectSchemaKeywordKeys(BOOKING_PDF_EXTRACT_JSON_SCHEMA)).sort()).toEqual([
			'additionalProperties',
			'description',
			'enum',
			'items',
			'properties',
			'required',
			'type',
		])
	})

	it('parses a valid Claude response into booking fields', async () => {
		stubToolUseAndCaptureRequest(VALID_RESULT)

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [{
				bookingType:      'hotel',
				title:            { value: 'Airbnb Sakura House' },
				confirmationCode: { value: 'HM12345' },
				address:          { value: '東京都台東区浅草1-1-1' },
			}],
		})
	})

	it('truncates oversized model strings instead of rejecting useful candidates', async () => {
		const longWarning = 'w'.repeat(260)
		const longEvidence = 'e'.repeat(360)
		stubToolUseAndCaptureRequest({
			...VALID_RESULT,
			bookings: [{
				...VALID_RESULT.bookings[0]!,
				title: {
					...VALID_RESULT.bookings[0]!.title,
					evidence: longEvidence,
				},
			}],
			warnings: ['short warning', longWarning],
		})

		const result = await extractBookingPdfFields(request(), CFG)

		expect(result.warnings[1]).toHaveLength(200)
		expect(result.bookings[0]!.title.evidence).toHaveLength(300)
	})

	it('prompts Claude to prefer property address over directions text', async () => {
		const readBody = stubToolUseAndCaptureRequest(VALID_RESULT)

		await extractBookingPdfFields(request(), CFG)

		const body = readBody()
		const prompt = body.messages[0]?.content.find(part => part.type === 'text')?.text ?? ''
		expect(body.system).toContain('strict travel booking PDF extraction engine')
		expect(prompt).toContain('Return a bookings array')
		expect(prompt).toContain('deduplicate')
		expect(prompt).toContain('originIataCode and destinationIataCode')
		expect(prompt).toContain('Narita International Airport T1')
		expect(prompt).toContain('Do not infer a specific airport code from a city name alone')
		expect(prompt).toContain('Do NOT use generic directions')
		expect(prompt).toContain('前往房源')
		expect(prompt).toContain('如何前往')
	})

	it('accepts multiple transport candidates for round-trip PDFs', async () => {
		const flightField = (value: string) => ({ value, confidence: value ? 0.9 : 0, evidence: value })
		const empty = flightField('')
		stubToolUseAndCaptureRequest({
			bookings: [
				{
					bookingType:      'flight',
					segmentRole:      'outbound',
					title:            flightField('MM626'),
					provider:         flightField('Peach Aviation'),
					confirmationCode: flightField('KATR7X'),
					origin:           flightField('Taipei'),
					destination:      flightField('Tokyo'),
					originIataCode:   flightField('tpe', 'Taiwan Taoyuan International Airport T1'),
					destinationIataCode: flightField('nrt', 'Narita International Airport T1'),
					checkIn:          flightField('2026-09-18'),
					checkOut:         flightField('2026-09-18'),
					address:          empty,
					link:             empty,
				},
				{
					bookingType:      'flight',
					segmentRole:      'return',
					title:            flightField('JX803'),
					provider:         flightField('STARLUX Airlines'),
					confirmationCode: flightField('D6RGRW'),
					origin:           flightField('Tokyo'),
					destination:      flightField('Taipei'),
					originIataCode:   flightField('NRT', 'Narita International Airport T2'),
					destinationIataCode: flightField('TPE', 'Taiwan Taoyuan International Airport T1'),
					checkIn:          flightField('2026-09-26'),
					checkOut:         flightField('2026-09-26'),
					address:          empty,
					link:             empty,
				},
			],
			warnings: [],
		})

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [
				{
					bookingType: 'flight',
					segmentRole: 'outbound',
					title:       { value: 'MM626' },
					origin:      { value: 'Taipei' },
					destination: { value: 'Tokyo' },
					originIataCode: { value: 'TPE' },
					destinationIataCode: { value: 'NRT' },
				},
				{
					bookingType: 'flight',
					segmentRole: 'return',
					title:       { value: 'JX803' },
					origin:      { value: 'Tokyo' },
					destination: { value: 'Taipei' },
					originIataCode: { value: 'NRT' },
					destinationIataCode: { value: 'TPE' },
				},
			],
		})
	})

	it('normalizes concrete flight IATA code fields', async () => {
		const flightField = (value: string, evidence = value) => ({ value, confidence: value ? 0.9 : 0, evidence })
		const empty = flightField('')
		stubToolUseAndCaptureRequest({
			bookings: [{
				bookingType:      'flight',
				segmentRole:      'outbound',
				title:            flightField('MM626'),
				provider:         flightField('Peach Aviation'),
				confirmationCode: flightField('KATR7X'),
				origin:           flightField('Taipei', 'Taiwan Taoyuan International Airport T1'),
				destination:      flightField('Tokyo', 'Narita International Airport T1'),
				originIataCode:   flightField('tpe', 'Taiwan Taoyuan International Airport T1'),
				destinationIataCode: flightField('nrt', 'Narita International Airport T1'),
				checkIn:          flightField('2026-09-18'),
				checkOut:         flightField('2026-09-18'),
				address:          empty,
				link:             empty,
			}],
			warnings: [],
		})

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [{
				origin:      { value: 'Taipei' },
				destination: { value: 'Tokyo' },
				originIataCode: { value: 'TPE' },
				destinationIataCode: { value: 'NRT' },
			}],
		})
	})

	it('does not infer a specific flight airport from city-only evidence', async () => {
		const flightField = (value: string, evidence = value) => ({ value, confidence: value ? 0.9 : 0, evidence })
		const empty = flightField('')
		stubToolUseAndCaptureRequest({
			bookings: [{
				bookingType:      'flight',
				segmentRole:      'outbound',
				title:            flightField('MM626'),
				provider:         flightField('Peach Aviation'),
				confirmationCode: flightField('KATR7X'),
				origin:           flightField('Taipei', 'Taipei - Tokyo'),
				destination:      flightField('Tokyo', 'Taipei - Tokyo'),
				originIataCode:   empty,
				destinationIataCode: empty,
				checkIn:          flightField('2026-09-18'),
				checkOut:         flightField('2026-09-18'),
				address:          empty,
				link:             empty,
			}],
			warnings: [],
		})

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [{
				origin:      { value: 'Taipei' },
				destination: { value: 'Tokyo' },
				originIataCode: { value: '' },
				destinationIataCode: { value: '' },
			}],
		})
	})

	it('maps all-empty useful fields to a parse error', async () => {
		stubToolUseAndCaptureRequest({
			...VALID_RESULT,
			bookings: [{
				...VALID_RESULT.bookings[0],
				title:            { value: '', confidence: 0, evidence: '' },
				confirmationCode: { value: '', confidence: 0, evidence: '' },
				origin:           { value: '', confidence: 0, evidence: '' },
				destination:      { value: '', confidence: 0, evidence: '' },
				checkIn:          { value: '', confidence: 0, evidence: '' },
				checkOut:         { value: '', confidence: 0, evidence: '' },
				address:          { value: '', confidence: 0, evidence: '' },
			}],
		})

		await expect(extractBookingPdfFields(request(), CFG)).rejects.toMatchObject({ status: 422 })
	})
})
