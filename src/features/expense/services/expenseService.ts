// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditUpdate } from '@/utils/audit'
import { bumpTripActivity } from '@/services/tripActivity'
import { ExpenseDocSchema, UpdateExpenseSchema, type Expense, type ExpenseReceipt, type CreateExpenseInput, type UpdateExpenseInput } from '@/types'
import { uploadReceipt, purgeReceipt } from './expenseStorage'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
  WorkerRejected, WorkerAmbiguous,
} from '@/services/workerBase'
import { safePurgeWithEnqueueFallback, enqueueOrphanPurges } from '@/services/orphanPurge'
import { captureError } from '@/services/sentry'

// Re-export for tests + back-compat with callers that previously
// imported the discriminated error types from this module.
export { WorkerRejected, WorkerAmbiguous }

// WorkerRejected / WorkerAmbiguous / workerFetch / preflightIdToken
// all live in @/services/workerBase now -- shared single chokepoint
// for every service that calls a mutating Worker endpoint. See the
// re-exports near the top of this file.

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
 * Create an expense + optional receipt. Goes through the Worker
 * /expense-create endpoint (Admin SDK write) because firestore.rules
 * has `allow create: if false` on expenses -- the Worker is the only
 * authorized writer. The Worker validates the full payload (splits
 * shape + memberId-in-roster + Σsplits == amount + paidBy + currency
 * + receipt path pattern) before the Admin SDK setDoc.
 *
 * Receipt orchestration stays client-side: we mint the expenseId
 * locally (so the Storage path is known up front), upload to
 * canWriteFiles-gated Storage, then send the payload + receipt URL
 * to the Worker. If validation fails we surface the error; the
 * orphan Storage blob routes through `safePurgeWithEnqueueFallback`
 * (in-process retry -> _purges queue -> daily Worker cron). See
 * `orphan-blob-durability` memory for the full escalation ladder.
 */
export async function createExpense(
  tripId: string,
  input: CreateExpenseInput,
  _createdBy: string,
  attachment?: File | null,
): Promise<string> {
  // Two preflight gates BEFORE any Storage side effect:
  //   1. workerBase: env config check (sync requireWorkerWriteBase)
  //   2. idToken:    auth session check (async, may need token refresh)
  // Either failure here throws BEFORE uploadReceipt -- the receipt
  // never lands in Storage, no rollback path needed. Without the
  // auth preflight a sign-out / token-refresh failure between upload
  // and workerFetch would slip into the ambiguous-cleanup branch
  // with a blob already on disk + a now-stale auth state that would
  // also reject the _purges enqueue, leaking the PII blob.
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()

  const { db, collection, doc } = await getFirebase()
  // Mint the expenseId client-side so the Storage path can be
  // constructed against it (Worker `makeReceiptSchema` path regex
  // re-enforces the same path/expenseId binding on the server side).
  // The Worker's `currentDocument.exists = false` on the create
  // PATCH ensures we don't accidentally overwrite an existing doc.
  const ref = doc(collection(db, ...P.expenses(tripId)))
  let receipt: ExpenseReceipt | null = null
  if (attachment instanceof File) {
    receipt = await uploadReceipt(tripId, ref.id, attachment)
  }
  const expensePayload: Record<string, unknown> = { ...input }
  if (receipt) expensePayload.receipt = receipt

  try {
    await workerFetch(workerBase, idToken, '/expense-create', {
      tripId,
      expenseId: ref.id,
      expense:   expensePayload,
    })
  } catch (e) {
    // Discriminate Worker rejection from commit-ambiguity:
    //   - WorkerRejected: Worker explicitly said no BEFORE any
    //     Firestore admin write. Safe to roll back inline.
    //   - WorkerAmbiguous (timeout / network / 5xx) OR unknown:
    //     Worker MAY have committed. Enqueue the new blob path
    //     for the orphan-purge cron, whose verify-before-delete
    //     compares doc.receipt.path to the queue entry's path
    //     -- the SAME check we'd do inline, just deferred. If
    //     Worker did commit, cron sees match → drops queue,
    //     blob lives (correct). If Worker didn't commit, cron
    //     sees missing doc / path mismatch → deletes blob
    //     (correct). Strictly better than inline read-back
    //     because it also handles the "read-back itself fails"
    //     case -- the cron retries the verify daily until it
    //     either resolves the entry or hits MAX_ATTEMPTS.
    if (receipt) {
      const paths = [receipt.path, receipt.thumbPath].filter(Boolean) as string[]
      if (e instanceof WorkerRejected) {
        await safePurgeWithEnqueueFallback({
          purge: () => purgeReceipt(receipt),
          enqueue: {
            tripId, collection: 'expenses', entityId: ref.id,
            paths,
            source: 'createExpense/rollback-receipt',
          },
          sentry: { source: 'createExpense/rollback-receipt', tripId, expenseId: ref.id },
        })
      } else {
        // Ambiguous -- defer to cron's verify-before-delete.
        await enqueueOrphanPurges({
          tripId, collection: 'expenses', entityId: ref.id,
          paths,
          source: 'createExpense/ambiguous-rollback',
        }).catch(enqueueErr => {
          captureError(enqueueErr, {
            source: 'createExpense/ambiguous-rollback-enqueue-failed',
            tripId, expenseId: ref.id,
            original: String((e as Error)?.message ?? e),
          })
        })
      }
    }
    throw e
  }
  void bumpTripActivity(tripId, 'expense', _createdBy)
  return ref.id
}

