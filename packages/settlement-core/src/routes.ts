// Routed settlement planning — multi-hop debt simplification.
//
// A simplified transfer ("A pays C, via B") is recorded as a set of ordinary
// pair settlements (legs) on REAL debt edges, so every unit still lands on a
// pairwise edge the rest of this package already understands. This module
// only plans and shape-checks those leg sets; it never invents an edge.
//
//   planSettlementRoutes(pairwise)   suggestions: cycle offsets + transfers
//   routeForPayment(pairwise, …)     route a real "P paid R amount"
//   maxPayable(pairwise, …)          the most such a payment can be
//   validateRouteShape(route)        structural invariants (shared with the
//                                    Worker, which ALSO checks every leg
//                                    against the live ledger)
//
// Input is the normalized pairwise remaining from computePairwiseRemaining:
// at most one direction per unordered pair, integer minor units.
//
// Invariants every produced route satisfies (and validateRouteShape checks):
//   - legs sit on real edges, at most one leg per unordered pair
//   - TRANSFER: payer −amount, receiver +amount, everyone else 0, and the
//     legs are ACYCLIC — so every leg lies on a payer→receiver path. Without
//     acyclicity a receiver could smuggle an unrelated debt cycle (which
//     conserves flow too) into "their" transfer and clear other people's
//     debts with no say from them.
//   - OFFSET: everyone 0, and the legs form ONE connected component — a
//     participant may confirm a cycle they are part of, never a disjoint
//     cycle that merging happened to bundle in.
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

/** Debt cycles cleared with no money moving; every participant nets to 0. */
export interface OffsetRoute {
  kind:            'OFFSET'
  /** Sorted. */
  participantUids: string[]
  legs:            RouteLeg[]
}

export type SettlementRoute = TransferRoute | OffsetRoute

type Graph = Map<string, Map<string, number>>
/** Per-edge amounts keyed by edgeKey(from, to). */
type Flow = Map<string, number>

/** Legs per route: one per edge of a 10-person trip (C(10,2)). */
export const MAX_ROUTE_LEGS = 45
/** People per route. The Worker reads the route's ledger with one
 *  `paidBy IN participants` query, and Firestore caps IN at 30 values. */
export const MAX_ROUTE_PARTICIPANTS = 30
/** Route ids leave room for the `-NN` leg suffix within doc-id limits. */
export const ROUTE_ID_MAX = 50

const positive = (n: number) => n > SETTLEMENT_EPS
const edgeKey = (from: string, to: string) => `${from}\u0000${to}`
const splitKey = (key: string) => key.split('\u0000') as [string, string]
const byEdge = (a: { fromUid: string; toUid: string }, b: { fromUid: string; toUid: string }) =>
  a.fromUid.localeCompare(b.fromUid) || a.toUid.localeCompare(b.toUid)

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

