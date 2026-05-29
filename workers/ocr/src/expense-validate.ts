// workers/ocr/src/expense-validate.ts
// Centralised validation for the expense-create / expense-update
// endpoints. Lives here (not in firestore.rules) because the
// invariants we need to enforce can't be expressed in CEL/rules:
//   - splits[i] inner shape ({ memberId, amountMinor }) -- rules has
//     no array-of-maps iteration / extraction
//   - splits[i].memberId ∈ trip roster -- can't extract field set
//     from array of maps to call hasOnly() on
//   - Σ splits[i].amountMinor === amountMinor -- no array reduce
//   - items[] + adjustments[] materialize to the claimed splits[]
//     (Phase B SPLIT_PREVIEW_DRIFT gate -- defers to
//     `@tripmate/expense-materialize` for the canonical pure-fn)
//
// Money: every wire-level amount is an integer minor-unit value
// (JPY → yen, USD → cents). The form layer parses display strings via
// parseMoneyToMinor before mutating; the Worker trusts integer input
// and rejects non-integers at the Zod boundary.
//
// Architecture: rules layer denies client writes on expense create
// + content update; clients call these Worker endpoints which do
// the full validation + write via Admin SDK.
import { z } from 'zod'
import {
  materializeExpenseSplits,
  canonicalizeSplits,
  MaterializeError,
  type MaterializeAdjustment,
  type MaterializeItem,
} from '@tripmate/expense-materialize'

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
  memberId:    z.string().min(1).max(UID_MAX),
  // Integer minor-unit grid is enforced by `.int()`; the per-split
  // value is also bounded transitively via the sum-equals-amountMinor
  // invariant (amountMinor itself capped at 1B), so an explicit
  // per-split cap would be redundant.
  amountMinor: z.number().int().nonnegative(),
})

// Phase B item schema: positive integer minor-unit amount, id required.
// Negative discount/tax/tip lines live in the sibling `adjustments[]`
// array. The materializer (`@tripmate/expense-materialize`) is the
// authoritative split gate and rejects non-positive items with
// ITEM_NOT_POSITIVE_INTEGER -- this schema rejects the same set at the
// request boundary so we get a clean Zod error path before the
// materializer runs in cross-field validation.
const ExpenseItemSchema = z.object({
  id:          z.string().min(1).max(64),
  name:        z.string().min(1).max(200),
  amountMinor: z.number().int().positive().max(1_000_000_000),
  // Items use `assignees` (list of uids); the inner validation that
  // every assignee is a trip member is checked in the cross-field
  // pass below where we have memberIds in scope.
  assignees:   z.array(z.string().min(1).max(UID_MAX)).min(1),
})

// Phase B adjustment shape. amountMinor is POSITIVE integer minor units;
// the sign on the expense total comes from `kind`. `scope` is either
// ITEM (delta is applied to a single line) or EXPENSE (delta is
// apportioned across all positive-effective items proportional to
// their current weight). `UNKNOWN` is OCR-draft-only and NOT accepted
// here -- the client downgrades it to EXPENSE by default and exposes
// the adjustment row so the user can switch it to ITEM before saving.
const ExpenseAdjustmentKindSchema = z.enum([
  'DISCOUNT', 'COUPON', 'TAX_EXEMPT', 'SURCHARGE', 'TAX', 'TIP', 'OTHER',
])
const ExpenseAdjustmentScopeSchema = z.enum(['ITEM', 'EXPENSE'])
const ExpenseAdjustmentSchema = z.object({
  id:           z.string().min(1).max(64),
  label:        z.string().min(1).max(120),
  kind:         ExpenseAdjustmentKindSchema,
  scope:        ExpenseAdjustmentScopeSchema,
  amountMinor:  z.number().int().positive().max(1_000_000_000),
  targetItemId: z.string().min(1).max(64).optional(),
}).refine(
  d => (d.scope === 'ITEM') === (d.targetItemId !== undefined),
  { message: 'targetItemId must be present iff scope === ITEM', path: ['targetItemId'] },
)

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
    title:       z.string().min(1).max(200),
    // 1B minor units is a defensive sanity cap: ¥1,000,000,000 (≈ ¥1B)
    // or $10,000,000.00 is far above any realistic single travel
    // expense in any currency this app supports. Below this is a typo
    // / OCR mis-read; above this is outright corruption or attack.
    // Without an upper bound a raw POST could submit
    // Number.MAX_SAFE_INTEGER and the splits/items sum math would
    // silently roll downstream into settlement displaying astronomical
    // debts.
    amountMinor: z.number().int().positive().max(1_000_000_000),
    currency:    z.string().length(3),
    category:    ExpenseCategorySchema,
    paidBy:      z.string().min(1).max(UID_MAX),
    splits:      z.array(ExpenseSplitSchema).min(1).max(50),
    date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    note:        z.string().max(1000).optional(),
    // Items + assignees caps: OCR receipts rarely exceed ~30 line
    // items; 100 buys 3× headroom while bounding the worst-case
    // validation cost. Assignees per item caps at 50 to mirror the
    // splits cap (same per-item semantic -- N members on a line).
    items:       z.array(ExpenseItemSchema.extend({
      assignees: z.array(z.string().min(1).max(UID_MAX)).min(1).max(50),
    })).max(100).optional(),
    // Phase B: persisted adjustments. Required (default empty array) so
    // every doc carries the field; legacy docs missing it fail
    // parse on read per the no-backcompat decision. Cap at 50 matches
    // a generous receipt: tax + tip + a handful of per-item discounts.
    adjustments: z.array(ExpenseAdjustmentSchema).max(50),
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
 * Run the cross-field invariants that Zod can't express on its own:
 *   - paidBy ∈ memberIds
 *   - every splits[i].memberId ∈ memberIds
 *   - Σ splits[i].amountMinor === amountMinor  (integer equality)
 *   - When items.length > 0: the materializer (`@tripmate/expense-
 *     materialize::materializeExpenseSplits`) recomputes the
 *     authoritative splits from (items, adjustments, members) and
 *     `canonicalizeSplits` is compared against the caller-supplied
 *     splits[]. A mismatch is rejected as SPLIT_PREVIEW_DRIFT --
 *     closes the same financial attribution corruption vector the
 *     old splitsFromItemsMirror per-member check guarded, but with
 *     the canonical pure-fn shared by client preview + Worker
 *     authoritative recompute so there's no second impl to drift.
 *   - every items[i].assignees[j] ∈ memberIds (handled by the
 *     materializer's NON_MEMBER_ASSIGNEE guard, re-thrown as
 *     ExpenseValidationError below).
 *
 * Per-field minor-unit-grid checks (formerly `isMinorUnitAmount` +
 * `minorUnitsFor`) are gone: every wire-level money field is now
 * `z.number().int()` at the Zod gate, so a malformed float can't
 * reach this layer in the first place.
 *
 * Throws ExpenseValidationError on first failure with a dotted field
 * path so callers can surface a form-level error.
 */
