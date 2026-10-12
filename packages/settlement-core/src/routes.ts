// Routed settlement planning — multi-hop debt simplification.
//
// A simplified transfer ("A pays C, via B") is recorded as a set of ordinary
// pair settlements (legs) on REAL debt edges, so every unit still lands on a
// pairwise edge the rest of this package already understands. This module
// only plans and shape-checks those leg sets; it never invents an edge.
//
//   planSettlementRoutes(pairwise)   suggestions: cycle offsets + transfers
//   routeForPayment(pairwise, …)     route an arbitrary "P paid R amount"
//   validateRouteShape(route)        structural invariants (shared with the
//                                    Worker, which ALSO checks capacity)
//
// Input is the normalized pairwise remaining from computePairwiseRemaining:
// at most one direction per unordered pair, integer minor units.
//
// See docs/design/settlement-debt-simplification.md.
import { SETTLEMENT_EPS, canonicalPairKey } from './index'

/** One pair settlement inside a route. `expectedRemainingMinor` is the
 *  edge's normalized remaining when the route was planned — the Worker's
 *  per-edge CAS. */
export interface RouteLeg {
  fromUid:                string
  toUid:                  string
  amountMinor:            number
  expectedRemainingMinor: number
}

/** Money actually moves payer → receiver; intermediates net to zero. */
export interface TransferRoute {
  kind:        'TRANSFER'
  payerUid:    string
  receiverUid: string
  amountMinor: number
  legs:        RouteLeg[]
}

/** A debt cycle cleared with no money moving; every participant nets to 0. */
export interface OffsetRoute {
  kind:            'OFFSET'
  /** Sorted. */
  participantUids: string[]
  /** The amount cleared on every edge of the cycle. */
  amountMinor:     number
  legs:            RouteLeg[]
}

export type SettlementRoute = TransferRoute | OffsetRoute

type Graph = Map<string, Map<string, number>>

/** Hard cap on legs per route: one per edge of a 10-person trip (C(10,2)). */
export const MAX_ROUTE_LEGS = 45

const positive = (n: number) => n > SETTLEMENT_EPS

function toGraph(pairwise: Record<string, Record<string, number>>): Graph {
  const g: Graph = new Map()
  for (const from of Object.keys(pairwise).sort()) {
    for (const to of Object.keys(pairwise[from]!).sort()) {
      const amount = pairwise[from]![to]!
      if (from === to || !positive(amount)) continue
      if (!g.has(from)) g.set(from, new Map())
      g.get(from)!.set(to, amount)
    }
  }
  return g
}

function capacity(g: Graph, from: string, to: string): number {
  return g.get(from)?.get(to) ?? 0
}

function subtract(g: Graph, from: string, to: string, amount: number): void {
  const row = g.get(from)
  if (!row) return
  const rest = (row.get(to) ?? 0) - amount
  if (positive(rest)) row.set(to, rest)
  else row.delete(to)
  if (row.size === 0) g.delete(from)
}

/** Sorted neighbours with remaining capacity — every traversal is
 *  deterministic, so the same ledger always yields the same plan. */
function neighbours(g: Graph, from: string): string[] {
  return [...(g.get(from)?.keys() ?? [])].sort()
}

function nodesOf(g: Graph): string[] {
  const set = new Set<string>()
  for (const [from, row] of g) {
    set.add(from)
    for (const to of row.keys()) set.add(to)
  }
  return [...set].sort()
}

/** Net position per person: positive = owed money (creditor). */
function netOf(g: Graph): Map<string, number> {
  const net = new Map<string, number>()
  for (const [from, row] of g) {
    for (const [to, amount] of row) {
      net.set(from, (net.get(from) ?? 0) - amount)
      net.set(to,   (net.get(to)   ?? 0) + amount)
    }
  }
  return net
}

function legsFrom(
  flow:     Map<string, number>,
  original: Graph,
): RouteLeg[] {
  return [...flow.entries()]
    .filter(([, amount]) => positive(amount))
    .map(([key, amount]) => {
      const [fromUid, toUid] = key.split('\u0000') as [string, string]
      return { fromUid, toUid, amountMinor: amount, expectedRemainingMinor: capacity(original, fromUid, toUid) }
    })
    .sort((a, b) => a.fromUid.localeCompare(b.fromUid) || a.toUid.localeCompare(b.toUid))
}