function flowGraph(flow: Flow): Graph {
  const g: Graph = new Map()
  for (const [key, amount] of [...flow.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!positive(amount)) continue
    const [from, to] = splitKey(key)
    if (!g.has(from)) g.set(from, new Map())
    g.get(from)!.set(to, amount)
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

function addEdge(g: Graph, from: string, to: string, amount: number): void {
  if (!positive(amount)) return
  if (!g.has(from)) g.set(from, new Map())
  const row = g.get(from)!
  row.set(to, (row.get(to) ?? 0) + amount)
}

function addFlow(flow: Flow, from: string, to: string, amount: number): void {
  const key = edgeKey(from, to)
  const next = (flow.get(key) ?? 0) + amount
  if (positive(next)) flow.set(key, next)
  else flow.delete(key)
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

function legsFrom(flow: Flow, original: Graph): RouteLeg[] {
  return [...flow.entries()]
    .filter(([, amount]) => positive(amount))
    .map(([key, amount]) => {
      const [fromUid, toUid] = splitKey(key)
      return { fromUid, toUid, amountMinor: amount, expectedRemainingMinor: capacity(original, fromUid, toUid) }
    })
    .sort(byEdge)
}

function flowOf(legs: ReadonlyArray<Pick<RouteLeg, 'fromUid' | 'toUid' | 'amountMinor'>>): Flow {
  const flow: Flow = new Map()
  for (const leg of legs) addFlow(flow, leg.fromUid, leg.toUid, leg.amountMinor)
  return flow
}

/** Sorted unique uids a route's legs touch. */
export function routeParticipants(legs: ReadonlyArray<{ fromUid: string; toUid: string }>): string[] {
  return [...new Set(legs.flatMap(l => [l.fromUid, l.toUid]))].sort()
}

/** Canonical leg order (by from, then to). The Worker assigns leg indices
 *  — and therefore leg doc ids — in this order, so client and Worker agree
 *  on which id belongs to which edge. */
export function canonicalRouteLegs<L extends { fromUid: string; toUid: string }>(legs: readonly L[]): L[] {
  return [...legs].sort(byEdge)
}

/** Doc id of the `index`-th canonical leg of `routeId`. Derived, never
 *  client-chosen: a client-chosen id could collide with an unrelated
 *  settlement, and a derived one lets delete find every leg by id. */
export function routeLegId(routeId: string, index: number): string {
  return `${routeId}-${String(index).padStart(2, '0')}`
}

/** True while every leg still matches the live ledger, i.e. the Worker's
 *  per-edge CAS would accept the route as planned. */
export function isRouteCurrent(
  route:    { legs: ReadonlyArray<Pick<RouteLeg, 'fromUid' | 'toUid' | 'amountMinor' | 'expectedRemainingMinor'>> },
  pairwise: Record<string, Record<string, number>>,
): boolean {
  return route.legs.every(leg => {
    const live = pairwise[leg.fromUid]?.[leg.toUid] ?? 0
    return live === leg.expectedRemainingMinor && leg.amountMinor <= live
  })
}

function withinCaps(legs: ReadonlyArray<{ fromUid: string; toUid: string }>): boolean {
  return legs.length <= MAX_ROUTE_LEGS && routeParticipants(legs).length <= MAX_ROUTE_PARTICIPANTS
}

// ─── Cycles ────────────────────────────────────────────────────────

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

const cycleEdges = (cycle: string[]) => cycle.slice(0, -1).map((from, i) => [from, cycle[i + 1]!] as const)

/** Remove every directed cycle from `flow` (mutated). Cancelling a cycle
 *  changes nobody's net, so the flow still moves the same amount from the
 *  same source to the same sink. Returns what was removed. */
function cancelFlowCycles(flow: Flow): Flow {
  const removed: Flow = new Map()
  for (let cycle = findCycle(flowGraph(flow)); cycle; cycle = findCycle(flowGraph(flow))) {
    const edges = cycleEdges(cycle)
    const amount = Math.min(...edges.map(([from, to]) => flow.get(edgeKey(from, to)) ?? 0))
    for (const [from, to] of edges) {
      addFlow(flow, from, to, -amount)
      addFlow(removed, from, to, amount)
    }
  }
  return removed
}

/** Split a circulation into simple cycles (deterministic order). */
function decomposeCycles(flow: Flow): Flow[] {
  const rest = new Map(flow)
  const cycles: Flow[] = []
  for (let cycle = findCycle(flowGraph(rest)); cycle; cycle = findCycle(flowGraph(rest))) {
    const edges = cycleEdges(cycle)
    const amount = Math.min(...edges.map(([from, to]) => rest.get(edgeKey(from, to)) ?? 0))
    const one: Flow = new Map()
    for (const [from, to] of edges) {
      addFlow(rest, from, to, -amount)
      addFlow(one, from, to, amount)
    }
    cycles.push(one)
  }
  return cycles
}

/** Split an acyclic source→sink flow into paths (deterministic order). */
function decomposePaths(flow: Flow, source: string, sink: string): Flow[] {
  const rest = new Map(flow)
  const paths: Flow[] = []
  for (let guard = 0; guard < 10_000; guard++) {
    const g = flowGraph(rest)
    if (g.size === 0) break
    const path = [source]
    const seen = new Set(path)
    while (path[path.length - 1] !== sink) {
      const next = neighbours(g, path[path.length - 1]!).find(n => !seen.has(n))
      if (next === undefined) break
      path.push(next)
      seen.add(next)
    }
    if (path[path.length - 1] !== sink) break   // unreachable for a valid flow; defensive
    const edges = path.slice(0, -1).map((from, i) => [from, path[i + 1]!] as const)
    const amount = Math.min(...edges.map(([from, to]) => rest.get(edgeKey(from, to)) ?? 0))
    const one: Flow = new Map()
    for (const [from, to] of edges) {
      addFlow(rest, from, to, -amount)
      addFlow(one, from, to, amount)
    }
    paths.push(one)
  }
  return paths
}

/** Weakly connected components of `g`, each as a flow (sorted by first uid). */
function components(g: Graph): Flow[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(x, root)
    return root
  }
  for (const node of nodesOf(g)) parent.set(node, node)
  for (const [from, row] of g) {
    for (const to of row.keys()) {
      const a = find(from), b = find(to)
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
    }
  }
  const byRoot = new Map<string, Flow>()
  for (const node of nodesOf(g)) {
    const root = find(node)
    if (!byRoot.has(root)) byRoot.set(root, new Map())
  }
  for (const [from, row] of g) {
    for (const [to, amount] of row) addFlow(byRoot.get(find(from))!, from, to, amount)
  }
  return [...byRoot.entries()]
    .filter(([, flow]) => flow.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, flow]) => flow)
}

