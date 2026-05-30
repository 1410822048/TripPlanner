// src/types/expense.ts
// Expense entity + per-member splits. Splits live in the same file
// because they're a child shape of expense — never used standalone.
//
// Money domain: every persisted / wire-level amount in this file is
// `amountMinor` — integer minor units (USD $12.34 = 1234, JPY ¥1200 =
// 1200). UI / OCR string handling happens at the boundary via
// `src/utils/money.ts`. The materializer + Worker authoritative
// recompute both work in integer minor units and reject non-integer
// values loudly.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

export interface ExpenseSplit {
  memberId:    string
  amountMinor: number       // 該成員實際分攤金額(integer minor units)
}

/** Receipt photo / PDF attached to an expense — uploaded via
 *  expenseStorage; same dual-variant pattern as booking attachments
 *  (full + thumbnail). Optional fields exist for legacy reads + PDF
 *  case (PDFs upload without a thumb). */
export interface ExpenseReceipt {
  url:        string
  path:       string
  /** Mime type at upload time. Drives image-vs-PDF rendering choice. */
  type:       string
  thumbUrl?:  string
  thumbPath?: string
}

/** Line item from an OCR'd receipt. Only ever populated by the OCR
 *  worker — manual entry doesn't produce items (users go straight to
 *  custom split via memo).
 *
 *  Lifecycle: lives or dies with the receipt photo. Removing the
 *  receipt clears items (the photo is items' ground truth). When
 *  items[].length > 0, the form switches to "by-item" split mode and
 *  splits[] is computed via `materializeExpenseSplits` at save-time
 *  using `items` + `adjustments` together.
 *
 *  Phase B contract:
 *    - `id` is required (ITEM-scope adjustments reference it).
 *    - `amountMinor` is a POSITIVE integer minor-unit amount —
 *      pre-discount subtotal.
 *      Discount / surcharge / tax / tip live in the sibling
 *      `Expense.adjustments[]` array. */
export interface ExpenseItem {
  id:          string
  name:        string
  amountMinor: number
  /** memberIds — non-empty. An item shared by N people splits its
   *  amount equally across them. */
  assignees: string[]
}

/** Adjustment kind — drives the +/- sign in the materializer pure fn
 *  (`@tripmate/expense-materialize::adjustmentSign`). Kind is also
 *  informational (icon / label in UI). DISCOUNT/COUPON/TAX_EXEMPT/OTHER
 *  subtract; SURCHARGE/TAX/TIP add. */
export type ExpenseAdjustmentKind =
  | 'DISCOUNT'
  | 'COUPON'
  | 'TAX_EXEMPT'
  | 'SURCHARGE'
  | 'TAX'
  | 'TIP'
  | 'OTHER'

/** Persisted adjustment scope — UNKNOWN is OCR-draft-only and never
 *  enters Firestore. Phase B Worker validation rejects UNKNOWN
 *  explicitly; the client converts via the visible adjustment row
 *  before save. */
export type ExpenseAdjustmentScope = 'ITEM' | 'EXPENSE'

/** Adjustment line for an expense — first-class replacement for the
 *  prior "discount as negative ExpenseItem" pattern. amountMinor is a
 *  POSITIVE integer minor-unit amount; the effective sign comes from
 *  `kind`.
 *
 *  Scope semantics:
 *    - ITEM:    reduces the target item's subtotal before its split.
 *               `targetItemId` is required.
 *    - EXPENSE: distributed across all items proportional to their
 *               post-ITEM-scope effective amounts. `targetItemId` MUST
 *               be omitted.
 *
 *  Phase B: wired into Worker authoritative recompute + `SPLIT_PREVIEW_
 *  DRIFT` rejection. Client computes preview via `materializeExpense
 *  Splits`, Worker recomputes from (items, adjustments, members) and
 *  rejects mismatches. */
export interface ExpenseAdjustment {
  id:            string
  label:         string
  kind:          ExpenseAdjustmentKind
  scope:         ExpenseAdjustmentScope
  amountMinor:   number
  targetItemId?: string
}

