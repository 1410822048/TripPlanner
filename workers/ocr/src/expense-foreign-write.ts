// workers/ocr/src/expense-foreign-write.ts
// Foreign-currency WRITE orchestration for the expense-write endpoints:
// FX-snapshot resolution + the create/update control flow that assembles the
// Firestore TxWrite. The two domains it delegates:
//   - serialization  → expense-foreign-codec.ts   (source mirror encode/decode)
//   - source→trip math → expense-foreign-materialize.ts (per-line allocation)
// Auth / BOLA / settlement-lock / mode routing stay in the expense-write
// orchestrator, which calls prepareForeignCreate (create) and
// buildForeignUpdateWrite (update).
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
import {
  encodeSourceItems,
  encodeSourceAdjustments,
  encodeSourceSplits,
  encodeFxSnapshot,
  readIntegerField,
  decodeSourceItemsField,
  decodeSourceAdjustmentsField,
  decodeSourceSplitsField,
}                                          from './expense-foreign-codec'
import {
  materializeForeignLineDomain,
  materializeForeignSplitDomain,
}                                          from './expense-foreign-materialize'

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
 *    4. Delegate to expense-foreign-materialize to derive the trip-domain
 *       items / adjustments / splits / amountMinor authoritatively. The
 *       materializer's per-line allocation is the financial-attribution
 *       boundary -- the Worker, not the client, decides who owes what for
 *       each receipt line. */
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
    const converted = materializeForeignSplitDomain({
      sourceSplits:         fp.sourceSplits,
      sourceAmountMinor:    fp.sourceAmountMinor,
      rateDecimal:          snapshot.rateDecimal,
      sourceFractionDigits,
      targetFractionDigits,
    })

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

  const materialized = materializeForeignLineDomain({
    sourceItems,
    sourceAdjustments,
    sourceAmountMinor:    fp.sourceAmountMinor,
    rateDecimal:          snapshot.rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
    members:              ctx.memberIds,
  })

  const parsedTrip: ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']> = {
    title:       fp.title,
    amountMinor: materialized.amountMinor,
    currency:    ctx.currency,
    category:    fp.category,
    paidBy:      fp.paidBy,
    splits:      materialized.splits,
    date:        fp.date,
    items:       materialized.tripItems,
    adjustments: materialized.tripAdjustments,
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

      const converted = materializeForeignSplitDomain({
        sourceSplits:         effectiveSourceSplits,
        sourceAmountMinor:    effectiveSourceAmountMinor,
        rateDecimal:          snapshot.rateDecimal,
        sourceFractionDigits,
        targetFractionDigits,
      })

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

      const materialized = materializeForeignLineDomain({
        sourceItems:          effectiveSourceItems,
        sourceAdjustments:    effectiveSourceAdjustments,
        sourceAmountMinor:    effectiveSourceAmountMinor,
        rateDecimal:          snapshot.rateDecimal,
        sourceFractionDigits,
        targetFractionDigits,
        members:              args.ctx.memberIds,
      })

      validateExpenseCrossField(
        {
          amountMinor: materialized.amountMinor,
          currency:    args.ctx.currency,
          paidBy:      fp.paidBy ?? readString(args.currentFields, 'paidBy') ?? '',
          splits:      materialized.splits,
          items:       materialized.tripItems,
          adjustments: materialized.tripAdjustments,
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
          values: materialized.tripItems.map(item => ({
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
          values: materialized.tripAdjustments.map(adj => {
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
      patchFields.sourceItems       = encodeSourceItems(effectiveSourceItems)
      patchFields.sourceAdjustments = encodeSourceAdjustments(effectiveSourceAdjustments)

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
