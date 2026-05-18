// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { ExpenseDocSchema, UpdateExpenseSchema, type Expense, type ExpenseReceipt, type CreateExpenseInput, type UpdateExpenseInput } from '@/types'
import { uploadReceipt, purgeReceipt } from './expenseStorage'

/** 200 covers a 14-day group trip with healthy margin. */
const LIST_LIMIT = 200

function expenseFromDoc(d: QueryDocumentSnapshot): Expense {
  return firestoreDocFromSchema(ExpenseDocSchema, d, 'expenseFromDoc')
}

// ─── Read ─────────────────────────────────────────────────────────
const listServices = createTripScopedListServices<Expense>({
  path:    P.expenses,
  fromDoc: expenseFromDoc,
  orderBy: [['date', 'desc'], ['createdAt', 'desc']],
  limit:   LIST_LIMIT,
  source:  'expenses',
})

export const getExpensesByTrip = listServices.fetch
export const subscribeToExpenses = listServices.subscribe

// ─── Write ────────────────────────────────────────────────────────
/**
 * Create an expense + optional receipt. Single-shot via mint-id-first
 * when a file is provided: doc-ref minted client-side, uploadReceipt
 * runs first using the pre-minted id as the Storage folder, then setDoc
 * writes everything in one shot. Storage rules gate uploads on
 * canWriteFiles(tripId) without checking the doc existence, so the
 * upload-before-write order is safe.
 */
export async function createExpense(
  tripId: string,
  input: CreateExpenseInput,
  createdBy: string,
  attachment?: File | null,
): Promise<string> {
  const [{ db, collection, doc, setDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const ref = doc(collection(db, ...P.expenses(tripId)))
  let receipt: ExpenseReceipt | null = null
  if (attachment instanceof File) {
    receipt = await uploadReceipt(tripId, ref.id, attachment)
  }
  const payload: Record<string, unknown> = {
    ...input,
    tripId,
    memberIds,
    ...auditCreate(createdBy, serverTimestamp()),
  }
  if (receipt) payload.receipt = receipt
  await setDoc(ref, payload)
  void bumpTripActivity(tripId, 'expense', createdBy)
  return ref.id
}

/**
 * Update with optional receipt change. Tri-state attachment:
 *   undefined → leave receipt untouched
 *   null      → remove existing receipt (Storage purge + Firestore deleteField)
 *   File      → replace (purge old → upload new → patch doc)
 */
export async function updateExpense(
  tripId: string,
  expenseId: string,
  updates: UpdateExpenseInput,
  options: {
    uid:           string
    attachment?:   File | null
    existingPaths?: { path?: string; thumbPath?: string }
  },
): Promise<void> {
  const { uid, attachment, existingPaths } = options
  const validated = validateUpdateOrThrow(UpdateExpenseSchema, updates, {
    source: 'updateExpense', tripId, expenseId,
  })
  const { db, doc, updateDoc, serverTimestamp, deleteField } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...validated,
    ...auditUpdate(uid, serverTimestamp()),
  }

  if (attachment === null) {
    if (existingPaths) await purgeReceipt(existingPaths)
    patch.receipt = deleteField()
  } else if (attachment instanceof File) {
    if (existingPaths) await purgeReceipt(existingPaths)
    const receipt: ExpenseReceipt = await uploadReceipt(tripId, expenseId, attachment)
    patch.receipt = receipt
  }

  await updateDoc(doc(db, ...P.expense(tripId, expenseId)), patch)
  void bumpTripActivity(tripId, 'expense', uid)
}

export async function deleteExpense(
  tripId: string,
  expenseId: string,
  uid: string,
  existingPaths?: { path?: string; thumbPath?: string },
): Promise<void> {
  // Purge Storage first so a doc with broken refs is never the long-term
  // state. If purge fails the doc remains; user can retry the delete.
  if (existingPaths) await purgeReceipt(existingPaths)
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.expense(tripId, expenseId)))
  void bumpTripActivity(tripId, 'expense', uid)
}
