// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { ExpenseDocSchema, UpdateExpenseSchema, type Expense, type CreateExpenseInput, type UpdateExpenseInput } from '@/types'

/** Defensive cap — see bookingService. Expenses can pile up on long trips
 *  with shared meals; 200 covers a 14-day group trip with healthy margin. */
const LIST_LIMIT = 200

/** 驗證一份 Firestore doc 是否符合 Expense schema；失敗時丟出錯誤以利觀測 */
function expenseFromDoc(d: QueryDocumentSnapshot): Expense {
  const parsed = ExpenseDocSchema.safeParse(d.data())
  if (!parsed.success) {
    captureError(parsed.error, { source: 'expenseFromDoc', docId: d.id })
    throw new Error(`Expense ${d.id} failed schema validation`)
  }
  return { id: d.id, ...parsed.data }
}

// ─── Read ─────────────────────────────────────────────────────────
export async function getExpensesByTrip(tripId: string): Promise<Expense[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.expenses(tripId)),
    orderBy('date', 'desc'),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  )
  const snap = await getDocs(q)
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getExpensesByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return snap.docs.map(expenseFromDoc)
}

// ─── Write ────────────────────────────────────────────────────────
export async function createExpense(
  tripId: string,
  input: CreateExpenseInput,
  createdBy: string,
): Promise<string> {
  const { db, collection, addDoc, serverTimestamp } = await getFirebase()
  const ref = await addDoc(collection(db, ...P.expenses(tripId)), {
    ...input,
    tripId,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateExpense(
  tripId: string,
  expenseId: string,
  updates: UpdateExpenseInput,
): Promise<void> {
  // Defense-in-depth: TS gates this at the call site, but a Zod check
  // at the service boundary catches edge cases like a future code path
  // that bypasses the typed form layer. captureError so corruption
  // attempts (or stale clients) surface in Sentry, not silently.
  const parsed = UpdateExpenseSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateExpense', tripId, expenseId })
    throw new Error('Update payload failed validation')
  }
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.expense(tripId, expenseId)), { ...parsed.data, updatedAt: serverTimestamp() })
}

export async function deleteExpense(
  tripId: string,
  expenseId: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.expense(tripId, expenseId)))
}
