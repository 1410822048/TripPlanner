// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { ExpenseDocSchema, type Expense, type CreateExpenseInput } from '@/types'

/** 驗證一份 Firestore doc 是否符合 Expense schema；失敗時丟出錯誤以利觀測 */
function expenseFromDoc(d: QueryDocumentSnapshot): Expense {
  const parsed = ExpenseDocSchema.safeParse(d.data())
  if (!parsed.success) {
    console.error(`[expenseService] invalid expense doc ${d.id}:`, parsed.error.issues)
    throw new Error(`Expense ${d.id} failed schema validation`)
  }
  return { id: d.id, ...parsed.data }
}

// ─── Read ─────────────────────────────────────────────────────────
export async function getExpensesByTrip(tripId: string): Promise<Expense[]> {
  const { db, collection, query, orderBy, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.expenses(tripId)),
    orderBy('date', 'desc'),
    orderBy('createdAt', 'desc'),
  )
  const snap = await getDocs(q)
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
  updates: Partial<CreateExpenseInput>,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.expense(tripId, expenseId)), { ...updates, updatedAt: serverTimestamp() })
}

export async function deleteExpense(
  tripId: string,
  expenseId: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.expense(tripId, expenseId)))
}