/** Phase 3b — source-currency mirror of `ExpenseItem`. Only persisted
 *  on foreign-currency expenses (sourceCurrency !== tripCurrency); the
 *  amount is in SOURCE minor units (USD cents, EUR cents, …) so the
 *  Worker can replay convertAndMaterializeFromSource on any future
 *  money / date update without losing the original receipt precision.
 *
 *  Invariant (enforced via ExpenseDocSchema.superRefine):
 *    - present iff parent `items` is present (length + id pair-wise)
 *    - sourceItems[i].id === items[i].id
 *  Anything else (name, assignees) is the source-of-truth on the
 *  source side and trip-side fields are derived by the Worker; the
 *  schema does not lock those to be equal (lets Phase 3c surface
 *  source-domain editing without an extra schema migration). */
export interface SourceExpenseItem {
  id:                string
  name:              string
  sourceAmountMinor: number
  assignees:         string[]
}

/** Phase 3b — source-currency mirror of `ExpenseAdjustment`. Same
 *  rationale as SourceExpenseItem: persists raw source-domain amounts
 *  + IDs so the Worker can replay conversion authoritatively.
 *
 *  Invariant (enforced via ExpenseDocSchema.superRefine):
 *    - present iff `sourceCurrency` is present (foreign mode); the
 *      array length must match adjustments[] and IDs pair-wise. */
export interface SourceExpenseAdjustment {
  id:                string
  label:             string
  kind:              ExpenseAdjustmentKind
  scope:             ExpenseAdjustmentScope
  sourceAmountMinor: number
  targetItemId?:     string
}

/** Worker-minted FX conversion snapshot — locked at the moment the
 *  expense was created / had its money fields updated. Present iff
 *  `sourceCurrency !== tripCurrency`; same-currency expenses keep
 *  `fxSnapshot` undefined (degenerate path).
 *
 *  Written by the Worker's foreign-mode router on create + every
 *  money/date update. The read schema validates it so any drift
 *  surfaces via firestoreDocFromSchema. No client code reads / writes
 *  it directly until Phase 3c surfaces source-domain UI.
 *
 *  `convertedAmountMinor` MUST equal `Expense.amountMinor` (trip
 *  currency); the Worker is authoritative and overwrites any client-
 *  supplied preview. `rateDecimal` is a canonical string (no trailing
 *  zeros, see `@tripmate/fx-core::isCanonicalRateString`). */
export interface FxSnapshot {
  provider:             'frankfurter-v2'
  baseCurrency:         string        // === sourceCurrency
  quoteCurrency:        string        // === Expense.currency (trip currency)
  requestedDate:        string        // 'YYYY-MM-DD' — caller's expense.date
  rateDate:             string        // 'YYYY-MM-DD' — provider's rate date (may differ on weekends/holidays)
  rateDecimal:          string        // canonical decimal string (no trailing zeros)
  sourceAmountMinor:    number        // === Expense.sourceAmountMinor
  convertedAmountMinor: number        // === Expense.amountMinor (trip-currency minor)
  fetchedAt:            Timestamp     // server-stamped REQUEST_TIME
}

