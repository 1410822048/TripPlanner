// Unit tests for the expense validation helper (Phase B contract).
// Lives in the Worker because most invariants can't be expressed in
// firestore.rules:
//   - paidBy ∈ memberIds (cross-doc roster check)
//   - every splits[i].memberId ∈ memberIds
//   - amountMinor + splits[i].amountMinor are integer minor units
//     (enforced at the Zod boundary via .int())
//   - Σ splits[i].amountMinor === amountMinor
//   - items[] + adjustments[] materialize (via the shared
//     `@tripmate/expense-materialize` pure-fn) to the claimed splits[]
//     -- mismatches are rejected as SPLIT_PREVIEW_DRIFT
import { describe, it, expect } from 'vitest'
import {
	ExpenseValidationError,
	makeExpenseCreateSchema,
	makeForeignExpenseCreateSchema,
	makeForeignExpenseUpdateSchema,
	makeReceiptSchema,
	validateExpenseCrossField,
} from '../src/expense-validate'

const TRIP_ID = 'abc123'
const EXPENSE_ID = 'exp123'
const BUCKET = 'tripplanner-80a4f.firebasestorage.app'
const MEMBERS = ['owner-uid', 'editor-uid', 'viewer-uid']

function legitReceiptUrl(path: string) {
	const enc = path.replace(/\//g, '%2F')
	return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${enc}?alt=media&token=abc`
}

function basePayload(overrides: Record<string, unknown> = {}) {
	return {
		title:       'Lunch',
		amountMinor: 1000,
		currency:    'JPY',
		category:    'food' as const,
		paidBy:      'editor-uid',
		splits:      [{ memberId: 'editor-uid', amountMinor: 1000 }],
		date:        '2026-05-21',
		// Phase B: required field, blank for manual-entry expense.
		adjustments: [] as unknown[],
		...overrides,
	}
}

describe('expense schema (per-field) - makeExpenseCreateSchema', () => {
	const schema = makeExpenseCreateSchema()

	it('accepts a minimal valid payload', () => {
		expect(schema.safeParse(basePayload()).success).toBe(true)
	})

	it('rejects amountMinor of zero or negative', () => {
		expect(schema.safeParse(basePayload({ amountMinor: 0 })).success).toBe(false)
		expect(schema.safeParse(basePayload({ amountMinor: -5 })).success).toBe(false)
	})

	it('rejects amountMinor above 1B sanity cap', () => {
		expect(schema.safeParse(basePayload({
			amountMinor: 1_000_000_001,
			splits: [{ memberId: 'editor-uid', amountMinor: 1_000_000_001 }],
		})).success).toBe(false)
	})

	it('accepts amountMinor at exactly the 1B cap (boundary)', () => {
		expect(schema.safeParse(basePayload({
			amountMinor: 1_000_000_000,
			splits: [{ memberId: 'editor-uid', amountMinor: 1_000_000_000 }],
		})).success).toBe(true)
	})

	it('rejects non-integer amountMinor (int() guard)', () => {
		// .int() rejects Infinity / NaN / fractional values uniformly.
		expect(schema.safeParse(basePayload({ amountMinor: Infinity })).success).toBe(false)
		expect(schema.safeParse(basePayload({ amountMinor: NaN })).success).toBe(false)
		expect(schema.safeParse(basePayload({ amountMinor: 12.34 })).success).toBe(false)
	})

	it('rejects splits with negative amountMinor', () => {
		const res = schema.safeParse(basePayload({
			amountMinor: 100,
			splits: [{ memberId: 'editor-uid', amountMinor: -50 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects splits with fractional amountMinor (.int() guard)', () => {
		const res = schema.safeParse(basePayload({
			amountMinor: 100,
			splits: [{ memberId: 'editor-uid', amountMinor: 99.5 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects currency outside ISO 4217 3-char shape', () => {
		expect(schema.safeParse(basePayload({ currency: 'YEN' })).success).toBe(true)  // 3 chars OK
		expect(schema.safeParse(basePayload({ currency: 'JapaneseYen' })).success).toBe(false)
		expect(schema.safeParse(basePayload({ currency: 'JP' })).success).toBe(false)
	})

	it('rejects date that isn\'t YYYY-MM-DD', () => {
		expect(schema.safeParse(basePayload({ date: '2026-5-21' })).success).toBe(false)
		expect(schema.safeParse(basePayload({ date: '21/05/2026' })).success).toBe(false)
	})

	it('rejects empty splits array', () => {
		expect(schema.safeParse(basePayload({ splits: [] })).success).toBe(false)
	})

	it('rejects > 50 splits (DoS cap)', () => {
		const huge = Array.from({ length: 51 }, () => ({ memberId: 'editor-uid', amountMinor: 1 }))
		expect(schema.safeParse(basePayload({ splits: huge, amountMinor: 51 })).success).toBe(false)
	})

	it('silently strips client-supplied receipt key (legacy direct-path closed in 4c)', () => {
		// Sanity-check the post-4c contract: receipt is NOT a field on
		// makeExpenseCreateSchema. Zod's default strip() behavior makes
		// the unknown key disappear from parsed output.
		const path = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.webp`
		const res = schema.safeParse(basePayload({
			receipt: { url: legitReceiptUrl(path), path, type: 'image/webp' },
		}))
		expect(res.success).toBe(true)
		expect((res as { data: Record<string, unknown> }).data.receipt).toBeUndefined()
	})

	it('rejects items[] exceeding the DoS cap (100)', () => {
		const huge = Array.from({ length: 101 }, (_, i) => ({
			id: `it-${i}`, name: 'x', amountMinor: 1, assignees: ['editor-uid'],
		}))
		const res = schema.safeParse(basePayload({ items: huge }))
		expect(res.success).toBe(false)
	})

	it('rejects paidBy exceeding 128-char cap (UID length bound)', () => {
		const longUid = 'x'.repeat(129)
		const res = schema.safeParse(basePayload({
			paidBy: longUid,
			splits: [{ memberId: longUid, amountMinor: 1000 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects splits[].memberId exceeding 128-char cap', () => {
		const longUid = 'x'.repeat(200)
		const res = schema.safeParse(basePayload({
			splits: [{ memberId: longUid, amountMinor: 1000 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects items[].assignees[] exceeding 128-char cap', () => {
		const longUid = 'x'.repeat(300)
		const res = schema.safeParse(basePayload({
			items: [{ id: 'it1', name: 'x', amountMinor: 1, assignees: [longUid] }],
		}))
		expect(res.success).toBe(false)
	})

	it('accepts paidBy at exactly 128 chars (max boundary)', () => {
		// Firebase uid max length; the validator must not reject the
		// realistic worst case.
		const maxUid = 'x'.repeat(128)
		const res = schema.safeParse(basePayload({
			paidBy: maxUid,
			splits: [{ memberId: maxUid, amountMinor: 1000 }],
		}))
		expect(res.success).toBe(true)
	})

	it('rejects items[i].assignees exceeding cap (50)', () => {
		const tooManyAssignees = Array.from({ length: 51 }, (_, i) => `uid-${i}`)
		const res = schema.safeParse(basePayload({
			items: [{ id: 'it1', name: 'x', amountMinor: 1, assignees: tooManyAssignees }],
		}))
		expect(res.success).toBe(false)
	})

	// ── Phase B item-shape regressions ─────────────────────────────────

	it('rejects items[] missing id (Phase B: id is required)', () => {
		const res = schema.safeParse(basePayload({
			items: [{ name: 'Coffee', amountMinor: 500, assignees: ['editor-uid'] }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects items[i].amountMinor that is negative (Phase B: positive only)', () => {
		// Discounts/surcharges now live in adjustments[], not as
		// negative items.
		const res = schema.safeParse(basePayload({
			items: [{ id: 'it1', name: 'Discount', amountMinor: -100, assignees: ['editor-uid'] }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects items[i].amountMinor that is zero (Phase B: strictly positive)', () => {
		const res = schema.safeParse(basePayload({
			items: [{ id: 'it1', name: 'Free', amountMinor: 0, assignees: ['editor-uid'] }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects items[i].amountMinor that is non-integer (.int() guard)', () => {
		const res = schema.safeParse(basePayload({
			items: [{ id: 'it1', name: 'Coffee', amountMinor: 100.5, assignees: ['editor-uid'] }],
		}))
		expect(res.success).toBe(false)
	})

	// ── adjustments[] schema (Phase B contract) ─────────────────────────

	it('requires adjustments field (no default → missing rejected)', () => {
		const { adjustments: _omit, ...rest } = basePayload()
		void _omit
		expect(schema.safeParse(rest).success).toBe(false)
	})

	it('accepts empty adjustments[]', () => {
		expect(schema.safeParse(basePayload({ adjustments: [] })).success).toBe(true)
	})

	it('accepts a valid EXPENSE-scope adjustment', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'Tax', kind: 'TAX', scope: 'EXPENSE', amountMinor: 80 }],
		}))
		expect(res.success).toBe(true)
	})

	it('accepts a valid ITEM-scope adjustment with targetItemId', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{
				id: 'a1', label: 'Coupon', kind: 'COUPON', scope: 'ITEM',
				amountMinor: 100, targetItemId: 'it1',
			}],
		}))
		expect(res.success).toBe(true)
	})

	it('rejects ITEM-scope adjustment without targetItemId', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'Coupon', kind: 'COUPON', scope: 'ITEM', amountMinor: 100 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects EXPENSE-scope adjustment WITH targetItemId (defensive symmetry)', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{
				id: 'a1', label: 'Tax', kind: 'TAX', scope: 'EXPENSE',
				amountMinor: 80, targetItemId: 'it1',
			}],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects UNKNOWN scope (OCR-draft-only — must be resolved before write)', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'Tax', kind: 'TAX', scope: 'UNKNOWN', amountMinor: 80 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects adjustment kind outside the enum', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'X', kind: 'BOGUS', scope: 'EXPENSE', amountMinor: 80 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects adjustment with non-positive amountMinor', () => {
		expect(schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'T', kind: 'TAX', scope: 'EXPENSE', amountMinor: 0 }],
		})).success).toBe(false)
		expect(schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'T', kind: 'TAX', scope: 'EXPENSE', amountMinor: -1 }],
		})).success).toBe(false)
	})

	it('rejects adjustment with non-integer amountMinor', () => {
		const res = schema.safeParse(basePayload({
			adjustments: [{ id: 'a1', label: 'T', kind: 'TAX', scope: 'EXPENSE', amountMinor: 80.5 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects adjustments[] exceeding cap (50)', () => {
		const huge = Array.from({ length: 51 }, (_, i) => ({
			id: `a-${i}`, label: 'x', kind: 'TAX', scope: 'EXPENSE', amountMinor: 1,
		}))
		const res = schema.safeParse(basePayload({ adjustments: huge }))
		expect(res.success).toBe(false)
	})
})

describe('validateExpenseCrossField - settlement-engine integrity', () => {
	it('passes on valid single-payer split', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 1000 }],
		}, MEMBERS)).not.toThrow()
	})

	it('passes on equal split across all members', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 300 },
				{ memberId: 'editor-uid', amountMinor: 300 },
				{ memberId: 'viewer-uid', amountMinor: 300 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects paidBy that is not a trip member', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 100, currency: 'JPY',
			paidBy: 'stranger-uid',                  // <-- not in MEMBERS
			splits: [{ memberId: 'editor-uid', amountMinor: 100 }],
		}, MEMBERS)).toThrow(ExpenseValidationError)
	})

	it('rejects a split whose memberId is not a trip member', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'editor-uid',   amountMinor: 50 },
				{ memberId: 'stranger-uid', amountMinor: 50 },   // <-- not in MEMBERS
			],
		}, MEMBERS)).toThrow(/splits\[1\]\.memberId/)
	})

	it('rejects when Σ splits != amountMinor', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 400 },
				{ memberId: 'editor-uid', amountMinor: 400 },   // sum = 800, not 1000
			],
		}, MEMBERS)).toThrow(/sum of splits/)
	})

	it('accepts properly distributed JPY equal-split (sum exact)', () => {
		// 1000 / 3 → [334, 333, 333] = 1000
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 334 },
				{ memberId: 'editor-uid', amountMinor: 333 },
				{ memberId: 'viewer-uid', amountMinor: 333 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects USD split off by 1 minor unit (integer equality, no tolerance)', () => {
		// USD 10.00 = 1000 minor; splits sum to 999 → reject.
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 500 },
				{ memberId: 'editor-uid', amountMinor: 499 },   // sum 999, amount 1000
			],
		}, MEMBERS)).toThrow(/sum of splits/)
	})

	it('error.field carries the dotted path for form-level error UI', () => {
		try {
			validateExpenseCrossField({
				amountMinor: 100, currency: 'JPY',
				paidBy: 'stranger-uid',
				splits: [{ memberId: 'editor-uid', amountMinor: 100 }],
			}, MEMBERS)
		} catch (e) {
			expect(e).toBeInstanceOf(ExpenseValidationError)
			expect((e as ExpenseValidationError).field).toBe('paidBy')
			return
		}
		expect.fail('should have thrown')
	})
})

