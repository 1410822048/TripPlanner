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
// Money domain:
//   item.amountMinor is a POSITIVE integer minor-unit amount
//   (pre-discount item subtotal). Minor units: USD $12.34 = 1234,
//   JPY ¥1200 = 1200, TWD NT$100 = 100 (TWD treated as zero-fraction
//   per app convention).
//   adjustment.amountMinor is a POSITIVE integer minor-unit amount;
//   the sign of the effect on the expense comes from `adjustment.kind`.
//   DISCOUNT/COUPON/TAX_EXEMPT subtract; SURCHARGE/TAX/TIP add. OTHER
//   is treated as subtract by default — it's the "I don't know which"
//   escape hatch and most user-typed OTHER labels are correction-like
//   in practice. UI may gain an explicit signed `direction` field in a
//   later phase if that default is wrong often enough.

import { convertMinorHalfEven, allocateRoundingResidual } from '@tripmate/fx-core'

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
 *  ITEM or EXPENSE happens in the client form before save. The materializer
 *  throws if it ever sees UNKNOWN, so a forgotten downgrade in the
 *  write path surfaces loudly rather than silently materializing the
 *  wrong scope. */
export type AdjustmentScope = 'ITEM' | 'EXPENSE'

/** Minimum item shape the materializer needs. `id` is required at
 *  this layer — ITEM-scope adjustments target by id, and per-item
 *  effective amounts (after step 2) are keyed by id. Phase B made
 *  `ExpenseItem.id` required in the persisted schema as well, so
 *  callers no longer need a separate id-minting pass before invoking
 *  the materializer. */
export interface MaterializeItem {
  id:          string
  amountMinor: number   // positive integer minor units
  assignees:   string[] // memberIds; ≥1
}

/** Minimum adjustment shape. `targetItemId` is required iff
 *  `scope === 'ITEM'`; the materializer throws on either side of that
 *  bi-implication. */
export interface MaterializeAdjustment {
  id:            string
  kind:          AdjustmentKind
  scope:         AdjustmentScope
  amountMinor:   number      // positive integer minor units
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
  memberId:    string
  amountMinor: number   // signed integer minor units; non-zero
}

/** Per-item contribution before member-level aggregation. This is the
 *  same authoritative math as `materializeExpenseSplits`, but keeps the
 *  item id so settlement records can persist an audit snapshot of which
 *  receipt lines were cleared. */