// ─── Max-flow (Edmonds–Karp on the debt graph) ─────────────────────

/** Push up to `limit` from `source` to `sink` along debt edges. Returns the
 *  per-edge flow and the amount pushed. `g` is not mutated. Residual
 *  reverse edges may cancel earlier flow, but the net per-edge flow always
 *  stays within [0, capacity]. */
function maxFlow(
  g:      Graph,
  source: string,
  sink:   string,
  limit:  number,
): { flow: Flow; amount: number } {
  const flow: Flow = new Map()
  const residual = (from: string, to: string) =>
    capacity(g, from, to) - (flow.get(edgeKey(from, to)) ?? 0) + (flow.get(edgeKey(to, from)) ?? 0)
  let pushed = 0
  while (positive(limit - pushed)) {
    // Residual neighbours: forward debt edges plus edges that already carry
    // flow back toward this node (cancellable). Sorted for determinism.
    const back = new Map<string, Set<string>>()
    for (const [key, amount] of flow) {
      if (!positive(amount)) continue
      const [from, to] = splitKey(key)
      if (!back.has(to)) back.set(to, new Set())
      back.get(to)!.add(from)
    }
    const residualNeighbours = (node: string) =>
      [...new Set([...(g.get(node)?.keys() ?? []), ...(back.get(node) ?? [])])].sort()
    // BFS over residual edges.
    const parent = new Map<string, string>([[source, source]])
    const queue = [source]
    while (queue.length > 0 && !parent.has(sink)) {
      const node = queue.shift()!
      for (const next of residualNeighbours(node)) {
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
      if (cancel > 0) addFlow(flow, to, from, -cancel)
      if (bottleneck - cancel > 0) addFlow(flow, from, to, bottleneck - cancel)
    }
    pushed += bottleneck
  }
  return { flow, amount: pushed }
}

// ─── Caps ──────────────────────────────────────────────────────────

/** Pairwise fallback for one edge: the debtor pays the creditor directly.
 *  Always a valid route (one leg on a real edge). */
function directTransfers(flow: Flow, original: Graph): TransferRoute[] {
  return legsFrom(flow, original).map(leg => ({
    kind:        'TRANSFER',
    payerUid:    leg.fromUid,
    receiverUid: leg.toUid,
    amountMinor: leg.amountMinor,
    legs:        [leg],
  }))
}

function mergeFlows(a: Flow, b: Flow): Flow {
  const out = new Map(a)
  for (const [key, amount] of b) {
    const [from, to] = splitKey(key)
    addFlow(out, from, to, amount)
  }
  return out
}

const flowAmountFrom = (flow: Flow, source: string) =>
  [...flow.entries()].reduce((sum, [key, amount]) => splitKey(key)[0] === source ? sum + amount : sum, 0)

/** Routes past the Worker's per-route limits are split; only a piece that
 *  can't fit even alone (a path or cycle through > 30 people) falls back to
 *  direct pair transfers. Unreachable at the 10-person target scale. */
function enforceCaps(route: SettlementRoute, original: Graph): SettlementRoute[] {
  if (withinCaps(route.legs)) return [route]
  const flow = flowOf(route.legs)

  if (route.kind === 'TRANSFER') {
    const out: SettlementRoute[] = []
    let current: Flow = new Map()
    const flush = () => {
      if (current.size === 0) return
      out.push({
        kind:        'TRANSFER',
        payerUid:    route.payerUid,
        receiverUid: route.receiverUid,
        amountMinor: flowAmountFrom(current, route.payerUid),
        legs:        legsFrom(current, original),
      })
      current = new Map()
    }
    for (const path of decomposePaths(flow, route.payerUid, route.receiverUid)) {
      const merged = mergeFlows(current, path)
      if (withinCaps(legsFrom(merged, original))) { current = merged; continue }
      flush()
      if (withinCaps(legsFrom(path, original))) current = path
      else out.push(...directTransfers(path, original))
    }
    flush()
    return out
  }

  const groups: Flow[] = []
  const fallback: SettlementRoute[] = []
  for (const cycle of decomposeCycles(flow)) {
    const nodes = new Set(routeParticipants(legsFrom(cycle, original)))
    const host = groups.findIndex(group =>
      routeParticipants(legsFrom(group, original)).some(uid => nodes.has(uid))
      && withinCaps(legsFrom(mergeFlows(group, cycle), original)))
    if (host >= 0) groups[host] = mergeFlows(groups[host]!, cycle)
    else if (withinCaps(legsFrom(cycle, original))) groups.push(cycle)
    else fallback.push(...directTransfers(cycle, original))
  }
  return [
    ...groups.map<OffsetRoute>(group => {
      const legs = legsFrom(group, original)
      return { kind: 'OFFSET', participantUids: routeParticipants(legs), legs }
    }),
    ...fallback,
  ]
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Plan the suggestion list: the cycle offsets first, then the transfers.
 *
 * Transfers are computed first: repeatedly pick, over every (debtor,
 * creditor) pair, the routable transfer that zeroes a whole person, else
 * the largest one — amount = min(debtor net, creditor net, max-flow on real
 * edges). By flow decomposition a debtor always reaches some creditor, so
 * each round moves a positive amount and the loop ends with every net at
 * zero. Transfers between the same two people are then merged; any cycle a
 * transfer's legs contain (max-flow or merging can create one) goes back to
 * the ledger, which is left as a pure circulation. Each connected part of
 * it becomes one OFFSET.
 *
 * Doing transfers before cancelling cycles matters: cancelling first
 * destroys edges the transfers could have used, and leaves one offset per
 * cycle for someone to confirm.
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
  const picked: Array<{ payer: string; receiver: string; flow: Flow }> = []

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
    let best: { payer: string; receiver: string; flow: Flow; amount: number; closes: boolean } | null = null
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

    // A cycle inside the flow is not part of this transfer: leave it on the
    // ledger for the offsets.
    cancelFlowCycles(best.flow)
    for (const [key, amount] of best.flow) {
      const [from, to] = splitKey(key)
      subtract(g, from, to, amount)
    }
    picked.push({ payer: best.payer, receiver: best.receiver, flow: best.flow })
  }

  // Same payer and receiver → one transfer. The sum of acyclic flows can
  // close a cycle; that part returns to the ledger too.
  const merged = new Map<string, { payer: string; receiver: string; flow: Flow }>()
  for (const p of picked) {
    const key = edgeKey(p.payer, p.receiver)
    const prev = merged.get(key)
    if (prev) prev.flow = mergeFlows(prev.flow, p.flow)
    else merged.set(key, { ...p, flow: new Map(p.flow) })
  }
  const transfers: TransferRoute[] = []
  for (const m of merged.values()) {
    for (const [key, amount] of cancelFlowCycles(m.flow)) {
      const [from, to] = splitKey(key)
      addEdge(g, from, to, amount)
    }
    const legs = legsFrom(m.flow, original)
    if (legs.length === 0) continue
    transfers.push({
      kind:        'TRANSFER',
      payerUid:    m.payer,
      receiverUid: m.receiver,
      amountMinor: flowAmountFrom(m.flow, m.payer),
      legs,
    })
  }

  // Whatever is left once nobody owes on net is a pure circulation; each
  // connected part is one offset, so no one confirms a cycle they're not in.
  const offsets = components(g).map<OffsetRoute>(flow => {
    const legs = legsFrom(flow, original)
    return { kind: 'OFFSET', participantUids: routeParticipants(legs), legs }
  })

  return [...offsets, ...transfers].flatMap(route => enforceCaps(route, original))
}