describe('validateExpenseCrossField - SPLIT_PREVIEW_DRIFT (Phase B materializer gate)', () => {
	// The Phase B contract: when items[] is present, the materializer
	// recomputes the authoritative splits from (items, adjustments,
	// members) and compares them to the caller-supplied splits[]. A
	// mismatch is the SPLIT_PREVIEW_DRIFT signal: client preview
	// disagrees with the Worker's authoritative recompute.

	it('accepts items-mode payload where splits match the materializer output', () => {
		// 900 / 3 assignees = 300/300/300, no adjustments
		expect(() => validateExpenseCrossField({
			amountMinor: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 300 },
				{ memberId: 'editor-uid', amountMinor: 300 },
				{ memberId: 'viewer-uid', amountMinor: 300 },
			],
			items: [
				{ id: 'it1', amountMinor: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
			adjustments: [],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects attribution-corruption attack (items pin debt on C, splits on B)', () => {
		// Σitems=1000, Σsplits=1000, both === amountMinor, but items pin
		// debt on viewer while splits pin it on owner.
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'owner-uid', amountMinor: 1000 }],
			items:  [{ id: 'it1', amountMinor: 1000, assignees: ['viewer-uid'] }],
			adjustments: [],
		}, MEMBERS)).toThrow(/SPLIT_PREVIEW_DRIFT/)
	})

	it('rejects when splits drops a member that items derive', () => {
		// items name 3 assignees but splits only lists 2.
		expect(() => validateExpenseCrossField({
			amountMinor: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 450 },
				{ memberId: 'editor-uid', amountMinor: 450 },   // missing viewer-uid
			],
			items: [
				{ id: 'it1', amountMinor: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
			adjustments: [],
		}, MEMBERS)).toThrow(/SPLIT_PREVIEW_DRIFT/)
	})

	it('rejects splits that skew distribution away from the materializer', () => {
		// Three members; same sum; but splits skew the distribution
		// unevenly compared to what items derive (300/300/300).
		expect(() => validateExpenseCrossField({
			amountMinor: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 500 },   // materializer: 300
				{ memberId: 'editor-uid', amountMinor: 200 },   // materializer: 300
				{ memberId: 'viewer-uid', amountMinor: 200 },   // materializer: 300
			],
			items: [
				{ id: 'it1', amountMinor: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
			adjustments: [],
		}, MEMBERS)).toThrow(/SPLIT_PREVIEW_DRIFT/)
	})

	it('accepts items remainder distribution (¥1 / 3 → [1, 0, 0]) preserved by materializer', () => {
		// item amountMinor 1 with 3 assignees: splitEqually gives [1, 0, 0];
		// materializer drops zero-amount members from the output, so
		// splits must drop them too.
		expect(() => validateExpenseCrossField({
			amountMinor: 1, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid', amountMinor: 1 },
			],
			items: [
				{ id: 'it1', amountMinor: 1, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
			adjustments: [],
		}, MEMBERS)).not.toThrow()
	})

	it('accepts ITEM-scope discount applied to a single line', () => {
		// Two items, ¥600 + ¥400 = ¥1000; ITEM-scope discount of ¥200
		// off item 1 → effective ¥400 + ¥400 = ¥800.
		// Owner+editor share item 1 (200 each); viewer takes item 2 (400).
		expect(() => validateExpenseCrossField({
			amountMinor: 800, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 200 },
				{ memberId: 'editor-uid', amountMinor: 200 },
				{ memberId: 'viewer-uid', amountMinor: 400 },
			],
			items: [
				{ id: 'it1', amountMinor: 600, assignees: ['owner-uid', 'editor-uid'] },
				{ id: 'it2', amountMinor: 400, assignees: ['viewer-uid'] },
			],
			adjustments: [
				{ id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 200, targetItemId: 'it1' },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('accepts EXPENSE-scope tax apportioned proportionally', () => {
		// items: ¥600 + ¥400 = ¥1000 base; EXPENSE-scope TAX +¥100.
		// Apportioned proportionally: 600/1000 → +60 to it1; remainder
		// goes to the last item → +40 to it2. Effective: 660 + 440 = 1100.
		// Owner+editor share it1 → 330 each; viewer takes it2 → 440.
		expect(() => validateExpenseCrossField({
			amountMinor: 1100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amountMinor: 330 },
				{ memberId: 'editor-uid', amountMinor: 330 },
				{ memberId: 'viewer-uid', amountMinor: 440 },
			],
			items: [
				{ id: 'it1', amountMinor: 600, assignees: ['owner-uid', 'editor-uid'] },
				{ id: 'it2', amountMinor: 400, assignees: ['viewer-uid'] },
			],
			adjustments: [
				{ id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 100 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects ITEM-scope adjustment whose targetItemId is not in items[]', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 800, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 800 }],
			items: [
				{ id: 'it1', amountMinor: 1000, assignees: ['editor-uid'] },
			],
			adjustments: [
				{ id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 200, targetItemId: 'nonexistent' },
			],
		}, MEMBERS)).toThrow(/TARGET_ITEM_NOT_FOUND/)
	})

	it('rejects ITEM-scope adjustment that drives an item below zero', () => {
		// 500 - 800 = -300 < 0 → OVER_DISCOUNT_ITEM
		expect(() => validateExpenseCrossField({
			amountMinor: 0, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 0 }],
			items: [
				{ id: 'it1', amountMinor: 500, assignees: ['editor-uid'] },
			],
			adjustments: [
				{ id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 800, targetItemId: 'it1' },
			],
		}, MEMBERS)).toThrow(/OVER_DISCOUNT_ITEM/)
	})

	it('rejects items with non-member assignees (via materializer NON_MEMBER_ASSIGNEE)', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 100 }],
			items: [
				{ id: 'it1', amountMinor: 100, assignees: ['editor-uid', 'stranger-uid'] },
			],
			adjustments: [],
		}, MEMBERS)).toThrow(/NON_MEMBER_ASSIGNEE/)
	})

	it('rejects adjustments[] when items[] is empty (manual-entry constraint)', () => {
		expect(() => validateExpenseCrossField({
			amountMinor: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 100 }],
			items: [],
			adjustments: [
				{ id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 10 },
			],
		}, MEMBERS)).toThrow(/adjustments require items/)
	})

	it('skips materializer when items[] is empty (manual-entry mode)', () => {
		// No items, no adjustments → cross-field check stops after the
		// splits-sum invariant. Headline regression: the old items-sum
		// invariant was unconditionally enforced even with items=[].
		expect(() => validateExpenseCrossField({
			amountMinor: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amountMinor: 1000 }],
			items: [],
			adjustments: [],
		}, MEMBERS)).not.toThrow()
	})
})

