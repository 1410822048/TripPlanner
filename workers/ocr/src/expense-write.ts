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
import {
  convertAndMaterializeFromSource,
  convertSourceSplitsToTarget,
  MaterializeError,
  type MaterializeItem,
  type MaterializeAdjustment,
  type MaterializeErrorCode,
}                                                                   from '@tripmate/expense-materialize'
import { getAdminToken, getProjectId, invalidateAdminToken }        from './admin'
import {
  readString,
  type FsValue,
}                                                                   from './firestore'
import {
  ExpenseValidationError,
  makeExpenseCreateSchema,
  makeExpenseUpdateSchema,
  makeForeignExpenseCreateSchema,
  makeForeignExpenseUpdateSchema,
  makeReceiptSchema,
  validateExpenseCrossField,
  type ExpenseReceiptOut,
  type ExpenseForeignCreateInput,
}                                                                   from './expense-validate'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
  type TxUpdateWrite,
}                                                                   from './firestore-tx'
import {
  consumeEntityIntents,
  type ConsumedIntent,
}                                                                   from './upload-intent'
import {
  currencyFractionDigits,
  getFxSnapshot,
  type FxSnapshot,
}                                                                   from './fx-rate'

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

interface TripContext {
  memberIds:  string[]
  /** Trip-scoped ISO 4217 currency. Every expense in this trip MUST
   *  carry this currency; mixing currencies inside a single trip would
   *  silently corrupt settlement / trip-total math (those layers assume
   *  one currency per trip). The bind is enforced in doCreate / doUpdate
   *  against parsed.data.currency / merged.currency respectively. */
  currency:   string
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
  // Trip currency is required for every trip created post-onboarding;
  // a missing value here is a data-integrity bug (e.g. raw admin write
  // bypassing the client onboarding flow) and we fail-closed rather
  // than silently let the caller pick the currency.
  const currency = readString(trip.fields, 'currency')
  if (!currency) {
    throw new CascadeError(500, 'trip.currency is missing')
  }
  return { memberIds, currency }
}

// ─── Firestore value encoders ─────────────────────────────────────

/** Carries the source-domain artifacts that Phase 3b persists alongside
 *  the trip-currency canonical fields. Only present on foreign-mode
 *  create writes. `fxSnapshot.fetchedAt` is encoded as null in the map
 *  and stamped at commit time via REQUEST_TIME updateTransforms (mirror
 *  of `createdAt` / `updatedAt`). */
export interface ForeignArtifacts {
  sourceCurrency:    string
  sourceAmountMinor: number
  sourceItems?:       ExpenseForeignCreateInput['sourceItems']
  sourceAdjustments?: ExpenseForeignCreateInput['sourceAdjustments']
  sourceSplits?:      ExpenseForeignCreateInput['sourceSplits']
  fxSnapshot:        FxSnapshot
}

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

function encodeSourceItems(
  src: NonNullable<ExpenseForeignCreateInput['sourceItems']>,
): FsValue {
  return {
    arrayValue: {
      values: src.map(item => ({
        mapValue: {
          fields: {
            id:                { stringValue:  item.id },
            name:              { stringValue:  item.name },
            sourceAmountMinor: { integerValue: String(item.sourceAmountMinor) },
            assignees: {
              arrayValue: { values: item.assignees.map(uid => ({ stringValue: uid })) },
            },
          },
        },
      })),
    },
  }
}

function encodeSourceAdjustments(
  src: NonNullable<ExpenseForeignCreateInput['sourceAdjustments']>,
): FsValue {
  return {
    arrayValue: {
      values: src.map(adj => {
        const aFields: Record<string, FsValue> = {
          id:                { stringValue:  adj.id },
          label:             { stringValue:  adj.label },
          kind:              { stringValue:  adj.kind },
          scope:             { stringValue:  adj.scope },
          sourceAmountMinor: { integerValue: String(adj.sourceAmountMinor) },
        }
        if (adj.targetItemId !== undefined) {
          aFields.targetItemId = { stringValue: adj.targetItemId }
        }
        return { mapValue: { fields: aFields } }
      }),
    },
  }
}

function encodeSourceSplits(
  src: NonNullable<ExpenseForeignCreateInput['sourceSplits']>,
): FsValue {
  return {
    arrayValue: {
      values: src.map(split => ({
        mapValue: {
          fields: {
            memberId:          { stringValue:  split.memberId },
            sourceAmountMinor: { integerValue: String(split.sourceAmountMinor) },
          },
        },
      })),
    },
  }
}

/** Encode FxSnapshot as a Firestore map. `fetchedAt` is set to null
 *  here -- the caller adds an `updateTransforms` entry pinned to
 *  REQUEST_TIME so Firestore stamps the field at commit. Writing both
 *  is intentional: the field MUST appear in the map so the create
 *  Write's `currentDocument.exists=false` doesn't reject the transform
 *  as targeting a missing parent. */
