// workers/ocr/src/expense-foreign-codec.ts
// Firestore REST codec for the foreign-currency SOURCE mirror:
// sourceItems / sourceAdjustments / sourceSplits / fxSnapshot encode +
// decode, plus the small `readIntegerField` reader. Split out of
// expense-foreign-write.ts (boundary extraction) so the orchestrator and the
// trip-currency create tail (expense-write.ts) share ONE serializer for the
// persisted source mirror — create-write and update-recompute can't drift in
// how they shape these fields.
//
// Pure serialization: no FX I/O, no materializer math (that's
// expense-foreign-materialize.ts), no tx plumbing. The source-domain struct
// types live here because decode produces them; the materializer imports them
// as its input shape.
import { readString, type FsValue }            from './firestore'
import { type FxSnapshot }                     from './fx-rate'
import { type ExpenseForeignCreateInput }      from './expense-validate'
import { type AdjustmentKind, type AdjustmentScope } from '@tripmate/expense-materialize'

// ─── Source-domain struct types (decode output / materializer input) ──

/** Decoded source-currency receipt line. `sourceAmountMinor` is positive
 *  integer minor units in the SOURCE currency (converted to trip currency
 *  by the materializer). */
export interface ForeignSourceItem {
  id:                string
  name:              string
  sourceAmountMinor: number
  assignees:         string[]
}

export interface ForeignSourceAdjustment {
  id:                string
  label:             string
  kind:              AdjustmentKind
  scope:             AdjustmentScope
  sourceAmountMinor: number
  targetItemId?:     string
}

export interface ForeignSourceSplit {
  memberId:          string
  sourceAmountMinor: number
}

// ─── Encoders (struct → Firestore REST FsValue) ───────────────────

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

// ─── Decoders (Firestore REST FsValue → struct) ───────────────────

/** Read an integer field encoded as Firestore REST's `{ integerValue: '<digits>' }`.
 *  Returns undefined when absent (not when zero -- distinguish via the
 *  caller's defensive check). */
export function readIntegerField(fields: Record<string, FsValue>, key: string): number | undefined {
  const v = (fields[key] as { integerValue?: string } | undefined)?.integerValue
  return v !== undefined ? Number(v) : undefined
}

/** Decode the persisted `sourceItems` array from Firestore REST shape
 *  into the source-domain item structs the materializer + name-zip
 *  expect. Returns undefined when the field is absent (legitimate for
 *  trip-currency docs; caller branches on foreign-ness BEFORE invoking
 *  this so undefined here would indicate a corrupt foreign doc). */
export function decodeSourceItemsField(
  fields: Record<string, FsValue>,
): ForeignSourceItem[] | undefined {
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

export function decodeSourceAdjustmentsField(
  fields: Record<string, FsValue>,
): ForeignSourceAdjustment[] | undefined {
  const arr = (fields.sourceAdjustments as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  if (!arr) return undefined
  return arr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const targetItemId = readString(inner, 'targetItemId')
    const out: ForeignSourceAdjustment = {
      id:                readString(inner, 'id')    ?? '',
      label:             readString(inner, 'label') ?? '',
      kind:              (readString(inner, 'kind')  ?? '') as AdjustmentKind,
      scope:             (readString(inner, 'scope') ?? '') as AdjustmentScope,
      sourceAmountMinor: Number((inner.sourceAmountMinor as { integerValue?: string } | undefined)?.integerValue ?? 0),
    }
    if (targetItemId !== undefined) out.targetItemId = targetItemId
    return out
  })
}

export function decodeSourceSplitsField(
  fields: Record<string, FsValue>,
): ForeignSourceSplit[] | undefined {
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
