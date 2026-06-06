// workers/ocr/src/expense-foreign-write.ts
// Foreign-currency domain for the expense-write endpoints: FX snapshot
// resolution + source-domain materialization (create AND update) + the
// Firestore encoders/decoders for the persisted source mirror. Split out of
// expense-write.ts (P4 boundary extraction). The Worker stays authoritative
// for per-line allocation (the financial-attribution boundary); this module
// owns that math. Auth / BOLA / settlement-lock / mode routing stay in the
// expense-write orchestrator, which calls prepareForeignCreate (create) and
// buildForeignUpdateWrite (update).
import {
  convertAndMaterializeFromSource,
  convertSourceSplitsToTarget,
  MaterializeError,
  type MaterializeItem,
  type MaterializeAdjustment,
  type MaterializeErrorCode,
}                                          from '@tripmate/expense-materialize'
import { readString, type FsValue }        from './firestore'
import {
  ExpenseValidationError,
  makeExpenseCreateSchema,
  makeForeignExpenseCreateSchema,
  makeForeignExpenseUpdateSchema,
  validateExpenseCrossField,
  type ExpenseReceiptOut,
  type ExpenseForeignCreateInput,
}                                          from './expense-validate'
import { CascadeError }                    from './cascade'
import {
  docResourceName,
  type TxWrite,
  type TxUpdateWrite,
}                                          from './firestore-tx'
import { getFxSnapshot, type FxSnapshot }  from './fx-rate'
import { currencyFractionDigits }          from '@tripmate/fx-core'
import { pushUnique, decodeExpense, type TripContext } from './expense-write-shared'

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

export function encodeSourceItems(
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

export function encodeSourceAdjustments(
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

export function encodeSourceSplits(
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
export function encodeFxSnapshot(fx: FxSnapshot): FsValue {
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
export async function prepareForeignCreate(
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
export async function buildForeignUpdateWrite(args: {
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
