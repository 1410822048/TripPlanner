// workers/ocr/src/expense-write.ts
// Worker-side expense create + content-update.
//
// Why these run on the Worker instead of via firestore.rules:
//   1. Splits validation (item shape + memberId-in-roster + non-neg
//      amounts + sum-equals-total) needs array iteration that the
//      rules language can't express.
//   2. paidBy-in-roster check needs to read trip member list; rules
//      can do same-doc memberIds lookup but the combined surface
//      of splits + paidBy + items.assignees all referencing the
//      roster is cleaner in one place.
//   3. Settlement-engine inputs (amount, splits, currency, paidBy)
//      reach computeBalancesFull directly; bad data here causes
//      classification errors and ghost debt edges. Single
//      validation chokepoint > rules + JS form layer duplication.
//
// firestore.rules has `allow create: if false` and a strict
// `changedOnly([deletedAt, updatedBy, updatedAt, ...])` on update,
// so this endpoint is the ONLY path that can write content fields
// to an expense doc. Client-side soft-delete / restore stay rules-gated
// (no settlement-engine risk); membership projection writes are Worker-owned.
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId, invalidateAdminToken }        from './admin'
import {
  readString,
  type FsValue,
}                                                                   from './firestore'
import {
  ExpenseValidationError,
  makeExpenseCreateSchema,
  makeExpenseUpdateSchema,
  makeReceiptSchema,
  validateExpenseCrossField,
  type ExpenseReceiptOut,
}                                                                   from './expense-validate'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
}                                                                   from './firestore-tx'
import {
  consumeEntityIntents,
  type ConsumedIntent,
}                                                                   from './upload-intent'

// ─── Request body schemas ─────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

export const ExpenseCreateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  expenseId: z.string().regex(TripIdRe),   // client mints via doc(collection(...))
  expense:   z.unknown(),                  // validated against schema after we know tripId/expenseId
  /** Phase 3.5 intent-driven receipt. When present, Worker reads the
   *  named intents, verifies storage objects exist, builds the receipt
   *  field server-side from intent.path + storage metadata, and marks
   *  the intents 'used' in the same tx as the expense doc write. This
   *  is the ONLY way to set a receipt -- client-supplied `expense.
   *  receipt` is rejected outright (was a legacy Phase 1-2 path). */
  intentIds: z.array(z.string().min(1).max(60)).max(2).optional(),
})
export type ExpenseCreateRequest = z.infer<typeof ExpenseCreateRequestSchema>

export const ExpenseUpdateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  expenseId: z.string().regex(TripIdRe),
  patch:     z.unknown(),                  // validated as partial after merge
  /** Same intent-driven receipt path as ExpenseCreateRequest. The ONLY
   *  way to attach / replace a receipt; `patch.receipt: <object>` is
   *  rejected. `patch.receipt: null` (deletion sentinel) remains valid
   *  but is mutually exclusive with intentIds. */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(2).optional(),
})
export type ExpenseUpdateRequest = z.infer<typeof ExpenseUpdateRequestSchema>

// ─── Authorization helpers ────────────────────────────────────────

interface TripContext {
  memberIds:  string[]
}

/** Verify caller is owner/editor of trip AND trip is not being
 *  cascade-deleted. Runs inside a Firestore transaction so the
 *  reads are committed atomically with the write -- closes the
 *  stale-read race where another client soft-deletes / stamps
 *  deletingAt between our auth check and our admin write.
 *  Throws CascadeError mapped to 403 / 410. */
async function authorizeCanWriteTx(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<TripContext> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)   throw new CascadeError(404, 'trip not found')
  if (!member.exists) throw new CascadeError(403, 'caller is not a trip member')

  const role = readString(member.fields, 'role')
  if (role !== 'owner' && role !== 'editor') {
    throw new CascadeError(403, 'caller role is not owner/editor')
  }
  if ('deletingAt' in trip.fields) {
    throw new CascadeError(410, 'trip is being deleted')
  }

  // Extract memberIds[] from the trip doc. Firestore REST shape:
  // { arrayValue: { values: [{ stringValue: '...' }, ...] } }
  const arr = (trip.fields.memberIds as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const memberIds = arr
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')
  if (memberIds.length === 0) {
    throw new CascadeError(500, 'trip.memberIds is empty')
  }
  return { memberIds }
}