export function validateExpenseCrossField(
  payload: {
    amountMinor:  number
    currency:     string
    paidBy:       string
    splits:       { memberId: string; amountMinor: number }[]
    items?:       { id: string; amountMinor: number; assignees: string[] }[]
    adjustments?: {
      id:            string
      kind:          string
      scope:         string
      amountMinor:   number
      targetItemId?: string
    }[]
  },
  memberIds: string[],
): void {
  if (!memberIds.includes(payload.paidBy)) {
    throw new ExpenseValidationError('paidBy', `${payload.paidBy} is not a trip member`)
  }

  let sum = 0
  for (let i = 0; i < payload.splits.length; i++) {
    const s = payload.splits[i]!  // safe by loop bound
    if (!memberIds.includes(s.memberId)) {
      throw new ExpenseValidationError(`splits[${i}].memberId`, `${s.memberId} is not a trip member`)
    }
    sum += s.amountMinor
  }
  if (sum !== payload.amountMinor) {
    throw new ExpenseValidationError(
      'splits',
      `sum of splits (${sum}) must equal amountMinor (${payload.amountMinor})`,
    )
  }

  // Phase B: when items[] is present, the materializer is the
  // authoritative split gate. Compare canonicalize(materialized)
  // against canonicalize(payload.splits); mismatch is the
  // SPLIT_PREVIEW_DRIFT signal -- caller's client-preview disagrees
  // with the Worker's authoritative recompute. The materializer also
  // enforces the items/adjustments cross-field invariants (positive-
  // int items, member-in-roster assignees, ITEM/EXPENSE scope shape,
  // over-discount guards) so the items-mode path doesn't need
  // duplicate Zod-level checks.
  //
  // adjustments[] without items[] is rejected: adjustments only make
  // sense relative to an item set. A manual-entry expense (no items)
  // should not carry adjustments -- the user types the final amount
  // directly and splits manually.
  const items       = payload.items ?? []
  const adjustments = payload.adjustments ?? []
  if (items.length === 0) {
    if (adjustments.length > 0) {
      throw new ExpenseValidationError(
        'adjustments',
        'adjustments require items[] to be non-empty (manual-entry expenses cannot carry adjustments)',
      )
    }
    return
  }

  const matItems: MaterializeItem[] = items.map(i => ({
    id:          i.id,
    amountMinor: i.amountMinor,
    assignees:   i.assignees,
  }))
  const matAdjustments: MaterializeAdjustment[] = adjustments.map(a => ({
    id:           a.id,
    kind:         a.kind as MaterializeAdjustment['kind'],
    scope:        a.scope as MaterializeAdjustment['scope'],
    amountMinor:  a.amountMinor,
    targetItemId: a.targetItemId,
  }))

  let materialized: ReturnType<typeof materializeExpenseSplits>
  try {
    materialized = materializeExpenseSplits({
      items:       matItems,
      adjustments: matAdjustments,
      members:     memberIds,
    })
  } catch (e) {
    if (e instanceof MaterializeError) {
      // Translate the structured materializer error to an
      // ExpenseValidationError with a stable field hint. The
      // materializer's `code` is the canonical handle; the dotted
      // field path is for form-level UI -- it picks the parent
      // collection that's most likely to surface the issue.
      const field = e.code.startsWith('ITEM_') || e.code === 'NON_MEMBER_ASSIGNEE' ||
                    e.code === 'DUPLICATE_ITEM_ASSIGNEE' || e.code === 'DUPLICATE_ITEM_ID' ||
                    e.code === 'OVER_DISCOUNT_ITEM'
        ? 'items'
        : 'adjustments'
      throw new ExpenseValidationError(field, `${e.code}: ${e.message}`)
    }
    throw e
  }

  // Compare canonical forms (sorted, zero-filtered) -- both sides
  // arrive at the same byte sequence iff every per-member amount
  // matches. A mismatch is the headline financial-attribution
  // corruption signal: client preview disagrees with Worker
  // authoritative recompute.
  const want = canonicalizeSplits(materialized)
  const got  = canonicalizeSplits(payload.splits.map(s => ({ memberId: s.memberId, amountMinor: s.amountMinor })))
  if (want !== got) {
    throw new ExpenseValidationError(
      'splits',
      `SPLIT_PREVIEW_DRIFT: materialized ${want} ≠ payload ${got}`,
    )
  }
}