export interface MaterializeSplitContribution {
  itemId:      string
  memberId:    string
  amountMinor: number
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
  // Foreign-currency conversion gate. Source-domain inputs to
  // `convertAndMaterializeFromSource` fail with these before any
  // fx-core math runs; once converted, the post-conversion items/
  // adjustments flow through the regular materializer and surface as
  // the codes above.
  | 'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER'
  | 'SOURCE_ITEM_NOT_POSITIVE_INTEGER'
  | 'SOURCE_ADJUSTMENT_NOT_POSITIVE_INTEGER'
  | 'SOURCE_SUM_MISMATCH'
  | 'SOURCE_SPLITS_EMPTY'
  | 'SOURCE_SPLIT_MEMBER_MISSING'
  | 'SOURCE_SPLIT_NOT_NONNEGATIVE_INTEGER'
  | 'DUPLICATE_SOURCE_SPLIT_MEMBER'
  | 'SOURCE_SPLIT_SUM_MISMATCH'

export class MaterializeError extends Error {
  // Field declared explicitly (not via `public code: ...` shorthand)
  // because the client's tsconfig enables `erasableSyntaxOnly`, which
  // forbids constructor parameter properties (TS-only sugar that
  // doesn't survive type erasure).
  readonly code: MaterializeErrorCode
  constructor(code: MaterializeErrorCode, message: string) {
    super(message)
    this.code = code
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

/**
 * Deterministic apportionment of an integer `total` over weighted items
 * using largest-remainder (Hamilton method). Tie-broken by ascending
 * index so client preview and Worker recompute land on the same byte
 * sequence even when ideal fractions collide. Array.prototype.sort is
 * stable since ES2019, and both runtimes are V8.
 *
 * When `caps` is provided, no allocation exceeds caps[i]: leftover
 * bumps skip saturated items. Used for negative-sign EXPENSE-scope
 * adjustments where each item's effective amount must stay non-negative
 * — without the cap, three ¥1 items + ¥2 discount degenerate into
 * base=[0,0,0] / remainder-on-last=[0,0,2] and rejects a legal apportion.
 * Positive-sign (SURCHARGE/TAX/TIP) callers omit caps — items can absorb
 * arbitrarily large additions.
 *
 * Precondition (enforced by caller):
 *   - total ≥ 0; every weights[i] > 0
 *   - When caps is provided: total ≤ Σ caps. The caller pre-checks this
 *     and throws a domain-specific error (OVER_DISCOUNT_EXPENSE in our
 *     case) so this helper stays algorithm-only.
 *
 * Returns alloc[] with alloc[i] ≥ 0; Σ alloc[i] === total when the
 * precondition holds, and alloc[i] ≤ caps[i] (when caps given).
 */
function apportionByWeight(
  total:   number,
  weights: number[],
  caps?:   number[],
): number[] {
  if (total === 0 || weights.length === 0) return weights.map(() => 0)
  const weightTotal = weights.reduce((s, w) => s + w, 0)

  const base       = new Array<number>(weights.length)
  const remainders: Array<{ idx: number; frac: number }> = []
  let baseSum = 0
  for (let i = 0; i < weights.length; i++) {
    const ideal = (total * weights[i]!) / weightTotal
    const b     = Math.floor(ideal)
    base[i]     = b
    baseSum    += b
    remainders.push({ idx: i, frac: ideal - b })
  }

  let leftover = total - baseSum
  if (leftover === 0) return base

  remainders.sort((a, b) => b.frac - a.frac || a.idx - b.idx)
  for (const { idx } of remainders) {
    if (leftover === 0) break
    if (caps !== undefined && base[idx]! >= caps[idx]!) continue
    base[idx] = base[idx]! + 1
    leftover -= 1
  }
  return base
}

/** Deterministic equal split for integer minor-unit amounts. Mirrors
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
    memberId:    id,
    amountMinor: sign * (base + (i < rem ? 1 : 0)),
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
 *      step 2). Apportionment uses largest-remainder (Hamilton),
 *      tie-broken by ascending item index. Negative deltas (discounts)
 *      cap each per-item allocation at the item's effective amount;
 *      a negative aggregate exceeding total weight throws
 *      OVER_DISCOUNT_EXPENSE upfront. Positive deltas (surcharges)
 *      have no per-item cap.
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
export function materializeExpenseSplitContributions(input: MaterializeInput): MaterializeSplitContribution[] {
  const { items, adjustments, members } = input

  // Step 1: validate items. amountMinor is integer minor units — we
  // require `Number.isInteger` so a payload that ships fractional
  // values (a Phase-B bug, a hand-edited Firestore doc, a botched
  // currency conversion) fails loudly here instead of being silently
  // rounded inside `splitEqually`.
  const itemById = new Map<string, MaterializeItem>()
  const memberSet = new Set(members)
  for (const item of items) {
    if (!Number.isInteger(item.amountMinor) || item.amountMinor <= 0) {
      throw new MaterializeError(
        'ITEM_NOT_POSITIVE_INTEGER',
        `item ${item.id}: amountMinor must be a positive integer minor-unit amount, got ${item.amountMinor}`,
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
    // share grows by `amountMinor / assignees.length` per duplicate,
    // biasing allocation while still passing the member-membership
    // check. The Worker authoritative recompute makes that bias
    // server-canonical, so the gate has to live here before split math
    // runs.
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
  for (const item of items) itemEffective.set(item.id, item.amountMinor)

  for (const adj of adjustments) {
    if (!Number.isInteger(adj.amountMinor) || adj.amountMinor <= 0) {
      throw new MaterializeError(
        'ADJUSTMENT_NOT_POSITIVE_INTEGER',
        `adjustment ${adj.id}: amountMinor must be a positive integer minor-unit amount, got ${adj.amountMinor}`,
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
      const delta = adjustmentSign(adj.kind) * adj.amountMinor
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
    .reduce((sum, a) => sum + adjustmentSign(a.kind) * a.amountMinor, 0)

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
    const sign     = expenseNetDelta < 0 ? -1 : 1
    // adj.amountMinor validated as integer above, so expenseNetDelta is
    // an integer sum — no Math.round normalisation needed.
    const absDelta = Math.abs(expenseNetDelta)
    // Negative aggregate cannot exceed total weight. Pre-checking up
    // front (rather than discovering the violation in the middle of
    // apportionment) keeps the helper algorithm-only and surfaces the
    // domain error at the layer that owns it.
    if (sign < 0 && absDelta > weightTotal) {
      throw new MaterializeError(
        'OVER_DISCOUNT_EXPENSE',
        `expense-scope discount ${absDelta} exceeds available item total ${weightTotal}`,
      )
    }
    const weights = weightedItems.map(i => itemEffective.get(i.id) ?? 0)
    // Caps only matter for discounts; surcharges can grow items without
    // bound (a 100% TIP on a ¥500 item lands a +500 alloc cleanly).
    const caps  = sign < 0 ? weights.slice() : undefined
    const alloc = apportionByWeight(absDelta, weights, caps)
    for (let i = 0; i < weightedItems.length; i++) {
      const item = weightedItems[i]!
      const cur  = itemEffective.get(item.id) ?? 0
      itemEffective.set(item.id, cur + sign * alloc[i]!)
    }
  }

  // Step 4: split each item's effective amount across its assignees,
  // aggregate per-member. Preserve `members` order in the output so
  // both sides serialize identically.
  const contributions: MaterializeSplitContribution[] = []
  for (const item of items) {
    const effective = itemEffective.get(item.id) ?? 0
    if (effective === 0) continue
    const splits = splitEqually(effective, item.assignees)
    for (const { memberId, amountMinor } of splits) {
      contributions.push({ itemId: item.id, memberId, amountMinor })
    }
  }
  return contributions
}

export function materializeExpenseSplits(input: MaterializeInput): MaterializeSplit[] {
  const contributions = materializeExpenseSplitContributions(input)
  const memberTotals = new Map<string, number>()
  for (const { memberId, amountMinor } of contributions) {
    memberTotals.set(memberId, (memberTotals.get(memberId) ?? 0) + amountMinor)
  }

  // Step 5: project onto `members` input order, drop zero totals.
  const out: MaterializeSplit[] = []
  for (const uid of input.members) {
    const total = memberTotals.get(uid) ?? 0
    if (total !== 0) out.push({ memberId: uid, amountMinor: total })
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
      .filter(s => s.amountMinor !== 0)
      .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
      .map(s => ({ memberId: s.memberId, amountMinor: s.amountMinor })),
  )
}

// ─── Source-domain conversion + materialization ───────────────────
//
// Pure helper consumed by the Worker's foreign-mode router
// (workers/ocr/src/expense-write.ts) on every foreign-currency expense
// create + money/date update. Keeping per-line allocation here keeps
// the financial attribution boundary Worker-authoritative — a
// totals-only validation would let an attacker rearrange
// item→assignee mapping while keeping the source total constant,
// biasing settlement debt edges.
// See memory: per-line-authority-over-totals-only-validation.

/** Item shape in source currency. `amountMinor` is integer minor units
 *  in the SOURCE currency (e.g. USD cents) — the conversion pipeline
 *  re-expresses it in TRIP currency before invoking the materializer. */
export interface ConvertAndMaterializeSourceItem {
  id:          string
  amountMinor: number   // positive integer source-currency minor units
  assignees:   string[]
}

/** Adjustment shape in source currency. Sign comes from `kind` exactly
 *  like the materializer's `MaterializeAdjustment`; this layer adds
 *  nothing semantic, only changes the currency basis of `amountMinor`. */
export interface ConvertAndMaterializeSourceAdjustment {
  id:            string
  kind:          AdjustmentKind
  scope:         AdjustmentScope
  amountMinor:   number   // positive integer source-currency minor units
  targetItemId?: string
}

export interface ConvertSourceLineItem {
  id:          string
  amountMinor: number
}

export interface ConvertSourceLineAdjustment {
  id:            string
  kind:          AdjustmentKind
  scope:         AdjustmentScope
  amountMinor:   number
  targetItemId?: string
}

export interface ConvertSourceLinesToTargetInput {
  sourceItems:          ConvertSourceLineItem[]
  sourceAdjustments:    ConvertSourceLineAdjustment[]
  sourceAmountMinor:    number
  rateDecimal:          string
  sourceFractionDigits: number
  targetFractionDigits: number
}

export interface ConvertSourceLinesToTargetResult {
  amountMinor:  number
  items:        ConvertSourceLineItem[]
  adjustments:  ConvertSourceLineAdjustment[]
}

export interface ConvertSourceSplit {
  memberId:    string
  amountMinor: number
}

export interface ConvertSourceSplitsToTargetInput {
  sourceSplits:          ConvertSourceSplit[]
  sourceAmountMinor:     number
  rateDecimal:           string
  sourceFractionDigits:  number
  targetFractionDigits:  number
}

export interface ConvertSourceSplitsToTargetResult {
  amountMinor: number
  splits:      MaterializeSplit[]
}

export interface ConvertAndMaterializeFromSourceInput {
  sourceItems:          ConvertAndMaterializeSourceItem[]
  sourceAdjustments:    ConvertAndMaterializeSourceAdjustment[]
  /** Authoritative source-currency total of the receipt. Must equal
   *  Σ sourceItems.amountMinor + sign(adj.kind) × Σ sourceAdjustments.amountMinor;
   *  mismatch → SOURCE_SUM_MISMATCH at the boundary. */
  sourceAmountMinor:    number
  /** Canonical decimal string per fx-core::isCanonicalRateString. */
  rateDecimal:          string
  sourceFractionDigits: number
  targetFractionDigits: number
  members:              string[]
}

export interface ConvertAndMaterializeFromSourceResult {
  /** Trip-currency total — converted from sourceAmountMinor via half-even
   *  rounding; equal to Σ items.amountMinor + sign × Σ adjustments.amountMinor
   *  by construction (rounding residual lands on the largest item). */
  amountMinor: number
  /** Trip-currency items. amountMinor on each line is positive integer
   *  trip-currency minor units; the LARGEST line absorbs any rounding
   *  residual so the materializer's pre-adjustment sum reconciles
   *  against the authoritative converted total. */
  items:       MaterializeItem[]
  /** Trip-currency adjustments. Each amountMinor is independently
   *  converted; no residual is applied here (residual lands on items
   *  by design — discounts/tips drift ±1 minor across thousands of
   *  expenses biases line-item display worse than absorbing on items). */
  adjustments: MaterializeAdjustment[]
  /** Per-member splits derived from the trip-currency items+adjustments
   *  via `materializeExpenseSplits`. Σ splits === amountMinor. */
  splits:      MaterializeSplit[]
}

/**
 * Convert source-currency items+adjustments to trip currency and
 * materialize splits in one pass. The output is the canonical
 * trip-currency expense shape — caller (Phase 3b Worker handler) writes
 * `amountMinor / items / adjustments / splits` directly into Firestore
 * and persists the FxSnapshot separately for audit.
 *
 * Pipeline:
 *   1. Validate source-domain self-consistency (positive integers +
 *      Σ items + signed Σ adjustments === sourceAmountMinor).
 *   2. Convert sourceAmountMinor → tripAmountMinor (authoritative).
 *   3. Convert each item.amountMinor + adjustment.amountMinor
 *      independently via `convertMinorHalfEven`.
 *   4. Compute signedAdjustmentSumTrip = Σ sign(kind) × tripAdjMinor.
 *   5. expectedItemSum = tripAmountMinor - signedAdjustmentSumTrip;
 *      reconcile per-line items via `allocateRoundingResidual` so
 *      Σ tripItems === expectedItemSum (residual lands on largest item).
 *   6. Run `materializeExpenseSplits` over the trip-currency
 *      items+adjustments+members to derive splits.
 *
 * Determinism: identical inputs → identical bytes on every call. Both
 * the client preview (Phase 3c) and the Worker authoritative recompute
 * (Phase 3b) call this exact function; preview is display-only,
 * Worker overwrites whatever the client sent.
 */
export function convertSourceLinesToTarget(
  input: ConvertSourceLinesToTargetInput,
): ConvertSourceLinesToTargetResult {
  const {
    sourceItems, sourceAdjustments, sourceAmountMinor,
    rateDecimal, sourceFractionDigits, targetFractionDigits,
  } = input

  // Step 1a: source-domain positive-integer gates. We re-validate here
  // (the Worker Zod schema in expense-validate.ts already enforces
  // these at the boundary) because the function is shared with the
  // client preview path — preview callers don't run through Zod and we
  // don't want preview to silently produce garbage on a malformed
  // input. Defense-in-depth without duplicating per-field error codes.
  if (!Number.isInteger(sourceAmountMinor) || sourceAmountMinor <= 0) {
    throw new MaterializeError(
      'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER',
      `sourceAmountMinor must be a positive integer, got ${sourceAmountMinor}`,
    )
  }
  for (const item of sourceItems) {
    if (!Number.isInteger(item.amountMinor) || item.amountMinor <= 0) {
      throw new MaterializeError(
        'SOURCE_ITEM_NOT_POSITIVE_INTEGER',
        `source item ${item.id}: amountMinor must be a positive integer source-currency minor amount, got ${item.amountMinor}`,
      )
    }
  }
  for (const adj of sourceAdjustments) {
    if (!Number.isInteger(adj.amountMinor) || adj.amountMinor <= 0) {
      throw new MaterializeError(
        'SOURCE_ADJUSTMENT_NOT_POSITIVE_INTEGER',
        `source adjustment ${adj.id}: amountMinor must be a positive integer source-currency minor amount, got ${adj.amountMinor}`,
      )
    }
  }

  // Step 1b: source-sum reconciliation. The receipt's printed total
  // (sourceAmountMinor) must equal items + signed adjustments. A mismatch
  // here means the client lied or the OCR draft is internally
  // inconsistent — refuse to proceed so the Worker doesn't paper over
  // the inconsistency by silently rebalancing during conversion.
  let signedSourceAdjSum = 0
  for (const adj of sourceAdjustments) {
    signedSourceAdjSum += adjustmentSign(adj.kind) * adj.amountMinor
  }
  let sourceItemSum = 0
  for (const item of sourceItems) sourceItemSum += item.amountMinor
  if (sourceItemSum + signedSourceAdjSum !== sourceAmountMinor) {
    throw new MaterializeError(
      'SOURCE_SUM_MISMATCH',
      `source items (${sourceItemSum}) + signed source adjustments (${signedSourceAdjSum}) must equal sourceAmountMinor (${sourceAmountMinor})`,
    )
  }

  // Step 2: authoritative total conversion.
  const tripAmountMinor = convertMinorHalfEven({
    sourceMinor: sourceAmountMinor,
    rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
  })

  // Step 3: per-line conversion. Items and adjustments use the SAME
  // rateDecimal so a single fxSnapshot covers the entire expense and
  // replay (cache rateDecimal → reconvert) produces the same bytes.
  const tripItemRaw = sourceItems.map(item => convertMinorHalfEven({
    sourceMinor: item.amountMinor,
    rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
  }))
  const tripAdjMinor = sourceAdjustments.map(adj => convertMinorHalfEven({
    sourceMinor: adj.amountMinor,
    rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
  }))

  // Step 4: signed sum of adjustments in trip currency. Sign is purely
  // a function of `kind`, not of the converted minor value.
  let signedTripAdjSum = 0
  for (let i = 0; i < sourceAdjustments.length; i++) {
    signedTripAdjSum += adjustmentSign(sourceAdjustments[i]!.kind) * tripAdjMinor[i]!
  }

  // Step 5: reconcile per-item sum. We need
  //   Σ tripItems + signedTripAdjSum === tripAmountMinor
  // so the expected per-item sum is `tripAmountMinor - signedTripAdjSum`.
  // `allocateRoundingResidual` puts the drift on the LARGEST line —
  // tie-broken by first index — which keeps relative distortion minimal
  // and is deterministic for client/Worker parity.
  const expectedItemSum = tripAmountMinor - signedTripAdjSum
  const tripItemMinor   = allocateRoundingResidual({
    lines:       tripItemRaw,
    targetTotal: expectedItemSum,
  })

  // Step 6: build trip-currency materializer inputs and delegate to
  // the canonical split gate. The materializer rejects any item that
  // ended up ≤ 0 after residual allocation (an over-discounted receipt
  // converted into too-small minor units, or a SOURCE input where
  // adjustments dominate items) via ITEM_NOT_POSITIVE_INTEGER —
  // the Worker maps that to the same ExpenseValidationError path so
  // the operator sees one error class instead of two.
  const tripItems: ConvertSourceLineItem[] = sourceItems.map((item, i) => ({
    id:          item.id,
    amountMinor: tripItemMinor[i]!,
  }))
  const tripAdjustments: ConvertSourceLineAdjustment[] = sourceAdjustments.map((adj, i) => ({
    id:           adj.id,
    kind:         adj.kind,
    scope:        adj.scope,
    amountMinor:  tripAdjMinor[i]!,
    targetItemId: adj.targetItemId,
  }))

  return {
    amountMinor: tripAmountMinor,
    items:       tripItems,
    adjustments: tripAdjustments,
  }
}

/**
 * Convert manual foreign-currency split totals to trip currency without
 * manufacturing visible line items. This is the source-domain equivalent
 * of "manual total split": the user only entered a total and per-member
 * shares, so there is no receipt item to persist or render.
 *
 * The split sum is validated in source currency first. Each split is then
 * converted independently and reconciled to the authoritative converted
 * receipt total via largest-line residual allocation, keeping the Worker
 * authoritative while preserving the user's split proportions.
 */
export function convertSourceSplitsToTarget(
  input: ConvertSourceSplitsToTargetInput,
): ConvertSourceSplitsToTargetResult {
  const {
    sourceSplits, sourceAmountMinor, rateDecimal,
    sourceFractionDigits, targetFractionDigits,
  } = input

  if (!Number.isInteger(sourceAmountMinor) || sourceAmountMinor <= 0) {
    throw new MaterializeError(
      'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER',
      `sourceAmountMinor must be a positive integer, got ${sourceAmountMinor}`,
    )
  }
  if (sourceSplits.length === 0) {
    throw new MaterializeError(
      'SOURCE_SPLITS_EMPTY',
      'sourceSplits must contain at least one split',
    )
  }

  const seen = new Set<string>()
  let sourceSplitSum = 0
  for (const split of sourceSplits) {
    if (!split.memberId) {
      throw new MaterializeError(
        'SOURCE_SPLIT_MEMBER_MISSING',
        'source split memberId is required',
      )
    }
    if (seen.has(split.memberId)) {
      throw new MaterializeError(
        'DUPLICATE_SOURCE_SPLIT_MEMBER',
        `source split member ${split.memberId} appears more than once`,
      )
    }
    seen.add(split.memberId)

    if (!Number.isInteger(split.amountMinor) || split.amountMinor < 0) {
      throw new MaterializeError(
        'SOURCE_SPLIT_NOT_NONNEGATIVE_INTEGER',
        `source split ${split.memberId}: amountMinor must be a non-negative integer source-currency minor amount, got ${split.amountMinor}`,
      )
    }
    sourceSplitSum += split.amountMinor
  }
  if (sourceSplitSum !== sourceAmountMinor) {
    throw new MaterializeError(
      'SOURCE_SPLIT_SUM_MISMATCH',
      `source splits (${sourceSplitSum}) must equal sourceAmountMinor (${sourceAmountMinor})`,
    )
  }

  const tripAmountMinor = convertMinorHalfEven({
    sourceMinor: sourceAmountMinor,
    rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
  })
  const rawTripSplits = sourceSplits.map(split => convertMinorHalfEven({
    sourceMinor: split.amountMinor,
    rateDecimal,
    sourceFractionDigits,
    targetFractionDigits,
  }))
  const tripSplits = allocateRoundingResidual({
    lines:       rawTripSplits,
    targetTotal: tripAmountMinor,
  })

  return {
    amountMinor: tripAmountMinor,
    splits: sourceSplits
      .map((split, i) => ({ memberId: split.memberId, amountMinor: tripSplits[i]! })),
  }
}

export function convertAndMaterializeFromSource(
  input: ConvertAndMaterializeFromSourceInput,
): ConvertAndMaterializeFromSourceResult {
  const converted = convertSourceLinesToTarget({
    sourceItems:          input.sourceItems,
    sourceAdjustments:    input.sourceAdjustments,
    sourceAmountMinor:    input.sourceAmountMinor,
    rateDecimal:          input.rateDecimal,
    sourceFractionDigits: input.sourceFractionDigits,
    targetFractionDigits: input.targetFractionDigits,
  })

  const tripItems: MaterializeItem[] = converted.items.map((item, i) => ({
    id:          item.id,
    amountMinor: item.amountMinor,
    assignees:   input.sourceItems[i]!.assignees,
  }))
  const tripAdjustments: MaterializeAdjustment[] = converted.adjustments.map(adj => ({
    id:           adj.id,
    kind:         adj.kind,
    scope:        adj.scope,
    amountMinor:  adj.amountMinor,
    targetItemId: adj.targetItemId,
  }))

  const splits = materializeExpenseSplits({
    items:       tripItems,
    adjustments: tripAdjustments,
    members:     input.members,
  })

  return {
    amountMinor: converted.amountMinor,
    items:       tripItems,
    adjustments: tripAdjustments,
    splits,
  }
}
