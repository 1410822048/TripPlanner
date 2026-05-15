// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { ExpenseDocSchema, UpdateExpenseSchema, type Expense, type ExpenseReceipt, type CreateExpenseInput, type UpdateExpenseInput } from '@/types'
import { uploadReceipt, purgeReceipt } from './expenseStorage'

/** Defensive cap — see bookingService. Expenses can pile up on long trips
 *  with shared meals; 200 covers a 14-day group trip with healthy margin. */
const LIST_LIMIT = 200

/** 驗證一份 Firestore doc 是否符合 Expense schema；失敗時丟出錯誤以利觀測 */
function expenseFromDoc(d: QueryDocumentSnapshot): Expense {
  return firestoreDocFromSchema(ExpenseDocSchema, d, 'expenseFromDoc')
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

/** Realtime variant — same query shape, pushed via onSnapshot. */
export const subscribeToExpenses = (
  tripId: string,
  onData: (data: Expense[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Expense>({
  buildQuery: ({ db, collection, query, orderBy, limit }) => query(
    collection(db, ...P.expenses(tripId)),
    orderBy('date', 'desc'),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: expenseFromDoc,
  source:  'subscribeToExpenses',
  limit:   LIST_LIMIT,
}, onData, onError)

// ─── Write ────────────────────────────────────────────────────────
/**
 * Create an expense + optional receipt. Two-phase write when a file is
 * present:
 *   1. addDoc with the form fields (so we get a doc id for the Storage
 *      folder)
 *   2. uploadReceipt against `trips/{tripId}/expenses/{id}/...`
 *   3. updateDoc to patch the receipt URLs onto the newly-created doc
 *
 * The two-phase pattern mirrors createBooking — Storage rules gate
 * writes on the trip's canWrite, so we don't need a transactional
 * guarantee that one doesn't race the other.
 */
export async function createExpense(
  tripId: string,
  input: CreateExpenseInput,
  createdBy: string,
  attachment?: File | null,
): Promise<string> {
  const { db, collection, doc, addDoc, updateDoc, serverTimestamp } = await getFirebase()
  const ref = await addDoc(collection(db, ...P.expenses(tripId)), {
    ...input,
    tripId,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  if (attachment instanceof File) {
    const receipt = await uploadReceipt(tripId, ref.id, attachment)
    await updateDoc(doc(db, ...P.expense(tripId, ref.id)), { receipt, updatedAt: serverTimestamp() })
  }
  return ref.id
}

/**
 * Update with optional receipt change. Tri-state attachment matches
 * the booking pattern + useAttachment's pickAttachmentChange():
 *   undefined → leave receipt untouched
 *   null      → remove existing receipt (Storage purge + Firestore deleteField)
 *   File      → replace (purge old → upload new → patch doc)
 *
 * `existingPaths` is the snapshot of paths to purge on replace/clear.
 * Caller (useExpenses hook) reads from the cached doc.
 */
export async function updateExpense(
  tripId: string,
  expenseId: string,
  updates: UpdateExpenseInput,
  attachment?: File | null,
  existingPaths?: { path?: string; thumbPath?: string },
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
  const { db, doc, updateDoc, serverTimestamp, deleteField } = await getFirebase()
  const patch: Record<string, unknown> = { ...parsed.data, updatedAt: serverTimestamp() }

  // Receipt mutation paths
  if (attachment === null) {
    // Clear — purge Storage first (best-effort), then deleteField on the doc
    if (existingPaths) await purgeReceipt(existingPaths)
    patch.receipt = deleteField()
  } else if (attachment instanceof File) {
    // Replace — purge the old then upload the new
    if (existingPaths) await purgeReceipt(existingPaths)
    const receipt: ExpenseReceipt = await uploadReceipt(tripId, expenseId, attachment)
    patch.receipt = receipt
  }
  // attachment === undefined → leave receipt untouched

  await updateDoc(doc(db, ...P.expense(tripId, expenseId)), patch)
}

export async function deleteExpense(
  tripId: string,
  expenseId: string,
  existingPaths?: { path?: string; thumbPath?: string },
): Promise<void> {
  // Purge Storage first so a doc with broken refs is never the long-term
  // state. If purge fails the doc remains; user can retry the delete.
  if (existingPaths) await purgeReceipt(existingPaths)
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.expense(tripId, expenseId)))
}