const edgeKey = (from: string, to: string) => `${from}\u0000${to}`

// ─── Cycle cancellation ────────────────────────────────────────────

/** First directed cycle reachable in sorted DFS order, as a node list
 *  [a, b, …, a]; null when the graph is acyclic. */
function findCycle(g: Graph): string[] | null {
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of neighbours(g, node)) {
      const s = state.get(next)
      if (s === 'open') return [...stack.slice(stack.indexOf(next)), next]
      if (s === undefined) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of nodesOf(g)) {
    if (state.has(node)) continue
    const found = visit(node)
    if (found) return found
  }
  return null
}

/** Strip every cycle out of `g` (mutated), one OFFSET route per cycle. */
function cancelCycles(g: Graph, original: Graph): OffsetRoute[] {
  const offsets: OffsetRoute[] = []
  for (let cycle = findCycle(g); cycle; cycle = findCycle(g)) {
    const edges = cycle.slice(0, -1).map((from, i) => [from, cycle[i + 1]!] as const)
    const amount = Math.min(...edges.map(([from, to]) => capacity(g, from, to)))
    const flow = new Map<string, number>()
    for (const [from, to] of edges) {
      subtract(g, from, to, amount)
      flow.set(edgeKey(from, to), amount)
    }
    offsets.push({
      kind:            'OFFSET',
      participantUids: [...new Set(cycle)].sort(),
      amountMinor:     amount,
      legs:            legsFrom(flow, original),
    })
  }
  return offsets
}

// ─── Max-flow (Edmonds–Karp on the debt graph) ─────────────────────

/** Push up to `limit` from `source` to `sink` along debt edges. Returns the
 *  per-edge flow (edges keyed from→to) and the amount pushed. `g` is not
 *  mutated. Residual reverse edges may cancel earlier flow, but the net
 *  per-edge flow always stays within [0, capacity]. */
function maxFlow(
  g:      Graph,
  source: string,
  sink:   string,
  limit:  number,
): { flow: Map<string, number>; amount: number } {
  const flow = new Map<string, number>()
  const residual = (from: string, to: string) =>
    capacity(g, from, to) - (flow.get(edgeKey(from, to)) ?? 0) + (flow.get(edgeKey(to, from)) ?? 0)
  const nodes = nodesOf(g)
  let pushed = 0
  while (positive(limit - pushed)) {
    // BFS over residual edges, sorted for determinism.
    const parent = new Map<string, string>([[source, source]])
    const queue = [source]
    while (queue.length > 0 && !parent.has(sink)) {
      const node = queue.shift()!
      for (const next of nodes) {
        if (parent.has(next) || next === node) continue
        if (positive(residual(node, next))) {
          parent.set(next, node)
          queue.push(next)
        }
      }
    }
    if (!parent.has(sink)) break
    const path: string[] = [sink]
    while (path[0] !== source) path.unshift(parent.get(path[0]!)!)
    let bottleneck = limit - pushed
    for (let i = 0; i < path.length - 1; i++) bottleneck = Math.min(bottleneck, residual(path[i]!, path[i + 1]!))
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!, to = path[i + 1]!
      // Cancel opposite flow first, then add forward flow.
      const back = flow.get(edgeKey(to, from)) ?? 0
      const cancel = Math.min(back, bottleneck)
      if (cancel > 0) flow.set(edgeKey(to, from), back - cancel)
      if (bottleneck - cancel > 0) flow.set(edgeKey(from, to), (flow.get(edgeKey(from, to)) ?? 0) + bottleneck - cancel)
    }
    pushed += bottleneck
  }
  return { flow, amount: pushed }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Plan the suggestion list: at most one OFFSET (all cycles together), then
 * the transfers.
 *
 * Transfers come first: repeatedly pick, over every (debtor, creditor)
 * pair, the routable transfer that zeroes a whole person, else the largest
 * one — amount = min(debtor net, creditor net, max-flow on real edges). By
 * flow decomposition a debtor always reaches some creditor, so each round
 * moves a positive amount and the loop ends with every net at zero. What
 * is left is a pure circulation, cleared by one merged OFFSET.
 *
 * Doing transfers before cancelling cycles matters: cancelling first
 * destroys edges the transfers could have used, and leaves one offset per
 * cycle for someone to confirm (measured on random 10-person trips: ~16 →
 * ~11 transfers, ~8 → ≤1 offsets).
 *
 * Not guaranteed minimal — that is NP-hard in general, and transfers are
 * further restricted to real debt edges (the traceability requirement) —
 * but never more transfers than pairwise listing.
 */
