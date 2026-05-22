// src/types/expense.ts
// Expense entity + per-member splits. Splits live in the same file
// because they're a child shape of expense — never used standalone.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

export interface ExpenseSplit {
  memberId: string
  amount:   number          // 該成員實際分攤金額
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
 *  splits[] is computed from item assignees at save-time. */
export interface ExpenseItem {
  name:      string
  amount:    number
  /** memberIds — non-empty. An item shared by N people splits its
   *  amount equally across them. */
  assignees: string[]
}

// trips/{tripId}/expenses/{expenseId}
export interface Expense {
  id: string
  tripId: string
  title: string
  amount: number            // 總額
  currency: string
  category: ExpenseCategory
  paidBy: string            // memberId
  splits: ExpenseSplit[]    // sum(splits.amount) === amount
  date: string              // 'YYYY-MM-DD'
  /** Optional receipt — photo or PDF the user kept for record. When
   *  OCR is run against the photo, `items` gets populated and the form
   *  switches to chip-based split mode on edit. */
  receipt?: ExpenseReceipt
  /** OCR'd line items — present only when the user ran OCR against the
   *  receipt. Drives the "by-item" split mode in the form. */
  items?: ExpenseItem[]
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
}

export type ExpenseCategory =
  | 'food'
  | 'transport'
  | 'accommodation'
  | 'activity'
  | 'shopping'
  | 'other'

export const ExpenseSplitSchema = z.object({
  memberId: z.string().min(1),
  amount:   z.number().nonnegative(),
})

export const ExpenseItemSchema = z.object({
  name: z.string().min(1).max(200),
  // Amount may be negative — receipts often include discount / cashback
  // / promo lines that legitimately subtract from the total (e.g.
  // "キャッシュレス還元 -6"). Sum-equals-total is enforced at the form
  // layer regardless of sign.
  amount: z.number(),
  // Every item must have at least one assignee — enforced both client-
  // side (form validation) and at the schema level so any future code
  // path that tries to write a "dangling" item gets rejected.
  assignees: z.array(z.string().min(1)).min(1, '至少需要一位分攤者'),
})

// Pulled out as a base so UpdateExpenseSchema can `.partial()` from the
// pre-refine shape (refines don't survive .partial(), and a partial
// update can't fully enforce the splits-sum check without joining with
// the persisted doc — leave that invariant to the create form).
const ExpenseShape = z.object({
  title:    z.string().min(1, '請輸入標題').max(100),
  amount:   z.coerce.number().positive('金額必須大於 0'),
  currency: z.string().default('JPY'),
  category: z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:   z.string().min(1, '請選擇付款人'),
  splits:   z.array(ExpenseSplitSchema).min(1, '至少需選擇一位分攤人'),
  date:     z.string().min(1, '請選擇日期'),
  items:    z.array(ExpenseItemSchema).optional(),
  note:     z.string().optional(),
})

export const CreateExpenseSchema = ExpenseShape.refine(
  data => Math.abs(data.splits.reduce((s, x) => s + x.amount, 0) - data.amount) < 0.01,
  { message: '分攤金額總和需等於總額', path: ['splits'] },
)
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>

/** Update payload — fields optional but per-field rules (length, enum,
 *  positivity) still enforced. The cross-field refine (splits-sum =
 *  amount) is intentionally dropped: partial updates can't validate it
 *  without joining the persisted doc, and the create path already gates
 *  the invariant at write-time. */
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

export const ExpenseDocSchema = z.object({
  tripId:     z.string(),
  title:      z.string(),
  amount:     z.number(),
  currency:   z.string(),
  category:   z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:     z.string(),
  splits:     z.array(ExpenseSplitSchema),
  date:       z.string(),
  receipt:    ExpenseReceiptSchema.optional(),
  items:      z.array(ExpenseItemSchema).optional(),
  note:       z.string().optional(),
  createdBy:  z.string(),
  updatedBy:  z.string(),
  memberIds:  z.array(z.string().min(1)).min(1),
  createdAt:  TimestampSchema,
  updatedAt:  TimestampSchema,
  /** Soft-delete tombstone (settlement phase-2). Nullable + optional
   *  for parse tolerance — Zod sees the full server doc (always
   *  null/Timestamp per the create rule) AND optimistic-cache rows
   *  that may not include the field until the listener reconciles. */
  deletedAt:  TimestampSchema.nullable().optional(),
  /** Receipt-purge watermark. Same parse-tolerance reasoning as
   *  deletedAt: rule enforces present+null on create, so server-side
   *  it's always shaped, but optimistic patches / partial cache rows
   *  may omit it before reconciliation. */
  receiptPurgedAt: TimestampSchema.nullable().optional(),
})
