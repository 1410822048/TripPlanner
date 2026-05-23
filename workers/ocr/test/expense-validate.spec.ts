// Unit tests for the expense validation helper. This is the logic
// that took over from firestore.rules when expense create + content
// update moved to the Worker (rules can't iterate arrays of maps).
// Coverage focuses on the invariants the rule layer could NEVER
// express:
//   - paidBy ∈ memberIds (cross-doc roster check)
//   - every splits[i].memberId ∈ memberIds
//   - amount + splits[i].amount non-negative
//   - Σ splits[i].amount === amount
//   - items[].assignees[] ∈ memberIds (if items present)
import { describe, it, expect } from 'vitest'
import {
	ExpenseValidationError,
	makeExpenseCreateSchema,
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
		title:    'Lunch',
		amount:   1000,
		currency: 'JPY',
		category: 'food' as const,
		paidBy:   'editor-uid',
		splits:   [{ memberId: 'editor-uid', amount: 1000 }],
		date:     '2026-05-21',
		...overrides,
	}
}

describe('expense schema (per-field) - makeExpenseCreateSchema', () => {
	const schema = makeExpenseCreateSchema()

	it('accepts a minimal valid payload', () => {
		expect(schema.safeParse(basePayload()).success).toBe(true)
	})

	it('rejects amount of zero or negative', () => {
		expect(schema.safeParse(basePayload({ amount: 0 })).success).toBe(false)
		expect(schema.safeParse(basePayload({ amount: -5 })).success).toBe(false)
	})

	it('rejects amount above 1B sanity cap', () => {
		expect(schema.safeParse(basePayload({
			amount: 1_000_000_001,
			splits: [{ memberId: 'editor-uid', amount: 1_000_000_001 }],
		})).success).toBe(false)
	})

	it('accepts amount at exactly the 1B cap (boundary)', () => {
		expect(schema.safeParse(basePayload({
			amount: 1_000_000_000,
			splits: [{ memberId: 'editor-uid', amount: 1_000_000_000 }],
		})).success).toBe(true)
	})

	it('rejects Infinity / NaN amounts (finite() guard)', () => {
		expect(schema.safeParse(basePayload({ amount: Infinity })).success).toBe(false)
		expect(schema.safeParse(basePayload({ amount: NaN })).success).toBe(false)
	})

	it('rejects splits with negative amount', () => {
		const res = schema.safeParse(basePayload({
			amount: 100,
			splits: [{ memberId: 'editor-uid', amount: -50 }],
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
		const huge = Array.from({ length: 51 }, () => ({ memberId: 'editor-uid', amount: 1 }))
		expect(schema.safeParse(basePayload({ splits: huge, amount: 51 })).success).toBe(false)
	})

	it('silently strips client-supplied receipt key (legacy direct-path closed in 4c)', () => {
		// Sanity-check the post-4c contract: receipt is NOT a field on
		// makeExpenseCreateSchema. Zod's default strip() behavior makes
		// the unknown key disappear from parsed output. Combined with
		// the gate-level rejection in doCreate / doUpdate, this means a
		// client-supplied receipt can never reach Firestore via this
		// path. Receipt validation (URL/path binding, mime allowlist)
		// is covered by the separate `makeReceiptSchema` block below,
		// applied to Worker-built receipts via validateBuiltReceipt.
		const path = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.webp`
		const res = schema.safeParse(basePayload({
			receipt: { url: legitReceiptUrl(path), path, type: 'image/webp' },
		}))
		expect(res.success).toBe(true)
		expect((res as { data: Record<string, unknown> }).data.receipt).toBeUndefined()
	})

	it('rejects items[] exceeding the DoS cap (100)', () => {
		const huge = Array.from({ length: 101 }, () => ({ name: 'x', amount: 1, assignees: ['editor-uid'] }))
		const res = schema.safeParse(basePayload({ items: huge }))
		expect(res.success).toBe(false)
	})

	it('rejects paidBy exceeding 128-char cap (UID length bound)', () => {
		const longUid = 'x'.repeat(129)
		const res = schema.safeParse(basePayload({
			paidBy: longUid,
			splits: [{ memberId: longUid, amount: 1000 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects splits[].memberId exceeding 128-char cap', () => {
		const longUid = 'x'.repeat(200)
		const res = schema.safeParse(basePayload({
			splits: [{ memberId: longUid, amount: 1000 }],
		}))
		expect(res.success).toBe(false)
	})

	it('rejects items[].assignees[] exceeding 128-char cap', () => {
		const longUid = 'x'.repeat(300)
		const res = schema.safeParse(basePayload({
			items: [{ name: 'x', amount: 1, assignees: [longUid] }],
		}))
		expect(res.success).toBe(false)
	})

	it('accepts paidBy at exactly 128 chars (max boundary)', () => {
		// Firebase uid max length; the validator must not reject the
		// realistic worst case.
		const maxUid = 'x'.repeat(128)
		// memberId must be in MEMBERS so the cross-field check would pass,
		// but here we only test the schema layer accepts the length.
		const res = schema.safeParse(basePayload({
			paidBy: maxUid,
			splits: [{ memberId: maxUid, amount: 1000 }],
		}))
		expect(res.success).toBe(true)
	})

	it('rejects items[i].assignees exceeding cap (50)', () => {
		const tooManyAssignees = Array.from({ length: 51 }, (_, i) => `uid-${i}`)
		const res = schema.safeParse(basePayload({
			items: [{ name: 'x', amount: 1, assignees: tooManyAssignees }],
		}))
		expect(res.success).toBe(false)
	})
})

describe('validateExpenseCrossField - settlement-engine integrity', () => {
	it('passes on valid single-payer split', () => {
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 1000 }],
		}, MEMBERS)).not.toThrow()
	})

	it('passes on equal split across all members', () => {
		expect(() => validateExpenseCrossField({
			amount: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 300 },
				{ memberId: 'editor-uid', amount: 300 },
				{ memberId: 'viewer-uid', amount: 300 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects paidBy that is not a trip member', () => {
		expect(() => validateExpenseCrossField({
			amount: 100, currency: 'JPY',
			paidBy: 'stranger-uid',                  // <-- not in MEMBERS
			splits: [{ memberId: 'editor-uid', amount: 100 }],
		}, MEMBERS)).toThrow(ExpenseValidationError)
	})

	it('rejects a split whose memberId is not a trip member', () => {
		expect(() => validateExpenseCrossField({
			amount: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'editor-uid',  amount: 50 },
				{ memberId: 'stranger-uid', amount: 50 },   // <-- not in MEMBERS
			],
		}, MEMBERS)).toThrow(/splits\[1\]\.memberId/)
	})

	it('rejects when Σ splits != amount (the headline gap rules couldn\'t close)', () => {
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 400 },
				{ memberId: 'editor-uid', amount: 400 },   // sum = 800, not 1000
			],
		}, MEMBERS)).toThrow(/sum of splits/)
	})

	it('accepts properly distributed JPY equal-split (sum exact)', () => {
		// 1000 / 3 → splitEqually distributes remainder: [334, 333, 333] = 1000
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 334 },
				{ memberId: 'editor-uid', amount: 333 },
				{ memberId: 'viewer-uid', amount: 333 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects JPY split with sub-yen amounts (no minor-unit currency tolerance)', () => {
		// Previous code tolerated |diff| <= 0.5; now JPY (0 minor units)
		// rounds each side and demands strict equality. 333.33×3 = 999.99
		// rounds to 1000... but each individual split is non-integer too,
		// and a malicious payload could exploit the gap to corrupt
		// settlement math. Strict round-then-equal is what we want.
		expect(() => validateExpenseCrossField({
			amount: 1000.5, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 333 },
				{ memberId: 'editor-uid', amount: 333 },
				{ memberId: 'viewer-uid', amount: 333 },   // sum = 999, amount = 1000.5
			],
		}, MEMBERS)).toThrow(/amount/)
	})

	it('rejects JPY splits with sub-yen amounts even when sum rounds to amount', () => {
		// The headline regression for the per-field precision gate: raw
		// caller submits 333.33 × 3 = 999.99 ≈ 1000 (sum rounds clean to
		// 1000) but each individual split sits between integer yen.
		// Settlement engine + display layer downstream assume amounts
		// are clean on the currency's minor-unit grid.
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 333.33 },
				{ memberId: 'editor-uid', amount: 333.33 },
				{ memberId: 'viewer-uid', amount: 333.34 },   // sum = 1000.00 exact
			],
		}, MEMBERS)).toThrow(/splits\[0\]\.amount/)
	})

	it('rejects USD splits with sub-cent amounts even when sum rounds to amount', () => {
		// USD analogue of the above: 1.0050 isn't a legal 2-decimal
		// amount even though three of them sum cleanly to 3.015 ≈ 3.02.
		expect(() => validateExpenseCrossField({
			amount: 3.02, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 1.0050 },
				{ memberId: 'editor-uid', amount: 1.0075 },
				{ memberId: 'viewer-uid', amount: 1.0075 },
			],
		}, MEMBERS)).toThrow(/splits\[0\]\.amount/)
	})

	it('rejects items[i].amount with sub-unit value for the currency', () => {
		// items[] amounts feed splitsFromItems on the client; sub-unit
		// items would propagate through the splits derivation, but a raw
		// caller could bypass the client and write the items directly.
		expect(() => validateExpenseCrossField({
			amount: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 100 }],
			items: [
				{ amount: 50.5, assignees: ['editor-uid'] },
				{ amount: 49.5, assignees: ['editor-uid'] },
			],
		}, MEMBERS)).toThrow(/items\[0\]\.amount/)
	})

	it('rejects amount itself with sub-unit value for the currency', () => {
		expect(() => validateExpenseCrossField({
			amount: 100.5, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 100.5 }],
		}, MEMBERS)).toThrow(/amount/)
	})

	it('accepts USD split exact at 2-decimal precision', () => {
		// $10.50 split into thirds with proper distribution = $3.50 each
		expect(() => validateExpenseCrossField({
			amount: 10.50, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 3.50 },
				{ memberId: 'editor-uid', amount: 3.50 },
				{ memberId: 'viewer-uid', amount: 3.50 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('accepts USD split with IEEE-754 drift absorbed by minor-unit rounding', () => {
		// 0.1 + 0.2 = 0.30000000000000004 in JS; rounded to cents = 30.
		expect(() => validateExpenseCrossField({
			amount: 0.3, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 0.1 },
				{ memberId: 'editor-uid', amount: 0.2 },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects USD split off by 1 cent (no half-unit tolerance for USD)', () => {
		// Previous Math.abs(diff) <= 0.5 would have accepted this --
		// 49 cent gap is well below 0.5 USD. Now: rejected.
		expect(() => validateExpenseCrossField({
			amount: 10.00, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 5.00 },
				{ memberId: 'editor-uid', amount: 4.99 },   // sum 9.99, amount 10.00
			],
		}, MEMBERS)).toThrow(/sum of splits/)
	})

	it('falls back to 2-decimal precision for unrecognised currency code', () => {
		// Honest path gets caught by Zod's `.length(3)` upstream; defensive
		// branch protects the cross-field validator from crashing on an
		// unknown code that slipped past.
		expect(() => validateExpenseCrossField({
			amount: 100.00, currency: 'XYZ',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 100.00 }],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects items whose sum does not equal amount (items-mode invariant)', () => {
		// Headline gap the Worker was the last chokepoint to close:
		// splits sum to amount (1000) but items sum to 300. On next edit
		// the items-mode toggle would regenerate splits from items and
		// silently rewrite the splits total, breaking settlement
		// chronology.
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 1000 }],
			items: [
				{ amount: 100, assignees: ['editor-uid'] },
				{ amount: 200, assignees: ['editor-uid'] },
			],
		}, MEMBERS)).toThrow(/sum of items/)
	})

	it('accepts items with negative line (discount / refund) when sum still equals amount', () => {
		// splitEqually supports negative totals for discount lines; the
		// items-sum invariant must too.
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 1000 }],
			items: [
				{ amount: 1100, assignees: ['editor-uid'] },
				{ amount: -100, assignees: ['editor-uid'] },   // discount line
			],
		}, MEMBERS)).not.toThrow()
	})

	it('skips items-sum check when items[] is empty (not items mode)', () => {
		// Schema allows items to be omitted OR an empty array. Empty
		// means "no items mode"; sum invariant should not apply.
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 1000 }],
			items: [],
		}, MEMBERS)).not.toThrow()
	})

	it('rejects items with non-member assignees', () => {
		expect(() => validateExpenseCrossField({
			amount: 100, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'editor-uid', amount: 100 }],
			items: [
				{ amount: 100, assignees: ['editor-uid', 'stranger-uid'] },   // <-- stranger
			],
		}, MEMBERS)).toThrow(/items\[0\]\.assignees\[1\]/)
	})

	// ── Per-member items↔splits consistency (P1: financial attribution) ──

	it('P1: items pin debt on C but splits pin it on B → rejected (attribution corruption vector)', async () => {
		// The headline attack: both sum invariants pass (Σitems=1000,
		// Σsplits=1000, both === amount), but items{assignees:[C]} +
		// splits{memberId:B} attribute the same 1000 to different
		// members. Settlement records B's debt; next items-mode UI
		// edit recomputes splits from items and silently flips B→C.
		expect(() => validateExpenseCrossField({
			amount: 1000, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'owner-uid',  amount: 1000 }],   // owner owes
			items:  [{ amount: 1000, assignees: ['viewer-uid'] }], // viewer ate
		}, MEMBERS)).toThrow(/member/)
	})

	it('P1: items derive correct per-member totals → accepted', async () => {
		// 3 members split a 900 yen meal: items → splits derivation is
		// the same as the client's splitsFromItems. Worker accepts the
		// match.
		expect(() => validateExpenseCrossField({
			amount: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 300 },
				{ memberId: 'editor-uid', amount: 300 },
				{ memberId: 'viewer-uid', amount: 300 },
			],
			items: [
				{ amount: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('P1: derived split contains member NOT in splits → rejected', async () => {
		// items name 3 assignees but splits only lists 2 -- the 3rd
		// member's debt would be lost from settlement.
		expect(() => validateExpenseCrossField({
			amount: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 450 },
				{ memberId: 'editor-uid', amount: 450 },   // missing viewer-uid
			],
			items: [
				{ amount: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
		}, MEMBERS)).toThrow(/items derive 3 per-member entries but splits has 2/)
	})

	it('P1: split amount differs from derived → rejected', async () => {
		// Both sides have the same 3 members; same sum (900); but
		// splits skew the distribution unevenly compared to what
		// items derive (300/300/300). This would silently rewrite
		// the per-member distribution on next items-mode UI edit.
		expect(() => validateExpenseCrossField({
			amount: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 500 },   // derived: 300
				{ memberId: 'editor-uid', amount: 200 },   // derived: 300
				{ memberId: 'viewer-uid', amount: 200 },   // derived: 300
			],
			items: [
				{ amount: 900, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
		}, MEMBERS)).toThrow(/member owner-uid: items derive 300 but splits has 500/)
	})

	it('P1: items remainder distribution (¥1 / 3 → [1, 0, 0]) preserved in splits', async () => {
		// Edge case: item amount 1 with 3 assignees → splitEqually
		// returns [1, 0, 0]. Splits must include the 0 entries (the
		// client's splitsFromItems doesn't filter them out).
		expect(() => validateExpenseCrossField({
			amount: 1, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 1 },
				{ memberId: 'editor-uid', amount: 0 },
				{ memberId: 'viewer-uid', amount: 0 },
			],
			items: [
				{ amount: 1, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('P1: USD $10 / 3 assignees → client integer convention (no minor-unit scaling)', async () => {
		// REGRESSION: an earlier version of the Worker derivation
		// scaled item.amount * factor and ran the distribution in
		// minor-unit space, producing [334¢, 333¢, 333¢] for USD $10
		// across 3 assignees. But the app's convention is amount-as-
		// integer regardless of currency (see src/utils/currency.ts):
		// client's splitsFromItems(amount=10, assignees=[a,b,c]) returns
		// [{a, 4}, {b, 3}, {c, 3}] -- dollar-unit integers. Worker MUST
		// mirror that exactly or every USD/EUR write via items mode
		// gets falsely flagged as attribution-corruption.
		expect(() => validateExpenseCrossField({
			amount: 10, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 4 },   // client splitEqually gives 4 to first
				{ memberId: 'editor-uid', amount: 3 },
				{ memberId: 'viewer-uid', amount: 3 },
			],
			items: [
				{ amount: 10, assignees: ['owner-uid', 'editor-uid', 'viewer-uid'] },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('P1: USD attribution attack still rejected (cross-member swap)', async () => {
		// The genuine attack vector must still be caught for USD:
		// items pin 10 on owner, splits pin 10 on viewer → reject.
		expect(() => validateExpenseCrossField({
			amount: 10, currency: 'USD',
			paidBy: 'editor-uid',
			splits: [{ memberId: 'viewer-uid', amount: 10 }],
			items:  [{ amount: 10, assignees: ['owner-uid'] }],
		}, MEMBERS)).toThrow(/member/)
	})

	it('P1: negative item (discount line) accumulates correctly into per-member totals', async () => {
		// Two items: ¥1500 split between owner+editor, then a ¥-600
		// discount split between the same two. Net derived totals
		// should be owner=450, editor=450.
		expect(() => validateExpenseCrossField({
			amount: 900, currency: 'JPY',
			paidBy: 'editor-uid',
			splits: [
				{ memberId: 'owner-uid',  amount: 450 },
				{ memberId: 'editor-uid', amount: 450 },
			],
			items: [
				{ amount: 1500, assignees: ['owner-uid', 'editor-uid'] },
				{ amount: -600, assignees: ['owner-uid', 'editor-uid'] },
			],
		}, MEMBERS)).not.toThrow()
	})

	it('error.field carries the dotted path for form-level error UI', () => {
		try {
			validateExpenseCrossField({
				amount: 100, currency: 'JPY',
				paidBy: 'stranger-uid',
				splits: [{ memberId: 'editor-uid', amount: 100 }],
			}, MEMBERS)
		} catch (e) {
			expect(e).toBeInstanceOf(ExpenseValidationError)
			expect((e as ExpenseValidationError).field).toBe('paidBy')
			return
		}
		expect.fail('should have thrown')
	})
})

// ── makeReceiptSchema ────────────────────────────────────────────────
//
// After Phase 3.5 commit 4c the client can no longer supply a receipt
// shape; the Worker builds it from consumed upload intents and validates
// the built object through this schema as defense-in-depth. The tests
// that used to live under makeExpenseCreateSchema (URL origin binding,
// path mismatch, thumbUrl pairing) moved here -- the receipt-shape
// invariants are the same, just exercised directly on the receipt
// schema rather than via an outer create body.

describe('makeReceiptSchema (Worker-built receipt validation)', () => {
	const schema = makeReceiptSchema(TRIP_ID, EXPENSE_ID, BUCKET)
	const okPath = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.webp`

	it('accepts a minimal valid receipt', () => {
		const res = schema.safeParse({
			url:  legitReceiptUrl(okPath),
			path: okPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(true)
	})

	it('rejects receipt.path that doesn\'t match trips/<tripId>/expenses/<expenseId>/...', () => {
		const wrongPath = 'trips/OTHER-TRIP/expenses/exp123/r.webp'
		const res = schema.safeParse({
			url:  legitReceiptUrl(wrongPath),
			path: wrongPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(false)
	})

	// P1 regression: receipt URL must be bound to receipt path. Pre-fix
	// the schema only checked the path regex; URL was any z.string().url().
	// An attacker could submit a legit-looking path but a hostile URL
	// pointing at an external server -- the Firestore doc gets written,
	// then the UI renders an evil image from off-platform.

	it('rejects receipt.url pointing at an off-Firebase origin (URL origin binding)', () => {
		const res = schema.safeParse({
			url:  'https://evil.example.com/track.png',
			path: okPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(false)
	})

	it('rejects receipt.url whose Storage path doesn\'t match receipt.path (binding mismatch)', () => {
		const wrongPath = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/something-else.webp`
		const res = schema.safeParse({
			url:  legitReceiptUrl(wrongPath),  // URL encodes wrongPath, not okPath
			path: okPath,
			type: 'image/webp',
		})
		expect(res.success).toBe(false)
	})

	it('rejects thumbUrl whose Storage path doesn\'t match thumbPath', () => {
		const thumbPath = `trips/${TRIP_ID}/expenses/${EXPENSE_ID}/r.thumb.webp`
		const res = schema.safeParse({
			url:       legitReceiptUrl(okPath),
			path:      okPath,
			type:      'image/webp',
			thumbUrl:  legitReceiptUrl(okPath),  // main path, not thumb path
			thumbPath,
		})
		expect(res.success).toBe(false)
	})

	it('rejects thumbUrl without paired thumbPath (and vice versa)', () => {
		const thumbOnly = schema.safeParse({
			url:      legitReceiptUrl(okPath),
			path:     okPath,
			type:     'image/webp',
			thumbUrl: legitReceiptUrl(okPath),
		})
		expect(thumbOnly.success).toBe(false)
	})

	it('rejects type outside the RECEIPT_MIME allowlist', () => {
		const res = schema.safeParse({
			url:  legitReceiptUrl(okPath),
			path: okPath,
			type: 'application/zip' as unknown as 'image/webp',
		})
		expect(res.success).toBe(false)
	})

	it('accepts URL with arbitrary query string (token/alt=media) on top of correct base', () => {
		const enc = okPath.replace(/\//g, '%2F')
		const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${enc}?alt=media&token=ffffffff-ffff-ffff-ffff-ffffffffffff&extra=ignored`
		const res = schema.safeParse({ url, path: okPath, type: 'image/webp' })
		expect(res.success).toBe(true)
	})
})