/**
 * Map a payment that really happened — "payer paid receiver amountMinor" —
 * onto the current debt graph. One logical payment may split over several
 * paths. Null when the debt graph cannot explain that much (see maxPayable)
 * or the route would exceed the per-route limits.
 */
export function routeForPayment(
  pairwise:    Record<string, Record<string, number>>,
  payerUid:    string,
  receiverUid: string,
  amountMinor: number,
): TransferRoute | null {
  if (payerUid === receiverUid || !Number.isSafeInteger(amountMinor) || !positive(amountMinor)) return null
  const g = toGraph(pairwise)
  const { flow, amount } = maxFlow(g, payerUid, receiverUid, amountMinor)
  if (amount < amountMinor) return null
  cancelFlowCycles(flow)
  const legs = legsFrom(flow, g)
  if (!withinCaps(legs)) return null
  return { kind: 'TRANSFER', payerUid, receiverUid, amountMinor, legs }
}

/** The most a payment from `payerUid` to `receiverUid` can clear: the
 *  max-flow over every path of real debt between them (0 when
 *  unreachable). */
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
  | 'TOO_MANY_PARTICIPANTS'
  | 'BAD_AMOUNT'
  | 'SELF_LEG'
  | 'DUPLICATE_PAIR'
  | 'NOT_CONSERVED'
  | 'BAD_ENDPOINTS'
  | 'CYCLIC'
  | 'DISCONNECTED'