// trips/{tripId}/expenses/{expenseId}
export interface Expense {
  id: string
  tripId: string
  title: string
  amountMinor: number       // 總額(integer minor units)
  currency: string
  category: ExpenseCategory
  paidBy: string            // memberId
  splits: ExpenseSplit[]    // sum(splits.amountMinor) === amountMinor
  date: string              // 'YYYY-MM-DD'
  /** Optional receipt — photo or PDF the user kept for record. When
   *  OCR is run against the photo, `items` gets populated and the form
   *  switches to chip-based split mode on edit. */
  receipt?: ExpenseReceipt
  /** OCR'd line items — present only when the user ran OCR against the
   *  receipt. Drives the "by-item" split mode in the form. Phase B:
   *  positive-only line totals; discounts live in `adjustments`. */
  items?: ExpenseItem[]
  /** Adjustments (discounts / surcharges / tax / tip). Phase B
   *  contract: always present (empty array when none). Worker
   *  authoritative recompute uses `materializeExpenseSplits({items,
   *  adjustments, members})`; client preview MUST match. */
  adjustments: ExpenseAdjustment[]
  note?: string
  createdBy: string
  /** Last-writer uid. See useFeatureBadges. */
  updatedBy: string
  /** Denormalised member uids — drives the same-doc read rule. See
   *  trip.memberIds for rationale. */
  memberIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
  /**
   * Soft-delete tombstone. When present, the expense is considered
   * deleted by the UI (filtered out of `useExpenses` consumers) but
   * preserved in the underlying collection so the settlement algorithm
   * can run chronological replay and classify orphan reasons
   * (OVERPAYMENT vs EXPENSE_DELETED). See `computeBalancesFull` for
   * the replay logic.
   *
   * Set by `deleteExpense` (the original hard-delete was replaced when
   * settlement phase-2 shipped). Absent / null on live expenses.
   */
  deletedAt?: Timestamp | null
  /**
   * Receipt-purge watermark. `null` on every live expense (create
   * rule rejects missing / non-null values); set to a server
   * Timestamp by the daily Worker cron after Storage receipt + the
   * `receipt` field are cleared. Once stamped, the doc exits the
   * cron's `receiptPurgedAt == null AND deletedAt < cutoff`
   * candidate set permanently — without this watermark the cron
   * would re-scan every soft-deleted expense forever.
   */
  receiptPurgedAt?: Timestamp | null
  /** FX source-currency fields. Present iff this expense was created
   *  from a source currency different from the trip currency. Written
   *  by the Worker's foreign-mode router (expense-write.ts) on create
   *  and every money/date update; absent on same-currency expenses.
   *
   *  Invariant (enforced by Worker + ExpenseDocSchema.superRefine):
   *    sourceCurrency === fxSnapshot.baseCurrency
   *    sourceAmountMinor === fxSnapshot.sourceAmountMinor
   *    Expense.amountMinor === fxSnapshot.convertedAmountMinor */
  sourceCurrency?: string
  sourceAmountMinor?: number
  fxSnapshot?: FxSnapshot
  /** Persisted source-domain line items + adjustments. Only present
   *  on foreign-currency expenses. The Worker re-runs
   *  convertAndMaterializeFromSource(sourceItems, sourceAdjustments,
   *  rateDecimal, members) on every money / date update so the
   *  trip-currency items / adjustments / splits stay derivable from a
   *  single authoritative source.
   *
   *  Group invariant (ExpenseDocSchema.superRefine):
   *    - foreign mode (corePresent === 3): sourceItems present iff
   *      `items` present; sourceAdjustments REQUIRED (mirrors the
   *      always-present `adjustments` array).
   *    - same-currency mode (corePresent === 0): both MUST be absent. */
  sourceItems?: SourceExpenseItem[]
  sourceAdjustments?: SourceExpenseAdjustment[]
}

export type ExpenseCategory =
  | 'food'
  | 'transport'
  | 'accommodation'
  | 'activity'
  | 'shopping'
  | 'other'

export const ExpenseSplitSchema = z.object({
  memberId:    z.string().min(1),
  // Integer minor units. Zero is allowed for splits that legitimately
  // reduce to zero after materialization (an item assigned to one
  // person with a discount covering its full price).
  amountMinor: z.number().int().nonnegative(),
})

export const ExpenseItemSchema = z.object({
  // Phase B: id required. ITEM-scope adjustments target items by id;
  // optional id would let an adjustment dangle silently. Length cap of
  // 64 accommodates UUIDs + any future short-id scheme.
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  // Phase B: positive integer minor units. Discounts / surcharges / tax
  // / tip migrated to the sibling `adjustments[]` field. The materializer
  // (Worker authoritative split gate) rejects non-positive items with
  // ITEM_NOT_POSITIVE_INTEGER.
  amountMinor: z.number().int().positive(),
  // Every item must have at least one assignee — enforced both client-
  // side (form validation) and at the schema level so any future code
  // path that tries to write a "dangling" item gets rejected.
  assignees: z.array(z.string().min(1)).min(1, '至少需要一位分攤者'),
})

