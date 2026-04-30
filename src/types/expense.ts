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
  receiptUrl?: string
  note?: string
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
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

export const ExpenseDocSchema = z.object({
  tripId:     z.string(),
  title:      z.string(),
  amount:     z.number(),
  currency:   z.string(),
  category:   z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:     z.string(),
  splits:     z.array(ExpenseSplitSchema),
  date:       z.string(),
  receiptUrl: z.string().optional(),
  note:       z.string().optional(),
  createdBy:  z.string(),
  createdAt:  TimestampSchema,
  updatedAt:  TimestampSchema,
})