// ─── Firestore value encoders ─────────────────────────────────────

function encodeExpense(
  payload: ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']>,
  tripId:  string,
  memberIds: string[],
  createdBy: string,
  receipt?: ExpenseReceiptOut,
): Record<string, FsValue> {
  // createdAt / updatedAt are written via `updateTransforms` with
  // setToServerValue: REQUEST_TIME -- NOT here in the fields map.
  // Using CF Workers' Date.now() would drift relative to Firestore
  // server clock; the settlement engine sorts by createdAt for the
  // chronological replay that classifies orphan reasons (see
  // `buildOrphanReasonMap` in services/settlement.ts), and a CF/
  // Firestore skew could re-order events across the boundary and
  // flip OVERPAYMENT vs EXPENSE_DELETED classifications. REQUEST_
  // TIME pins both stamps to Firestore commit time, matching the
  // legacy rules-path that used `request.time`.
  const fields: Record<string, FsValue> = {
    tripId:          { stringValue: tripId },
    title:           { stringValue: payload.title },
    amount:          { doubleValue: payload.amount },
    currency:        { stringValue: payload.currency },
    category:        { stringValue: payload.category },
    paidBy:          { stringValue: payload.paidBy },
    splits:          {
      arrayValue: {
        values: payload.splits.map(s => ({
          mapValue: {
            fields: {
              memberId: { stringValue: s.memberId },
              amount:   { doubleValue: s.amount },
            },
          },
        })),
      },
    },
    date:            { stringValue: payload.date },
    memberIds:       {
      arrayValue: { values: memberIds.map(uid => ({ stringValue: uid })) },
    },
    createdBy:       { stringValue: createdBy },
    updatedBy:       { stringValue: createdBy },
    deletedAt:       { nullValue: null },
    receiptPurgedAt: { nullValue: null },
  }
  if (payload.note != null) {
    fields.note = { stringValue: payload.note }
  }
  if (payload.items) {
    fields.items = {
      arrayValue: {
        values: payload.items.map(item => ({
          mapValue: {
            fields: {
              name:   { stringValue: item.name },
              amount: { doubleValue: item.amount },
              assignees: {
                arrayValue: {
                  values: item.assignees.map(uid => ({ stringValue: uid })),
                },
              },
            },
          },
        })),
      },
    }
  }
  if (receipt) {
    const rfields: Record<string, FsValue> = {
      url:  { stringValue: receipt.url },
      path: { stringValue: receipt.path },
      type: { stringValue: receipt.type },
    }
    if (receipt.thumbUrl != null)  rfields.thumbUrl  = { stringValue: receipt.thumbUrl }
    if (receipt.thumbPath != null) rfields.thumbPath = { stringValue: receipt.thumbPath }
    fields.receipt = { mapValue: { fields: rfields } }
  }
  return fields
}

// ─── Endpoint: expense-create ─────────────────────────────────────

export async function expenseCreate(
  callerUid:          string,
  req:                ExpenseCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ expenseId: string }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson, bucket))
}