/** Adjustment kind / scope literals — mirror of
 *  `@tripmate/expense-materialize::AdjustmentKind` / `AdjustmentScope`.
 *  Re-declared here (rather than re-exported) so the Zod parse layer
 *  doesn't take a runtime dep on the materializer package. */
export const EXPENSE_ADJUSTMENT_KINDS = [
  'DISCOUNT', 'COUPON', 'TAX_EXEMPT', 'SURCHARGE', 'TAX', 'TIP', 'OTHER',
] as const

export const EXPENSE_ADJUSTMENT_SCOPES = ['ITEM', 'EXPENSE'] as const

/** Persisted adjustment shape. `amountMinor` is a positive integer
 *  minor-unit amount; sign comes from `kind`. Draft surfaces that
 *  temporarily hold a zero amount should use a draft-only schema, not
 *  this persisted shape.
 *
 *  Phase B: wired into ExpenseDocSchema + ExpenseShape +
 *  CreateExpenseSchema. The Worker authoritative recompute runs
 *  `materializeExpenseSplits({items, adjustments, members})` and
 *  rejects SPLIT_PREVIEW_DRIFT if the client preview disagrees.
 *
 *  The ITEM-iff-targetItemId refine mirrors the runtime guard in
 *  `@tripmate/expense-materialize` (ITEM_SCOPE_NO_TARGET /
 *  EXPENSE_SCOPE_HAS_TARGET). Catching it at the Zod boundary
 *  rejects malformed docs before invoking the materializer. */
export const ExpenseAdjustmentSchema = z.object({
  id:           z.string().min(1).max(64),
  label:        z.string().min(1).max(120),
  kind:         z.enum(EXPENSE_ADJUSTMENT_KINDS),
  scope:        z.enum(EXPENSE_ADJUSTMENT_SCOPES),
  amountMinor:  z.number().int().positive(),
  targetItemId: z.string().min(1).max(64).optional(),
}).refine(
  data => (data.scope === 'ITEM') === (data.targetItemId !== undefined),
  { message: 'targetItemId must be present iff scope === ITEM', path: ['targetItemId'] },
)

/** Phase 3b — source-currency item shape. Mirrors ExpenseItemSchema but
 *  with `sourceAmountMinor` in source-currency minor units. Same id /
 *  name / assignees constraints (the materializer reuses these on the
 *  trip-domain side). */
export const SourceExpenseItemSchema = z.object({
  id:                z.string().min(1).max(64),
  name:              z.string().min(1).max(200),
  sourceAmountMinor: z.number().int().positive(),
  assignees:         z.array(z.string().min(1)).min(1, '至少需要一位分攤者'),
})

/** Phase 3b — source-currency adjustment shape. Mirrors
 *  ExpenseAdjustmentSchema with the same ITEM-iff-targetItemId refine.
 *  `sourceAmountMinor` is positive integer source-currency minor units;
 *  the effective sign / direction comes from `kind` exactly as on the
 *  trip-domain side. */
export const SourceExpenseAdjustmentSchema = z.object({
  id:                z.string().min(1).max(64),
  label:             z.string().min(1).max(120),
  kind:              z.enum(EXPENSE_ADJUSTMENT_KINDS),
  scope:             z.enum(EXPENSE_ADJUSTMENT_SCOPES),
  sourceAmountMinor: z.number().int().positive(),
  targetItemId:      z.string().min(1).max(64).optional(),
}).refine(
  data => (data.scope === 'ITEM') === (data.targetItemId !== undefined),
  { message: 'targetItemId must be present iff scope === ITEM', path: ['targetItemId'] },
)

