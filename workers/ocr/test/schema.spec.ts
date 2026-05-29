import { describe, expect, it } from 'vitest'
import { OcrResponseSchema, GEMINI_RESPONSE_SCHEMA } from '../src/schema'

describe('OCR response schema - adjustment buckets', () => {
	it('requires ignoredLines so informational receipt rows have a non-financial bucket', () => {
		const payload = {
			items:       [{ name: '弁当', amountText: '500' }],
			adjustments: [],
			totalText:   '500',
		}

		expect(OcrResponseSchema.safeParse(payload).success).toBe(false)
	})

	it('accepts ignored included-tax / payment metadata without forcing an adjustment', () => {
		const payload = {
			items:        [{ name: '弁当', amountText: '500' }],
			adjustments:  [],
			ignoredLines: ['内消費税等 45', '現金 1,000', 'お釣り 500'],
			totalText:    '500',
		}

		expect(OcrResponseSchema.safeParse(payload).success).toBe(true)
	})

	it('accepts decimal amountText for fractional currencies (USD)', () => {
		const payload = {
			items:        [{ name: 'Coffee', amountText: '4.50' }, { name: 'Donut', amountText: '2.25' }],
			adjustments:  [],
			ignoredLines: [],
			totalText:    '6.75',
			currency:     'USD',
		}

		expect(OcrResponseSchema.safeParse(payload).success).toBe(true)
	})

	it('rejects negative / scientific / leading-or-trailing-dot / symbol amountText', () => {
		for (const bad of ['-1', '1e3', '.5', '12.', '', '¥500', '$12.34']) {
			const payload = {
				items:        [{ name: 'x', amountText: bad }],
				adjustments:  [],
				ignoredLines: [],
				totalText:    '0',
			}
			expect(OcrResponseSchema.safeParse(payload).success).toBe(false)
		}
	})

	// Defensive self-heal: receipts often print thousand separators
	// ("¥10,276") and an LLM can leak that into amountText despite the
	// prompt's "no group separator" rule. Schema strips ASCII comma,
	// full-width comma, and whitespace before regex-matching so the
	// receipt parses instead of failing the user.
	it('normalizes grouping separators (ASCII comma, full-width comma, space) in amountText', () => {
		for (const raw of ['10,276', '10，276', '10 276', '1,234.56']) {
			const payload = {
				items:        [{ name: 'x', amountText: raw }],
				adjustments:  [],
				ignoredLines: [],
				totalText:    raw,
			}
			const result = OcrResponseSchema.safeParse(payload)
			expect(result.success).toBe(true)
			if (result.success) {
				// Confirm the canonicalised value matches the expected digits.
				const expected = raw.replace(/[,，\s]/g, '')
				expect(result.data.items[0].amountText).toBe(expected)
				expect(result.data.totalText).toBe(expected)
			}
		}
	})

	it('keeps Gemini JSON schema required fields in sync with Zod schema', () => {
		expect(GEMINI_RESPONSE_SCHEMA.required).toEqual([
			'items',
			'adjustments',
			'ignoredLines',
			'totalText',
		])
	})
})
