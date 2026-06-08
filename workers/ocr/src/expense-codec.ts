// workers/ocr/src/expense-codec.ts
// Trip-currency Firestore REST codec for expense docs: the create-doc
// encoder, the partial-patch encoder, and the current+patch merge used for
// cross-field re-validation. Split out of expense-write.ts so the
// orchestrator keeps only auth / tx / routing -- mirrors
// expense-foreign-codec.ts on the source-domain side.
//
// Pure functions, no I/O. The shared sub-encoders (splits / items /
// adjustments / receipt) are the SINGLE source for both the create shape and
// the patch shape, which previously duplicated this map-building verbatim
// across encodeExpense + encodePatch. Foreign source-mirror fields delegate
// to expense-foreign-codec; settlement-lock / tx / updateMask-delete live in
// the orchestrator and are deliberately NOT here.
import type { FsValue } from './firestore'
import {
  makeExpenseCreateSchema,
  makeExpenseUpdateSchema,
  type ExpenseReceiptOut,
} from './expense-validate'
import type { ForeignArtifacts } from './expense-foreign-write'
import {
  encodeSourceItems,
  encodeSourceAdjustments,
  encodeSourceSplits,
  encodeFxSnapshot,
} from './expense-foreign-codec'
import { CascadeError } from './cascade'
import { decodeExpense } from './expense-write-shared'

type ExpenseCreatePayload = ReturnType<ReturnType<typeof makeExpenseCreateSchema>['parse']>
type ExpenseUpdatePayload = ReturnType<ReturnType<typeof makeExpenseUpdateSchema>['parse']>

// ─── Shared sub-encoders (single source for create + patch) ───────

/** splits[] → Firestore REST array-of-maps. */
function encodeSplits(splits: { memberId: string; amountMinor: number }[]): FsValue {
  return {
    arrayValue: {
      values: splits.map(s => ({
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

/** items[] → Firestore REST array-of-maps (id / name / amount / assignees). */
function encodeItems(
  items: { id: string; name: string; amountMinor: number; assignees: string[] }[],
): FsValue {
  return {
    arrayValue: {
      values: items.map(item => ({
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

/** adjustments[] → Firestore REST array-of-maps. `targetItemId` is emitted
 *  only when present (ITEM-scope rows); EXPENSE-scope rows omit the key. */
function encodeAdjustments(
  adjustments: {
    id: string; label: string; kind: string; scope: string
    amountMinor: number; targetItemId?: string
  }[],
): FsValue {
  return {
    arrayValue: {
      values: adjustments.map(adj => {
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

/** receipt → Firestore REST mapValue (path-only). url/thumbUrl are no
 *  longer written (download token stripped at consume; reads via getBlob).
 *  thumbPath omitted when absent. Exported so the foreign-mode update path
 *  (expense-foreign-write.ts) reuses this single encoder instead of an
 *  inline duplicate. */
export function encodeReceipt(receipt: ExpenseReceiptOut): FsValue {
  const rfields: Record<string, FsValue> = {
    path: { stringValue: receipt.path },
    type: { stringValue: receipt.type },
  }
  if (receipt.thumbPath != null) rfields.thumbPath = { stringValue: receipt.thumbPath }
  return { mapValue: { fields: rfields } }
}

// ─── Create-doc encoder ───────────────────────────────────────────

/** Encode the validated create payload into the canonical Firestore REST
 *  `fields` map. `receipt` (intent-built) and `foreign` (source mirror) are
 *  threaded in as separate params -- neither is part of the create body
 *  schema. */
export function encodeExpense(
  payload:   ExpenseCreatePayload,
  tripId:    string,
  memberIds: string[],
  createdBy: string,
  receipt?:  ExpenseReceiptOut,
  foreign?:  ForeignArtifacts,
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
    splits:          encodeSplits(payload.splits),
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
    fields.items = encodeItems(payload.items)
  }
  // Phase B: adjustments[] is REQUIRED on every persisted doc (empty
  // array when none). The Worker is the only writer for content
  // fields, so the encoded shape here is the canonical Firestore
  // representation that ExpenseDocSchema parses on read.
  fields.adjustments = encodeAdjustments(payload.adjustments)
  if (receipt) {
    fields.receipt = encodeReceipt(receipt)
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

// ─── Partial-update encoder + merge ───────────────────────────────

/** Merge Firestore-stored fields with the validated patch into a
 *  flat object suitable for validateExpenseCrossField. Receipt is
 *  handled out-of-band (deletion sentinel + intent-built receipt are
 *  not part of the patch schema after 4c) so this function never
 *  sees a receipt field. */
export function mergeExpense(
  current: Record<string, FsValue>,
  patch:   ExpenseUpdatePayload,
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
export function encodePatch(
  patch:    ExpenseUpdatePayload,
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
  if (patch.splits      !== undefined) out.splits      = encodeSplits(patch.splits)
  if (patch.items       !== undefined) out.items       = encodeItems(patch.items)
  if (patch.adjustments !== undefined) out.adjustments = encodeAdjustments(patch.adjustments)
  if (receipt) out.receipt = encodeReceipt(receipt)
  return out
}
