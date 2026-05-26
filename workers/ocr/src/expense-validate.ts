// workers/ocr/src/expense-validate.ts
// Centralised validation for the expense-create / expense-update
// endpoints. Lives here (not in firestore.rules) because the
// invariants we need to enforce can't be expressed in CEL/rules:
//   - splits[i] inner shape ({ memberId, amount }) -- rules has no
//     array-of-maps iteration / extraction
//   - splits[i].memberId ∈ trip roster -- can't extract field set
//     from array of maps to call hasOnly() on
//   - Σ splits[i].amount === amount -- no array reduce
//
// Architecture: rules layer denies client writes on expense create
// + content update; clients call these Worker endpoints which do
// the full validation + write via Admin SDK.
import { z } from 'zod'

/** Thrown for any validation failure. `field` is a dotted path the
 *  caller can surface in form-level error UI. */
export class ExpenseValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ExpenseValidationError'
    this.field = field
  }
}

// ─── Field-level Zod schemas ──────────────────────────────────────

// TripId / ExpenseId validation lives in expense-write.ts at the
// request-shape gate (ExpenseCreateRequestSchema). Removed from
// here since they were never referenced after the request-shape
// schemas were inlined.

const ExpenseCategorySchema = z.enum([
  'food', 'transport', 'accommodation', 'activity', 'shopping', 'other',
])

// Storage path / mime for receipt. Validation lives here only --
// firestore.rules used to carry `validExpenseReceipt` as a parallel
// gate, but once expense create became `allow create: if false` the
// helper was unreachable + got deleted. Path regex pins the receipt
// to the caller-claimed expenseId so a payload can't reference
// another expense's blob.
const RECEIPT_MIME = [
  'image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/pdf',
] as const

/** Bucket-bound origin/path check. (Used to mirror a firestore.rules
 *  `validStorageUrlFor` helper that was removed in Phase 3.6 once all
 *  three media fields — expense.receipt, booking.attachment, wish.image
 *  — became Worker-authoritative.) The receipt URL MUST be a Firebase
 *  Storage
 *  download URL for the exact bucket + path in the same payload.
 *  Without this an attacker can submit a legit-looking path but an
 *  `evil.example.com/track.png` url; rules previously checked it,
 *  but the Worker bypasses rules so we have to port the invariant.
 *
 *  `path.replace(/\//g, '%2F')` matches `getDownloadURL` semantics:
 *  the entire path becomes the URL path segment with slashes percent-
 *  encoded. Our Storage paths only contain [A-Za-z0-9_./-], so no
 *  other chars need encoding for the equality check. Query string
 *  (`?alt=media&token=...`) is ignored -- it carries the per-blob
 *  download token and is irrelevant to origin binding. */
