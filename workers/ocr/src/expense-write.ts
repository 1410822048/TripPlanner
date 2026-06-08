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
  validateExpenseCrossField,
  type ExpenseReceiptOut,
}                                                                   from './expense-validate'
import { buildReceiptFromIntents, validateBuiltReceipt }         from './expense-receipt-write'
import { pushUnique, decodeExpense, type TripContext }              from './expense-write-shared'
import {
  prepareForeignCreate, buildForeignUpdateWrite,
  type ForeignArtifacts,
}                                                                   from './expense-foreign-write'
import {
  encodeSourceItems, encodeSourceAdjustments, encodeSourceSplits, encodeFxSnapshot,
}                                                                   from './expense-foreign-codec'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
  type TxUpdateWrite,
}                                                                   from './firestore-tx'
import { consumeEntityIntents }                                     from './upload-intent'

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

const ExpensePayloadModeSchema = z.enum(['TRIP_CURRENCY', 'FOREIGN_CURRENCY'])
type ExpensePayloadMode = z.infer<typeof ExpensePayloadModeSchema>

const SOURCE_EXPENSE_WIRE_KEYS = [
  'sourceCurrency',
  'sourceAmountMinor',
  'sourceItems',
  'sourceAdjustments',
  'sourceSplits',
] as const

// ─── Foreign-mode routing ─────────────────────────────────────────
//
// Create payloads must carry an explicit `mode`. This makes the
// submit-boundary DTO the single source of truth: stale source*
// form fields can no longer accidentally strip trip-currency fields
// on the client and then fall through to the trip schema on Worker.
//
// `mode: FOREIGN_CURRENCY` routes through the source-domain pipeline:
//   1. parse via `makeForeignExpenseCreateSchema` (.strict() rejects
//      any client attempt to also send trip-currency money fields)
//   2. cross-field gate: `sourceCurrency !== tripContext.currency`
//      (same-currency must use the trip path, not foreign)
//   3. resolve FX snapshot via `getFxSnapshot` (provider + cache)
//   4. run `convertAndMaterializeFromSource` to derive the
//      trip-currency `amountMinor / items / adjustments / splits`
//      authoritatively (per-line allocation guard against
//      attribution-corruption attacks)
//   5. persist BOTH the source-domain inputs AND the materialized
//      trip-currency outputs in the same tx commit; `fxSnapshot.
//      fetchedAt` is server-stamped via REQUEST_TIME
//
// Trip-currency (non-foreign) payloads continue to use the original
// `makeExpenseCreateSchema` path. Trip mode rejects any defined
// source* key so cancelled foreign UI state cannot produce a half
// foreign / half trip payload.

function assertPayloadRecord(
  body:  unknown,
  field: 'expense' | 'patch',
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ExpenseValidationError(field, `${field} must be an object`)
  }
  return body as Record<string, unknown>
}

function readExpensePayloadMode(
  body:  Record<string, unknown>,
  field: 'expense' | 'patch',
  opts:  { required: boolean },
): ExpensePayloadMode | undefined {
  const mode = body.mode
  if (mode === undefined) {
    if (opts.required) {
      throw new ExpenseValidationError(`${field}.mode`, 'mode is required')
    }
    return undefined
  }

  const result = ExpensePayloadModeSchema.safeParse(mode)
  if (!result.success) {
    throw new ExpenseValidationError(
      `${field}.mode`,
      'mode must be TRIP_CURRENCY or FOREIGN_CURRENCY',
    )
  }
  return result.data
}

function stripExpensePayloadMode(body: Record<string, unknown>): Record<string, unknown> {
  const { mode: _mode, ...rest } = body
  return rest
}

function hasDefinedOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
}

function assertNoSourceExpenseKeys(
  body:  Record<string, unknown>,
  field: 'expense' | 'patch',
): void {
  for (const key of SOURCE_EXPENSE_WIRE_KEYS) {
    if (hasDefinedOwn(body, key)) {
      throw new ExpenseValidationError(
        `${field}.${key}`,
        'source fields require mode=FOREIGN_CURRENCY',
      )
    }
  }
}