function encodeFxSnapshot(fx: FxSnapshot): FsValue {
  return {
    mapValue: {
      fields: {
        provider:             { stringValue:  fx.provider },
        baseCurrency:         { stringValue:  fx.baseCurrency },
        quoteCurrency:        { stringValue:  fx.quoteCurrency },
        requestedDate:        { stringValue:  fx.requestedDate },
        rateDate:             { stringValue:  fx.rateDate },
        rateDecimal:          { stringValue:  fx.rateDecimal },
        sourceAmountMinor:    { integerValue: String(fx.sourceAmountMinor) },
        convertedAmountMinor: { integerValue: String(fx.convertedAmountMinor) },
        fetchedAt:            { nullValue:    null },
      },
    },
  }
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

/** Map a `MaterializeError.code` (raised by
 *  `convertAndMaterializeFromSource` on bad source-domain inputs) to the
 *  source-side field path the foreign create/update Worker handlers
 *  surface in their `ExpenseValidationError`. Kept as a single source
 *  of truth so create + update produce identical field hints for the
 *  same underlying materializer failure. */
function mapMaterializeErrorField(code: MaterializeErrorCode): string {
  switch (code) {
    case 'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER':
    case 'SOURCE_SUM_MISMATCH':
      return 'sourceAmountMinor'
    case 'SOURCE_SPLITS_EMPTY':
    case 'SOURCE_SPLIT_MEMBER_MISSING':
    case 'SOURCE_SPLIT_NOT_NONNEGATIVE_INTEGER':
    case 'DUPLICATE_SOURCE_SPLIT_MEMBER':
    case 'SOURCE_SPLIT_SUM_MISMATCH':
      return 'sourceSplits'
    case 'SOURCE_ADJUSTMENT_NOT_POSITIVE_INTEGER':
      return 'sourceAdjustments'
    case 'SOURCE_ITEM_NOT_POSITIVE_INTEGER':
    case 'NON_MEMBER_ASSIGNEE':
    case 'DUPLICATE_ITEM_ID':
    case 'DUPLICATE_ITEM_ASSIGNEE':
    case 'ITEM_NOT_POSITIVE_INTEGER':
    case 'OVER_DISCOUNT_ITEM':
      return 'sourceItems'
    default:
      // Catch-all for shape errors the materializer can raise from the
      // converted trip-currency inputs (ITEM_NO_ASSIGNEES, UNKNOWN_SCOPE,
      // ITEM_SCOPE_NO_TARGET, EXPENSE_SCOPE_HAS_TARGET, TARGET_ITEM_NOT_
      // FOUND, OVER_DISCOUNT_EXPENSE, ADJUSTMENT_UNKNOWN_KIND,
      // ADJUSTMENT_NOT_POSITIVE_INTEGER, EXPENSE_SCOPE_NO_WEIGHT). All
      // are line-shape problems on the source side because the trip
      // counterparts are derived from source by zip.
      return 'sourceItems'
  }
}

/** Resolve a foreign-currency create payload into the shape the shared
 *  encode/write tail expects: a trip-currency `parsed` (matching
 *  `ExpenseCreateInput`) plus the source-domain artifacts that get
 *  persisted alongside.
 *
 *  Steps:
 *    1. Zod parse via `makeForeignExpenseCreateSchema` -- strict() so
 *       any trip-currency money key in the body is a loud rejection
 *       rather than a silent strip (the Worker is the authority).
 *    2. Cross-field: sourceCurrency MUST differ from trip currency.
 *       Same-currency clients must use the trip path (no FX snapshot
 *       to persist, would corrupt the audit trail with provider==null).
 *    3. Resolve the FxSnapshot via getFxSnapshot (cache or provider).
 *    4. Run convertAndMaterializeFromSource to derive the trip-domain
 *       items / adjustments / splits / amountMinor authoritatively.
 *       The materializer's per-line allocation is the financial-
 *       attribution boundary -- the Worker, not the client, decides
 *       who owes what for each receipt line.
 *    5. Zip the materializer's id-keyed outputs with the source-domain
 *       `name` / `label` strings to rebuild the trip-currency
 *       items[] / adjustments[] shape the encoder + cross-field
 *       validator expect. */
async function prepareForeignCreate(
  body:               unknown,
  ctx:                TripContext,
  serviceAccountJson: string,
): Promise<{
  parsedTrip:       ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']>
  foreignArtifacts: ForeignArtifacts
}> {
  const fParseResult = makeForeignExpenseCreateSchema().safeParse(body)
  if (!fParseResult.success) {
    const issue = fParseResult.error.issues[0]
    throw new ExpenseValidationError(issue.path.join('.'), issue.message)
  }
  const fp = fParseResult.data

  if (fp.sourceCurrency === ctx.currency) {
    // Same-currency foreign path is meaningless: no rate, no snapshot
    // to persist, and a degenerate FxSnapshot with provider==null
    // would confuse the audit trail. The client should send a
    // trip-currency body instead.
    throw new ExpenseValidationError(
      'sourceCurrency',
      `sourceCurrency ${fp.sourceCurrency} equals trip currency; use the trip-currency expense path instead`,
    )
  }

  const sourceFractionDigits = currencyFractionDigits(fp.sourceCurrency)
  const targetFractionDigits = currencyFractionDigits(ctx.currency)

  const snapshot = await getFxSnapshot(
    {
      requestedDate:     fp.date,
      sourceCurrency:    fp.sourceCurrency,
      tripCurrency:      ctx.currency,
      sourceAmountMinor: fp.sourceAmountMinor,
      sourceFractionDigits,
      targetFractionDigits,
    },
    serviceAccountJson,
  )
  if (!snapshot) {
    // Defensive: getFxSnapshot returns null only when source === trip,
    // which we explicitly rejected above. Reaching here means a logic
    // drift; fail closed rather than persist a partial doc.
    throw new CascadeError(500, 'unexpected null FxSnapshot for foreign expense (source !== trip)')
  }

  if (fp.sourceSplits !== undefined) {
    let converted: ReturnType<typeof convertSourceSplitsToTarget>
    try {
      converted = convertSourceSplitsToTarget({
        sourceSplits: fp.sourceSplits.map(split => ({
          memberId:    split.memberId,
          amountMinor: split.sourceAmountMinor,
        })),
        sourceAmountMinor: fp.sourceAmountMinor,
        rateDecimal:       snapshot.rateDecimal,
        sourceFractionDigits,
        targetFractionDigits,
      })
    } catch (e) {
      if (e instanceof MaterializeError) {
        throw new ExpenseValidationError(
          mapMaterializeErrorField(e.code),
          `${e.code}: ${e.message}`,
        )
      }
      throw e
    }

    return {
      parsedTrip: {
        title:       fp.title,
        amountMinor: converted.amountMinor,
        currency:    ctx.currency,
        category:    fp.category,
        paidBy:      fp.paidBy,
        splits:      converted.splits,
        date:        fp.date,
        items:       [],
        adjustments: [],
        ...(fp.note !== undefined ? { note: fp.note } : {}),
      },
      foreignArtifacts: {
        sourceCurrency:    fp.sourceCurrency,
        sourceAmountMinor: fp.sourceAmountMinor,
        sourceSplits:      fp.sourceSplits,
        fxSnapshot:        snapshot,
      },
    }
  }

  const sourceItems       = fp.sourceItems
  const sourceAdjustments = fp.sourceAdjustments
  if (!sourceItems || !sourceAdjustments) {
    throw new CascadeError(500, 'foreign create source-domain invariant violated post-parse')
  }

  let materialized: ReturnType<typeof convertAndMaterializeFromSource>
  try {
    materialized = convertAndMaterializeFromSource({
      sourceItems: sourceItems.map(i => ({
        id:          i.id,
        amountMinor: i.sourceAmountMinor,
        assignees:   i.assignees,
      })),
      sourceAdjustments: sourceAdjustments.map(a => ({
        id:           a.id,
        kind:         a.kind,
        scope:        a.scope,
        amountMinor:  a.sourceAmountMinor,
        targetItemId: a.targetItemId,
      })),
      sourceAmountMinor: fp.sourceAmountMinor,
      rateDecimal:       snapshot.rateDecimal,
      sourceFractionDigits,
      targetFractionDigits,
      members:           ctx.memberIds,
    })
  } catch (e) {
    if (e instanceof MaterializeError) {
      // Map materializer codes onto ExpenseValidationError so the
      // operator sees a single error class. The structured `code` is
      // preserved in the message for telemetry / Sentry grouping.
      throw new ExpenseValidationError(
        mapMaterializeErrorField(e.code),
        `${e.code}: ${e.message}`,
      )
    }
    throw e
  }

  // Zip materializer output (id-keyed) with source-side names/labels
  // to rebuild the trip-currency items[] / adjustments[] shape the
  // encoder + cross-field validator expect. The materializer guarantees
  // its output preserves source order, so positional zip is safe.
  const tripItems = materialized.items.map((mi: MaterializeItem, i: number) => {
    const src = sourceItems[i]!
    return {
      id:          mi.id,
      name:        src.name,
      amountMinor: mi.amountMinor,
      assignees:   mi.assignees,
    }
  })
  const tripAdjustments = materialized.adjustments.map((ma: MaterializeAdjustment, i: number) => {
    const src = sourceAdjustments[i]!
    const out: {
      id:            string
      label:         string
      kind:          MaterializeAdjustment['kind']
      scope:         MaterializeAdjustment['scope']
      amountMinor:   number
      targetItemId?: string
    } = {
      id:          ma.id,
      label:       src.label,
      kind:        ma.kind,
      scope:       ma.scope,
      amountMinor: ma.amountMinor,
    }
    if (ma.targetItemId !== undefined) out.targetItemId = ma.targetItemId
    return out
  })

  const parsedTrip: ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']> = {
    title:       fp.title,
    amountMinor: materialized.amountMinor,
    currency:    ctx.currency,
    category:    fp.category,
    paidBy:      fp.paidBy,
    splits:      materialized.splits,
    date:        fp.date,
    items:       tripItems,
    adjustments: tripAdjustments,
    ...(fp.note !== undefined ? { note: fp.note } : {}),
  }
  const foreignArtifacts: ForeignArtifacts = {
    sourceCurrency:    fp.sourceCurrency,
    sourceAmountMinor: fp.sourceAmountMinor,
    sourceItems,
    sourceAdjustments,
    fxSnapshot:        snapshot,
  }
  return { parsedTrip, foreignArtifacts }
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

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v)
}