function urlMatchesPath(url: string, path: string, bucket: string): boolean {
  const prefix = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/`
  const expectedBase = prefix + path.replace(/\//g, '%2F')
  const actualBase = url.split('?')[0]
  return actualBase === expectedBase
}

/**
 * Validates the Worker-built receipt object before it gets written to
 * the expense doc. After Phase 3.5 commit 4c the client can never
 * supply this shape directly -- it's always constructed server-side
 * from consumed upload intents (`buildReceiptFromIntents` in
 * expense-write.ts). Validation here is defense-in-depth: if an intent
 * ever produced a malformed URL / path mismatch, we want a clear error
 * at write time rather than a corrupt receipt landing in Firestore.
 *
 * Exported so expense-write.ts can call it directly on the built
 * receipt -- previously this was reached indirectly via the inner
 * `receipt:` field of makeExpenseCreate/UpdateSchema. That field was
 * removed in 4c so the body validation schemas only carry client-
 * supplied fields.
 */
export function makeReceiptSchema(tripId: string, expenseId: string, bucket: string) {
  const pathRe = new RegExp(`^trips/${tripId}/expenses/${expenseId}/.+`)
  return z.object({
    url:       z.string().url().max(2048),
    path:      z.string().min(1).max(500).regex(pathRe, 'receipt.path must match trips/<tripId>/expenses/<expenseId>/...'),
    type:      z.enum(RECEIPT_MIME),
    thumbUrl:  z.string().url().max(2048).optional(),
    thumbPath: z.string().min(1).max(500).regex(pathRe, 'receipt.thumbPath must match trips/<tripId>/expenses/<expenseId>/...').optional(),
  })
    .refine(
      d => ('thumbUrl' in d) === ('thumbPath' in d),
      { message: 'thumbUrl and thumbPath must be paired', path: ['thumbUrl'] },
    )
    .refine(
      d => urlMatchesPath(d.url, d.path, bucket),
      { message: 'receipt.url must be the Firebase Storage download URL for receipt.path', path: ['url'] },
    )
    .refine(
      d => !d.thumbUrl || !d.thumbPath || urlMatchesPath(d.thumbUrl, d.thumbPath, bucket),
      { message: 'receipt.thumbUrl must be the Firebase Storage download URL for receipt.thumbPath', path: ['thumbUrl'] },
    )
}

// Firebase uid is at most 128 chars. Capping every uid-shaped string
// here bounds the validation / cross-field-includes cost an attacker
// could waste with a giant raw-POST payload of multi-MB "uids".
const UID_MAX = 128

const ExpenseSplitSchema = z.object({
  memberId: z.string().min(1).max(UID_MAX),
  // `.finite()` rejects Infinity / NaN early; the per-amount value is
  // also bounded transitively via the sum-equals-amount invariant
  // (amount itself is capped at 1B), so an explicit per-split cap
  // would be redundant.
  amount:   z.number().nonnegative().finite(),
})

const ExpenseItemSchema = z.object({
  name:      z.string().min(1).max(200),
  // Items support negative values (discount / refund lines); cap on
  // both sides so a positive-and-negative pair can't sum to a tiny
  // amount while each carrying an astronomical magnitude that would
  // overflow downstream Math.
  amount:    z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  // Items use `assignees` (list of uids); the inner validation that
  // every assignee is a trip member is checked in the cross-field
  // pass below where we have memberIds in scope.
  assignees: z.array(z.string().min(1).max(UID_MAX)).min(1),
})

/** Full create payload — the FULL client-supplied expense body the
 *  Worker will validate before write. createdBy/updatedBy/audit
 *  timestamps, memberIds, and (post-4c) `receipt` are server-supplied
 *  and NOT in this schema.
 *
 *  Items + items[].assignees carry DoS caps -- items array <=100,
 *  each item's assignees <= MEMBERS roster size (enforced in the
 *  cross-field pass), and the per-assignee uid is the standard
 *  Firebase uid length cap of 128 chars (via z.string().min(1)
 *  with implicit upper bound from memberIds.includes check). */
export function makeExpenseCreateSchema() {
  return z.object({
    title:    z.string().min(1).max(200),
    // 1B major units is a defensive sanity cap: ¥1B / $1B is far above
    // any realistic single travel expense in any currency this app
    // supports. Below this is a typo / OCR mis-read; above this is
    // outright corruption or attack. Without an upper bound a raw POST
    // could submit Number.MAX_SAFE_INTEGER and the splits/items sum
    // math would silently roll downstream into settlement displaying
    // astronomical debts.
    amount:   z.number().positive().finite().max(1_000_000_000),
    currency: z.string().length(3),
    category: ExpenseCategorySchema,
    paidBy:   z.string().min(1).max(UID_MAX),
    splits:   z.array(ExpenseSplitSchema).min(1).max(50),
    date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    note:     z.string().max(1000).optional(),
    // Items + assignees caps: OCR receipts rarely exceed ~30 line
    // items; 100 buys 3× headroom while bounding the worst-case
    // validation cost. Assignees per item caps at 50 to mirror the
    // splits cap (same per-item semantic -- N members on a line).
    items:    z.array(ExpenseItemSchema.extend({
      assignees: z.array(z.string().min(1).max(UID_MAX)).min(1).max(50),
    })).max(100).optional(),
  })
}
export type ExpenseCreateInput = z.infer<ReturnType<typeof makeExpenseCreateSchema>>

/** Update payload — partial of the create body. `receipt` is handled
 *  out-of-band by the Worker (deletion sentinel `null` or new intent-
 *  driven attachment) and is not part of this schema. */
export function makeExpenseUpdateSchema() {
  return makeExpenseCreateSchema().partial()
}
export type ExpenseUpdateInput = z.infer<ReturnType<typeof makeExpenseUpdateSchema>>

/** Output shape of `buildReceiptFromIntents` + the Worker-stored
 *  receipt field in Firestore. Defined here next to `makeReceiptSchema`
 *  so the schema, the validated output, and the encoder all reference
 *  the same single source of truth. */
export type ExpenseReceiptOut = z.infer<ReturnType<typeof makeReceiptSchema>>

// ─── Cross-field validation (needs trip member roster) ────────────

/**
 * Resolve the ISO 4217 minor-unit count for `currency` via the ICU
 * data shipped with V8. JPY → 0 (integer yen). USD/EUR → 2 (cents).
 * BHD/JOD/KWD → 3. Returns 2 for any unknown / malformed code (the
 * safe default — strict equality on 2 decimals is at least as strict
 * as on 0 or 3, and an unrecognised currency code would have already
 * failed Zod's `.length(3)` upstream of this function on the honest
 * path). The previous `Math.abs(diff) <= 0.5` tolerance let any
 * currency through a half-unit gap; even integer JPY accepted a 0.49
 * discrepancy that an attacker could splash into the doc to corrupt
 * downstream settlement / display.
 */
function minorUnitsFor(currency: string): number {
  try {
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    return fmt.resolvedOptions().minimumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Epsilon for "value lands on a minor-unit grid". 1e-6 swallows the
 *  worst-case IEEE-754 drift we'd see from summing a few dozen
 *  decimal-rounded amounts (~1e-10 per op) while still rejecting a
 *  half-unit deviation. Any genuine sub-unit value (JPY 333.33,
 *  USD 1.005) lands well above this threshold. */
const PRECISION_EPS = 1e-6

/** True when `value` rounds losslessly to the currency's minor-unit
 *  grid. For JPY (factor=1) this is "is essentially an integer". For
 *  USD/EUR (factor=100) this is "at most 2 decimal places". */
function isMinorUnitAmount(value: number, factor: number): boolean {
  const scaled = value * factor
  return Math.abs(scaled - Math.round(scaled)) < PRECISION_EPS
}

/**
 * Run the cross-field invariants that Zod can't express on its own:
 *   - paidBy ∈ memberIds
 *   - every splits[i].memberId ∈ memberIds
 *   - amount + every splits[i].amount + every items[i].amount lands
 *     on the currency's minor-unit grid (JPY = integer yen, USD/EUR
 *     = at most 2 decimals, BHD = at most 3). Without this per-field
 *     gate a raw Worker caller could write JPY 333.33 splits that
 *     still sum-round to the correct total; the settlement engine
 *     and display layers downstream assume minor-unit cleanness.
 *   - Σ splits[i].amount === amount  (strict equality after rounding
 *     each side to the currency's minor-unit precision)
 *   - Σ items[i].amount  === amount  when items.length > 0 (items
 *     mode); without this gate splits and items can diverge in a doc
 *     and a subsequent items-mode edit would regenerate splits from
 *     items, silently rewriting the splits total.
 *   - PER-MEMBER consistency between items and splits: the per-member
 *     totals derived by `splitsFromItems(items)` (matching client
 *     algorithm bit-for-bit) MUST equal splits[]. Closes a financial
 *     attribution corruption vector where items{assignees:[C]} +
 *     splits{memberId:B} both passing the sum check would record
 *     B's debt initially, then flip to C on the next items-mode UI
 *     edit -- no audit trail of the rewrite.
 *   - every items[i].assignees[j] ∈ memberIds (if items present)
 *
 * Throws ExpenseValidationError on first failure with a dotted field
 * path so callers can surface a form-level error.
 */
export function validateExpenseCrossField(
  payload: {
    amount:   number
    currency: string
    paidBy:   string
    splits:   { memberId: string; amount: number }[]
    items?:   { amount: number; assignees: string[] }[]
  },
  memberIds: string[],
): void {
  if (!memberIds.includes(payload.paidBy)) {
    throw new ExpenseValidationError('paidBy', `${payload.paidBy} is not a trip member`)
  }

  // Resolve factor up-front so every per-field precision check uses
  // the same currency-bound grid.
  const factor = 10 ** minorUnitsFor(payload.currency)

  if (!isMinorUnitAmount(payload.amount, factor)) {
    throw new ExpenseValidationError(
      'amount',
      `amount (${payload.amount}) is not aligned to ${payload.currency} minor unit`,
    )
  }

  let sum = 0
  for (let i = 0; i < payload.splits.length; i++) {
    const s = payload.splits[i]!  // safe by loop bound
    if (!memberIds.includes(s.memberId)) {
      throw new ExpenseValidationError(`splits[${i}].memberId`, `${s.memberId} is not a trip member`)
    }
    if (!isMinorUnitAmount(s.amount, factor)) {
      throw new ExpenseValidationError(
        `splits[${i}].amount`,
        `splits[${i}].amount (${s.amount}) is not aligned to ${payload.currency} minor unit`,
      )
    }
    sum += s.amount
  }
  // Sum-equals-amount, both scaled to minor-unit integers. Per-field
  // precision was just checked above, so this only catches the
  // "every individual amount is clean but they don't add up" case.
  const sumScaled    = Math.round(sum * factor)
  const amountScaled = Math.round(payload.amount * factor)
  if (sumScaled !== amountScaled) {
    throw new ExpenseValidationError(
      'splits',
      `sum of splits (${sum}) must equal amount (${payload.amount}) at currency precision`,
    )
  }
  if (payload.items && payload.items.length > 0) {
    // Σ items[i].amount must also equal amount when items mode is in
    // use. The client form gates "use items" on items.length > 0 and
    // derives splits via splitsFromItems() -- so on the client the
    // two sums move together. The Worker is the only chokepoint for
    // expense content, and a raw caller could otherwise submit splits
    // that sum to amount but items that DON'T (e.g. items sum 300,
    // splits sum 1000, amount 1000). The doc would write; on next
    // edit the form's items-mode toggle would regenerate splits from
    // items and silently rewrite splits to total 300, breaking
    // settlement chronology. Negative items (discount / refund lines)
    // are intentionally supported -- the sum invariant naturally
    // accommodates them.
    let itemSum = 0
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i]!  // safe by loop bound
      if (!isMinorUnitAmount(item.amount, factor)) {
        throw new ExpenseValidationError(
          `items[${i}].amount`,
          `items[${i}].amount (${item.amount}) is not aligned to ${payload.currency} minor unit`,
        )
      }
      itemSum += item.amount
      for (let j = 0; j < item.assignees.length; j++) {
        const uid = item.assignees[j]!  // safe by loop bound
        if (!memberIds.includes(uid)) {
          throw new ExpenseValidationError(
            `items[${i}].assignees[${j}]`,
            `${uid} is not a trip member`,
          )
        }
      }
    }
    const itemSumScaled = Math.round(itemSum * factor)
    if (itemSumScaled !== amountScaled) {
      throw new ExpenseValidationError(
        'items',
        `sum of items (${itemSum}) must equal amount (${payload.amount}) at currency precision`,
      )
    }

    // Per-member consistency: splits[] MUST equal the per-member
    // totals derivable from items[] via the client's splitsFromItems
    // algorithm. Without this, items-mode + splits-mode can disagree
    // on which member owes what -- attacker can submit items pinning
    // cost on C (assignees=[C]) but splits pinning the debt on B
    // (memberId=B). Both sums match `amount` so the existing checks
    // pass. Settlement records B's debt. Next UI edit toggles items
    // mode, derives splits from items, and silently rewrites B's
    // debt over to C. That's financial attribution corruption with
    // no audit trail. The check below mirrors splitsFromItems() in
    // src/features/expense/utils.ts BIT-FOR-BIT -- both work in the
    // integer-only major-unit domain (the app's amount-as-integer
    // convention, see src/utils/currency.ts). DO NOT introduce the
    // currency `factor` here -- it would scale into minor units and
    // produce a different distribution than the client's algorithm,
    // making legit USD/EUR writes look like attribution corruption.
    // Parity is enforced by src/features/expense/utils.parity.test.ts
    // which feeds the same fixtures through both implementations.
    const derived = splitsFromItemsMirror(payload.items)
    const actual  = new Map<string, number>()
    for (const s of payload.splits) {
      actual.set(s.memberId, Math.round(s.amount))
    }
    if (derived.size !== actual.size) {
      throw new ExpenseValidationError(
        'splits',
        `items derive ${derived.size} per-member entries but splits has ${actual.size}`,
      )
    }
    for (const [uid, derivedAmount] of derived) {
      const actualAmount = actual.get(uid)
      if (actualAmount === undefined) {
        throw new ExpenseValidationError(
          'splits',
          `member ${uid} appears in items but not in splits`,
        )
      }
      if (actualAmount !== derivedAmount) {
        throw new ExpenseValidationError(
          'splits',
          `member ${uid}: items derive ${derivedAmount} but splits has ${actualAmount}`,
        )
      }
    }
  }
}

/**
 * Worker-side mirror of `splitsFromItems()` in
 * `src/features/expense/utils.ts`. Returns a Map<memberId, integer>
 * where integer is in the same domain (major units) that the client
 * already uses. EXPORTED for the parity test that imports both this
 * and the client implementation and asserts equality over a
 * corpus -- the only thing keeping the two from drifting silently
 * over time. If you change this algorithm, that test will fail
 * loudly + point you at the client mirror.
 */
export function splitsFromItemsMirror(
  items: { amount: number; assignees: string[] }[],
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const item of items) {
    if (item.assignees.length === 0) continue
    const intTotal = Math.round(item.amount)
    if (intTotal === 0) continue
    const sign     = intTotal < 0 ? -1 : 1
    const absTotal = Math.abs(intTotal)
    const base     = Math.floor(absTotal / item.assignees.length)
    const rem      = absTotal - base * item.assignees.length
    for (let i = 0; i < item.assignees.length; i++) {
      const per = sign * (base + (i < rem ? 1 : 0))
      const uid = item.assignees[i]!  // safe by loop bound; appease noUncheckedIndexedAccess
      totals.set(uid, (totals.get(uid) ?? 0) + per)
    }
  }
  return totals
}