async function doCreate(
  callerUid:          string,
  req:                ExpenseCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ expenseId: string }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeCanWriteTx(tx, req.tripId, callerUid)

    // Phase 3.5 legacy-cleanup: client-supplied `expense.receipt` is
    // unconditionally rejected. Receipts now flow exclusively through
    // the intent path (Worker mints the path, the client uploads via
    // SDK to that path, then the Worker reads Storage metadata and
    // builds the receipt field server-side here). The receipt is NOT
    // part of the body validation schema (`makeExpenseCreateSchema`)
    // anymore -- it's threaded into encodeExpense as a separate
    // parameter and validated via `makeReceiptSchema` as defense-in-
    // depth against a malformed intent producing a bad URL/path.
    const callerReceipt = (req.expense as { receipt?: unknown } | null)?.receipt
    if (callerReceipt !== undefined && callerReceipt !== null) {
      throw new ExpenseValidationError(
        'receipt',
        'expense.receipt cannot be set directly; upload via /upload-intents and pass intentIds',
      )
    }
    let receipt: ExpenseReceiptOut | undefined
    const intentMarkUsedWrites: TxWrite[] = []
    if (req.intentIds && req.intentIds.length > 0) {
      const { consumed, markUsedWrites } = await consumeEntityIntents(
        tx, req.intentIds, callerUid, accessToken, projectId, bucket,
        { tripId: req.tripId, entityType: 'expense', entityId: req.expenseId },
      )
      receipt = validateBuiltReceipt(
        buildReceiptFromIntents(consumed), req.tripId, req.expenseId, bucket,
      )
      intentMarkUsedWrites.push(...markUsedWrites)
    }

    const parsed = makeExpenseCreateSchema().safeParse(req.expense)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new ExpenseValidationError(issue.path.join('.'), issue.message)
    }
    validateExpenseCrossField(parsed.data, ctx.memberIds)

    // Read the target doc inside the tx -- this lets us enforce
    // create-only semantics (no overwrite) at commit time via
    // the tx's optimistic-concurrency check. We also pin
    // `currentDocument.exists=false` as belt-and-suspenders.
    const existing = await tx.get(`trips/${req.tripId}/expenses/${req.expenseId}`)
    if (existing.exists) {
      throw new CascadeError(409, 'expense already exists at this id')
    }

    const fields = encodeExpense(parsed.data, req.tripId, ctx.memberIds, callerUid, receipt)

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${req.expenseId}`),
      fields,
      currentDocument: { exists: false },
      // Server-stamp both audit timestamps to Firestore commit time.
      // See encodeExpense() comment for why CF Date.now() would
      // break settlement chronological replay.
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    return {
      // Intent mark-used writes go FIRST so they commit alongside the
      // expense doc atomically -- if the expense write rejects (409
      // exists, ABORTED retry, etc.) the intents stay pending and
      // can be retried; if both succeed, intents are used and the
      // expense doc owns the path. No half-state.
      writes: [...intentMarkUsedWrites, write],
      result: { expenseId: req.expenseId },
    }
  })
}

/** Run the Worker-built receipt through `makeReceiptSchema` so the
 *  same URL/path-binding + mime invariants that used to gate the
 *  legacy direct-from-client path still apply to intent-derived
 *  receipts. Defense-in-depth: if Storage metadata ever returns an
 *  unexpected shape (token missing, mime drift, etc.) we want a clear
 *  ExpenseValidationError at write time rather than a corrupt
 *  `receipt` field landing in Firestore. */
function validateBuiltReceipt(
  built:     ReturnType<typeof buildReceiptFromIntents>,
  tripId:    string,
  expenseId: string,
  bucket:    string,
): ExpenseReceiptOut {
  const result = makeReceiptSchema(tripId, expenseId, bucket).safeParse(built)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ExpenseValidationError(
      `receipt.${issue.path.join('.')}`,
      `intent-built receipt failed validation: ${issue.message}`,
    )
  }
  return result.data
}

/** Build an ExpenseReceipt-shaped object from consumed intents.
 *  Required: at least one intent with kind='full' or kind='pdf' (the
 *  primary blob). Optional: a single thumb. Throws on a missing
 *  download token (the Firebase Storage SDK adds these on every
 *  upload, so missing means non-SDK upload path -- defense-in-depth
 *  against malformed object metadata). */
function buildReceiptFromIntents(consumed: ConsumedIntent[]): {
  url:        string
  path:       string
  type:       string
  thumbUrl?:  string
  thumbPath?: string
} {
  const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
  if (!primary) {
    throw new ExpenseValidationError(
      'intentIds',
      'must include a full or pdf intent (primary blob missing)',
    )
  }
  if (!primary.downloadUrl) {
    throw new ExpenseValidationError(
      'intentIds',
      `primary upload at ${primary.path} has no Firebase Storage download token`,
    )
  }
  const out: {
    url:        string
    path:       string
    type:       string
    thumbUrl?:  string
    thumbPath?: string
  } = {
    url:  primary.downloadUrl,
    path: primary.path,
    type: primary.storage.contentType,
  }
  const thumb = consumed.find(c => c.kind === 'thumb')
  if (thumb) {
    if (!thumb.downloadUrl) {
      throw new ExpenseValidationError(
        'intentIds',
        `thumb upload at ${thumb.path} has no Firebase Storage download token`,
      )
    }
    out.thumbUrl  = thumb.downloadUrl
    out.thumbPath = thumb.path
  }
  return out
}

// ─── Endpoint: expense-update ─────────────────────────────────────

/**
 * Allowed patch fields. Anything else (tripId, createdBy, createdAt,
 * memberIds, deletedAt, receiptPurgedAt) is owner-of-rules / Worker-
 * elsewhere and rejected here.
 */
const UPDATABLE_FIELDS = new Set([
  'title', 'amount', 'currency', 'category',
  'paidBy', 'splits', 'date', 'note', 'items', 'receipt',
])

export async function expenseUpdate(
  callerUid:          string,
  req:                ExpenseUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doUpdate(callerUid, req, serviceAccountJson, bucket))
}

async function doUpdate(
  callerUid:          string,
  req:                ExpenseUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Patch-shape gate runs OUTSIDE the transaction body -- it's pure
  // request validation, no retry value.
  if (typeof req.patch !== 'object' || req.patch === null) {
    throw new ExpenseValidationError('patch', 'patch must be an object')
  }
  for (const k of Object.keys(req.patch as Record<string, unknown>)) {
    if (!UPDATABLE_FIELDS.has(k)) {
      throw new ExpenseValidationError(k, 'field is not updatable via this endpoint')
    }
  }
  // Phase 3.5 legacy-cleanup: only two patch.receipt values are
  // accepted from the client -- `undefined` (no change) or `null`
  // (deletion sentinel). Any object value is rejected; new receipts
  // must come through intentIds. The deletion-vs-intentIds case is
  // still mutually exclusive because they're contradictory operations
  // (delete current vs. set new); the client picks one.
  const callerPatchReceipt = (req.patch as { receipt?: unknown }).receipt
  if (callerPatchReceipt !== undefined && callerPatchReceipt !== null) {
    throw new ExpenseValidationError(
      'receipt',
      'patch.receipt cannot be set directly; upload via /upload-intents and pass intentIds (or set patch.receipt=null to delete)',
    )
  }
  if (req.intentIds && req.intentIds.length > 0 && callerPatchReceipt === null) {
    throw new ExpenseValidationError(
      'receipt',
      'cannot combine intentIds (set new receipt) with patch.receipt=null (delete current receipt)',
    )
  }

  // patch.receipt is no longer part of the parse schema -- handle the
  // deletion sentinel out-of-band so the receipt object can never
  // reach the parser by accident.
  const receiptDeletion = (req.patch as { receipt?: unknown }).receipt === null
  // Strip `receipt` from the parseable body so a stray key from
  // future client-side bugs can't sneak in via Zod's default strip()
  // behavior (it would silently drop the field, but explicit removal
  // makes the contract obvious to readers).
  const patchForSchema = { ...(req.patch as Record<string, unknown>) }
  delete patchForSchema.receipt

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeCanWriteTx(tx, req.tripId, callerUid)

    // Phase 3.5: consume intents inside tx and validate the built
    // receipt separately. Mirror of doCreate path. Done INSIDE the tx
    // so the consume + expense update commit atomically.
    let receipt: ExpenseReceiptOut | undefined
    const intentMarkUsedWrites: TxWrite[] = []
    if (req.intentIds && req.intentIds.length > 0) {
      const { consumed, markUsedWrites } = await consumeEntityIntents(
        tx, req.intentIds, callerUid, accessToken, projectId, bucket,
        { tripId: req.tripId, entityType: 'expense', entityId: req.expenseId },
      )
      receipt = validateBuiltReceipt(
        buildReceiptFromIntents(consumed), req.tripId, req.expenseId, bucket,
      )
      intentMarkUsedWrites.push(...markUsedWrites)
    }
    const patchParsed = makeExpenseUpdateSchema().safeParse(patchForSchema)
    if (!patchParsed.success) {
      const issue = patchParsed.error.issues[0]
      throw new ExpenseValidationError(issue.path.join('.'), issue.message)
    }

    // Read current expense doc INSIDE the tx so commit-time
    // conflict check catches concurrent soft-delete / restore /
    // tombstone-flip between our read and our write. Pre-tx the
    // window between read and write let an editor land content
    // patches onto an already-tombstoned doc (Admin bypasses the
    // rules-layer tombstone freeze).
    const current = await tx.get(`trips/${req.tripId}/expenses/${req.expenseId}`)
    if (!current.exists) {
      throw new CascadeError(404, 'expense not found')
    }
    if ('deletedAt' in current.fields && (current.fields.deletedAt as { nullValue?: null; timestampValue?: string } | undefined)?.timestampValue) {
      throw new CascadeError(409, 'cannot edit a tombstoned expense')
    }

    const merged = mergeExpense(current.fields, patchParsed.data)
    validateExpenseCrossField(merged, ctx.memberIds)

    // Build the update mask + field map. Receipt write happens via
    // the separate `receipt` arg (intent-built) or via deletion
    // sentinel (`receiptDeletion`). For deletion we list 'receipt'
    // in the updateMask WITHOUT a corresponding entry in `fields`
    // -- Firestore REST commit treats mask-but-no-field as field-
    // delete, atomically inside the same commit as the content
    // patch. This closes the race where a 2nd PATCH (the old
    // deleteDocFields path) could wipe a concurrent worker's just-
    // written new receipt.
    const patchFields = encodePatch(patchParsed.data, receipt)
    patchFields.updatedBy = { stringValue: callerUid }
    // updatedAt is set via updateTransforms (REQUEST_TIME) below --
    // NOT in patchFields. Using CF Workers' Date.now() would
    // create drift with Firestore server clock that the settlement
    // engine's chronological replay assumes is monotonic.

    const updateMask = Object.keys(patchFields)
    if (receiptDeletion) updateMask.push('receipt')

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${req.expenseId}`),
      fields:          patchFields,
      updateMask,
      currentDocument: { exists: true },
      // Server-stamp updatedAt. createdAt is preserved (not in the
      // mask, no transform here -- Firestore leaves the existing
      // value intact for unchanged fields).
      updateTransforms: [
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    // intentMarkUsedWrites first so they commit atomically with the
    // expense patch -- mirrors the create path's invariant.
    return { writes: [...intentMarkUsedWrites, write], result: undefined }
  })

  return { ok: true }
}