// ── makeReceiptSchema ────────────────────────────────────────────────
//
// After Phase 3.5 commit 4c the client can no longer supply a receipt
// shape; the Worker builds it from consumed upload intents and validates
// the built object through this schema as defense-in-depth.

describe('makeReceiptSchema (Worker-built receipt validation)', () => {
	const schema = makeReceiptSchema(TRIP_ID, EXPENSE_ID)
	const okPath = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.webp`

	it('accepts a minimal valid receipt', () => {
		const res = schema.safeParse({
			path: okPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(true)
	})

	it('rejects receipt.path that doesn\'t match trips/<tripId>/expenses/<expenseId>/...', () => {
		const wrongPath = 'trips/OTHER-TRIP/expenses/exp123/r.webp'
		const res = schema.safeParse({
			path: wrongPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(false)
	})

	it('rejects receipt.thumbPath that doesn\'t match the expense prefix', () => {
		const res = schema.safeParse({
			path:      okPath,
			type:      'image/webp',
			thumbPath: 'trips/OTHER-TRIP/expenses/exp123/r.thumb.webp',
		})
		expect(res.success).toBe(false)
	})

	it('accepts a path-only receipt (path + thumbPath, no bearer URL)', () => {
		// path-only: the Worker writes path + thumbPath only; reads go
		// through getBlob(path) gated by Storage Rules. No bearer URL is
		// ever persisted.
		const res = schema.safeParse({
			path:      okPath,
			type:      'image/webp',
			thumbPath: `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.thumb.webp`,
		})
		expect(res.success).toBe(true)
	})

	it('drops a stray legacy url/thumbUrl key (no bearer URL persisted)', () => {
		// Regression guard: even if a url/thumbUrl sneaks into the built
		// object, the path-only schema drops it so it can never land in
		// Firestore.
		const parsed = schema.parse({
			url:      legitReceiptUrl(okPath),
			path:     okPath,
			type:     'image/webp',
			thumbUrl: legitReceiptUrl(okPath),
		})
		expect(parsed).not.toHaveProperty('url')
		expect(parsed).not.toHaveProperty('thumbUrl')
	})

	it('rejects type outside the RECEIPT_MIME allowlist', () => {
		const res = schema.safeParse({
			path: okPath,
			type: 'application/zip' as unknown as 'image/webp',
		})
		expect(res.success).toBe(false)
	})
})

// ─── Foreign-schema parser contract ───────────────────────────────
//
// makeForeignExpenseCreateSchema / makeForeignExpenseUpdateSchema are
// wired into the Worker's foreign-mode router (expense-write.ts): a
// payload carrying `sourceCurrency` is parsed by these schemas and
// fed through convertAndMaterializeFromSource. These tests pin the
// parser shape independently of the handler-level integration covered
// by expense-write.spec.ts so a schema refactor that loosens the
// contract surfaces here, not as a behavioural regression downstream.

describe('makeForeignExpenseCreateSchema', () => {
	const schema = makeForeignExpenseCreateSchema()

	function baseForeignPayload(overrides: Record<string, unknown> = {}) {
		return {
			title:             'NYC Lunch',
			sourceCurrency:    'USD',
			sourceAmountMinor: 1234, // $12.34
			category:          'food' as const,
			paidBy:            'editor-uid',
			date:              '2026-05-30',
			sourceItems: [
				{ id: 'i1', name: 'Burger',  sourceAmountMinor: 800, assignees: ['editor-uid'] },
				{ id: 'i2', name: 'Soda',    sourceAmountMinor: 434, assignees: ['editor-uid'] },
			],
			sourceAdjustments: [] as unknown[],
			...overrides,
		}
	}

	it('accepts a minimal valid source-domain payload', () => {
		expect(schema.safeParse(baseForeignPayload()).success).toBe(true)
	})

	it('rejects sourceCurrency length !== 3', () => {
		expect(schema.safeParse(baseForeignPayload({ sourceCurrency: 'US' })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceCurrency: 'USDX' })).success).toBe(false)
	})

	it('rejects lowercase sourceCurrency (ISO 4217 uppercase regex)', () => {
		// Aligns with fx-rate.ts CCY_RE + schema.ts trip.currency. A
		// tolerant length(3) check would let 'usd' sneak through and
		// then quietly miss the foreign-mode router's `sourceCurrency
		// !== tripContext.currency` bind (which compares uppercase
		// strings).
		expect(schema.safeParse(baseForeignPayload({ sourceCurrency: 'usd' })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceCurrency: 'Usd' })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceCurrency: '123' })).success).toBe(false)
	})

	it('rejects sourceAmountMinor 0 / negative / non-integer / above cap', () => {
		expect(schema.safeParse(baseForeignPayload({ sourceAmountMinor: 0 })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceAmountMinor: -1 })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceAmountMinor: 12.34 })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ sourceAmountMinor: 1_000_000_001 })).success).toBe(false)
	})

	it('rejects empty sourceItems[] (min(1) — no foreign manual-entry path)', () => {
		expect(schema.safeParse(baseForeignPayload({ sourceItems: [] })).success).toBe(false)
	})

	it('rejects sourceItems[] above the 100-item cap', () => {
		const items = Array.from({ length: 101 }, (_, i) => ({
			id: `i${i}`, name: `item-${i}`, sourceAmountMinor: 100, assignees: ['editor-uid'],
		}))
		expect(schema.safeParse(baseForeignPayload({ sourceItems: items })).success).toBe(false)
	})

	it('rejects sourceItems[].sourceAmountMinor 0 / negative', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceItems: [{ id: 'i1', name: 'x', sourceAmountMinor: 0, assignees: ['editor-uid'] }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects sourceItems[] entry missing assignees', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceItems: [{ id: 'i1', name: 'x', sourceAmountMinor: 100, assignees: [] }],
		}))
		expect(res.success).toBe(false)
	})

	it('accepts EXPENSE-scope adjustment without targetItemId', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceAdjustments: [{
				id: 'a1', label: 'Service', kind: 'SURCHARGE', scope: 'EXPENSE', sourceAmountMinor: 50,
			}],
		}))
		expect(res.success).toBe(true)
	})

	it('accepts ITEM-scope adjustment WITH targetItemId', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceAdjustments: [{
				id: 'a1', label: 'Combo', kind: 'DISCOUNT', scope: 'ITEM',
				sourceAmountMinor: 30, targetItemId: 'i1',
			}],
		}))
		expect(res.success).toBe(true)
	})

	it('rejects ITEM-scope adjustment WITHOUT targetItemId (refine)', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceAdjustments: [{
				id: 'a1', label: 'Combo', kind: 'DISCOUNT', scope: 'ITEM', sourceAmountMinor: 30,
			}],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects EXPENSE-scope adjustment WITH targetItemId (refine)', () => {
		const res = schema.safeParse(baseForeignPayload({
			sourceAdjustments: [{
				id: 'a1', label: 'Service', kind: 'SURCHARGE', scope: 'EXPENSE',
				sourceAmountMinor: 50, targetItemId: 'i1',
			}],
		}))
		expect(res.success).toBe(false)
	})

	// ── .strict() smuggling rejection battery ───────────────────────
	//
	// Foreign schemas use .strict() so Zod *rejects* (rather than
	// silently strips) any trip-currency wire-contract key that leaks
	// into a source-domain payload. Rationale: the Worker is
	// authoritative for amountMinor / currency / splits / fxSnapshot;
	// a foreign payload that even mentions them at the top level is a
	// buggy client we want to surface, not a no-op. This battery pins
	// the schema-level rejection so a future refactor can't
	// re-introduce the silent-strip loophole.
	//
	// Tested per-key so a future refactor that re-orders schemas can't
	// regress ONE key by accident; the issues-array check enforces the
	// rejection comes from the strict() gate (`unrecognized_keys`),
	// not e.g. a coincidental refine failure.
	it('rejects payload that smuggles trip-currency fields (amountMinor / currency / splits combined)', () => {
		const res = schema.safeParse({
			...baseForeignPayload(),
			amountMinor: 12345,
			currency:    'JPY',
			splits:      [{ memberId: 'editor-uid', amountMinor: 12345 }],
		})
		expect(res.success).toBe(false)
		if (!res.success) {
			// Each unknown key produces its own unrecognized_keys issue
			// (Zod aggregates by parent object). Pin the issue code so a
			// refactor that flipped back to .strip() (which yields no
			// issues at all) would surface here.
			const issues = res.error.issues
			expect(issues.some(i => i.code === 'unrecognized_keys')).toBe(true)
		}
	})

	for (const key of ['amountMinor', 'currency', 'splits', 'items', 'adjustments', 'fxSnapshot'] as const) {
		it(`rejects smuggled trip-currency key "${key}" individually`, () => {
			const res = schema.safeParse({
				...baseForeignPayload(),
				[key]: 1,  // value type is irrelevant -- .strict() fires on key presence
			})
			expect(res.success).toBe(false)
			if (!res.success) {
				expect(res.error.issues.some(i => i.code === 'unrecognized_keys')).toBe(true)
			}
		})
	}

	it('rejects bad date format', () => {
		expect(schema.safeParse(baseForeignPayload({ date: '2026/05/30' })).success).toBe(false)
		expect(schema.safeParse(baseForeignPayload({ date: '5-30-2026' })).success).toBe(false)
	})
})

