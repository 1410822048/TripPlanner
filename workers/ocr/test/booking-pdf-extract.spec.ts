import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKING_PDF_LINE_MAX_CHARS } from '@tripmate/pdf-page-limit'
import {
	BOOKING_PDF_EXTRACT_JSON_SCHEMA,
	BookingPdfExtractRequestSchema,
	BookingPdfExtractResponseSchema,
	extractBookingPdfFields,
	parseVisibleDateRanges,
	type BookingPdfExtractRequest,
} from '../src/booking-pdf-extract'
import type { QwenConfig } from '../src/qwen'

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

const CFG: QwenConfig = {
	apiKey:  'test-key',
	baseUrl: 'https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
	model:   'qwen3.7-flash',
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

type CapturedQwenRequest = {
	model?: string
	max_tokens?: number
	enable_thinking?: boolean
	response_format?: {
		type?: string
		json_schema?: { name?: string; strict?: boolean; schema?: unknown }
	}
	messages: Array<{ role: string; content: string }>
}

function stubQwenAndCaptureRequest(input: unknown) {
	let rawBody = ''
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBody = String(init?.body ?? '')
		return new Response(JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(input) } }],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => JSON.parse(rawBody) as CapturedQwenRequest
}

function stubQwenSequence(inputs: unknown[]) {
	const rawBodies: string[] = []
	let call = 0
	globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		rawBodies.push(String(init?.body ?? ''))
		const content = inputs[call++]
		return new Response(JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	return () => rawBodies.map(body => JSON.parse(body) as CapturedQwenRequest)
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
	it('caps forged page counts and payload size before Qwen is called', () => {
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

		// The production constant is deliberately a loose JsonObject — it
		// goes straight to the provider API. Narrow it by CHECKING, not by
		// asserting: an `as unknown as` here would let a schema that lost
		// `properties` or `required` keep compiling, which is the exact
		// "the test describes a shape that no longer exists" failure this
		// whole type-gate exercise is about.
		const { properties, required } = BOOKING_PDF_EXTRACT_JSON_SCHEMA
		if (
			!properties || typeof properties !== 'object' || Array.isArray(properties) ||
			!Array.isArray(required) || !required.every(key => typeof key === 'string')
		) {
			throw new TypeError('BOOKING_PDF_EXTRACT_JSON_SCHEMA lost its properties/required shape')
		}

		expect(Object.keys(properties).sort()).toEqual(zodKeys)
		expect([...required].sort()).toEqual(zodKeys)
	})

	it('uses Model Studio JSON mode with the conservative schema in the prompt', async () => {
		const readBody = stubQwenAndCaptureRequest(VALID_RESULT)

		await extractBookingPdfFields(request(), CFG)

		const body = readBody()
		expect(body.model).toBe('qwen3.7-flash')
		expect(body.enable_thinking).toBe(false)
		expect(body.response_format).toEqual({ type: 'json_object' })
		expect(body.max_tokens).toBeUndefined()
		expect(body.messages[0]?.content).toContain('Return exactly one JSON object')
		expect(body.messages[0]?.content).toContain('Required JSON Schema')
		expect(body.messages[0]?.content).toContain('"title"')
		expect(body.messages[1]?.content).toContain('Never return any of these fields as a bare string')
		expect(body.messages[1]?.content).toContain('A " | " inside a line marks a column boundary')
		expect(body.messages[1]?.content).toContain('2026年9月18日至26日')
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

	it('retries one schema mismatch with an explicit field-shape correction', async () => {
		const readBodies = stubQwenSequence([
			{
				...VALID_RESULT,
				bookings: [{ ...VALID_RESULT.bookings[0], title: 'Airbnb Sakura House' }],
			},
			VALID_RESULT,
		])

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [{ title: { value: 'Airbnb Sakura House' } }],
		})

		const bodies = readBodies()
		expect(bodies).toHaveLength(2)
		expect(bodies[1]?.messages[1]?.content).toContain('Correction after validation failure')
		expect(bodies[1]?.messages[1]?.content).toContain('bare strings are invalid')
	})

	it('fails fast on truncated output instead of repeating the same request', async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
			choices: [{ finish_reason: 'length', message: { content: '{"bookings":' } }],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

		await expect(extractBookingPdfFields(request(), CFG)).rejects.toMatchObject({ status: 422 })
		expect(globalThis.fetch).toHaveBeenCalledTimes(1)
	})

	it('parses a valid Qwen response into booking fields', async () => {
		stubQwenAndCaptureRequest(VALID_RESULT)

		await expect(extractBookingPdfFields(request(), CFG)).resolves.toMatchObject({
			bookings: [{
				bookingType:      'hotel',
				title:            { value: 'Airbnb Sakura House' },
				confirmationCode: { value: 'HM12345' },
				address:          { value: '東京都台東区浅草1-1-1' },
			}],
		})
	})

	it('fills empty hotel dates from one explicit visible date range', async () => {
		stubQwenAndCaptureRequest({
			...VALID_RESULT,
			bookings: [{
				...VALID_RESULT.bookings[0],
				checkIn:  { value: '', confidence: 0, evidence: '' },
				checkOut: { value: '', confidence: 0, evidence: '' },
			}],
			warnings: ['Dates were left empty because the year was considered ambiguous.'],
		})

		const result = await extractBookingPdfFields(request({
			text: '入住 | 退房\n9月18日 週五 | 9月26日 週六\n2026年9月18日至26日',
			lines: [
				{ page: 1, text: '入住 | 退房', x: 100, y: 285 },
				{ page: 1, text: '9月18日 週五 | 9月26日 週六', x: 100, y: 264 },
				{ page: 2, text: '2026年9月18日至26日', x: 252, y: 393 },
			],
		}), CFG)

		expect(result.bookings[0]).toMatchObject({
			checkIn:  { value: '2026-09-18', confidence: 1, evidence: '2026年9月18日至26日' },
			checkOut: { value: '2026-09-26', confidence: 1, evidence: '2026年9月18日至26日' },
		})
	})

	it('does not guess hotel dates when multiple explicit ranges conflict', async () => {
		stubQwenAndCaptureRequest({
			...VALID_RESULT,
			bookings: [{
				...VALID_RESULT.bookings[0],
				checkIn:  { value: '', confidence: 0, evidence: '' },
				checkOut: { value: '', confidence: 0, evidence: '' },
			}],
		})

		const result = await extractBookingPdfFields(request({
			text: '2026年9月18日至26日\n2026年10月1日至3日',
			lines: [
				{ page: 1, text: '2026年9月18日至26日', x: 100, y: 300 },
				{ page: 2, text: '2026年10月1日至3日', x: 100, y: 300 },
			],
		}), CFG)

		expect(result.bookings[0]).toMatchObject({
			checkIn:  { value: '' },
			checkOut: { value: '' },
		})
	})

	it('does not guess hotel dates when one line carries two column-merged ranges', async () => {
		stubQwenAndCaptureRequest({
			...VALID_RESULT,
			bookings: [{
				...VALID_RESULT.bookings[0],
				checkIn:  { value: '', confidence: 0, evidence: '' },
				checkOut: { value: '', confidence: 0, evidence: '' },
			}],
		})

		const result = await extractBookingPdfFields(request({
			text: '2026年9月18日至26日 | 2026年10月1日至3日',
			lines: [
				{ page: 1, text: '2026年9月18日至26日 | 2026年10月1日至3日', x: 100, y: 300 },
			],
		}), CFG)

		expect(result.bookings[0]).toMatchObject({
			checkIn:  { value: '' },
			checkOut: { value: '' },
		})
	})

	it('truncates oversized model strings instead of rejecting useful candidates', async () => {
		const longWarning = 'w'.repeat(260)
		const longEvidence = 'e'.repeat(360)
		stubQwenAndCaptureRequest({
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

	it('prompts Qwen to prefer property address over directions text', async () => {
		const readBody = stubQwenAndCaptureRequest(VALID_RESULT)

		await extractBookingPdfFields(request(), CFG)

		const body = readBody()
		const system = body.messages[0]?.content ?? ''
		const prompt = body.messages[1]?.content ?? ''
		expect(system).toContain('strict travel booking PDF extraction engine')
		expect(prompt).toContain('Return a bookings array')
		expect(prompt).toContain('deduplicate')
		expect(prompt).toContain('originIataCode and destinationIataCode')
		expect(prompt).toContain('origin and destination MUST be the three-letter IATA airport codes')
		expect(prompt).toContain('full airport names or terminal details only in evidence')
		expect(prompt).toContain('Narita International Airport T1')
		expect(prompt).toContain('Do not infer a specific airport code from a city name alone')
		expect(prompt).toContain('Do NOT use generic directions')
		expect(prompt).toContain('前往房源')
		expect(prompt).toContain('如何前往')
	})

	it('accepts multiple transport candidates for round-trip PDFs', async () => {
		const flightField = (value: string, evidence = value) => ({ value, confidence: value ? 0.9 : 0, evidence })
		const empty = flightField('')
		stubQwenAndCaptureRequest({
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
					// evidence asserted too: these four fields were being fed
					// an airport name as a second argument that the helper
					// silently dropped, so the scenario the test names —
					// IATA code carrying its full airport evidence — was
					// never actually set up.
					originIataCode: { value: 'TPE', evidence: 'Taiwan Taoyuan International Airport T1' },
					destinationIataCode: { value: 'NRT', evidence: 'Narita International Airport T1' },
				},
				{
					bookingType: 'flight',
					segmentRole: 'return',
					title:       { value: 'JX803' },
					origin:      { value: 'Tokyo' },
					destination: { value: 'Taipei' },
					originIataCode: { value: 'NRT', evidence: 'Narita International Airport T2' },
					destinationIataCode: { value: 'TPE', evidence: 'Taiwan Taoyuan International Airport T1' },
				},
			],
		})
	})

	it('normalizes concrete flight IATA code fields', async () => {
		const flightField = (value: string, evidence = value) => ({ value, confidence: value ? 0.9 : 0, evidence })
		const empty = flightField('')
		stubQwenAndCaptureRequest({
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
		stubQwenAndCaptureRequest({
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
		stubQwenAndCaptureRequest({
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

describe('parseVisibleDateRanges', () => {
	const CASES: Array<[string, string, Array<[string, string]>]> = [
		['U+301C wave dash',                 '2026年9月18日〜26日',                     [['2026-09-18', '2026-09-26']]],
		['NFKC-normalized tilde',            '2026年9月18日~26日',                      [['2026-09-18', '2026-09-26']]],
		['year rollover',                    '2026年12月28日至1月3日',                  [['2026-12-28', '2027-01-03']]],
		['two column-merged ranges',         '2026年9月18日至26日 | 2026年10月1日至3日', [['2026-09-18', '2026-09-26'], ['2026-10-01', '2026-10-03']]],
		['90 nights accepted',               '2026年1月1日至4月1日',                    [['2026-01-01', '2026-04-01']]],
		['91 nights rejected',               '2026年1月1日至4月2日',                    []],
		['zero nights rejected',             '2026年9月18日至18日',                     []],
		['impossible calendar date rejected', '2026年2月28日至30日',                     []],
		['validity period rejected',         '2026年1月1日至12月31日',                  []],
	]

	it.each(CASES)('%s', (_name, text, expected) => {
		expect(parseVisibleDateRanges(text).map(range => [range.checkIn, range.checkOut])).toEqual(expected)
	})

	it('does not leak lastIndex across calls on the shared pattern', () => {
		expect(parseVisibleDateRanges('2026年9月18日〜26日')).toHaveLength(1)
		expect(parseVisibleDateRanges('2026年9月18日〜26日')).toHaveLength(1)
	})
})
