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

/**
 * Limit on the realtime expense listener. Sized to cover (active +
 * tombstoned) docs because soft-delete keeps the doc in the same
 * collection -- SettlementSummary's chronological replay needs to see
 * tombstones to classify orphan reasons, so we can't just filter them
 * out at the server. 500 buys headroom for ~5×/day delete rate × 30
 * days of tombstones on top of an active set the original 200 was
 * sized for.
 *
 * Tombstones are not auto-pruned at the doc level (only the receipt
 * bytes get purged after 10 days). Long-running trips that exceed
 * 500 total entries would lose the oldest from the listener; if that
 * becomes real we'd add a separate active-only listener for the UI
 * list and keep the unfiltered one scoped to SettlementSummary.
 */
const LIST_LIMIT = 500

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
    // Explicit null so the doc is queryable under
    // where('deletedAt', '==', null). Required by firestore.rules
    // create gate; future server-side active-only filter relies on it.
    deletedAt: null,
    // Explicit null marks this doc as a future receipt-purge candidate.
    // The Worker cron filters on `receiptPurgedAt == null AND deletedAt
    // < cutoff` — without the field present it can't be queried, and
    // omitting it would cause the cron to drift back to "re-scan every
    // historical tombstone forever". Cron stamps a Timestamp here once
    // the receipt bytes + receipt field are cleared.
    receiptPurgedAt: null,
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

/**
 * Soft-delete: set deletedAt instead of hard-deleting the doc. UI
 * filters tombstones out of the list (ExpensePage.displayExpenses);
 * settlement chronological replay still sees them to classify orphan
 * reasons. Receipt bytes are cleared by the Worker cron 10 days after
 * deletedAt (see workers/ocr/src/receipt-purge.ts) -- `receiptPurgedAt`
 * is seeded `null` at create time, so the cron filter picks it up
 * automatically when deletedAt < cutoff.
 */
export async function deleteExpense(
  tripId: string,
  expenseId: string,
  uid: string,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.expense(tripId, expenseId)), {
    deletedAt: serverTimestamp(),
    ...auditUpdate(uid, serverTimestamp()),
  })
  void bumpTripActivity(tripId, 'expense', uid)
}