// Pulled out as a base so UpdateExpenseSchema can `.partial()` from the
// pre-refine shape (refines don't survive .partial(), and a partial
// update can't fully enforce the splits-sum check without joining with
// the persisted doc — leave that invariant to the create form).
const ExpenseShape = z.object({
  title:       z.string().min(1, '請輸入標題').max(100),
  // Persist-side: positive integer minor units. The form layer holds
  // the user-facing decimal string in `amountText` and converts via
  // `parseMoneyToMinor` at submit time.
  amountMinor: z.number().int().positive('金額必須大於 0'),
  currency:    z.string().default('JPY'),
  category:    z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:      z.string().min(1, '請選擇付款人'),
  splits:      z.array(ExpenseSplitSchema).min(1, '至少需選擇一位分攤人'),
  date:        z.string().min(1, '請選擇日期'),
  items:       z.array(ExpenseItemSchema).optional(),
  // Phase B: adjustments always present (empty array when none). The
  // form layer constructs them; the Worker materializes splits from
  // (items, adjustments, members) and rejects drift.
  adjustments: z.array(ExpenseAdjustmentSchema),
  note:        z.string().optional(),
})

export const CreateExpenseSchema = ExpenseShape.refine(
  data => data.splits.reduce((s, x) => s + x.amountMinor, 0) === data.amountMinor,
  { message: '分攤金額總和需等於總額', path: ['splits'] },
)
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>

/** Update payload — fields optional but per-field rules (length, enum,
 *  positivity) still enforced. The cross-field refine (splits-sum =
 *  amountMinor) is intentionally dropped: partial updates can't validate
 *  it without joining the persisted doc, and the create path already
 *  gates the invariant at write-time. */
export const UpdateExpenseSchema = ExpenseShape.partial()
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>

/** Accepted receipt mime types. Mirrors the Worker-side
 *  `makeReceiptSchema()` `type` enum in expense-validate.ts (the
 *  validation moved from firestore.rules to the Worker once expense
 *  create became Worker-only). Same set as bookings -- receipts and
 *  booking attachments share the upload pipeline (compressImage →
 *  WebP for images, pass-through for PDFs). */
export const EXPENSE_RECEIPT_MIME_TYPES = [
  'image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'application/pdf',
] as const

export const ExpenseReceiptSchema = z.object({
  url:       z.string().url().max(2048),
  path:      z.string().min(1).max(500),
  type:      z.enum(EXPENSE_RECEIPT_MIME_TYPES),
  thumbUrl:  z.string().url().max(2048).optional(),
  thumbPath: z.string().min(1).max(500).optional(),
})

/** Currency code shape — ISO 4217 alpha-3 uppercase. Mirrors the
 *  Worker-side foreign-schema validator. Re-declared locally rather
 *  than imported so the client doesn't take a runtime dep on the
 *  Worker package. */
const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217 alpha-3 uppercase')

/** ISO date 'YYYY-MM-DD' shape — both `requestedDate` (caller's
 *  expense.date) and `rateDate` (provider's actual rate date) follow
 *  the same form. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')

/** Canonical decimal rate string — no trailing zeros, no leading zeros
 *  beyond a single `0` before a `.`, at least one digit. Mirrors
 *  `@tripmate/fx-core::isCanonicalRateString`. Local declaration keeps
 *  the read schema free of the fx-core runtime dep. */
const CanonicalRateDecimalSchema = z.string().regex(
  /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/,
  'rateDecimal must be canonical (no trailing zeros)',
)

/** FxSnapshot read schema. The Worker is authoritative for writes
 *  (foreign-mode router in expense-write.ts); this schema only gates
 *  reads so an unexpected shape gets surfaced via the same
 *  firestoreDocFromSchema Sentry path as other doc-level schema
 *  regressions. */
export const FxSnapshotSchema = z.object({
  provider:             z.literal('frankfurter-v2'),
  baseCurrency:         CurrencyCodeSchema,
  quoteCurrency:        CurrencyCodeSchema,
  requestedDate:        IsoDateSchema,
  rateDate:             IsoDateSchema,
  rateDecimal:          CanonicalRateDecimalSchema,
  sourceAmountMinor:    z.number().int().positive(),
  convertedAmountMinor: z.number().int().nonnegative(),
  fetchedAt:            TimestampSchema,
})