type ShapeLeg = Pick<RouteLeg, 'fromUid' | 'toUid' | 'amountMinor'>

/**
 * Structural invariants of a route, independent of the ledger. The Worker
 * runs this AND checks every leg against the live remaining (capacity +
 * expectedRemainingMinor CAS) inside its transaction.
 *
 *   - 1..MAX_ROUTE_LEGS legs over ≤ MAX_ROUTE_PARTICIPANTS people,
 *     positive integer amounts, no self legs
 *   - at most one leg per unordered pair (no A→B together with B→A)
 *   - flow conservation: TRANSFER — payer −amount, receiver +amount,
 *     everyone else 0; OFFSET — everyone 0
 *   - TRANSFER legs are acyclic; OFFSET legs are one connected component
 */
export function validateRouteShape(
  route:
    | { kind: 'TRANSFER'; payerUid: string; receiverUid: string; amountMinor: number; legs: ShapeLeg[] }
    | { kind: 'OFFSET'; legs: ShapeLeg[] },
): RouteShapeError | null {
  const { legs } = route
  if (legs.length === 0) return 'NO_LEGS'
  if (legs.length > MAX_ROUTE_LEGS) return 'TOO_MANY_LEGS'
  if (routeParticipants(legs).length > MAX_ROUTE_PARTICIPANTS) return 'TOO_MANY_PARTICIPANTS'
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
    if (!net.has(route.payerUid) || !net.has(route.receiverUid)) return 'BAD_ENDPOINTS'
    for (const [uid, n] of net) {
      const expected =
        uid === route.payerUid    ? -route.amountMinor
        : uid === route.receiverUid ? route.amountMinor
        : 0
      if (n !== expected) return 'NOT_CONSERVED'
    }
    if (findCycle(flowGraph(flowOf(legs)))) return 'CYCLIC'
    return null
  }
  for (const n of net.values()) if (n !== 0) return 'NOT_CONSERVED'
  if (components(flowGraph(flowOf(legs))).length !== 1) return 'DISCONNECTED'
  return null
}