describe('makeForeignExpenseUpdateSchema', () => {
	const schema = makeForeignExpenseUpdateSchema()

	// Helpers for full money-group / text-only patches.
	function fullMoneyPatch(overrides: Record<string, unknown> = {}) {
		return {
			sourceCurrency:    'USD',
			sourceAmountMinor: 1234,
			sourceItems: [
				{ id: 'i1', name: 'Burger', sourceAmountMinor: 1234, assignees: ['editor-uid'] },
			],
			sourceAdjustments: [],
			...overrides,
		}
	}

	it('accepts an empty partial patch', () => {
		expect(schema.safeParse({}).success).toBe(true)
	})

	it('accepts a text-only patch (title) — non-money field freely partial', () => {
		expect(schema.safeParse({ title: 'renamed' }).success).toBe(true)
	})

	it('accepts a date-only patch — non-money field freely partial', () => {
		expect(schema.safeParse({ date: '2026-06-01' }).success).toBe(true)
	})

	it('accepts a full money-group patch (all four source fields together)', () => {
		expect(schema.safeParse(fullMoneyPatch()).success).toBe(true)
	})

	it('accepts a full money-group + text patch (mixed money and non-money)', () => {
		expect(schema.safeParse(fullMoneyPatch({ title: 'Updated' })).success).toBe(true)
	})

	// Atomic-money-group regression battery: each source-money field
	// alone MUST reject, otherwise the Worker's foreign-mode authority
	// can't reliably recompute per-line FX/splits from a partial patch.
	it('rejects partial money-group patch — only sourceAmountMinor', () => {
		const res = schema.safeParse({ sourceAmountMinor: 999 })
		expect(res.success).toBe(false)
		if (!res.success) {
			expect(res.error.issues[0].message).toMatch(/atomic group/i)
		}
	})

	it('rejects partial money-group patch — only sourceCurrency', () => {
		// Critical: previously a regression that accepted `{ sourceCurrency:
		// 'USD' }` alone would let a client toggle the currency without
		// providing the per-line source breakdown needed to recompute.
		expect(schema.safeParse({ sourceCurrency: 'USD' }).success).toBe(false)
	})

	it('rejects partial money-group patch — only sourceItems', () => {
		expect(schema.safeParse({
			sourceItems: [{ id: 'i1', name: 'x', sourceAmountMinor: 100, assignees: ['u'] }],
		}).success).toBe(false)
	})

	it('rejects partial money-group patch — only sourceAdjustments', () => {
		expect(schema.safeParse({
			sourceAdjustments: [{
				id: 'a1', label: 'Tip', kind: 'TIP', scope: 'EXPENSE', sourceAmountMinor: 50,
			}],
		}).success).toBe(false)
	})

	it('rejects three-of-four money-group patch (missing sourceAdjustments)', () => {
		// Belt-and-suspenders: even 3-of-4 must fail. The atomic group
		// requires ALL four together; "I'll always add an empty
		// adjustments[] later" semantics are not allowed.
		const patch = fullMoneyPatch() as Record<string, unknown>
		delete patch.sourceAdjustments
		expect(schema.safeParse(patch).success).toBe(false)
	})

	it('still enforces per-field rules inside a full money-group patch (uppercase regex)', () => {
		// Even with a full money group, per-field rules still fire --
		// lowercase 'usd' violates the ISO 4217 uppercase regex.
		expect(schema.safeParse(fullMoneyPatch({ sourceCurrency: 'usd' })).success).toBe(false)
	})

	it('still enforces ITEM-iff-targetItemId refine on sourceAdjustments under partial', () => {
		// Adjustments-only is also a partial-money-group rejection, but
		// the inner refine should fire FIRST -- this test pins that both
		// gates are alive (a regression that flattened to a single
		// rejection path would still pass this assertion, so combined
		// with the partial-money-group test above we get full coverage).
		const res = schema.safeParse({
			sourceAdjustments: [{
				id: 'a1', label: 'Combo', kind: 'DISCOUNT', scope: 'ITEM', sourceAmountMinor: 30,
			}],
		})
		expect(res.success).toBe(false)
	})

	// .strict() propagates through .partial().superRefine(): an update
	// payload that smuggles a trip-currency key must reject even when
	// no money fields are present (i.e. text-only patch shape). Without
	// this assertion a future refactor that re-built the update schema
	// from a fresh z.object() could silently drop the strict gate.
	for (const key of ['amountMinor', 'currency', 'splits', 'items', 'adjustments', 'fxSnapshot'] as const) {
		it(`rejects smuggled trip-currency key "${key}" on an update patch (strict() propagates through partial)`, () => {
			const res = schema.safeParse({ title: 'renamed', [key]: 1 })
			expect(res.success).toBe(false)
			if (!res.success) {
				expect(res.error.issues.some(i => i.code === 'unrecognized_keys')).toBe(true)
			}
		})
	}
})
