// workers/ocr/src/settlement-codec.ts
// Substrate of the settlement endpoints (settlement-route-write.ts): the
// fail-closed read caps, the member/currency authorization read, and the
// Firestore REST <-> domain codecs for expenses, settlement legs and
// lineage. Pure decode/encode plus one tx read (authorizeMemberTx); no
// writes.
import { EXPENSE_LIMITS } from '@tripmate/entity-contracts'
import {
  docIdFromName,
  readString,
  type FsValue,
}                                                           from './firestore'
import { CascadeError }                                     from './cascade'
import { requireTripAccess }                                from './membership-shared'
import type { TxContext, TxReadDoc }                        from './firestore-tx'
import type { CoreExpense, CoreSettlement }                 from '@tripmate/settlement-core'
import type { MaterializeAdjustment }                       from '@tripmate/expense-materialize'
import type {
  PairExpenseForSettlement,
  SettlementAppliedSource,
}                                                           from './settlement-lineage'
import type { TripCurrencyContext }                         from './settlement-write-shared'

// ─── In-tx read caps (fail-closed) ────────────────────────────────

/** Defensive caps for the in-tx reads. A pathological trip can't
 *  hang a tx waiting on 10k expenses / settlements; matches the
 *  client-side `LIST_LIMIT` ceilings (200 settlements, 500 expenses
 *  per the expense service).
 *
 *  CRITICAL: cap MUST be fail-closed (not fail-open with a partial
 *  dataset). Either form of under-read can let an overpay slip past:
 *    - missed prior settlements → applied undercounted → remaining
 *      overstated → gate accepts amount that's actually overpay
 *    - missed reverse-direction expenses → normalize step under-cancels
 *      the forward edge → forward remaining overstated, same effect
 *  We request `limit + 1` and reject with 503 when truncation is
 *  detected so the client retries / surfaces an error -- never silently
 *  computes pair remaining off a partial view. */
export const EXPENSE_READ_LIMIT    = 500
/** Firestore's per-commit (and per-transaction) write cap. */
export const MAX_COMMIT_WRITES     = 500

// ─── Authorization helpers ────────────────────────────────────────

/** Settlement create authz: caller must be a trip member (any role —
 *  matches the existing rule's `exists(memberPath)`). The receiver-
 *  only invariant (`toUid == callerUid`) is checked separately by
 *  the create flow so the failure can carry a precise field path.
 *  Returns the trip's currency for the cross-check. */
export async function authorizeMemberTx(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<TripCurrencyContext & { ownerId: string | undefined; formerMemberUids: string[] }> {
  // Any role: recording a receipt is the receiver's right, not an edit.
  const { trip } = await requireTripAccess(tx, tripId, callerUid)

  const currency = readString(trip.fields, 'currency')
  if (!currency) {
    // Defensive -- every trip created via createTrip carries a currency.
    // If it's missing we'd otherwise silently accept any settlement
    // currency since the cross-check below short-circuits.
    throw new CascadeError(500, 'trip.currency is missing')
  }
  const former = (trip.fields.formerMemberNames as { mapValue?: { fields?: Record<string, unknown> } } | undefined)
    ?.mapValue?.fields ?? {}
  return { currency, ownerId: readString(trip.fields, 'ownerId'), formerMemberUids: Object.keys(former) }
}

// ─── Decoders: REST fields → domain shapes ────────────────────────

/** Fail-closed money decode for the debt math. `Number(x?.integerValue ?? 0)`
 *  silently read a missing / doubleValue / corrupt amount as 0, which
 *  understates the pair's debt and lets a settlement be recorded for the
 *  wrong remaining amount. A doc we can't decode is a 500, not a zero. */
export function requireMinor(fields: Record<string, FsValue> | undefined, key: string, what: string): number {
  const n = readInteger(fields, key)
  if (n === null) throw new CascadeError(500, `${what}: ${key} is not a valid integer`)
  return n
}

export function decodeExpenseForDomain(fields: Record<string, FsValue>): CoreExpense {
  const amountMinor = requireMinor(fields, 'amountMinor', 'expense')
  const paidBy = readString(fields, 'paidBy') ?? ''
  const splitArr = (fields.splits as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const splits = splitArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    return {
      memberId:    readString(inner, 'memberId') ?? '',
      amountMinor: requireMinor(inner, 'amountMinor', 'expense split'),
    }
  })
  return { amountMinor, paidBy, splits }
}

/** A settlement doc's ledger: its legs, each an ordinary from → to clear
 *  stamped with the doc's createdAt (the order the pair math folds in).
 *  Reads only `legs` and `createdAt`, so it works on the projected
 *  ledger query. Fail-closed: a doc whose legs can't be decoded is a 500,
 *  never a silently smaller ledger. */
