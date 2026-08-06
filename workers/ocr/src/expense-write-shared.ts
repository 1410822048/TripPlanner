// workers/ocr/src/expense-write-shared.ts
// Cross-cutting substrate shared by the expense-write orchestration and the
// foreign-currency write path (expense-foreign-write.ts): the trip auth
// context, a small array helper, and the persisted-expense decoder. Split
// out of expense-write.ts (P4) so the foreign module can reuse them without
// a cycle back into the orchestration module.
import { readString, type FsValue } from './firestore'

export interface TripContext {
  memberIds:  string[]
  isOwner:    boolean
  /** Trip-scoped ISO 4217 currency. Every expense in this trip MUST
   *  carry this currency; mixing currencies inside a single trip would
   *  silently corrupt settlement / trip-total math (those layers assume
   *  one currency per trip). The bind is enforced in doCreate / doUpdate
   *  against parsed.data.currency / merged.currency respectively. */
  currency:   string
}

export function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v)
}

/** Decode the Firestore REST `fields` map back into the shape we
 *  need for cross-field validation. Only extracts what's checked. */
export function decodeExpense(fields: Record<string, FsValue>): {
  amountMinor:  number
  currency:     string
  paidBy:       string
  splits:       { memberId: string; amountMinor: number }[]
  items?:       { id: string; amountMinor: number; allocations: { memberId: string; shares: number }[] }[]
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
    const allocationArr = (inner.allocations as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
    return {
      id:          readString(inner, 'id') ?? '',
      amountMinor: Number(inner.amountMinor?.integerValue ?? 0),
      allocations: allocationArr
        .map(v => {
          const allocationFields = v.mapValue?.fields ?? {}
          return {
            memberId: readString(allocationFields, 'memberId') ?? '',
            shares:   Number((allocationFields.shares as { integerValue?: string } | undefined)?.integerValue ?? 0),
          }
        })
        .filter(a => a.memberId !== ''),
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

/** The live roster widened with the departed members an existing expense
 *  ALREADY references. Update paths only -- create must stay roster-pure.
 *
 *  Without this, removing a member freezes every expense they ever paid
 *  for or shared: `validateExpenseCrossField` rejects the out-of-roster
 *  `paidBy` / `splits[].memberId` that the stored doc still carries, so
 *  even a title edit 400s forever. Stripping those refs instead is not an
 *  option -- that rewrites settled history.
 *
 *  Granularity is set membership, not per-field equality: a ghost already
 *  on the doc may have their split amount change (otherwise any total edit
 *  would be blocked again), but a ghost the doc never referenced is still
 *  rejected. */
export function rosterForUpdate(
  memberIds:     string[],
  currentFields: Record<string, FsValue>,
): string[] {
  const current = decodeExpense(currentFields)
  const allowed = new Set(memberIds)
  allowed.add(current.paidBy)
  for (const split of current.splits) allowed.add(split.memberId)
  for (const item of current.items ?? []) {
    for (const allocation of item.allocations) allowed.add(allocation.memberId)
  }
  allowed.delete('')
  return [...allowed]
}
