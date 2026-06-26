// src/features/expense/services/expenseService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditUpdate } from '@/utils/audit'
import { bumpTripActivity } from '@/services/tripActivity'
import { ExpenseDocSchema, UpdateExpenseSchema, type Expense, type CreateExpenseInput, type UpdateExpenseInput } from '@/types/expense'
import { uploadReceipt, purgeReceipt } from './expenseStorage'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
  WorkerRejected, WorkerAmbiguous,
} from '@/services/workerBase'
import { safePurgeWithEnqueueFallback, enqueueOrphanPurges } from '@/services/orphanPurge'
import { captureError, breadcrumb } from '@/services/sentry'

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

const SOURCE_EXPENSE_WIRE_KEYS = [
  'sourceCurrency',
  'sourceAmountMinor',
  'sourceItems',
  'sourceAdjustments',
  'sourceSplits',
] as const

const TRIP_PREVIEW_WIRE_KEYS = [
  'amountMinor',
  'currency',
  'splits',
  'items',
  'adjustments',
] as const

type WorkerExpenseMode = 'TRIP_CURRENCY' | 'FOREIGN_CURRENCY'

function hasDefinedOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined
}

function assertCompleteForeignSourceGroup(
  payload: Record<string, unknown>,
  source: 'createExpense' | 'updateExpense',
): void {
  const hasAnySourceField = SOURCE_EXPENSE_WIRE_KEYS.some(key => hasDefinedOwn(payload, key))
  if (!hasAnySourceField) return

  const hasLineSourceGroup =
    Array.isArray(payload.sourceItems) &&
    Array.isArray(payload.sourceAdjustments) &&
    payload.sourceSplits === undefined
  const hasSplitSourceGroup =
    Array.isArray(payload.sourceSplits) &&
    payload.sourceItems === undefined &&
    payload.sourceAdjustments === undefined

  const hasCompleteSourceGroup =
    typeof payload.sourceCurrency === 'string' &&
    typeof payload.sourceAmountMinor === 'number' &&
    (hasLineSourceGroup || hasSplitSourceGroup)

  if (!hasCompleteSourceGroup) {
    throw new Error(
      `${source}: foreign expense payload requires sourceCurrency, sourceAmountMinor, and exactly one source domain: sourceItems+sourceAdjustments OR sourceSplits`,
    )
  }
}

/**
 * Resolve the wire mode. The explicit `input.mode` (stamped by
 * buildExpenseFormResult from the form's foreign-open intent) is the
 * PRIMARY discriminator; source-field presence is demoted to a
 * defense-in-depth cross-check so a stale form field can't silently flip
 * the route (mode=TRIP carrying a leftover sourceCurrency, or mode=FOREIGN
 * with the source group dropped). When mode is absent — a text-only patch
 * or a non-form caller — we fall back to deriving from source presence;
 * that path is the defensive default, NOT the primary contract.
 */
function resolveWorkerExpenseMode(
  declared: unknown,
  payload:  Record<string, unknown>,
  source:   'createExpense' | 'updateExpense',
): WorkerExpenseMode {
  const hasSourceCurrency = typeof payload.sourceCurrency === 'string'
  if (declared === undefined) {
    return hasSourceCurrency ? 'FOREIGN_CURRENCY' : 'TRIP_CURRENCY'
  }
  // Runtime enum gate. `mode` is TS-typed on the DTO, but createExpense
  // never runs CreateExpenseSchema.parse — a cast, a test helper, an old
  // caller, or corrupt data could smuggle an out-of-enum value. Without
  // this, e.g. 'FOREIGN' would fail BOTH equality checks below and fall
  // through to the trip path in workerExpensePayload, silently routing an
  // invalid discriminator as trip-currency. Reject before any IO.
  if (declared !== 'TRIP_CURRENCY' && declared !== 'FOREIGN_CURRENCY') {
    throw new Error(`${source}: mode must be TRIP_CURRENCY or FOREIGN_CURRENCY, got "${String(declared)}"`)
  }
  if (declared === 'FOREIGN_CURRENCY' && !hasSourceCurrency) {
    throw new Error(`${source}: mode=FOREIGN_CURRENCY requires a sourceCurrency on the payload`)
  }
  if (declared === 'TRIP_CURRENCY') {
    const stray = SOURCE_EXPENSE_WIRE_KEYS.find(key => hasDefinedOwn(payload, key))
    if (stray) {
      throw new Error(`${source}: mode=TRIP_CURRENCY must not carry source-domain field "${stray}"`)
    }
  }
  return declared
}