/** Merge Firestore-stored fields with the validated patch into a
 *  flat object suitable for validateExpenseCrossField. Receipt is
 *  handled out-of-band (deletion sentinel + intent-built receipt are
 *  not part of the patch schema after 4c) so this function never
 *  sees a receipt field. */
function mergeExpense(
  current: Record<string, FsValue>,
  patch:   ReturnType<ReturnType<typeof makeExpenseUpdateSchema>['parse']>,
): {
  amount:   number
  currency: string
  paidBy:   string
  splits:   { memberId: string; amount: number }[]
  items?:   { amount: number; assignees: string[] }[]
} {
  const decoded = decodeExpense(current)
  return {
    amount:   patch.amount   ?? decoded.amount,
    currency: patch.currency ?? decoded.currency,
    paidBy:   patch.paidBy   ?? decoded.paidBy,
    splits:   patch.splits   ?? decoded.splits,
    items:    patch.items    ?? decoded.items,
  }
}

/** Decode the Firestore REST `fields` map back into the shape we
 *  need for cross-field validation. Only extracts what's checked. */
function decodeExpense(fields: Record<string, FsValue>): {
  amount:   number
  currency: string
  paidBy:   string
  splits:   { memberId: string; amount: number }[]
  items?:   { amount: number; assignees: string[] }[]
} {
  const amount = Number(fields.amount?.doubleValue ?? fields.amount?.integerValue ?? 0)
  const currency = readString(fields, 'currency') ?? ''
  const paidBy = readString(fields, 'paidBy') ?? ''
  const splitArr = (fields.splits as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const splits = splitArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      memberId: readString(inner, 'memberId') ?? '',
      amount:   Number(inner.amount?.doubleValue ?? inner.amount?.integerValue ?? 0),
    }
  })
  const itemArr = (fields.items as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const items = itemArr ? itemArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const aArr = (inner.assignees as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
    return {
      amount:    Number(inner.amount?.doubleValue ?? inner.amount?.integerValue ?? 0),
      assignees: aArr.map(a => a.stringValue ?? '').filter(s => s !== ''),
    }
  }) : undefined
  return { amount, currency, paidBy, splits, items }
}