// ─── Authorization helpers ────────────────────────────────────────

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
  const ownerId = readString(trip.fields, 'ownerId')

  // Extract memberIds[] from the trip doc. Firestore REST shape:
  // { arrayValue: { values: [{ stringValue: '...' }, ...] } }
  const arr = (trip.fields.memberIds as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const memberIds = arr
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')
  if (memberIds.length === 0) {
    throw new CascadeError(500, 'trip.memberIds is empty')
  }
  // Trip currency is required for every trip created post-onboarding;
  // a missing value here is a data-integrity bug (e.g. raw admin write
  // bypassing the client onboarding flow) and we fail-closed rather
  // than silently let the caller pick the currency.
  const currency = readString(trip.fields, 'currency')
  if (!currency) {
    throw new CascadeError(500, 'trip.currency is missing')
  }
  return { memberIds, isOwner: ownerId === callerUid, currency }
}

export function expenseIsSettlementLocked(fields: Record<string, FsValue>): boolean {
  // Single source of truth: the settlementLockIds reference set. Each
  // settlement that applies to this expense adds its id on create and
  // removes it on delete, so a non-empty set ⇔ at least one live settlement
  // still references it. Replaces the old `settlementLockedAt`-presence
  // check PLUS the global `appliedExpenseIds ARRAY_CONTAINS` fallback — that
  // fallback existed because the old singular lock pointer could go stale
  // (delete never cleared it); the set is now maintained atomically on
  // BOTH create and delete, so the per-expense field alone is authoritative
  // and the trip-wide settlements scan is gone.
  const arr = (fields.settlementLockIds as { arrayValue?: { values?: unknown[] } } | undefined)?.arrayValue?.values
  return Array.isArray(arr) && arr.length > 0
}

function assertCanEditExpenseAfterSettlement(
  ctx:           TripContext,
  currentFields: Record<string, FsValue>,
): void {
  if (ctx.isOwner) return
  if (expenseIsSettlementLocked(currentFields)) {
    throw new CascadeError(403, 'only the trip owner may edit an expense after it has been settled')
  }
}

// ─── Firestore value encoders ─────────────────────────────────────