export function decodeSettlementLegs(fields: Record<string, FsValue>): CoreSettlement[] {
  const legs = (fields.legs as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  if (!legs || legs.length === 0) throw new CascadeError(500, 'settlement: legs is missing or empty')
  const createdAtMs = parseCreatedAtMs(fields)
  return legs.map(v => {
    const leg = v.mapValue?.fields ?? {}
    const fromUid = readString(leg, 'fromUid')
    const toUid   = readString(leg, 'toUid')
    if (!fromUid || !toUid || fromUid === toUid) throw new CascadeError(500, 'settlement leg: fromUid / toUid is malformed')
    return { fromUid, toUid, amountMinor: requireMinor(leg, 'amountMinor', 'settlement leg'), createdAtMs }
  })
}

/** createdAt (REST timestampValue) as epoch ms. Every Worker write stamps
 *  REQUEST_TIME; missing / unparseable sorts first, deterministically. */
export function parseCreatedAtMs(fields: Record<string, FsValue>): number {
  const iso = fields.createdAt?.timestampValue
  const ms = typeof iso === 'string' ? Date.parse(iso) : 0
  return Number.isFinite(ms) ? ms : 0
}

export function decodePairExpenseForSettlement(doc: TxReadDoc): PairExpenseForSettlement {
  const core = decodeExpenseForDomain(doc.fields)
  const expenseId = docIdFromName(doc.name) ?? ''
  const itemArr = (doc.fields.items as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const items = itemArr?.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const allocationArr = (inner.allocations as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
    return {
      id:          readString(inner, 'id') ?? '',
      name:        readString(inner, 'name') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
      allocations: allocationArr
        .map(allocation => {
          const fields = allocation.mapValue?.fields ?? {}
          return {
            memberId: readString(fields, 'memberId') ?? '',
            shares:   Number((fields.shares as { integerValue?: string } | undefined)?.integerValue ?? 0),
          }
        })
        .filter(allocation => allocation.memberId !== ''),
    }
  })
  const adjArr = (doc.fields.adjustments as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const adjustments = adjArr.map(v => {
    const inner = v.mapValue?.fields ?? {}
    const targetItemId = readString(inner, 'targetItemId')
    const out: MaterializeAdjustment & { label: string } = {
      id:          readString(inner, 'id')    ?? '',
      label:       readString(inner, 'label') ?? '',
      kind:        (readString(inner, 'kind')  ?? '') as MaterializeAdjustment['kind'],
      scope:       (readString(inner, 'scope') ?? '') as MaterializeAdjustment['scope'],
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
    }
    if (targetItemId !== undefined) out.targetItemId = targetItemId
    return out
  })
  return {
    ...core,
    id:          expenseId,
    title:       readString(doc.fields, 'title') ?? expenseId,
    createdAtMs: parseCreatedAtMs(doc.fields),
    items,
    adjustments,
  }
}

/** Lineage titles are display-only snapshots; cap them at the client's
 *  read limit (code points, so an emoji is never split) so a legacy long
 *  expense title can't make the settlement unparseable for every member. */
// Written at the expense title cap (+ '…'), well inside what clients read.
const LINEAGE_TITLE_MAX = EXPENSE_LIMITS.title
export function lineageTitle(title: string): string {
  const chars = Array.from(title)
  return chars.length <= LINEAGE_TITLE_MAX ? title : chars.slice(0, LINEAGE_TITLE_MAX - 1).join('') + '…'
}

/** The doc's display lineage: every leg's sources, flattened, each tagged
 *  with the index of the leg it belongs to. */
export function encodeAppliedSources(perLeg: SettlementAppliedSource[][]): FsValue {
  return {
    arrayValue: {
      values: perLeg.flatMap((sources, legIndex) => sources.map(source => {
        const fields: Record<string, FsValue> = {
          legIndex:     { integerValue: String(legIndex) },
          expenseId:    { stringValue:  source.expenseId },
          expenseTitle: { stringValue:  lineageTitle(source.expenseTitle) },
          amountMinor:  { integerValue: String(source.amountMinor) },
        }
        if (source.itemId !== undefined && source.itemName !== undefined) {
          fields.itemId = { stringValue: source.itemId }
          fields.itemName = { stringValue: source.itemName }
        }
        return { mapValue: { fields } }
      })),
    },
  }
}

/** The doc's lock set, per expense: which legs lock it. Sorted by expense
 *  id; each expense once, however many legs lock it. `ids` is the union
 *  the expense lock writes use. */
export function encodeLockedExpenses(perLeg: readonly (readonly string[])[]): { ids: string[]; value: FsValue } {
  const legsByExpense = new Map<string, number[]>()
  perLeg.forEach((ids, legIndex) => {
    for (const id of ids) {
      const legs = legsByExpense.get(id) ?? []
      if (!legs.includes(legIndex)) legs.push(legIndex)
      legsByExpense.set(id, legs)
    }
  })
  const ids = [...legsByExpense.keys()].sort()
  return {
    ids,
    value: {
      arrayValue: {
        values: ids.map(expenseId => ({ mapValue: { fields: {
          expenseId:  { stringValue: expenseId },
          legIndexes: { arrayValue: { values: legsByExpense.get(expenseId)!.map(i => ({ integerValue: String(i) })) } },
        } } })),
      },
    },
  }
}

/** Every expense id in a doc's `lockedExpenses`. */
export function decodeLockedExpenseIds(fields: Record<string, FsValue>): string[] {
  const entries = (fields.lockedExpenses as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  return entries.flatMap(v => {
    const id = readString(v.mapValue?.fields, 'expenseId')
    return id ? [id] : []
  })
}

export function readInteger(fields: Record<string, FsValue> | undefined, key: string): number | null {
  const raw = fields?.[key]
  if (!raw || !('integerValue' in raw)) return null
  const n = Number(raw.integerValue)
  return Number.isSafeInteger(n) ? n : null
}

/** True when a settlement doc has been soft-deleted (cancelled). Shared
 *  by the create-path idempotency check (reject reuse of a cancelled id)
 *  and the delete-path idempotency check (no-op on a second cancel). */
export function isSoftDeleted(fields: Record<string, FsValue>): boolean {
  return Boolean((fields.deletedAt as { timestampValue?: string } | undefined)?.timestampValue)
}
