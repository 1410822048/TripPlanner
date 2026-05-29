// @tripmate/expense-materialize — single source of truth for translating
// an expense's (items, adjustments, members) into per-member splits.
// Shared between the React client (preview) and the Cloudflare Worker
// (authoritative recompute on expense-write).
//
// Scope is deliberately narrow: pure data-in / data-out. No Firestore
// Timestamp, no Firebase SDK, no zod parse, no async. Callers adapt
// their richer entity shapes (src/types/expense.ts on the client,
// expense-validate.ts on the Worker) into the minimal `MaterializeInput`
// shape declared here.
//
// Why this exists:
//   Phase B of the Expense Adjustment refactor (see memory:
//   expense-adjustment-design) requires that Worker validation
//   recompute splits authoritatively and reject `SPLIT_PREVIEW_DRIFT`
//   when the client-sent preview disagrees. That contract is only
//   tractable if both sides call the same pure function. Mirrored
//   impls + cross-check fixtures (the pattern settlement-core
//   replaced) would re-introduce the drift surface this package is
//   designed to eliminate.
//
// Sign convention:
//   item.amount is POSITIVE minor units (pre-discount item subtotal).
//   adjustment.amount is POSITIVE minor units; the sign of the effect
//   on the expense comes from `adjustment.kind`. DISCOUNT/COUPON/
//   TAX_EXEMPT subtract; SURCHARGE/TAX/TIP add. OTHER is treated as
//   subtract by default — it's the "I don't know which" escape hatch
//   and most user-typed OTHER labels are correction-like in practice.
//   UI may gain an explicit signed `direction` field in a later phase
//   if that default is wrong often enough.

// ─── Public types ─────────────────────────────────────────────────

/** Item kinds the materializer accepts. Identical to the persisted
 *  `ExpenseAdjustment.kind` enum on the client (src/types/expense.ts)
 *  and Worker (workers/ocr/src/expense-validate.ts). The materializer
 *  only reads `kind` to derive the +/- sign — kind is otherwise
 *  informational (UI label / icon). */
export type AdjustmentKind =
  | 'DISCOUNT'
  | 'COUPON'
  | 'TAX_EXEMPT'
  | 'SURCHARGE'
  | 'TAX'
  | 'TIP'
  | 'OTHER'

/** Persisted adjustment scope. `UNKNOWN` is intentionally NOT included
 *  — it only exists as `suggestedScope` on OCR drafts; resolving it to
 *  ITEM or EXPENSE is a Phase C UI responsibility. The materializer
 *  throws if it ever sees UNKNOWN, so a forgotten downgrade in the
 *  write path surfaces loudly rather than silently materializing the
 *  wrong scope. */
export type AdjustmentScope = 'ITEM' | 'EXPENSE'

/** Minimum item shape the materializer needs. `id` is required at
 *  this layer (ITEM-scope adjustments target by id), but the client
 *  type leaves `ExpenseItem.id` optional during Phase A — the call
 *  site must mint ids before invoking the materializer. */
export interface MaterializeItem {
  id:        string
  amount:    number   // positive minor units
  assignees: string[] // memberIds; ≥1
}

/** Minimum adjustment shape. `targetItemId` is required iff
 *  `scope === 'ITEM'`; the materializer throws on either side of that
 *  bi-implication. */
export interface MaterializeAdjustment {
  id:            string
  kind:          AdjustmentKind
  scope:         AdjustmentScope
  amount:        number      // positive minor units
  targetItemId?: string      // required when scope === 'ITEM'
}

/** Member uids participating in this expense's split universe. The
 *  materializer rejects any assignee not in this list — callers
 *  (client form / Worker validation) hand in the active trip members
 *  so the materializer can catch stale-assignee bugs. */
export interface MaterializeInput {
  items:       MaterializeItem[]
  adjustments: MaterializeAdjustment[]
  members:     string[]
}

/** Output shape — matches client `ExpenseSplit` and Worker decode. */
export interface MaterializeSplit {
  memberId: string
  amount:   number   // signed minor units; non-zero
}

// ─── Errors ───────────────────────────────────────────────────────

/** Structured error codes — kept stable so the Worker can map them to
 *  HTTP responses (e.g. 400 SPLIT_PREVIEW_DRIFT vs 400 OVER_DISCOUNT
 *  vs 500 unexpected) and the client can format human-readable
 *  messages without parsing free-form `message` strings. */