export function planSettlementRoutes(
  pairwise: Record<string, Record<string, number>>,
): SettlementRoute[] {
  const original = toGraph(pairwise)
  const g = toGraph(pairwise)
  const routes: SettlementRoute[] = []

  for (let guard = 0; guard < 10_000 && g.size > 0; guard++) {
    const net = netOf(g)
    const debtors = [...net.entries()]
      .filter(([, n]) => n < -SETTLEMENT_EPS)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    const creditors = [...net.entries()]
      .filter(([, n]) => n > SETTLEMENT_EPS)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (debtors.length === 0) break

    // Prefer a transfer that zeroes a whole person (fewest transfers left),
    // then the largest amount; ties fall to uid order for determinism.
    let best: { payer: string; receiver: string; flow: Map<string, number>; amount: number; closes: boolean } | null = null
    for (const [debtor, debtorNet] of debtors) {
      for (const [creditor, creditorNet] of creditors) {
        const want = Math.min(-debtorNet, creditorNet)
        const { flow, amount } = maxFlow(g, debtor, creditor, want)
        if (!positive(amount)) continue
        const closes = amount === want
        if (!best || (closes && !best.closes) || (closes === best.closes && amount > best.amount)) {
          best = { payer: debtor, receiver: creditor, flow, amount, closes }
        }
      }
    }
    if (!best) break   // unreachable by conservation; defensive
    const debtor = best.payer

    for (const [key, amount] of best.flow) {
      if (!positive(amount)) continue
      const [from, to] = key.split('\u0000') as [string, string]
      subtract(g, from, to, amount)
    }
    routes.push({
      kind:        'TRANSFER',
      payerUid:    debtor,
      receiverUid: best.receiver,
      amountMinor: best.amount,
      legs:        legsFrom(best.flow, original),
    })
  }

  // Whatever is left once nobody owes on net is a pure circulation.
  const offset = mergeOffsets(cancelCycles(g, original))
  return [...(offset ? [offset] : []), ...mergeTransfers(routes)]
}

/** Fold transfers with the same payer and receiver into one. Their legs
 *  were planned on a shrinking graph, so the merged per-edge amounts still
 *  fit within the original remaining. */
function mergeTransfers(routes: SettlementRoute[]): SettlementRoute[] {
  const out: SettlementRoute[] = []
  const byPair = new Map<string, TransferRoute>()
  for (const r of routes) {
    if (r.kind === 'OFFSET') { out.push(r); continue }
    const key = edgeKey(r.payerUid, r.receiverUid)
    const prev = byPair.get(key)
    if (!prev) {
      const copy: TransferRoute = { ...r, legs: r.legs.map(l => ({ ...l })) }
      byPair.set(key, copy)
      out.push(copy)
      continue
    }
    prev.amountMinor += r.amountMinor
    for (const leg of r.legs) {
      const same = prev.legs.find(l => l.fromUid === leg.fromUid && l.toUid === leg.toUid)
      if (same) same.amountMinor += leg.amountMinor
      else prev.legs.push({ ...leg })
    }
    prev.legs.sort((a, b) => a.fromUid.localeCompare(b.fromUid) || a.toUid.localeCompare(b.toUid))
  }
  return out
}

/**
 * Route "payer paid receiver `amountMinor`" on the current debt graph — the
 * receiver's escape hatch when the money was paid against a suggestion that
 * has since been re-planned. Null when the debt graph cannot carry that
 * much from payer to receiver.
 */
export function routeForPayment(
  pairwise:    Record<string, Record<string, number>>,
  payerUid:    string,
  receiverUid: string,
  amountMinor: number,
): TransferRoute | null {
  if (payerUid === receiverUid || !positive(amountMinor)) return null
  const g = toGraph(pairwise)
  const { flow, amount } = maxFlow(g, payerUid, receiverUid, amountMinor)
  if (amount < amountMinor) return null
  return { kind: 'TRANSFER', payerUid, receiverUid, amountMinor, legs: legsFrom(flow, g) }
}