/** Read an integer field encoded as Firestore REST's `{ integerValue: '<digits>' }`.
 *  Returns undefined when absent (not when zero -- distinguish via the
 *  caller's defensive check). */
function readIntegerField(fields: Record<string, FsValue>, key: string): number | undefined {
  const v = (fields[key] as { integerValue?: string } | undefined)?.integerValue
  return v !== undefined ? Number(v) : undefined
}

interface DecodedSourceItem {
  id:                string
  name:              string
  sourceAmountMinor: number
  assignees:         string[]
}

interface DecodedSourceAdjustment {
  id:                string
  label:             string
  kind:              MaterializeAdjustment['kind']
  scope:             MaterializeAdjustment['scope']
  sourceAmountMinor: number
  targetItemId?:     string
}

interface DecodedSourceSplit {
  memberId:          string
  sourceAmountMinor: number
}

/** Decode the persisted `sourceItems` array from Firestore REST shape
 *  into the source-domain item structs the materializer + name-zip
 *  expect. Returns undefined when the field is absent (legitimate for
 *  trip-currency docs; caller branches on foreign-ness BEFORE invoking
 *  this so undefined here would indicate a corrupt foreign doc). */
function decodeSourceItemsField(
  fields: Record<string, FsValue>,
): DecodedSourceItem[] | undefined {
  const arr = (fields.sourceItems as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  if (!arr) return undefined
  return arr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const aArr = (inner.assignees as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
    return {
      id:                readString(inner, 'id')   ?? '',
      name:              readString(inner, 'name') ?? '',
      sourceAmountMinor: Number((inner.sourceAmountMinor as { integerValue?: string } | undefined)?.integerValue ?? 0),
      assignees:         aArr
        .map(a => (a as { stringValue?: string }).stringValue ?? '')
        .filter(s => s !== ''),
    }
  })
}