export type MaterializeErrorCode =
  | 'ITEM_NOT_POSITIVE_INTEGER'
  | 'ITEM_NO_ASSIGNEES'
  | 'NON_MEMBER_ASSIGNEE'
  | 'DUPLICATE_ITEM_ASSIGNEE'
  | 'DUPLICATE_ITEM_ID'
  | 'ADJUSTMENT_NOT_POSITIVE_INTEGER'
  | 'ADJUSTMENT_UNKNOWN_KIND'
  | 'UNKNOWN_SCOPE'
  | 'ITEM_SCOPE_NO_TARGET'
  | 'EXPENSE_SCOPE_HAS_TARGET'
  | 'TARGET_ITEM_NOT_FOUND'
  | 'OVER_DISCOUNT_ITEM'
  | 'OVER_DISCOUNT_EXPENSE'
  | 'EXPENSE_SCOPE_NO_WEIGHT'

export class MaterializeError extends Error {
  constructor(public code: MaterializeErrorCode, message: string) {
    super(message)
    this.name = 'MaterializeError'
  }
}

// ─── Public helpers ───────────────────────────────────────────────

/** Sign the adjustment kind contributes to the expense total. Exported
 *  so UI can mirror the convention (e.g. preview "ク−¥100" prefix for
 *  DISCOUNT) without re-deriving it.
 *
 *  Runtime gate: this package is the Worker-authoritative split gate
 *  in Phase B. JSON / Firestore docs are not type-checked, so an
 *  out-of-band `kind` string would silently return `undefined` from
 *  the switch and propagate NaN through delta math. The default
 *  branch throws ADJUSTMENT_UNKNOWN_KIND so the failure surfaces at
 *  the boundary rather than as `NaN ¥` splits downstream. */
export function adjustmentSign(kind: AdjustmentKind): 1 | -1 {
  switch (kind) {
    case 'DISCOUNT':
    case 'COUPON':
    case 'TAX_EXEMPT':
    case 'OTHER':
      return -1
    case 'SURCHARGE':
    case 'TAX':
    case 'TIP':
      return 1
    default:
      throw new MaterializeError(
        'ADJUSTMENT_UNKNOWN_KIND',
        `adjustment kind ${String(kind)} is not recognised`,
      )
  }
}

// ─── Internal helpers ─────────────────────────────────────────────

/** Deterministic equal split for integer minor units. Mirrors
 *  `src/features/expense/utils.ts::splitEqually` exactly — same
 *  Math.floor + abs + sign-multiplication idiom — so Phase B can
 *  retire the client-side copy without behavioral drift.
 *
 *  Remainder lands on the FIRST `rem` members of the input array,
 *  not on a sorted view. Caller-provided assignee ordering is the
 *  tie-break; both client form and Worker decode hand assignees in
 *  the same order (the order they were minted into the doc), so
 *  client preview and Worker recompute land on the same byte. */
function splitEqually(total: number, memberIds: string[]): MaterializeSplit[] {
  if (!memberIds.length) return []
  const intTotal = Math.round(total)
  if (intTotal === 0) return []
  const sign     = intTotal < 0 ? -1 : 1
  const absTotal = Math.abs(intTotal)
  const base     = Math.floor(absTotal / memberIds.length)
  const rem      = absTotal - base * memberIds.length
  return memberIds.map((id, i) => ({
    memberId: id,
    amount:   sign * (base + (i < rem ? 1 : 0)),
  }))
}

// ─── Public algorithm ─────────────────────────────────────────────

/**
 * Convert (items, adjustments, members) into per-member splits.
 *
 * Pipeline:
 *   1. Validate inputs (positive items, non-empty assignees, member
 *      membership, no duplicate item ids, adjustment shape).
 *   2. Apply ITEM-scope adjustments to per-item effective amounts.
 *      Throws OVER_DISCOUNT_ITEM if any item's effective < 0.
 *   3. Compute the net EXPENSE-scope delta and apportion it across
 *      items proportional to their current effective amount (after
 *      step 2). Apportionment uses deterministic remainder so the
 *      last item in input order absorbs the rounding remainder.
 *      Throws OVER_DISCOUNT_EXPENSE if aggregate effective < 0.
 *   4. Equal-split each item's effective amount across its assignees
 *      and aggregate per-member.
 *   5. Drop zero-amount members, return.
 *
 * Determinism: input order of items and assignees is preserved
 * through apportionment and per-item split, so client preview and
 * Worker recompute produce identical byte sequences given identical
 * inputs.
 *
 * Complexity: O(I·A + I·M) where I = items, A = adjustments,
 * M = members. Expense-scale (I ≤ 50, A ≤ 5, M ≤ 8) is well under
 * a millisecond.
 */
