// src/features/expense/services/settlementRoutes.ts
// 付款建議（routed settlement）的 UI 領域層 — 純函式，無 side effect。
//
// 規劃演算法、形狀驗證、lineage 都在 @tripmate/settlement-core，Worker 用的是
// 同一份程式碼；這裡只做 client 需要的組裝：
//   planRouteSuggestions   簡化後的付款建議 + 每段 leg 預覽會清掉哪些費用
//   paymentRoute           「記錄收款」：把一筆真實付款映射到目前帳上的合法路徑
//   groupSettlementHistory 清算紀錄：同一個 route 的 legs 合併成一列
//   routeRole              目前使用者在 route 裡的角色（付款 / 收款 / 中間人 / 抵銷參與者）
//
// 一律吃 computeBalancesFull 回傳的 pairwise（normalized remaining）——與 Worker
// 計算 CAS 用的是同一份邊，所以建議與 Worker 的接受條件一致。
import {
  buildSettlementLineage,
  canonicalRouteLegs,
  isRouteCurrent,
  maxPayable,
  planSettlementRoutes,
  routeForPayment,
  routeLegId,
  type CoreSettlement,
  type LineageExpense,
  type OffsetRoute,
  type RouteLeg,
  type SettlementAppliedSource,
  type SettlementRoute,
  type TransferRoute,
} from '@tripmate/settlement-core'
import { memberItemContributions, type MaterializeAdjustment, type MaterializeItem } from '@tripmate/expense-materialize'
import type { Expense } from '@/types'
import type { SettlementRecord, SettlementRouteHeader } from '@/types/settlement'

type Pairwise = Record<string, Record<string, number>>

/** A route leg plus the expenses it would clear, previewed with the
 *  Worker's own lineage code against the current ledger. */
export interface PreviewLeg extends RouteLeg {
  sources: SettlementAppliedSource[]
}

export type RouteSuggestion =
  | (Omit<TransferRoute, 'legs'> & { legs: PreviewLeg[] })
  | (Omit<OffsetRoute, 'legs'> & { legs: PreviewLeg[] })

interface ClientLineageExpense extends LineageExpense {
  items?:      Array<MaterializeItem & { name: string }>
  adjustments: MaterializeAdjustment[]
}

function toLineageExpense(e: Expense): ClientLineageExpense {
  return {
    id:          e.id,
    title:       e.title,
    createdAtMs: e.createdAt?.toMillis?.() ?? 0,
    amountMinor: e.amountMinor,
    paidBy:      e.paidBy,
    splits:      e.splits,
    ...(e.items ? { items: e.items.map(i => ({ id: i.id, name: i.name, amountMinor: i.amountMinor, allocations: i.allocations })) } : {}),
    adjustments: e.adjustments ?? [],
  }
}

const attribute = (e: ClientLineageExpense, memberId: string) => memberItemContributions(e, memberId)

/** Which expenses each leg of `route` would clear, given the active
 *  expenses and settlements the pairwise ledger was computed from. */
export function previewRouteLegs(
  route:       SettlementRoute,
  expenses:    Expense[],
  settlements: SettlementRecord[],
): PreviewLeg[] {
  const active = expenses.filter(e => !e.deletedAt).map(toLineageExpense)
  const prior: CoreSettlement[] = settlements
    .filter(s => s.deletedAt === null)
    .map(s => ({ fromUid: s.fromUid, toUid: s.toUid, amountMinor: s.amountMinor, createdAtMs: s.createdAt?.toMillis?.() ?? 0 }))
  return canonicalRouteLegs(route.legs).map(leg => {
    const inPair = (a: string, b: string) => (a === leg.fromUid && b === leg.toUid) || (a === leg.toUid && b === leg.fromUid)
    const { appliedSources } = buildSettlementLineage(
      active.filter(e => e.paidBy === leg.fromUid || e.paidBy === leg.toUid),
      prior.filter(s => inPair(s.fromUid, s.toUid)),
      leg.fromUid,
      leg.toUid,
      leg.amountMinor,
      attribute,
    )
    return { ...leg, sources: appliedSources }
  })
}

/** The simplified suggestion list (offsets first, then transfers). */
export function planRouteSuggestions(
  pairwise:    Pairwise,
  expenses:    Expense[],
  settlements: SettlementRecord[],
): RouteSuggestion[] {
  return planSettlementRoutes(pairwise).map(route => ({
    ...route,
    legs: previewRouteLegs(route, expenses, settlements),
  }) as RouteSuggestion)
}

/** What the record sheet will actually send for "payer paid receiver
 *  amount": the planned route while it still matches the live ledger, else
 *  a fresh route on the live ledger (the suggestion went stale — replan, do
 *  not weaken the Worker's CAS). Null when the ledger can no longer explain
 *  that much; `maxPayable` then says how much it can. */