/** Encode the validated patch fields back into Firestore REST shape.
 *  Only encodes fields PRESENT in the patch (partial update). Receipt
 *  is no longer part of the patch schema; the optional `receipt` arg
 *  (intent-built + validated) is encoded here so the field lands in
 *  the same commit as the rest of the patch. Receipt DELETION is
 *  expressed by the caller adding 'receipt' to the updateMask without
 *  a corresponding fields entry -- this function never receives the
 *  deletion sentinel. */
function encodePatch(
  patch:   ReturnType<ReturnType<typeof makeExpenseUpdateSchema>['parse']>,
  receipt?: ExpenseReceiptOut,
): Record<string, FsValue> {
  const out: Record<string, FsValue> = {}
  if (patch.title    !== undefined) out.title    = { stringValue: patch.title }
  if (patch.amount   !== undefined) out.amount   = { doubleValue: patch.amount }
  if (patch.currency !== undefined) out.currency = { stringValue: patch.currency }
  if (patch.category !== undefined) out.category = { stringValue: patch.category }
  if (patch.paidBy   !== undefined) out.paidBy   = { stringValue: patch.paidBy }
  if (patch.date     !== undefined) out.date     = { stringValue: patch.date }
  if (patch.note     !== undefined) out.note     = { stringValue: patch.note }
  if (patch.splits   !== undefined) {
    out.splits = {
      arrayValue: {
        values: patch.splits.map(s => ({
          mapValue: {
            fields: {
              memberId: { stringValue: s.memberId },
              amount:   { doubleValue: s.amount },
            },
          },
        })),
      },
    }
  }
  if (patch.items !== undefined) {
    out.items = {
      arrayValue: {
        values: patch.items.map(item => ({
          mapValue: {
            fields: {
              name:   { stringValue: item.name },
              amount: { doubleValue: item.amount },
              assignees: {
                arrayValue: { values: item.assignees.map(uid => ({ stringValue: uid })) },
              },
            },
          },
        })),
      },
    }
  }
  if (receipt) {
    const rfields: Record<string, FsValue> = {
      url:  { stringValue: receipt.url },
      path: { stringValue: receipt.path },
      type: { stringValue: receipt.type },
    }
    if (receipt.thumbUrl != null)  rfields.thumbUrl  = { stringValue: receipt.thumbUrl }
    if (receipt.thumbPath != null) rfields.thumbPath = { stringValue: receipt.thumbPath }
    out.receipt = { mapValue: { fields: rfields } }
  }
  return out
}