function encodeExpense(
  payload: ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']>,
  tripId:  string,
  memberIds: string[],
  createdBy: string,
  receipt?: ExpenseReceiptOut,
  foreign?: ForeignArtifacts,
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
    amountMinor:     { integerValue: String(payload.amountMinor) },
    currency:        { stringValue: payload.currency },
    category:        { stringValue: payload.category },
    paidBy:          { stringValue: payload.paidBy },
    splits:          {
      arrayValue: {
        values: payload.splits.map(s => ({
          mapValue: {
            fields: {
              memberId:    { stringValue: s.memberId },
              amountMinor: { integerValue: String(s.amountMinor) },
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
              id:          { stringValue: item.id },
              name:        { stringValue: item.name },
              amountMinor: { integerValue: String(item.amountMinor) },
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
  // Phase B: adjustments[] is REQUIRED on every persisted doc (empty
  // array when none). The Worker is the only writer for content
  // fields, so the encoded shape here is the canonical Firestore
  // representation that ExpenseDocSchema parses on read.
  fields.adjustments = {
    arrayValue: {
      values: payload.adjustments.map(adj => {
        const aFields: Record<string, FsValue> = {
          id:          { stringValue: adj.id },
          label:       { stringValue: adj.label },
          kind:        { stringValue: adj.kind },
          scope:       { stringValue: adj.scope },
          amountMinor: { integerValue: String(adj.amountMinor) },
        }
        if (adj.targetItemId !== undefined) {
          aFields.targetItemId = { stringValue: adj.targetItemId }
        }
        return { mapValue: { fields: aFields } }
      }),
    },
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
  // Phase 3b: source-domain mirror + fxSnapshot. fxSnapshot.fetchedAt
  // is intentionally written as null here and overridden by the caller's
  // REQUEST_TIME transform at commit time -- using Worker Date.now()
  // would drift relative to Firestore commit and break the chronological
  // replay invariant the settlement engine assumes.
  if (foreign) {
    fields.sourceCurrency    = { stringValue:  foreign.sourceCurrency }
    fields.sourceAmountMinor = { integerValue: String(foreign.sourceAmountMinor) }
    if (foreign.sourceSplits !== undefined) {
      fields.sourceSplits = encodeSourceSplits(foreign.sourceSplits)
    } else if (foreign.sourceItems !== undefined && foreign.sourceAdjustments !== undefined) {
      fields.sourceItems       = encodeSourceItems(foreign.sourceItems)
      fields.sourceAdjustments = encodeSourceAdjustments(foreign.sourceAdjustments)
    } else {
      throw new CascadeError(500, 'foreign artifacts missing source domain')
    }
    fields.fxSnapshot        = encodeFxSnapshot(foreign.fxSnapshot)
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
    const expenseBody = assertPayloadRecord(req.expense, 'expense')
    const expenseMode = readExpensePayloadMode(expenseBody, 'expense', { required: true })
    const expenseForSchema = stripExpensePayloadMode(expenseBody)

    const callerReceipt = expenseForSchema.receipt
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

    // Phase 3b: branch on the explicit submit DTO mode. Each branch
    // produces a (parsed trip-currency payload, optional foreign
    // artifacts) pair that the shared encode + write tail-end consumes.
    let parsed:  ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']>
    let foreign: ForeignArtifacts | undefined

    if (expenseMode === 'FOREIGN_CURRENCY') {
      const { parsedTrip, foreignArtifacts } = await prepareForeignCreate(
        expenseForSchema, ctx, serviceAccountJson,
      )
      parsed  = parsedTrip
      foreign = foreignArtifacts
    } else {
      assertNoSourceExpenseKeys(expenseForSchema, 'expense')
      const parseResult = makeExpenseCreateSchema().safeParse(expenseForSchema)
      if (!parseResult.success) {
        const issue = parseResult.error.issues[0]
        throw new ExpenseValidationError(issue.path.join('.'), issue.message)
      }
      // Bind expense currency to trip currency. Without this gate a raw
      // Worker caller could create a JPY-trip expense with currency:'USD'
      // and amountMinor encoded under USD-cent semantics; downstream
      // settlement / trip-total math assumes a single currency per trip
      // and would silently mix the two scales.
      if (parseResult.data.currency !== ctx.currency) {
        throw new ExpenseValidationError(
          'currency',
          `expense currency ${parseResult.data.currency} does not match trip currency ${ctx.currency}`,
        )
      }
      parsed = parseResult.data
    }

    // Cross-field validation is shared: paidBy ∈ memberIds, splits sum,
    // and (when items present) SPLIT_PREVIEW_DRIFT via the
    // materializer. On the foreign path the trip-currency payload was
    // built by the SAME materializer, so the drift check is trivially
    // satisfied -- but we still run it as defense-in-depth so any
    // mistake in the foreign branch surfaces with the standard
    // ExpenseValidationError path instead of a corrupt write.
    validateExpenseCrossField(parsed, ctx.memberIds)

    // Read the target doc inside the tx -- this lets us enforce
    // create-only semantics (no overwrite) at commit time via
    // the tx's optimistic-concurrency check. We also pin
    // `currentDocument.exists=false` as belt-and-suspenders.
    const existing = await tx.get(`trips/${req.tripId}/expenses/${req.expenseId}`)
    if (existing.exists) {
      throw new CascadeError(409, 'expense already exists at this id')
    }

    const fields = encodeExpense(parsed, req.tripId, ctx.memberIds, callerUid, receipt, foreign)

    const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
      // Server-stamp both audit timestamps to Firestore commit time.
      // See encodeExpense() comment for why CF Date.now() would
      // break settlement chronological replay.
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ]
    if (foreign) {
      // Phase 3b: server-stamp fxSnapshot.fetchedAt at commit time.
      // The field is written as null in encodeFxSnapshot so the parent
      // map exists for the nested transform to target; Firestore
      // applies the transform AFTER the field write within the same
      // Write, so the final stored value is REQUEST_TIME-stamped.
      updateTransforms.push({ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' })
    }

    const write: TxWrite = {
      document:         docResourceName(projectId, `trips/${req.tripId}/expenses/${req.expenseId}`),
      fields,
      currentDocument:  { exists: false },
      updateTransforms,
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

// ─── Endpoint: expense-update ─────────────────────────────────────

/**
 * Allowed patch fields. Anything else (tripId, createdBy, createdAt,
 * memberIds, deletedAt, receiptPurgedAt) is owner-of-rules / Worker-
 * elsewhere and rejected here.
 */
const UPDATABLE_FIELDS = new Set([
  'title', 'amountMinor', 'currency', 'category',
  'paidBy', 'splits', 'date', 'note', 'items', 'adjustments', 'receipt',
])

// Phase 3c update routing: the explicit patch.mode is the source of
// truth. TRIP_CURRENCY patches may not carry source/fx fields; when
// applied to an existing foreign doc they atomically delete the source
// mirror + fxSnapshot. FOREIGN_CURRENCY patches use the foreign schema
// and require a full source money group when switching from a trip doc.
const PATCH_FOREIGN_KEYS_REJECTED_ON_TRIP_DOC = [
  'sourceCurrency',
  'sourceAmountMinor',
  'sourceItems',
  'sourceAdjustments',
  'sourceSplits',
  'sourceFractionDigits',
  'fxSnapshot',
] as const

function assertNoForeignFieldsOnTripPatch(patch: Record<string, unknown>): void {
  for (const key of PATCH_FOREIGN_KEYS_REJECTED_ON_TRIP_DOC) {
    if (key in patch) {
      throw new ExpenseValidationError(
        `patch.${key}`,
        `UNSUPPORTED_FOREIGN_FIELD: ${key} is not allowed in TRIP_CURRENCY mode`,
      )
    }
  }
}

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
  // request validation, no retry value. UPDATABLE_FIELDS is only
  // checked for the trip-currency path (foreign-update schema's
  // `.strict()` is the equivalent gate for the foreign branch). The
  // branch itself is explicit patch.mode, not inferred from stray
  // source fields or current document shape.
  const patchBody = assertPayloadRecord(req.patch, 'patch')
  // Phase 3.5 legacy-cleanup: only two patch.receipt values are
  // accepted from the client -- `undefined` (no change) or `null`
  // (deletion sentinel). Any object value is rejected; new receipts
  // must come through intentIds. The deletion-vs-intentIds case is
  // still mutually exclusive because they're contradictory operations
  // (delete current vs. set new); the client picks one.
  const callerPatchReceipt = patchBody.receipt
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
  const receiptDeletion = patchBody.receipt === null
  // Strip `receipt` from the parseable body so a stray key from
  // future client-side bugs can't sneak in via Zod's default strip()
  // behavior (it would silently drop the field, but explicit removal
  // makes the contract obvious to readers).
  const patchForSchema = { ...patchBody }
  delete patchForSchema.receipt
  const patchMode = readExpensePayloadMode(patchForSchema, 'patch', { required: true })
  delete patchForSchema.mode
  if (patchMode === 'TRIP_CURRENCY') {
    assertNoSourceExpenseKeys(patchForSchema, 'patch')
  }

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeCanWriteTx(tx, req.tripId, callerUid)

    // Read current expense doc before consuming upload intents. A locked
    // settled-source reject must not mark a freshly-uploaded receipt
    // intent as used when no expense patch will be committed.
    const current = await tx.get(`trips/${req.tripId}/expenses/${req.expenseId}`)
    if (!current.exists) {
      throw new CascadeError(404, 'expense not found')
    }
    if ('deletedAt' in current.fields && (current.fields.deletedAt as { nullValue?: null; timestampValue?: string } | undefined)?.timestampValue) {
      throw new CascadeError(409, 'cannot edit a tombstoned expense')
    }
    assertCanEditExpenseAfterSettlement(ctx, current.fields)

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

    const currentSourceCurrency = readString(current.fields, 'sourceCurrency')
    const isCurrentForeign      = typeof currentSourceCurrency === 'string' && currentSourceCurrency.length > 0

    let write: TxWrite
    if (patchMode === 'FOREIGN_CURRENCY') {
      write = await buildForeignUpdateWrite({
        patchForSchema,
        receipt,
        receiptDeletion,
        currentFields:         current.fields,
        currentSourceCurrency: isCurrentForeign ? currentSourceCurrency : undefined,
        ctx,
        projectId,
        tripId:                req.tripId,
        expenseId:             req.expenseId,
        callerUid,
        serviceAccountJson,
      })
    } else {
      write = buildTripUpdateWrite({
        patchForSchema,
        receipt,
        receiptDeletion,
        currentFields: current.fields,
        deleteForeignFields: isCurrentForeign,
        ctx,
        projectId,
        tripId:        req.tripId,
        expenseId:     req.expenseId,
        callerUid,
      })
    }

    // intentMarkUsedWrites first so they commit atomically with the
    // expense patch -- mirrors the create path's invariant.
    return { writes: [...intentMarkUsedWrites, write], result: undefined }
  })

  return { ok: true }
}

/** Build the TxWrite for a TRIP_CURRENCY update. This path is also the
 *  canonical way to switch a foreign-currency expense back to the trip
 *  currency: source-domain mirror fields are deleted by listing them in
 *  the updateMask without writing corresponding field values. */
function buildTripUpdateWrite(args: {
  patchForSchema: Record<string, unknown>
  receipt:        ExpenseReceiptOut | undefined
  receiptDeletion: boolean
  currentFields: Record<string, FsValue>
  deleteForeignFields: boolean
  ctx:            TripContext
  projectId:      string
  tripId:         string
  expenseId:      string
  callerUid:      string
}): TxWrite {
  // TRIP_CURRENCY mode cannot accept source-domain input. When this
  // branch is applied to an existing foreign doc, the source mirror is
  // deleted below via updateMask-only field paths.
  assertNoForeignFieldsOnTripPatch(args.patchForSchema)
  for (const k of Object.keys(args.patchForSchema)) {
    if (!UPDATABLE_FIELDS.has(k)) {
      throw new ExpenseValidationError(k, 'field is not updatable via this endpoint')
    }
  }
  const patchParsed = makeExpenseUpdateSchema().safeParse(args.patchForSchema)
  if (!patchParsed.success) {
    const issue = patchParsed.error.issues[0]
    throw new ExpenseValidationError(issue.path.join('.'), issue.message)
  }

  const merged = mergeExpense(args.currentFields, patchParsed.data)
  // Same trip-currency bind as doCreate. Checking the merged value
  // (not patchParsed.data.currency directly) catches BOTH a raw
  // patch.currency divergence AND a pre-existing doc whose currency
  // somehow drifted from the trip (data-integrity guard for older
  // writes that pre-date this gate).
  if (merged.currency !== args.ctx.currency) {
    throw new ExpenseValidationError(
      'currency',
      `expense currency ${merged.currency} does not match trip currency ${args.ctx.currency}`,
    )
  }
  validateExpenseCrossField(merged, args.ctx.memberIds)

  // Build the update mask + field map. Receipt write happens via
  // the separate `receipt` arg (intent-built) or via deletion
  // sentinel (`receiptDeletion`). For deletion we list 'receipt'
  // in the updateMask WITHOUT a corresponding entry in `fields`
  // -- Firestore REST commit treats mask-but-no-field as field-
  // delete, atomically inside the same commit as the content
  // patch. This closes the race where a 2nd PATCH (the old
  // deleteDocFields path) could wipe a concurrent worker's just-
  // written new receipt.
  const patchFields = encodePatch(patchParsed.data, args.receipt)
  patchFields.updatedBy = { stringValue: args.callerUid }
  // updatedAt is set via updateTransforms (REQUEST_TIME) below --
  // NOT in patchFields. Using CF Workers' Date.now() would
  // create drift with Firestore server clock that the settlement
  // engine's chronological replay assumes is monotonic.

  const updateMask = Object.keys(patchFields)
  if (args.receiptDeletion) updateMask.push('receipt')
  if (args.deleteForeignFields) {
    pushUnique(updateMask, 'sourceCurrency')
    pushUnique(updateMask, 'sourceAmountMinor')
    pushUnique(updateMask, 'sourceItems')
    pushUnique(updateMask, 'sourceAdjustments')
    pushUnique(updateMask, 'sourceSplits')
    pushUnique(updateMask, 'fxSnapshot')
  }

  return {
    document:        docResourceName(args.projectId, `trips/${args.tripId}/expenses/${args.expenseId}`),
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
  amountMinor:  number
  currency:     string
  paidBy:       string
  splits:       { memberId: string; amountMinor: number }[]
  items?:       { id: string; amountMinor: number; assignees: string[] }[]
  adjustments?: { id: string; kind: string; scope: string; amountMinor: number; targetItemId?: string }[]
} {
  const decoded = decodeExpense(current)
  return {
    amountMinor: patch.amountMinor ?? decoded.amountMinor,
    currency:    patch.currency    ?? decoded.currency,
    paidBy:      patch.paidBy      ?? decoded.paidBy,
    splits:      patch.splits      ?? decoded.splits,
    items:       patch.items       ?? decoded.items,
    adjustments: patch.adjustments ?? decoded.adjustments,
  }
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
  if (patch.title       !== undefined) out.title       = { stringValue: patch.title }
  if (patch.amountMinor !== undefined) out.amountMinor = { integerValue: String(patch.amountMinor) }
  if (patch.currency    !== undefined) out.currency    = { stringValue: patch.currency }
  if (patch.category    !== undefined) out.category    = { stringValue: patch.category }
  if (patch.paidBy      !== undefined) out.paidBy      = { stringValue: patch.paidBy }
  if (patch.date        !== undefined) out.date        = { stringValue: patch.date }
  if (patch.note        !== undefined) out.note        = { stringValue: patch.note }
  if (patch.splits      !== undefined) {
    out.splits = {
      arrayValue: {
        values: patch.splits.map(s => ({
          mapValue: {
            fields: {
              memberId:    { stringValue: s.memberId },
              amountMinor: { integerValue: String(s.amountMinor) },
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
              id:          { stringValue: item.id },
              name:        { stringValue: item.name },
              amountMinor: { integerValue: String(item.amountMinor) },
              assignees: {
                arrayValue: { values: item.assignees.map(uid => ({ stringValue: uid })) },
              },
            },
          },
        })),
      },
    }
  }
  if (patch.adjustments !== undefined) {
    out.adjustments = {
      arrayValue: {
        values: patch.adjustments.map(adj => {
          const aFields: Record<string, FsValue> = {
            id:          { stringValue: adj.id },
            label:       { stringValue: adj.label },
            kind:        { stringValue: adj.kind },
            scope:       { stringValue: adj.scope },
            amountMinor: { integerValue: String(adj.amountMinor) },
          }
          if (adj.targetItemId !== undefined) {
            aFields.targetItemId = { stringValue: adj.targetItemId }
          }
          return { mapValue: { fields: aFields } }
        }),
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
