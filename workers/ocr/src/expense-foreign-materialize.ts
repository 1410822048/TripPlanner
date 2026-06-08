// workers/ocr/src/expense-foreign-materialize.ts
// Source → trip-currency projection shared by foreign-currency CREATE
// (prepareForeignCreate) and UPDATE (buildForeignUpdateWrite). The Worker is
// authoritative for per-line allocation — the financial-attribution boundary
// — and that math lives here, called from both write paths so they can't
// drift. Split out of expense-foreign-write.ts (boundary extraction).
//
// Two domains, mirroring the source mirror's two shapes:
//   - line domain  (sourceItems + sourceAdjustments): convertAndMaterialize
//     FromSource → trip items/adjustments/splits + total, then zip the id-keyed
//     materializer output back with the source-side name/label strings.
//   - split domain (sourceSplits, manual-total): convertSourceSplitsToTarget
//     → trip splits + total (no receipt lines).
//
// Both translate a MaterializeError into the source-field-aware
// ExpenseValidationError so create + update surface identical hints for the
// same underlying failure.
import {
  convertAndMaterializeFromSource,
  convertSourceSplitsToTarget,
  MaterializeError,
  type MaterializeItem,
  type MaterializeAdjustment,
  type MaterializeSplit,
  type MaterializeErrorCode,
}                                          from '@tripmate/expense-materialize'
import { ExpenseValidationError }          from './expense-validate'
import {
  type ForeignSourceItem,
  type ForeignSourceAdjustment,
  type ForeignSourceSplit,
}                                          from './expense-foreign-codec'

/** Trip-currency receipt line, materializer output re-joined with the
 *  source-side display `name`. */
export interface TripItem {
  id:          string
  name:        string
  amountMinor: number
  assignees:   string[]
}

/** Trip-currency adjustment, materializer output re-joined with the
 *  source-side display `label`. */
export interface TripAdjustment {
  id:            string
  label:         string
  kind:          MaterializeAdjustment['kind']
  scope:         MaterializeAdjustment['scope']
  amountMinor:   number
  targetItemId?: string
}

export interface MaterializedForeignLines {
  amountMinor:     number
  splits:          MaterializeSplit[]
  tripItems:       TripItem[]
  tripAdjustments: TripAdjustment[]
}

/** Map a `MaterializeError.code` (raised by the materializer on bad
 *  source-domain inputs) to the source-side field path the foreign
 *  create/update handlers surface in their `ExpenseValidationError`.
 *  Single source of truth so create + update produce identical field
 *  hints for the same underlying materializer failure. */
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

/** Line domain: convert + materialize the source receipt lines into
 *  trip-currency items/adjustments/splits + total, then re-join the
 *  id-keyed materializer output with the source-side name/label strings.
 *  The materializer preserves source order, so the positional zip is
 *  safe. Throws ExpenseValidationError on bad source input. */
export function materializeForeignLineDomain(input: {
  sourceItems:          ForeignSourceItem[]
  sourceAdjustments:    ForeignSourceAdjustment[]
  sourceAmountMinor:    number
  rateDecimal:          string
  sourceFractionDigits: number
  targetFractionDigits: number
  members:              string[]
}): MaterializedForeignLines {
  let materialized: ReturnType<typeof convertAndMaterializeFromSource>
  try {
    materialized = convertAndMaterializeFromSource({
      sourceItems: input.sourceItems.map(i => ({
        id:          i.id,
        amountMinor: i.sourceAmountMinor,
        assignees:   i.assignees,
      })),
      sourceAdjustments: input.sourceAdjustments.map(a => {
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
      sourceAmountMinor:    input.sourceAmountMinor,
      rateDecimal:          input.rateDecimal,
      sourceFractionDigits: input.sourceFractionDigits,
      targetFractionDigits: input.targetFractionDigits,
      members:              input.members,
    })
  } catch (e) {
    if (e instanceof MaterializeError) {
      throw new ExpenseValidationError(mapMaterializeErrorField(e.code), `${e.code}: ${e.message}`)
    }
    throw e
  }

  const tripItems = materialized.items.map((mi: MaterializeItem, i: number) => ({
    id:          mi.id,
    name:        input.sourceItems[i]!.name,
    amountMinor: mi.amountMinor,
    assignees:   mi.assignees,
  }))
  const tripAdjustments = materialized.adjustments.map((ma: MaterializeAdjustment, i: number) => {
    const out: TripAdjustment = {
      id:          ma.id,
      label:       input.sourceAdjustments[i]!.label,
      kind:        ma.kind,
      scope:       ma.scope,
      amountMinor: ma.amountMinor,
    }
    if (ma.targetItemId !== undefined) out.targetItemId = ma.targetItemId
    return out
  })

  return {
    amountMinor:     materialized.amountMinor,
    splits:          materialized.splits,
    tripItems,
    tripAdjustments,
  }
}

/** Split domain (manual-total): convert source splits directly to
 *  trip-currency splits + total. No receipt lines. Throws
 *  ExpenseValidationError on bad source input. */
export function materializeForeignSplitDomain(input: {
  sourceSplits:         ForeignSourceSplit[]
  sourceAmountMinor:    number
  rateDecimal:          string
  sourceFractionDigits: number
  targetFractionDigits: number
}): { amountMinor: number; splits: MaterializeSplit[] } {
  try {
    const converted = convertSourceSplitsToTarget({
      sourceSplits: input.sourceSplits.map(split => ({
        memberId:    split.memberId,
        amountMinor: split.sourceAmountMinor,
      })),
      sourceAmountMinor:    input.sourceAmountMinor,
      rateDecimal:          input.rateDecimal,
      sourceFractionDigits: input.sourceFractionDigits,
      targetFractionDigits: input.targetFractionDigits,
    })
    return { amountMinor: converted.amountMinor, splits: converted.splits }
  } catch (e) {
    if (e instanceof MaterializeError) {
      throw new ExpenseValidationError(mapMaterializeErrorField(e.code), `${e.code}: ${e.message}`)
    }
    throw e
  }
}