function workerExpensePayload(
  input: CreateExpenseInput | UpdateExpenseInput,
  source: 'createExpense' | 'updateExpense',
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...input }
  // Read the RAW runtime mode (untyped) before stripping it — the DTO type
  // claims a valid enum, but only resolveWorkerExpenseMode's runtime gate
  // actually enforces that.
  const declaredMode = payload.mode
  delete payload.mode
  // Defense-in-depth (unchanged): a half-populated foreign group is
  // rejected up front, before we trust any mode. No-op when there are no
  // source fields at all (the common trip-currency case).
  assertCompleteForeignSourceGroup(payload, source)
  // Explicit mode wins; resolve() cross-checks it against source presence.
  const mode = resolveWorkerExpenseMode(declaredMode, payload, source)

  if (mode === 'FOREIGN_CURRENCY') {
    for (const key of TRIP_PREVIEW_WIRE_KEYS) delete payload[key]
    return withWorkerExpenseMode(payload, 'FOREIGN_CURRENCY')
  }

  for (const key of SOURCE_EXPENSE_WIRE_KEYS) {
    if (payload[key] === undefined) delete payload[key]
  }
  return withWorkerExpenseMode(payload, 'TRIP_CURRENCY')
}

function withWorkerExpenseMode(
  payload: Record<string, unknown>,
  mode: WorkerExpenseMode,
): Record<string, unknown> {
  return { ...payload, mode }
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
  const expensePayload = workerExpensePayload(input, 'createExpense')
  // Phase 3.5: upload via intent flow, hand off intentIds + paths.
  // Worker /expense-create consumes the intentIds inline with the
  // expense doc write (single tx); paths are kept here for client-
  // side rollback if the Worker rejects / times out.
  let uploaded: { intentIds: string[]; paths: string[]; traceId: string } | null = null
  if (attachment instanceof File) {
    uploaded = await uploadReceipt(tripId, ref.id, attachment)
  }

  if (uploaded) {
    breadcrumb({
      category: 'upload',
      message:  'entity-write',
      data:     { traceId: uploaded.traceId, endpoint: '/expense-create', tripId, expenseId: ref.id },
    })
  }
  try {
    await workerFetch(workerBase, idToken, '/expense-create', {
      tripId,
      expenseId: ref.id,
      expense:   expensePayload,
      // Worker builds the receipt field server-side from these
      // intentIds (verify intent + storage object + mark used in
      // same Firestore transaction as the expense doc create).
      ...(uploaded ? { intentIds: uploaded.intentIds } : {}),
    }, uploaded ? { traceId: uploaded.traceId } : undefined)
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
    if (uploaded) {
      const paths = uploaded.paths
      if (e instanceof WorkerRejected) {
        await safePurgeWithEnqueueFallback({
          purge: () => purgeReceipt({ paths }),
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
  // Phase 3c-1 foreign-mode wire strip — same rationale as createExpense.
  // For updates the Worker's foreign-update schema treats
  // (sourceCurrency, sourceAmountMinor, sourceItems, sourceAdjustments)
  // as an atomic 4-field group: any source-side field present requires
  // all four. The form layer enforces that by always emitting the full
  // group together when the user is editing a foreign expense. Trip-
  // currency fields (amountMinor / currency / splits / items /
  // adjustments) on a foreign update are server-derived and stripped
  // here so the Worker's `.partial()` schema doesn't reject the
  // payload.
  const patch = workerExpensePayload(validated, 'updateExpense')

  // Receipt order (Phase 3.5): upload the NEW blobs first via the
  // intent flow (Worker mints unique paths server-side so there's no
  // collision with existingPaths), then call the Worker `/expense-
  // update`, then purge the OLD blob ONLY on Worker success.
  //
  // Two invariants gated by the ordering + Worker-server-issued path:
  //   1. Worker reject → new blob is purged, old blob untouched
  //      (user can re-attempt with same form data).
  //   2. Same-mime replacement → server-minted paths never collide
  //      with existing paths (each intent generates a fresh shortId),
  //      so the post-Worker purgeReceipt(existingPaths) only targets
  //      the genuinely-old blob.
  let uploadedNew: { intentIds: string[]; paths: string[]; traceId: string } | null = null
  if (attachment === null) {
    // Field-delete signal -- Worker drops the receipt field. Old
    // blob purge runs in the success branch below.
    patch.receipt = null
  } else if (attachment instanceof File) {
    uploadedNew = await uploadReceipt(tripId, expenseId, attachment)
    // patch.receipt NOT set here -- Worker builds receipt server-side
    // from intentIds in the same transaction as the doc patch.
  }

  if (uploadedNew) {
    breadcrumb({
      category: 'upload',
      message:  'entity-write',
      data:     { traceId: uploadedNew.traceId, endpoint: '/expense-update', tripId, expenseId },
    })
  }
  try {
    await workerFetch(workerBase, idToken, '/expense-update', {
      tripId,
      expenseId,
      patch,
      ...(uploadedNew ? { intentIds: uploadedNew.intentIds } : {}),
    }, uploadedNew ? { traceId: uploadedNew.traceId } : undefined)
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
    const newPaths: string[] = uploadedNew ? uploadedNew.paths : []
    const oldChanged = existingPaths && (attachment === null || attachment instanceof File)
    const oldPaths: string[] = oldChanged
      ? [existingPaths.path, existingPaths.thumbPath].filter(Boolean) as string[]
      : []

    if (e instanceof WorkerRejected) {
      // Definite no-commit. New blob is orphan; old blob is still
      // referenced by doc -- leave it.
      if (newPaths.length > 0) {
        await safePurgeWithEnqueueFallback({
          purge: () => purgeReceipt({ paths: newPaths }),
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
      if (newPaths.length > 0) {
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