/** The most `payerUid` can currently settle with `receiverUid` through the
 *  debt graph (0 when unreachable). Drives the amount cap in the UI. */
export function maxPayable(
  pairwise:    Record<string, Record<string, number>>,
  payerUid:    string,
  receiverUid: string,
): number {
  if (payerUid === receiverUid) return 0
  const g = toGraph(pairwise)
  return maxFlow(g, payerUid, receiverUid, Number.MAX_SAFE_INTEGER).amount
}

export type RouteShapeError =
  | 'NO_LEGS'
  | 'TOO_MANY_LEGS'
  | 'BAD_AMOUNT'
  | 'SELF_LEG'
  | 'DUPLICATE_PAIR'
  | 'NOT_CONSERVED'
  | 'BAD_ENDPOINTS'

/**
 * Structural invariants of a route, independent of the ledger. The Worker
 * runs this AND checks every leg against the live remaining (capacity +
 * expectedRemainingMinor CAS) inside its transaction.
 *
 *   - 1..MAX_ROUTE_LEGS legs, positive integer amounts, no self legs
 *   - at most one leg per unordered pair (no A→B together with B→A)
 *   - flow conservation: TRANSFER — payer −amount, receiver +amount,
 *     everyone else 0; OFFSET — everyone 0
 */
export function validateRouteShape(
  route:
    | { kind: 'TRANSFER'; payerUid: string; receiverUid: string; amountMinor: number; legs: Pick<RouteLeg, 'fromUid' | 'toUid' | 'amountMinor'>[] }
    | { kind: 'OFFSET'; legs: Pick<RouteLeg, 'fromUid' | 'toUid' | 'amountMinor'>[] },
): RouteShapeError | null {
  const { legs } = route
  if (legs.length === 0) return 'NO_LEGS'
  if (legs.length > MAX_ROUTE_LEGS) return 'TOO_MANY_LEGS'
  const pairs = new Set<string>()
  const net = new Map<string, number>()
  for (const leg of legs) {
    if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor <= 0) return 'BAD_AMOUNT'
    if (leg.fromUid === leg.toUid) return 'SELF_LEG'
    const key = canonicalPairKey(leg.fromUid, leg.toUid)
    if (pairs.has(key)) return 'DUPLICATE_PAIR'
    pairs.add(key)
    net.set(leg.fromUid, (net.get(leg.fromUid) ?? 0) - leg.amountMinor)
    net.set(leg.toUid,   (net.get(leg.toUid)   ?? 0) + leg.amountMinor)
  }
  if (route.kind === 'TRANSFER') {
    if (route.payerUid === route.receiverUid) return 'BAD_ENDPOINTS'
    if (!Number.isSafeInteger(route.amountMinor) || route.amountMinor <= 0) return 'BAD_AMOUNT'
    for (const [uid, n] of net) {
      const expected =
        uid === route.payerUid    ? -route.amountMinor
        : uid === route.receiverUid ? route.amountMinor
        : 0
      if (n !== expected) return 'NOT_CONSERVED'
    }
    if (!net.has(route.payerUid) || !net.has(route.receiverUid)) return 'BAD_ENDPOINTS'
    return null
  }
  for (const n of net.values()) if (n !== 0) return 'NOT_CONSERVED'
  return null
}

/** All cycle offsets as one route: nobody's net moves, so one confirmation
 *  clears every cycle instead of one tap per cycle. */
function mergeOffsets(offsets: OffsetRoute[]): OffsetRoute | null {
  if (offsets.length === 0) return null
  const legs = new Map<string, RouteLeg>()
  for (const o of offsets) {
    for (const leg of o.legs) {
      const key = edgeKey(leg.fromUid, leg.toUid)
      const prev = legs.get(key)
      if (prev) prev.amountMinor += leg.amountMinor
      else legs.set(key, { ...leg })
    }
  }
  return {
    kind:            'OFFSET',
    participantUids: [...new Set(offsets.flatMap(o => o.participantUids))].sort(),
    amountMinor:     Math.max(...[...legs.values()].map(l => l.amountMinor)),
    legs:            [...legs.values()].sort((a, b) => a.fromUid.localeCompare(b.fromUid) || a.toUid.localeCompare(b.toUid)),
  }
}