/**
 * Update with optional receipt change. Tri-state attachment:
 *   undefined → leave receipt untouched
 *   null      → remove existing receipt (Storage purge + Worker patch
 *               drops receipt field)
 *   File      → replace (purge old → upload new → Worker patch sets
 *               receipt field)
 *
 * Content fields (title/amount/splits/paidBy/category/etc.) go
 * through Worker /expense-update which validates them the same way
 * the create endpoint does. Client SDK update is restricted by
 * rules to soft-delete / restore + audit-only updates (see
 * `deleteExpense` below for the rules-gated path).
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
  // Same two preflight gates as createExpense: workerBase env + auth
  // idToken, both BEFORE the new-receipt upload below.
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  const { uid, attachment, existingPaths } = options
  const validated = validateUpdateOrThrow(UpdateExpenseSchema, updates, {
    source: 'updateExpense', tripId, expenseId,
  })
  const patch: Record<string, unknown> = { ...validated }

  // Receipt order: upload the NEW blob first (to a UNIQUE path
  // courtesy of uploadReceipt's random shortId suffix), then call
  // the Worker, then purge the OLD blob ONLY on Worker success.
  //
  // Two invariants gated by the ordering + uniqueness:
  //   1. Worker reject → new blob is purged, old blob untouched
  //      (user can re-attempt with same form data).
  //   2. Same-mime replacement → old and new paths differ because
  //      of shortId, so the post-Worker purgeReceipt(existingPaths)
  //      only targets the genuinely-old blob. Without unique
  //      suffixes Storage upload would overwrite then the purge
  //      would delete the just-written blob.
  let newReceiptBlob: ExpenseReceipt | null = null
  if (attachment === null) {
    // Field-delete signal -- Worker drops the receipt field. Old
    // blob purge runs in the success branch below.
    patch.receipt = null
  } else if (attachment instanceof File) {
    newReceiptBlob = await uploadReceipt(tripId, expenseId, attachment)
    patch.receipt = newReceiptBlob
  }

  try {
    await workerFetch(workerBase, idToken, '/expense-update', {
      tripId,
      expenseId,
      patch,
    })
  } catch (e) {
    // Two blobs may need cleanup after a failed update:
    //
    //   NEW blob (newReceiptBlob): we uploaded it before calling
    //     the Worker. If Worker rejected → orphan (purge). If
    //     Worker committed → doc references it (keep). If
    //     ambiguous → cron's verify-before-delete decides.
    //
    //   OLD blob (existingPaths): doc previously referenced it.
    //     If Worker rejected → still referenced (don't touch). If
    //     Worker COMMITTED → doc no longer references it (orphan;
    //     the success-path purge below would have handled it, but
    //     we threw, so it wasn't run). If ambiguous → cron's
    //     verify-before-delete also decides for the old path.
    //
    // WorkerRejected: only the new blob needs cleanup (old is
    // still referenced). WorkerAmbiguous / unknown: enqueue BOTH
    // paths -- cron will keep the one the doc still references
    // and delete the orphan. This closes the failure mode where
    // a Worker timeout-after-commit would leave the OLD blob
    // stranded indefinitely (we used to only handle new-blob
    // cleanup in this catch).
    const newPaths: string[] = newReceiptBlob
      ? [newReceiptBlob.path, newReceiptBlob.thumbPath].filter(Boolean) as string[]
      : []
    const oldChanged = existingPaths && (attachment === null || attachment instanceof File)
    const oldPaths: string[] = oldChanged
      ? [existingPaths.path, existingPaths.thumbPath].filter(Boolean) as string[]
      : []

    if (e instanceof WorkerRejected) {
      // Definite no-commit. New blob is orphan; old blob is still
      // referenced by doc -- leave it.
      if (newReceiptBlob && newPaths.length > 0) {
        await safePurgeWithEnqueueFallback({
          purge: () => purgeReceipt(newReceiptBlob),
          enqueue: {
            tripId, collection: 'expenses', entityId: expenseId,
            paths: newPaths,
            source: 'updateExpense/rollback-new-receipt',
          },
          sentry: { source: 'updateExpense/rollback-new-receipt', tripId, expenseId },
        })
      }
    } else {
      // Ambiguous. Enqueue both candidates -- cron verifies which
      // one the doc actually references and only deletes the other.
      const enqueueFailureCtx = (source: string) => (enqueueErr: unknown) => {
        captureError(enqueueErr, {
          source: `${source}-enqueue-failed`,
          tripId, expenseId,
          original: String((e as Error)?.message ?? e),
        })
      }
      if (newReceiptBlob && newPaths.length > 0) {
        await enqueueOrphanPurges({
          tripId, collection: 'expenses', entityId: expenseId,
          paths: newPaths,
          source: 'updateExpense/ambiguous-rollback',
        }).catch(enqueueFailureCtx('updateExpense/ambiguous-rollback'))
      }
      if (oldPaths.length > 0) {
        await enqueueOrphanPurges({
          tripId, collection: 'expenses', entityId: expenseId,
          paths: oldPaths,
          source: 'updateExpense/ambiguous-old-receipt',
        }).catch(enqueueFailureCtx('updateExpense/ambiguous-old-receipt'))
      }
    }
    throw e
  }

  // Success path -- now safe to drop the old blob (if any).
  if (existingPaths && (attachment === null || attachment instanceof File)) {
    // Best-effort old-blob purge with the full durability ladder:
    // 1) deleteStorageObject retries transient failures inline.
    // 2) safePurgeWithEnqueueFallback enqueues to _purges for the
    //    Worker orphan-purge cron if step 1 gave up.
    // 3) Sentry captures only if BOTH steps failed -- a genuine
    //    "no automated cleanup remaining" alert.
    await safePurgeWithEnqueueFallback({
      purge: () => purgeReceipt(existingPaths),
      enqueue: {
        tripId, collection: 'expenses', entityId: expenseId,
        paths: [existingPaths.path, existingPaths.thumbPath].filter(Boolean) as string[],
        source: 'updateExpense/purge-old-receipt',
      },
      sentry: { source: 'updateExpense/purge-old-receipt', tripId, expenseId },
    })
  }
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