function decodeSourceAdjustmentsField(
  fields: Record<string, FsValue>,
): DecodedSourceAdjustment[] | undefined {
  const arr = (fields.sourceAdjustments as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  if (!arr) return undefined
  return arr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const targetItemId = readString(inner, 'targetItemId')
    const out: DecodedSourceAdjustment = {
      id:                readString(inner, 'id')    ?? '',
      label:             readString(inner, 'label') ?? '',
      kind:              (readString(inner, 'kind')  ?? '') as MaterializeAdjustment['kind'],
      scope:             (readString(inner, 'scope') ?? '') as MaterializeAdjustment['scope'],
      sourceAmountMinor: Number((inner.sourceAmountMinor as { integerValue?: string } | undefined)?.integerValue ?? 0),
    }
    if (targetItemId !== undefined) out.targetItemId = targetItemId
    return out
  })
}

function decodeSourceSplitsField(
  fields: Record<string, FsValue>,
): DecodedSourceSplit[] | undefined {
  const arr = (fields.sourceSplits as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  if (!arr) return undefined
  return arr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      memberId:          readString(inner, 'memberId') ?? '',
      sourceAmountMinor: Number((inner.sourceAmountMinor as { integerValue?: string } | undefined)?.integerValue ?? 0),
    }
  })
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

    // Read current expense doc INSIDE the tx so commit-time
    // conflict check catches concurrent soft-delete / restore /
    // tombstone-flip between our read and our write. Pre-tx the
    // window between read and write let an editor land content
    // patches onto an already-tombstoned doc (Admin bypasses the
    // rules-layer tombstone freeze). It also tells us whether a
    // TRIP_CURRENCY patch must delete an existing source mirror.
    const current = await tx.get(`trips/${req.tripId}/expenses/${req.expenseId}`)
    if (!current.exists) {
      throw new CascadeError(404, 'expense not found')
    }
    if ('deletedAt' in current.fields && (current.fields.deletedAt as { nullValue?: null; timestampValue?: string } | undefined)?.timestampValue) {
      throw new CascadeError(409, 'cannot edit a tombstoned expense')
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

/** Build the TxWrite for a foreign-currency update.
 *
 *  Three sub-modes (drives the recompute path + which fields end up in
 *  the update mask):
 *    - **text-only** (no source money group, no date): patch only
 *      title/category/paidBy/note/receipt. Just write the patched
 *      fields; trip-currency money + fxSnapshot are preserved.
 *    - **date-only** (`fp.date` present, no money group): re-fetch FX
 *      for the new date using the doc's persisted source mirror
 *      (either sourceItems+sourceAdjustments OR sourceSplits),
 *      re-materialize. Overwrites amountMinor/items/adjustments/
 *      splits/fxSnapshot and re-writes the active source mirror
 *      (unchanged values, but stays consistent with the "any recompute
 *      rewrites the whole source mirror" invariant).
 *    - **money-group** (any of the source-money fields present →
 *      schema all-or-none requires sourceCurrency + sourceAmountMinor
 *      + exactly one source domain; optionally with date or text).
 *      Validate sourceCurrency !== trip currency, re-fetch FX,
 *      re-materialize from the patched source-domain inputs. Overwrites
 *      everything trip-currency + fxSnapshot.
 *
 *  Persistence invariant: source-domain fields (sourceCurrency,
 *  sourceAmountMinor, and exactly one of sourceItems+sourceAdjustments
 *  or sourceSplits) and the trip-currency canonical fields
 *  (amountMinor, currency, items, adjustments, splits, fxSnapshot) are
 *  ALL rewritten together when any recompute happens. Switching into
 *  trip currency is handled by the TRIP_CURRENCY branch, which deletes
 *  the source mirror. */
async function buildForeignUpdateWrite(args: {
  patchForSchema:        Record<string, unknown>
  receipt:               ExpenseReceiptOut | undefined
  receiptDeletion:       boolean
  currentFields:         Record<string, FsValue>
  currentSourceCurrency: string | undefined
  ctx:                   TripContext
  projectId:             string
  tripId:                string
  expenseId:             string
  callerUid:             string
  serviceAccountJson:    string
}): Promise<TxWrite> {
  const fParseResult = makeForeignExpenseUpdateSchema().safeParse(args.patchForSchema)
  if (!fParseResult.success) {
    const issue = fParseResult.error.issues[0]
    throw new ExpenseValidationError(issue.path.join('.'), issue.message)
  }
  const fp = fParseResult.data

  // The foreign-update schema's superRefine guarantees source-money
  // fields are present all-or-none and exactly one source domain is
  // active; this assertion documents that assumption so a future
  // refactor that relaxes the schema gets caught at the boundary
  // instead of producing a half-recomputed doc.
  const hasLineDomainPatch  = fp.sourceItems !== undefined || fp.sourceAdjustments !== undefined
  const hasSplitDomainPatch = fp.sourceSplits !== undefined
  const hasMoneyGroup =
    fp.sourceCurrency    !== undefined ||
    fp.sourceAmountMinor !== undefined ||
    hasLineDomainPatch ||
    hasSplitDomainPatch
  if (hasMoneyGroup) {
    const hasCompleteLineDomain = fp.sourceItems !== undefined && fp.sourceAdjustments !== undefined
    if (
      fp.sourceCurrency    === undefined ||
      fp.sourceAmountMinor === undefined ||
      hasLineDomainPatch === hasSplitDomainPatch ||
      (hasLineDomainPatch && !hasCompleteLineDomain)
    ) {
      throw new CascadeError(500, 'source-money group all-or-none invariant violated post-parse')
    }
  }
  const hasDate         = fp.date !== undefined
  const needsRecompute  = hasMoneyGroup || hasDate
  if (args.currentSourceCurrency === undefined && !hasMoneyGroup) {
    throw new ExpenseValidationError(
      'patch.sourceCurrency',
      'FOREIGN_CURRENCY update requires sourceCurrency, sourceAmountMinor, and exactly one source domain (sourceItems+sourceAdjustments OR sourceSplits) when the current expense is trip-currency',
    )
  }

  const patchFields: Record<string, FsValue> = {}
  const updateMask:  string[]                = []
  let fxSnapshotWritten = false

  if (needsRecompute) {
    const effectiveSourceCurrency = fp.sourceCurrency ?? args.currentSourceCurrency
    if (effectiveSourceCurrency === undefined) {
      throw new CascadeError(500, 'foreign update sourceCurrency invariant violated post-parse')
    }
    // Same-currency sourceCurrency must use the TRIP_CURRENCY branch.
    // FOREIGN_CURRENCY always means "persist a real FX snapshot".
    if (effectiveSourceCurrency === args.ctx.currency) {
      throw new ExpenseValidationError(
        'patch.sourceCurrency',
        `sourceCurrency ${effectiveSourceCurrency} equals trip currency; use TRIP_CURRENCY mode instead`,
      )
    }

    const currentDate = readString(args.currentFields, 'date')
    if (!currentDate) {
      throw new CascadeError(500, 'current foreign expense doc missing date')
    }
    const effectiveDate = fp.date ?? currentDate

    const currentSourceAmountMinor = readIntegerField(args.currentFields, 'sourceAmountMinor')
    const currentSourceItems       = decodeSourceItemsField(args.currentFields)
    const currentSourceAdjustments = decodeSourceAdjustmentsField(args.currentFields)
    const currentSourceSplits      = decodeSourceSplitsField(args.currentFields)

    const effectiveSourceAmountMinor = fp.sourceAmountMinor ?? currentSourceAmountMinor
    if (effectiveSourceAmountMinor === undefined) {
      throw new CascadeError(500, 'current foreign expense doc missing sourceAmountMinor')
    }

    const sourceFractionDigits = currencyFractionDigits(effectiveSourceCurrency)
    const targetFractionDigits = currencyFractionDigits(args.ctx.currency)

    const snapshot = await getFxSnapshot(
      {
        requestedDate:     effectiveDate,
        sourceCurrency:    effectiveSourceCurrency,
        tripCurrency:      args.ctx.currency,
        sourceAmountMinor: effectiveSourceAmountMinor,
        sourceFractionDigits,
        targetFractionDigits,
      },
      args.serviceAccountJson,
    )
    if (!snapshot) {
      throw new CascadeError(500, 'unexpected null FxSnapshot for foreign expense (source !== trip)')
    }

    const useSplitDomain =
      hasSplitDomainPatch ||
      (!hasLineDomainPatch && currentSourceSplits !== undefined)

    if (useSplitDomain) {
      const effectiveSourceSplits = fp.sourceSplits ?? currentSourceSplits
      if (!effectiveSourceSplits || effectiveSourceSplits.length === 0) {
        throw new CascadeError(500, 'current foreign expense doc missing sourceSplits')
      }

      let converted: ReturnType<typeof convertSourceSplitsToTarget>
      try {
        converted = convertSourceSplitsToTarget({
          sourceSplits: effectiveSourceSplits.map(split => ({
            memberId:    split.memberId,
            amountMinor: split.sourceAmountMinor,
          })),
          sourceAmountMinor: effectiveSourceAmountMinor,
          rateDecimal:       snapshot.rateDecimal,
          sourceFractionDigits,
          targetFractionDigits,
        })
      } catch (e) {
        if (e instanceof MaterializeError) {
          throw new ExpenseValidationError(
            mapMaterializeErrorField(e.code),
            `${e.code}: ${e.message}`,
          )
        }
        throw e
      }

      validateExpenseCrossField(
        {
          amountMinor: converted.amountMinor,
          currency:    args.ctx.currency,
          paidBy:      fp.paidBy ?? readString(args.currentFields, 'paidBy') ?? '',
          splits:      converted.splits,
          items:       [],
          adjustments: [],
        },
        args.ctx.memberIds,
      )

      patchFields.amountMinor = { integerValue: String(converted.amountMinor) }
      patchFields.currency    = { stringValue:  args.ctx.currency }
      patchFields.splits      = {
        arrayValue: {
          values: converted.splits.map(s => ({
            mapValue: {
              fields: {
                memberId:    { stringValue:  s.memberId },
                amountMinor: { integerValue: String(s.amountMinor) },
              },
            },
          })),
        },
      }
      patchFields.items       = { arrayValue: { values: [] } }
      patchFields.adjustments = { arrayValue: { values: [] } }

      patchFields.sourceCurrency    = { stringValue:  effectiveSourceCurrency }
      patchFields.sourceAmountMinor = { integerValue: String(effectiveSourceAmountMinor) }
      patchFields.sourceSplits      = encodeSourceSplits(effectiveSourceSplits)

      // Delete the line-domain source mirror if this expense is being
      // recomputed in manual-total split-domain mode.
      pushUnique(updateMask, 'sourceItems')
      pushUnique(updateMask, 'sourceAdjustments')
    } else {
      // Effective sources must be present for any line-domain
      // recompute. A foreign doc with a partial line source mirror is
      // data corruption, so fail loudly instead of materializing an
      // empty receipt.
      const effectiveSourceItems       = fp.sourceItems       ?? currentSourceItems
      const effectiveSourceAdjustments = fp.sourceAdjustments ?? currentSourceAdjustments
      if (!effectiveSourceItems || effectiveSourceItems.length === 0) {
        throw new CascadeError(500, 'current foreign expense doc missing sourceItems')
      }
      if (!effectiveSourceAdjustments) {
        throw new CascadeError(500, 'current foreign expense doc missing sourceAdjustments')
      }

      let materialized: ReturnType<typeof convertAndMaterializeFromSource>
      try {
        materialized = convertAndMaterializeFromSource({
          sourceItems: effectiveSourceItems.map(i => ({
            id:          i.id,
            amountMinor: i.sourceAmountMinor,
            assignees:   i.assignees,
          })),
          sourceAdjustments: effectiveSourceAdjustments.map(a => {
            const out: {
              id:            string
              kind:          MaterializeAdjustment['kind']
              scope:         MaterializeAdjustment['scope']
              amountMinor:   number
              targetItemId?: string
            } = {
              id:          a.id,
              kind:        a.kind,
              scope:       a.scope,
              amountMinor: a.sourceAmountMinor,
            }
            if (a.targetItemId !== undefined) out.targetItemId = a.targetItemId
            return out
          }),
          sourceAmountMinor: effectiveSourceAmountMinor,
          rateDecimal:       snapshot.rateDecimal,
          sourceFractionDigits,
          targetFractionDigits,
          members:           args.ctx.memberIds,
        })
      } catch (e) {
        if (e instanceof MaterializeError) {
          throw new ExpenseValidationError(
            mapMaterializeErrorField(e.code),
            `${e.code}: ${e.message}`,
          )
        }
        throw e
      }

      // Zip materializer output (id-keyed) with source-side names/labels
      // by positional index -- materializer preserves source order.
      const tripItems = materialized.items.map((mi: MaterializeItem, i: number) => ({
        id:          mi.id,
        name:        effectiveSourceItems[i]!.name,
        amountMinor: mi.amountMinor,
        assignees:   mi.assignees,
      }))
      const tripAdjustments = materialized.adjustments.map((ma: MaterializeAdjustment, i: number) => {
        const src = effectiveSourceAdjustments[i]!
        const out: {
          id:            string
          label:         string
          kind:          MaterializeAdjustment['kind']
          scope:         MaterializeAdjustment['scope']
          amountMinor:   number
          targetItemId?: string
        } = {
          id:          ma.id,
          label:       src.label,
          kind:        ma.kind,
          scope:       ma.scope,
          amountMinor: ma.amountMinor,
        }
        if (ma.targetItemId !== undefined) out.targetItemId = ma.targetItemId
        return out
      })

      validateExpenseCrossField(
        {
          amountMinor: materialized.amountMinor,
          currency:    args.ctx.currency,
          paidBy:      fp.paidBy ?? readString(args.currentFields, 'paidBy') ?? '',
          splits:      materialized.splits,
          items:       tripItems,
          adjustments: tripAdjustments,
        },
        args.ctx.memberIds,
      )

      patchFields.amountMinor = { integerValue: String(materialized.amountMinor) }
      patchFields.currency    = { stringValue:  args.ctx.currency }
      patchFields.splits      = {
        arrayValue: {
          values: materialized.splits.map(s => ({
            mapValue: {
              fields: {
                memberId:    { stringValue:  s.memberId },
                amountMinor: { integerValue: String(s.amountMinor) },
              },
            },
          })),
        },
      }
      patchFields.items = {
        arrayValue: {
          values: tripItems.map(item => ({
            mapValue: {
              fields: {
                id:          { stringValue:  item.id },
                name:        { stringValue:  item.name },
                amountMinor: { integerValue: String(item.amountMinor) },
                assignees: {
                  arrayValue: { values: item.assignees.map(uid => ({ stringValue: uid })) },
                },
              },
            },
          })),
        },
      }
      patchFields.adjustments = {
        arrayValue: {
          values: tripAdjustments.map(adj => {
            const aFields: Record<string, FsValue> = {
              id:          { stringValue:  adj.id },
              label:       { stringValue:  adj.label },
              kind:        { stringValue:  adj.kind },
              scope:       { stringValue:  adj.scope },
              amountMinor: { integerValue: String(adj.amountMinor) },
            }
            if (adj.targetItemId !== undefined) {
              aFields.targetItemId = { stringValue: adj.targetItemId }
            }
            return { mapValue: { fields: aFields } }
          }),
        },
      }

      patchFields.sourceCurrency    = { stringValue:  effectiveSourceCurrency }
      patchFields.sourceAmountMinor = { integerValue: String(effectiveSourceAmountMinor) }
      patchFields.sourceItems       = {
        arrayValue: {
          values: effectiveSourceItems.map(item => ({
            mapValue: {
              fields: {
                id:                { stringValue:  item.id },
                name:              { stringValue:  item.name },
                sourceAmountMinor: { integerValue: String(item.sourceAmountMinor) },
                assignees: {
                  arrayValue: { values: item.assignees.map(uid => ({ stringValue: uid })) },
                },
              },
            },
          })),
        },
      }
      patchFields.sourceAdjustments = {
        arrayValue: {
          values: effectiveSourceAdjustments.map(adj => {
            const aFields: Record<string, FsValue> = {
              id:                { stringValue:  adj.id },
              label:             { stringValue:  adj.label },
              kind:              { stringValue:  adj.kind },
              scope:             { stringValue:  adj.scope },
              sourceAmountMinor: { integerValue: String(adj.sourceAmountMinor) },
            }
            if (adj.targetItemId !== undefined) {
              aFields.targetItemId = { stringValue: adj.targetItemId }
            }
            return { mapValue: { fields: aFields } }
          }),
        },
      }

      // Delete the split-domain source mirror if this expense is being
      // recomputed in line-domain mode.
      pushUnique(updateMask, 'sourceSplits')
    }

    patchFields.fxSnapshot = encodeFxSnapshot(snapshot)
    fxSnapshotWritten      = true

    pushUnique(updateMask, 'amountMinor')
    pushUnique(updateMask, 'currency')
    pushUnique(updateMask, 'splits')
    pushUnique(updateMask, 'items')
    pushUnique(updateMask, 'adjustments')
    pushUnique(updateMask, 'sourceCurrency')
    pushUnique(updateMask, 'sourceAmountMinor')
    pushUnique(updateMask, 'sourceItems')
    pushUnique(updateMask, 'sourceAdjustments')
    pushUnique(updateMask, 'sourceSplits')
    pushUnique(updateMask, 'fxSnapshot')
  } else {
    // Text-only on a foreign doc preserves the canonical trip-currency
    // money fields, so it must not re-fetch FX. A paidBy change still
    // affects settlement debt edges, though, so re-run the same
    // member/cross-field gate against the current canonical money
    // snapshot before allowing the write.
    if (fp.paidBy !== undefined) {
      const decoded = decodeExpense(args.currentFields)
      if (decoded.currency !== args.ctx.currency) {
        throw new ExpenseValidationError(
          'currency',
          `expense currency ${decoded.currency} does not match trip currency ${args.ctx.currency}`,
        )
      }
      validateExpenseCrossField(
        {
          amountMinor:  decoded.amountMinor,
          currency:     decoded.currency,
          paidBy:       fp.paidBy,
          splits:       decoded.splits,
          items:        decoded.items,
          adjustments:  decoded.adjustments,
        },
        args.ctx.memberIds,
      )
    }
  }

  // Text-only fields write regardless of recompute. paidBy / date /
  // category / title / note are partial-OK on the foreign-update
  // schema, so handle each independently.
  if (fp.title    !== undefined) { patchFields.title    = { stringValue: fp.title    }; pushUnique(updateMask, 'title') }
  if (fp.category !== undefined) { patchFields.category = { stringValue: fp.category }; pushUnique(updateMask, 'category') }
  if (fp.paidBy   !== undefined) { patchFields.paidBy   = { stringValue: fp.paidBy   }; pushUnique(updateMask, 'paidBy') }
  if (fp.note     !== undefined) { patchFields.note     = { stringValue: fp.note     }; pushUnique(updateMask, 'note') }
  if (fp.date     !== undefined) { patchFields.date     = { stringValue: fp.date     }; pushUnique(updateMask, 'date') }

  // Receipt set / delete
  if (args.receipt) {
    const rfields: Record<string, FsValue> = {
      url:  { stringValue: args.receipt.url },
      path: { stringValue: args.receipt.path },
      type: { stringValue: args.receipt.type },
    }
    if (args.receipt.thumbUrl  != null) rfields.thumbUrl  = { stringValue: args.receipt.thumbUrl }
    if (args.receipt.thumbPath != null) rfields.thumbPath = { stringValue: args.receipt.thumbPath }
    patchFields.receipt = { mapValue: { fields: rfields } }
    pushUnique(updateMask, 'receipt')
  }
  if (args.receiptDeletion) pushUnique(updateMask, 'receipt')

  patchFields.updatedBy = { stringValue: args.callerUid }
  pushUnique(updateMask, 'updatedBy')

  const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
  ]
  if (fxSnapshotWritten) {
    // Stamp the new fxSnapshot.fetchedAt at commit time, same pattern
    // as doCreate. The parent map exists in patchFields (encodeFxSnapshot
    // wrote fetchedAt as null) so the nested transform's parent-must-
    // exist precondition is satisfied within the same Write.
    updateTransforms.push({ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' })
  }

  return {
    document:        docResourceName(args.projectId, `trips/${args.tripId}/expenses/${args.expenseId}`),
    fields:          patchFields,
    updateMask,
    currentDocument: { exists: true },
    updateTransforms,
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

/** Decode the Firestore REST `fields` map back into the shape we
 *  need for cross-field validation. Only extracts what's checked. */
function decodeExpense(fields: Record<string, FsValue>): {
  amountMinor:  number
  currency:     string
  paidBy:       string
  splits:       { memberId: string; amountMinor: number }[]
  items?:       { id: string; amountMinor: number; assignees: string[] }[]
  adjustments?: { id: string; kind: string; scope: string; amountMinor: number; targetItemId?: string }[]
} {
  const amountMinor = Number(fields.amountMinor?.integerValue ?? 0)
  const currency = readString(fields, 'currency') ?? ''
  const paidBy = readString(fields, 'paidBy') ?? ''
  const splitArr = (fields.splits as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const splits = splitArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      memberId:    readString(inner, 'memberId') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
    }
  })
  const itemArr = (fields.items as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const items = itemArr ? itemArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const aArr = (inner.assignees as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
    return {
      id:          readString(inner, 'id') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
      assignees:   aArr.map(a => a.stringValue ?? '').filter(s => s !== ''),
    }
  }) : undefined
  const adjArr = (fields.adjustments as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const adjustments = adjArr ? adjArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const targetItemId = readString(inner, 'targetItemId')
    const out: { id: string; kind: string; scope: string; amountMinor: number; targetItemId?: string } = {
      id:          readString(inner, 'id')    ?? '',
      kind:        readString(inner, 'kind')  ?? '',
      scope:       readString(inner, 'scope') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
    }
    if (targetItemId !== undefined) out.targetItemId = targetItemId
    return out
  }) : undefined
  return { amountMinor, currency, paidBy, splits, items, adjustments }
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