export function paymentRoute(
  pairwise:    Pairwise,
  payerUid:    string,
  receiverUid: string,
  amountMinor: number,
  planned?:    TransferRoute,
): TransferRoute | null {
  if (planned && planned.payerUid === payerUid && planned.receiverUid === receiverUid
      && planned.amountMinor === amountMinor && isRouteCurrent(planned, pairwise)) {
    return planned
  }
  return routeForPayment(pairwise, payerUid, receiverUid, amountMinor)
}

export { maxPayable }

/** Everyone who could currently be recorded as having paid `receiverUid`,
 *  with the most each payment could be. */
export function payersFor(pairwise: Pairwise, receiverUid: string, uids: string[]): Array<{ uid: string; maxMinor: number }> {
  return uids
    .filter(uid => uid !== receiverUid)
    .map(uid => ({ uid, maxMinor: maxPayable(pairwise, uid, receiverUid) }))
    .filter(p => p.maxMinor > 0)
}

// ─── Roles ────────────────────────────────────────────────────────

export type RouteRole =
  | { kind: 'payer' }
  | { kind: 'receiver' }
  /** Passed through: receivable from `fromUids` and payable to `toUids`
   *  both drop by `amountMinor`; net unchanged. */
  | { kind: 'intermediate'; amountMinor: number; fromUids: string[]; toUids: string[] }
  | { kind: 'offset' }
  | null

export function routeRole(
  route: { kind: 'TRANSFER' | 'OFFSET'; payerUid?: string; receiverUid?: string; legs: ReadonlyArray<{ fromUid: string; toUid: string; amountMinor: number }> },
  uid:   string | null,
): RouteRole {
  if (!uid) return null
  if (route.kind === 'TRANSFER' && route.payerUid === uid) return { kind: 'payer' }
  if (route.kind === 'TRANSFER' && route.receiverUid === uid) return { kind: 'receiver' }
  const incoming = route.legs.filter(l => l.toUid === uid)
  const outgoing = route.legs.filter(l => l.fromUid === uid)
  if (incoming.length === 0 && outgoing.length === 0) return null
  if (route.kind === 'OFFSET') return { kind: 'offset' }
  return {
    kind:        'intermediate',
    amountMinor: incoming.reduce((s, l) => s + l.amountMinor, 0),
    fromUids:    incoming.map(l => l.fromUid),
    toUids:      outgoing.map(l => l.toUid),
  }
}

// ─── History ──────────────────────────────────────────────────────

export type SettlementHistoryEntry =
  | { kind: 'single'; id: string; record: SettlementRecord }
  /** One logical route. `legs` are the ones currently visible, in leg
   *  order; `complete` is false while the listener has delivered only part
   *  of it (never cancel against a partial view — the Worker cancels the
   *  whole route anyway). */
  | { kind: 'route'; id: string; header: SettlementRouteHeader; legs: SettlementRecord[]; complete: boolean; settledBy: string; createdAtMs: number }

/** Group route legs into one entry per route, keep plain settlements as
 *  they are, newest first. Input order (createdAt desc) is preserved for
 *  ties so the list doesn't jump. */
export function groupSettlementHistory(settlements: SettlementRecord[]): SettlementHistoryEntry[] {
  const out: SettlementHistoryEntry[] = []
  const routes = new Map<string, Extract<SettlementHistoryEntry, { kind: 'route' }>>()
  for (const s of settlements) {
    if (!s.route) {
      out.push({ kind: 'single', id: s.id, record: s })
      continue
    }
    const existing = routes.get(s.route.id)
    if (existing) {
      existing.legs.push(s)
      if (s.route.legIndex === 0) existing.header = s.route
      continue
    }
    const entry = {
      kind:        'route' as const,
      id:          s.route.id,
      header:      s.route,
      legs:        [s],
      complete:    false,
      settledBy:   s.settledBy,
      createdAtMs: s.createdAt?.toMillis?.() ?? 0,
    }
    routes.set(s.route.id, entry)
    out.push(entry)
  }
  for (const entry of routes.values()) {
    entry.legs.sort((a, b) => (a.route!.legIndex - b.route!.legIndex))
    entry.complete = entry.legs.length === entry.header.legCount
  }
  return out
}

/** Every leg doc id of a route — what an optimistic cancel hides. */
export function routeLegIds(header: Pick<SettlementRouteHeader, 'id' | 'legCount'>): string[] {
  return Array.from({ length: header.legCount }, (_, i) => routeLegId(header.id, i))
}

// ─── Optimistic locks ─────────────────────────────────────────────

/** Conservative pending lock set for one leg: every active expense creating
 *  debt either way within the leg's pair. A superset of what the Worker
 *  will lock; the listener swaps in the exact set. */
export function pendingLegLocks(expenses: Expense[], leg: { fromUid: string; toUid: string }): string[] {
  return expenses
    .filter(e => !e.deletedAt)
    .filter(e =>
      (e.paidBy === leg.toUid   && e.splits.some(s => s.memberId === leg.fromUid)) ||
      (e.paidBy === leg.fromUid && e.splits.some(s => s.memberId === leg.toUid)))
    .map(e => e.id)
}