export const ExpenseDocSchema = z.object({
  tripId:      z.string(),
  title:       z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency:    z.string(),
  category:    z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:      z.string(),
  splits:      z.array(ExpenseSplitSchema),
  date:        z.string(),
  receipt:     ExpenseReceiptSchema.optional(),
  items:       z.array(ExpenseItemSchema).optional(),
  // Phase B: required on every doc, default empty array. Legacy docs
  // written before this contract do NOT have the field — per the
  // no-backcompat decision, those will fail parse on read. The Sentry
  // capture in firestoreDocFromSchema surfaces it as a single noisy
  // signal rather than a silent display regression.
  adjustments: z.array(ExpenseAdjustmentSchema),
  note:        z.string().optional(),
  createdBy:   z.string(),
  updatedBy:   z.string(),
  memberIds:   z.array(z.string().min(1)).min(1),
  createdAt:   TimestampSchema,
  updatedAt:   TimestampSchema,
  /** Soft-delete tombstone (settlement phase-2). Nullable + optional
   *  for parse tolerance — Zod sees the full server doc (always
   *  null/Timestamp per the create rule) AND optimistic-cache rows
   *  that may not include the field until the listener reconciles. */
  deletedAt:   TimestampSchema.nullable().optional(),
  /** Receipt-purge watermark. Same parse-tolerance reasoning as
   *  deletedAt: rule enforces present+null on create, so server-side
   *  it's always shaped, but optimistic patches / partial cache rows
   *  may omit it before reconciliation. */
  receiptPurgedAt: TimestampSchema.nullable().optional(),
  /** FX source fields. Optional (NOT nullable) because same-currency
   *  expenses simply omit them; the Worker's foreign-mode router
   *  writes them in the same tx as the materialized trip-currency
   *  outputs.
   *
   *  Group invariant (enforced via the schema-level superRefine
   *  below): the three fields are all-or-none, plus cross-field
   *  equality with the parent expense doc. */
  sourceCurrency:    CurrencyCodeSchema.optional(),
  sourceAmountMinor: z.number().int().positive().optional(),
  fxSnapshot:        FxSnapshotSchema.optional(),
  /** Source-domain line items + adjustments. The Worker uses these on
   *  every money / date update to re-derive the trip-domain canonical
   *  fields (items / adjustments / splits / amountMinor) via
   *  convertAndMaterializeFromSource. Optional at the shape level; the
   *  superRefine below enforces the actual presence-coupling
   *  (foreign-mode-only + id pair-wise alignment). */
  sourceItems:       z.array(SourceExpenseItemSchema).optional(),
  sourceAdjustments: z.array(SourceExpenseAdjustmentSchema).optional(),
}).superRefine((data, ctx) => {
  // FX group all-or-none + cross-field equality + source-domain mirror.
  //
  // Rationale: same-currency expenses omit all FX / source fields
  // (degenerate path); foreign-currency expenses MUST carry the full
  // source-domain mirror so the Worker can always replay
  // convertAndMaterializeFromSource from a single authoritative source.
  // Without this gate, a half-populated doc (Phase 3b Worker bug, raw
  // admin write, partial migration) would parse cleanly and surface as
  // silent display drift in 3c UI / settlement math.
  const hasSourceCurrency  = data.sourceCurrency     !== undefined
  const hasSourceAmount    = data.sourceAmountMinor  !== undefined
  const hasFx              = data.fxSnapshot         !== undefined
  const hasSourceItems     = data.sourceItems        !== undefined
  const hasSourceAdj       = data.sourceAdjustments  !== undefined
  const corePresent        = [hasSourceCurrency, hasSourceAmount, hasFx].filter(Boolean).length

  // Case 1: same-currency degenerate path -- ALL source fields must be
  // absent. A stray sourceItems / sourceAdjustments on a non-FX doc is
  // orphaned data and would mislead any future foreign-aware consumer.
  if (corePresent === 0) {
    if (hasSourceItems) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceItems must be absent on same-currency (non-FX) expenses',
        path: ['sourceItems'],
      })
    }
    if (hasSourceAdj) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceAdjustments must be absent on same-currency (non-FX) expenses',
        path: ['sourceAdjustments'],
      })
    }
    return
  }

  // Case 2: half-populated FX core trio -- reject loudly. Skip the rest
  // so the user sees the root-cause shape error, not derivative noise.
  if (corePresent !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'FX group must be all-or-none: sourceCurrency, sourceAmountMinor, and fxSnapshot must all be present together (or all absent)',
      path: ['fxSnapshot'],
    })
    return
  }

  // Case 3: full foreign mode -- cross-field equality + source-domain
  // mirror coupling. `data.fxSnapshot!` is safe; corePresent===3
  // guarantees the field is defined.
  const fx = data.fxSnapshot!
  if (data.sourceCurrency !== fx.baseCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sourceCurrency (${data.sourceCurrency}) must equal fxSnapshot.baseCurrency (${fx.baseCurrency})`,
      path: ['fxSnapshot', 'baseCurrency'],
    })
  }
  if (data.currency !== fx.quoteCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `currency (${data.currency}) must equal fxSnapshot.quoteCurrency (${fx.quoteCurrency})`,
      path: ['fxSnapshot', 'quoteCurrency'],
    })
  }
  if (data.sourceAmountMinor !== fx.sourceAmountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sourceAmountMinor (${data.sourceAmountMinor}) must equal fxSnapshot.sourceAmountMinor (${fx.sourceAmountMinor})`,
      path: ['fxSnapshot', 'sourceAmountMinor'],
    })
  }
  if (data.amountMinor !== fx.convertedAmountMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `amountMinor (${data.amountMinor}) must equal fxSnapshot.convertedAmountMinor (${fx.convertedAmountMinor})`,
      path: ['fxSnapshot', 'convertedAmountMinor'],
    })
  }

  // foreign mode requires BOTH items + sourceItems. The Worker's foreign
  // create schema mandates `sourceItems.min(1)` and the materializer
  // derives `items` from it on every money/date update -- a foreign doc
  // without items/sourceItems is unsupported state (admin drift or
  // Worker bug) that would 500 on any subsequent update. Catching it on
  // read here means the client rejects the doc loudly via the
  // firestoreDocFromSchema Sentry path instead of parsing it as valid
  // and exploding mid-edit.
  const hasItems = data.items !== undefined
  if (!hasItems || !hasSourceItems) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'foreign-mode expenses must carry both items and sourceItems (Worker materializes items from sourceItems on every money/date update)',
      path: [!hasItems ? 'items' : 'sourceItems'],
    })
  } else {
    const items = data.items!
    const src   = data.sourceItems!
    if (src.length !== items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `sourceItems.length (${src.length}) must equal items.length (${items.length})`,
        path: ['sourceItems'],
      })
    } else {
      // Pair-wise id alignment -- Worker uses positional index to map
      // source -> trip during convertAndMaterializeFromSource, but the
      // ids must also align so any future id-keyed consumer (UI edit,
      // settlement replay) reads a consistent doc.
      src.forEach((s, i) => {
        // Equal-length branch -- index safe; assertion is for
        // noUncheckedIndexedAccess.
        const tripItem = items[i]!
        if (s.id !== tripItem.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `sourceItems[${i}].id (${s.id}) must equal items[${i}].id (${tripItem.id})`,
            path: ['sourceItems', i, 'id'],
          })
        }
      })
    }
  }

  // sourceAdjustments REQUIRED in foreign mode -- adjustments is always
  // present (empty array when none), so its source mirror must be too.
  if (!hasSourceAdj) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sourceAdjustments must be present on foreign-mode expenses (mirror of adjustments)',
      path: ['sourceAdjustments'],
    })
  } else {
    const adj    = data.adjustments
    const srcAdj = data.sourceAdjustments!
    if (srcAdj.length !== adj.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `sourceAdjustments.length (${srcAdj.length}) must equal adjustments.length (${adj.length})`,
        path: ['sourceAdjustments'],
      })
    } else {
      srcAdj.forEach((s, i) => {
        // Equal-length branch -- index safe; assertion is for
        // noUncheckedIndexedAccess.
        const tripAdj = adj[i]!
        if (s.id !== tripAdj.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `sourceAdjustments[${i}].id (${s.id}) must equal adjustments[${i}].id (${tripAdj.id})`,
            path: ['sourceAdjustments', i, 'id'],
          })
        }
      })
    }
  }
})