export function materializeExpenseSplits(input: MaterializeInput): MaterializeSplit[] {
  const { items, adjustments, members } = input

  // Step 1: validate items. Amounts are minor units (JPY=¥, USD=cents)
  // — we require `Number.isInteger` rather than `Number.isFinite` so a
  // payload that ships fractional minor units (a Phase-B bug, a hand-
  // edited Firestore doc, a mis-typed currency conversion) fails loudly
  // here instead of being silently rounded inside `splitEqually`.
  const itemById = new Map<string, MaterializeItem>()
  const memberSet = new Set(members)
  for (const item of items) {
    if (!Number.isInteger(item.amount) || item.amount <= 0) {
      throw new MaterializeError(
        'ITEM_NOT_POSITIVE_INTEGER',
        `item ${item.id}: amount must be a positive integer (minor units), got ${item.amount}`,
      )
    }
    if (item.assignees.length === 0) {
      throw new MaterializeError(
        'ITEM_NO_ASSIGNEES',
        `item ${item.id}: at least one assignee required`,
      )
    }
    // Same-uid twice in one item's assignees would let `splitEqually`
    // treat the duplicate as a second seat — that member's effective
    // share grows by `amount / assignees.length` per duplicate, biasing
    // allocation while still passing the member-membership check. The
    // Worker authoritative recompute makes that bias server-canonical,
    // so the gate has to live here before split math runs.
    const seenAssignee = new Set<string>()
    for (const uid of item.assignees) {
      if (!memberSet.has(uid)) {
        throw new MaterializeError(
          'NON_MEMBER_ASSIGNEE',
          `item ${item.id}: assignee ${uid} is not a trip member`,
        )
      }
      if (seenAssignee.has(uid)) {
        throw new MaterializeError(
          'DUPLICATE_ITEM_ASSIGNEE',
          `item ${item.id}: assignee ${uid} listed more than once`,
        )
      }
      seenAssignee.add(uid)
    }
    if (itemById.has(item.id)) {
      throw new MaterializeError(
        'DUPLICATE_ITEM_ID',
        `duplicate item id ${item.id}`,
      )
    }
    itemById.set(item.id, item)
  }

  // Step 2: apply ITEM-scope adjustments to per-item effective amounts.
  const itemEffective = new Map<string, number>()
  for (const item of items) itemEffective.set(item.id, item.amount)

  for (const adj of adjustments) {
    if (!Number.isInteger(adj.amount) || adj.amount <= 0) {
      throw new MaterializeError(
        'ADJUSTMENT_NOT_POSITIVE_INTEGER',
        `adjustment ${adj.id}: amount must be a positive integer (minor units), got ${adj.amount}`,
      )
    }
    // `scope` is typed as AdjustmentScope at compile time, but the
    // materializer is also the Worker's runtime gate — a doc with a
    // legacy/corrupted UNKNOWN value or any other string must throw
    // rather than silently fall through to apportionment.
    if (adj.scope !== 'ITEM' && adj.scope !== 'EXPENSE') {
      throw new MaterializeError(
        'UNKNOWN_SCOPE',
        `adjustment ${adj.id}: scope must be ITEM or EXPENSE, got ${String(adj.scope)}`,
      )
    }
    if (adj.scope === 'ITEM') {
      if (!adj.targetItemId) {
        throw new MaterializeError(
          'ITEM_SCOPE_NO_TARGET',
          `adjustment ${adj.id}: ITEM scope requires targetItemId`,
        )
      }
      const target = itemById.get(adj.targetItemId)
      if (!target) {
        throw new MaterializeError(
          'TARGET_ITEM_NOT_FOUND',
          `adjustment ${adj.id}: targetItemId ${adj.targetItemId} not in items`,
        )
      }
      const delta = adjustmentSign(adj.kind) * adj.amount
      const next  = (itemEffective.get(adj.targetItemId) ?? 0) + delta
      if (next < 0) {
        throw new MaterializeError(
          'OVER_DISCOUNT_ITEM',
          `adjustment ${adj.id}: would drive item ${adj.targetItemId} below zero`,
        )
      }
      itemEffective.set(adj.targetItemId, next)
    } else {
      // EXPENSE scope must NOT carry targetItemId — defensive symmetry
      // with the ITEM-scope check above; surfaces "wrong scope chosen"
      // bugs that would otherwise silently ignore the target.
      if (adj.targetItemId !== undefined) {
        throw new MaterializeError(
          'EXPENSE_SCOPE_HAS_TARGET',
          `adjustment ${adj.id}: EXPENSE scope must not set targetItemId`,
        )
      }
    }
  }

  // Step 3: net EXPENSE-scope delta, apportion proportional to current
  // effective amounts. Items with effective ≤ 0 (fully discounted by
  // step 2) contribute zero weight — the remaining items absorb the
  // entire delta.
  const expenseNetDelta = adjustments
    .filter(a => a.scope === 'EXPENSE')
    .reduce((sum, a) => sum + adjustmentSign(a.kind) * a.amount, 0)

  if (expenseNetDelta !== 0) {
    const weightedItems = items.filter(i => (itemEffective.get(i.id) ?? 0) > 0)
    const weightTotal = weightedItems.reduce(
      (s, i) => s + (itemEffective.get(i.id) ?? 0),
      0,
    )
    if (weightTotal === 0) {
      throw new MaterializeError(
        'EXPENSE_SCOPE_NO_WEIGHT',
        'EXPENSE-scope adjustment present but no item has positive effective amount to apportion across',
      )
    }
    const sign = expenseNetDelta < 0 ? -1 : 1
    // adj.amount validated as integer above, so expenseNetDelta is
    // an integer sum — no Math.round normalisation needed.
    const absDelta = Math.abs(expenseNetDelta)
    let allocated = 0
    // Last item absorbs the rounding remainder so Σ apportioned == absDelta.
    for (let i = 0; i < weightedItems.length - 1; i++) {
      const item   = weightedItems[i]!
      const weight = itemEffective.get(item.id) ?? 0
      const portion = Math.floor((absDelta * weight) / weightTotal)
      const cur  = itemEffective.get(item.id) ?? 0
      const next = cur + sign * portion
      if (next < 0) {
        throw new MaterializeError(
          'OVER_DISCOUNT_EXPENSE',
          `expense-scope apportionment drives item ${item.id} below zero`,
        )
      }
      itemEffective.set(item.id, next)
      allocated += portion
    }
    const last = weightedItems[weightedItems.length - 1]!
    const lastCur  = itemEffective.get(last.id) ?? 0
    const lastNext = lastCur + sign * (absDelta - allocated)
    if (lastNext < 0) {
      throw new MaterializeError(
        'OVER_DISCOUNT_EXPENSE',
        `expense-scope apportionment drives item ${last.id} below zero`,
      )
    }
    itemEffective.set(last.id, lastNext)
  }

  // Step 4: split each item's effective amount across its assignees,
  // aggregate per-member. Preserve `members` order in the output so
  // both sides serialize identically.
  const memberTotals = new Map<string, number>()
  for (const item of items) {
    const effective = itemEffective.get(item.id) ?? 0
    if (effective === 0) continue
    const splits = splitEqually(effective, item.assignees)
    for (const { memberId, amount } of splits) {
      memberTotals.set(memberId, (memberTotals.get(memberId) ?? 0) + amount)
    }
  }

  // Step 5: project onto `members` input order, drop zero totals.
  const out: MaterializeSplit[] = []
  for (const uid of members) {
    const total = memberTotals.get(uid) ?? 0
    if (total !== 0) out.push({ memberId: uid, amount: total })
  }
  return out
}

/** Stable JSON shape for cross-trust-boundary comparison. The Worker
 *  computes its authoritative splits via `materializeExpenseSplits`,
 *  the client sends its preview via the same function — both call
 *  `canonicalizeSplits` to get a deterministic representation, then
 *  compare. Sorted by memberId so insertion-order differences
 *  (rare but possible across client/Worker map iteration) don't
 *  manifest as SPLIT_PREVIEW_DRIFT false positives.
 *
 *  Returned as a string so consumers can do a single === check
 *  instead of a deep-equal walk. */
export function canonicalizeSplits(splits: MaterializeSplit[]): string {
  return JSON.stringify(
    [...splits]
      .filter(s => s.amount !== 0)
      .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
      .map(s => ({ memberId: s.memberId, amount: s.amount })),
  )
}
