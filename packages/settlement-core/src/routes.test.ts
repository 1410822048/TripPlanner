import { describe, expect, it } from 'vitest'
import {
  canonicalRouteLegs,
  computePairwiseRemaining,
  isRouteCurrent,
  MAX_ROUTE_LEGS,
  MAX_ROUTE_PARTICIPANTS,
  maxPayable,
  planSettlementRoutes,
  routeForPayment,
  routeLegId,
  routeParticipants,
  validateRouteShape,
  type CoreExpense,
  type CoreSettlement,
  type SettlementRoute,
} from './index'

type Pairwise = Record<string, Record<string, number>>

/** Sum of leg amounts per directed edge across all routes. */
function clearedPerEdge(routes: SettlementRoute[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of routes) {
    for (const l of r.legs) {
      const key = `${l.fromUid}>${l.toUid}`
      out.set(key, (out.get(key) ?? 0) + l.amountMinor)
    }
  }
  return out
}

function edgesOf(pairwise: Pairwise): Map<string, number> {
  const out = new Map<string, number>()
  for (const from of Object.keys(pairwise)) {
    for (const [to, amount] of Object.entries(pairwise[from]!)) out.set(`${from}>${to}`, amount)
  }
  return out
}

/** Net position per person: positive = owed money. */
function netOf(pairwise: Pairwise): Map<string, number> {
  const net = new Map<string, number>()
  for (const [from, row] of Object.entries(pairwise)) {
    for (const [to, amount] of Object.entries(row)) {
      net.set(from, (net.get(from) ?? 0) - amount)
      net.set(to,   (net.get(to)   ?? 0) + amount)
    }
  }
  return net
}

/** Every invariant the Worker relies on, for any plan. */
function expectValidPlan(pairwise: Pairwise, routes: SettlementRoute[]) {
  const edges = edgesOf(pairwise)
  for (const r of routes) {
    expect(validateRouteShape(r)).toBeNull()
    expect(isRouteCurrent(r, pairwise)).toBe(true)
    for (const l of r.legs) {
      const key = `${l.fromUid}>${l.toUid}`
      // Only real debt edges, never more than they carry.
      expect(edges.has(key)).toBe(true)
      expect(l.expectedRemainingMinor).toBe(edges.get(key))
      expect(l.amountMinor).toBeLessThanOrEqual(l.expectedRemainingMinor)
      expect(Number.isSafeInteger(l.amountMinor)).toBe(true)
    }
    if (r.kind === 'TRANSFER') {
      const out = r.legs.filter(l => l.fromUid === r.payerUid).reduce((s, l) => s + l.amountMinor, 0)
      expect(out).toBe(r.amountMinor)
    } else {
      expect(r.participantUids).toEqual(routeParticipants(r.legs))
    }
  }
  // The plan clears the whole ledger exactly — nothing left, nothing extra.
  expect(clearedPerEdge(routes)).toEqual(edges)
}

/** Deterministic PRNG (mulberry32) so property cases are reproducible: a
 *  failure names its seed, and the same seed always replays it. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const person = (i: number) => `u${String(i).padStart(2, '0')}`

/** A plausible trip: `n` people, `count` expenses, each paid by one person
 *  and split evenly (largest remainder) among a random subset. */
function randomExpenses(seed: number, n: number, count: number): CoreExpense[] {
  const r = rng(seed)
  const people = Array.from({ length: n }, (_, i) => person(i))
  const expenses: CoreExpense[] = []
  for (let i = 0; i < count; i++) {
    const paidBy = people[Math.floor(r() * n)]!
    const members = people.filter(() => r() < 0.6)
    if (members.length === 0) continue
    const amountMinor = 100 + Math.floor(r() * 20_000)
    const base = Math.floor(amountMinor / members.length)
    const extra = amountMinor - base * members.length
    expenses.push({
      amountMinor, paidBy,
      splits: members.map((memberId, idx) => ({ memberId, amountMinor: base + (idx < extra ? 1 : 0) })),
    })
  }
  return expenses
}

function randomTrip(seed: number, n: number, count: number): Pairwise {
  return computePairwiseRemaining(randomExpenses(seed, n, count), [])
}

/** The real ledger: expenses + recorded legs as ordinary settlements, run
 *  through the same computePairwiseRemaining the Worker uses. Recording a
 *  route here is exactly what the Worker commits. */
class Ledger {
  private settlements: CoreSettlement[] = []
  private clock = 1
  constructor(private readonly expenses: CoreExpense[]) {}
  get pairwise(): Pairwise { return computePairwiseRemaining(this.expenses, this.settlements) }
  /** The Worker's acceptance test: shape + per-leg CAS + capacity. */
  accepts(route: SettlementRoute): boolean {
    if (validateRouteShape(route) !== null) return false
    return isRouteCurrent(route, this.pairwise)
  }
  record(route: SettlementRoute): void {
    if (!this.accepts(route)) throw new Error('Worker would refuse this route')
    const at = this.clock++
    for (const l of canonicalRouteLegs(route.legs)) {
      this.settlements.push({ fromUid: l.fromUid, toUid: l.toUid, amountMinor: l.amountMinor, createdAtMs: at })
    }
  }
}

function expectNoNegativeEdges(pairwise: Pairwise) {
  for (const row of Object.values(pairwise)) for (const v of Object.values(row)) expect(v).toBeGreaterThan(0)
}

describe('planSettlementRoutes — shapes', () => {
  it('a chain becomes one transfer through the middle person', () => {
    const pairwise = { a: { b: 1000 }, b: { c: 1000 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toEqual([{
      kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 1000,
      legs: [
        { fromUid: 'a', toUid: 'b', amountMinor: 1000, expectedRemainingMinor: 1000 },
        { fromUid: 'b', toUid: 'c', amountMinor: 1000, expectedRemainingMinor: 1000 },
      ],
    }])
    expectValidPlan(pairwise, routes)
  })

  it('a pure cycle is one offset and needs no transfer', () => {
    const pairwise = { a: { b: 500 }, b: { c: 500 }, c: { a: 500 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'OFFSET', participantUids: ['a', 'b', 'c'] })
    expectValidPlan(pairwise, routes)
  })

  it('a cycle with excess leaves only the excess as a transfer', () => {
    // a→b 800, b→c 500, c→a 500: offset 500 around, then a→b 300 remains.
    const pairwise = { a: { b: 800 }, b: { c: 500 }, c: { a: 500 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes.map(r => r.kind)).toEqual(['OFFSET', 'TRANSFER'])
    expect(routes[1]).toMatchObject({ payerUid: 'a', receiverUid: 'b', amountMinor: 300 })
    expectValidPlan(pairwise, routes)
  })

  it('a shared middle edge is split across two payers (partial legs)', () => {
    // a→b 10, d→b 10, b→c 20: both payers pay c via b; b→c is cleared in two parts.
    const pairwise = { a: { b: 1000 }, d: { b: 1000 }, b: { c: 2000 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes.map(r => r.kind === 'TRANSFER' && [r.payerUid, r.receiverUid, r.amountMinor]))
      .toEqual([['a', 'c', 1000], ['d', 'c', 1000]])
    expectValidPlan(pairwise, routes)
  })

  it('one logical payment may run over several paths (multi-path)', () => {
    // a owes c 600 net, reachable only via b (400) and via d (200).
    const pairwise = { a: { b: 400, d: 200 }, b: { c: 400 }, d: { c: 200 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 600 })
    expect(routes[0]!.legs).toHaveLength(4)
    expectValidPlan(pairwise, routes)
  })

  it('disconnected groups settle independently', () => {
    const pairwise = { a: { b: 300 }, c: { d: 400 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(2)
    expectValidPlan(pairwise, routes)
  })

  it('an empty ledger plans nothing', () => {
    expect(planSettlementRoutes({})).toEqual([])
  })

  it('is deterministic for the same ledger, regardless of key order', () => {
    const pairwise = randomTrip(7, 10, 40)
    const reversed: Pairwise = {}
    for (const from of Object.keys(pairwise).reverse()) {
      reversed[from] = {}
      for (const to of Object.keys(pairwise[from]!).reverse()) reversed[from]![to] = pairwise[from]![to]!
    }
    expect(planSettlementRoutes(pairwise)).toEqual(planSettlementRoutes(pairwise))
    expect(planSettlementRoutes(reversed)).toEqual(planSettlementRoutes(pairwise))
  })
})

describe('planSettlementRoutes — offsets and authorization boundaries', () => {
  it('never merges disconnected cycles: each gets its own offset', () => {
    // Two disjoint cycles. A participant of one must not be able to confirm
    // the other, so they cannot share an offset.
    const pairwise = {
      a: { b: 100 }, b: { c: 100 }, c: { a: 100 },
      d: { e: 200 }, e: { f: 200 }, f: { d: 200 },
    }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(2)
    expect(routes.map(r => r.kind === 'OFFSET' && r.participantUids)).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
    expectValidPlan(pairwise, routes)
  })

  it('cycles sharing a person are one connected offset', () => {
    // a→b→c→a and c→x→y→c share c.
    const pairwise = {
      a: { b: 100 }, b: { c: 100 }, c: { a: 100, x: 50 },
      x: { y: 50 }, y: { c: 50 },
    }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'OFFSET', participantUids: ['a', 'b', 'c', 'x', 'y'] })
    expectValidPlan(pairwise, routes)
  })

  it('every offset on random trips is one connected component', () => {
    for (let seed = 1; seed <= 150; seed++) {
      for (const r of planSettlementRoutes(randomTrip(seed, 10, 80))) {
        if (r.kind === 'OFFSET') expect(validateRouteShape(r), `seed ${seed}`).toBeNull()
      }
    }
  })
})

describe('planSettlementRoutes — properties over random 10-person trips', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1)

  it('every plan is valid and clears the ledger exactly', () => {
    for (const seed of seeds) {
      const pairwise = randomTrip(seed, 10, 40)
      expectValidPlan(pairwise, planSettlementRoutes(pairwise))
    }
  })

  it('never suggests more transfers than pairwise listing, and usually far fewer', () => {
    let pairTotal = 0, routedTotal = 0
    for (const seed of seeds) {
      const pairwise = randomTrip(seed, 10, 40)
      const pairCount = edgesOf(pairwise).size
      const transfers = planSettlementRoutes(pairwise).filter(r => r.kind === 'TRANSFER').length
      expect(transfers).toBeLessThanOrEqual(pairCount)
      pairTotal += pairCount
      routedTotal += transfers
    }
    // Not a contract, a regression guard on the planner's quality. Measured
    // 2026-10-13 on this generator: 44.7 pairwise -> 10.8 transfers.
    expect(routedTotal / seeds.length).toBeLessThanOrEqual(12)
    expect(routedTotal).toBeLessThan(pairTotal)
  })

  it('pick → record → replan, in a random order, always finishes the ledger', () => {
    for (const seed of seeds.slice(0, 80)) {
      const r = rng(seed * 7919)
      const ledger = new Ledger(randomExpenses(seed, 10, 40))
      const startNet = netOf(ledger.pairwise)
      const moved = new Map<string, number>()
      let steps = 0
      for (; steps < 200; steps++) {
        const pairwise = ledger.pairwise
        if (Object.keys(pairwise).length === 0) break
        const plan = planSettlementRoutes(pairwise)
        expect(plan.length, `seed ${seed}`).toBeGreaterThan(0)
        const pick = plan[Math.floor(r() * plan.length)]!
        const before = netOf(pairwise)
        ledger.record(pick)
        const after = ledger.pairwise
        expectNoNegativeEdges(after)
        // Economic balance: only the payer and receiver of a transfer move,
        // by exactly the amount; an offset moves nobody.
        const afterNet = netOf(after)
        for (const uid of new Set([...before.keys(), ...afterNet.keys()])) {
          const delta = (afterNet.get(uid) ?? 0) - (before.get(uid) ?? 0)
          const expected = pick.kind === 'TRANSFER'
            ? uid === pick.payerUid ? pick.amountMinor : uid === pick.receiverUid ? -pick.amountMinor : 0
            : 0
          expect(delta, `seed ${seed} uid ${uid}`).toBe(expected)
        }
        if (pick.kind === 'TRANSFER') {
          moved.set(pick.payerUid, (moved.get(pick.payerUid) ?? 0) + pick.amountMinor)
          moved.set(pick.receiverUid, (moved.get(pick.receiverUid) ?? 0) - pick.amountMinor)
        }
      }
      expect(Object.keys(ledger.pairwise), `seed ${seed} did not finish`).toEqual([])
      // Over the whole run every debtor paid exactly their net, every
      // creditor received exactly theirs.
      for (const [uid, net] of startNet) expect((moved.get(uid) ?? 0) + net, `seed ${seed} ${uid}`).toBe(0)
      expect(steps).toBeLessThan(200)
    }
  })

  it('a stale suggestion is refused once a route touching its edges lands', () => {
    let staleSeen = 0
    for (const seed of seeds.slice(0, 60)) {
      const ledger = new Ledger(randomExpenses(seed, 10, 40))
      const plan = planSettlementRoutes(ledger.pairwise)
      if (plan.length < 2) continue
      ledger.record(plan[0]!)
      const touched = new Set(plan[0]!.legs.map(l => `${l.fromUid}>${l.toUid}`))
      for (const other of plan.slice(1)) {
        const overlaps = other.legs.some(l => touched.has(`${l.fromUid}>${l.toUid}`))
        // CAS: any shared edge changed → refused; disjoint → still valid.
        expect(ledger.accepts(other), `seed ${seed}`).toBe(!overlaps)
        if (overlaps) staleSeen++
      }
    }
    expect(staleSeen).toBeGreaterThan(0)
  })
})

describe('routeForPayment / maxPayable', () => {
  const pairwise = { a: { b: 1000 }, b: { c: 600 }, d: { c: 200 } }

  it('routes an arbitrary payment through the debt chain (partial edge)', () => {
    const route = routeForPayment(pairwise, 'a', 'c', 600)
    expect(route).not.toBeNull()
    expect(validateRouteShape(route!)).toBeNull()
    expect(route!.legs).toEqual([
      { fromUid: 'a', toUid: 'b', amountMinor: 600, expectedRemainingMinor: 1000 },
      { fromUid: 'b', toUid: 'c', amountMinor: 600, expectedRemainingMinor: 600 },
    ])
  })

  it('refuses more than the chain can carry', () => {
    expect(maxPayable(pairwise, 'a', 'c')).toBe(600)
    expect(routeForPayment(pairwise, 'a', 'c', 601)).toBeNull()
  })

  it('counts every path toward the maximum (multi-path)', () => {
    const diamond = { a: { b: 300, d: 500 }, b: { c: 300 }, d: { c: 400 } }
    expect(maxPayable(diamond, 'a', 'c')).toBe(700)
    const route = routeForPayment(diamond, 'a', 'c', 700)!
    expect(validateRouteShape(route)).toBeNull()
    expect(route.legs.map(l => [l.fromUid, l.toUid, l.amountMinor]))
      .toEqual([['a', 'b', 300], ['a', 'd', 400], ['b', 'c', 300], ['d', 'c', 400]])
  })

  it('refuses unreachable pairs, self payments and non-integer amounts', () => {
    expect(maxPayable(pairwise, 'c', 'a')).toBe(0)
    expect(routeForPayment(pairwise, 'c', 'a', 1)).toBeNull()
    expect(routeForPayment(pairwise, 'a', 'a', 1)).toBeNull()
    expect(routeForPayment(pairwise, 'a', 'c', 1.5)).toBeNull()
    expect(routeForPayment(pairwise, 'a', 'c', 0)).toBeNull()
  })

  it('a payment against a vanished suggestion is re-routed on the live ledger', () => {
    // Plan says a→c 600 via b. Meanwhile b's own payment to c lands and the
    // old legs go stale — the receiver can still record what a really paid.
    const ledger = new Ledger([
      { amountMinor: 1000, paidBy: 'b', splits: [{ memberId: 'a', amountMinor: 1000 }] },
      { amountMinor: 800,  paidBy: 'c', splits: [{ memberId: 'b', amountMinor: 600 }, { memberId: 'd', amountMinor: 200 }] },
    ])
    const planned = routeForPayment(ledger.pairwise, 'a', 'c', 600)!
    ledger.record(routeForPayment(ledger.pairwise, 'b', 'c', 100)!)
    expect(ledger.accepts(planned)).toBe(false)
    expect(maxPayable(ledger.pairwise, 'a', 'c')).toBe(500)
    const replanned = routeForPayment(ledger.pairwise, 'a', 'c', 500)!
    expect(ledger.accepts(replanned)).toBe(true)
    ledger.record(replanned)
  })

  it('random payments only consume real debt and keep intermediates neutral', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 31)
      const ledger = new Ledger(randomExpenses(seed, 10, 30))
      const pairwise = ledger.pairwise
      const people = Array.from({ length: 10 }, (_, i) => person(i))
      const payer = people[Math.floor(r() * 10)]!
      const receiver = people[Math.floor(r() * 10)]!
      const max = maxPayable(pairwise, payer, receiver)
      expect(routeForPayment(pairwise, payer, receiver, max + 1), `seed ${seed}`).toBeNull()
      if (max === 0) continue
      const amount = 1 + Math.floor(r() * max)
      const route = routeForPayment(pairwise, payer, receiver, amount)!
      expect(route, `seed ${seed}`).not.toBeNull()
      expect(validateRouteShape(route), `seed ${seed}`).toBeNull()
      const before = netOf(pairwise)
      ledger.record(route)
      expectNoNegativeEdges(ledger.pairwise)
      const after = netOf(ledger.pairwise)
      for (const uid of people) {
        const delta = (after.get(uid) ?? 0) - (before.get(uid) ?? 0)
        expect(delta, `seed ${seed} ${uid}`).toBe(uid === payer ? amount : uid === receiver ? -amount : 0)
      }
    }
  })
})

describe('validateRouteShape', () => {
  const leg = (fromUid: string, toUid: string, amountMinor: number) => ({ fromUid, toUid, amountMinor })
  const transfer = (legs: ReturnType<typeof leg>[], amountMinor = 100) =>
    ({ kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor, legs })

  it('accepts a conserved transfer and a conserved offset', () => {
    expect(validateRouteShape(transfer([leg('a', 'b', 100), leg('b', 'c', 100)]))).toBeNull()
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'c', 5), leg('c', 'a', 5)] })).toBeNull()
  })

  it('rejects an intermediate that does not net to zero', () => {
    // b receives 100 but only passes on 60: b would lose 40 of receivable.
    expect(validateRouteShape(transfer([leg('a', 'b', 100), leg('b', 'c', 60)]))).toBe('NOT_CONSERVED')
  })

  it('rejects a transfer that smuggles in an unrelated cycle', () => {
    // a→c is the payment; d→e→f→d also conserves flow, but none of d/e/f
    // asked for anything — c must not be able to clear their debts.
    expect(validateRouteShape(transfer([
      leg('a', 'c', 100), leg('d', 'e', 5), leg('e', 'f', 5), leg('f', 'd', 5),
    ]))).toBe('CYCLIC')
    // A cycle through the intermediate is just as foreign.
    expect(validateRouteShape(transfer([
      leg('a', 'b', 100), leg('b', 'c', 100), leg('b', 'x', 7), leg('x', 'y', 7), leg('y', 'b', 7),
    ]))).toBe('CYCLIC')
  })

  it('rejects an offset that bundles disconnected cycles', () => {
    expect(validateRouteShape({ kind: 'OFFSET', legs: [
      leg('a', 'b', 5), leg('b', 'c', 5), leg('c', 'a', 5),
      leg('d', 'e', 9), leg('e', 'f', 9), leg('f', 'd', 9),
    ] })).toBe('DISCONNECTED')
  })

  it('rejects malformed legs', () => {
    expect(validateRouteShape(transfer([]))).toBe('NO_LEGS')
    expect(validateRouteShape(transfer([leg('a', 'a', 100)]))).toBe('SELF_LEG')
    expect(validateRouteShape(transfer([leg('a', 'c', 0)]))).toBe('BAD_AMOUNT')
    expect(validateRouteShape(transfer([leg('a', 'c', 1.5)], 1.5))).toBe('BAD_AMOUNT')
    expect(validateRouteShape(transfer([leg('a', 'c', 100), leg('a', 'c', 100)], 200))).toBe('DUPLICATE_PAIR')
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'a', 5)] })).toBe('DUPLICATE_PAIR')
    expect(validateRouteShape({ ...transfer([leg('a', 'c', 100)]), receiverUid: 'a' })).toBe('BAD_ENDPOINTS')
    expect(validateRouteShape({ ...transfer([leg('a', 'c', 100)]), receiverUid: 'z' })).toBe('BAD_ENDPOINTS')
    expect(validateRouteShape(transfer([leg('a', 'c', 100)], 99))).toBe('NOT_CONSERVED')
  })

  it('rejects an offset with any non-zero net', () => {
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'c', 4)] })).toBe('NOT_CONSERVED')
  })

  it('enforces the per-route caps', () => {
    const many = Array.from({ length: MAX_ROUTE_LEGS + 1 }, (_, i) => leg(person(i), person(i + 1), 1))
    expect(validateRouteShape({ kind: 'TRANSFER', payerUid: person(0), receiverUid: person(MAX_ROUTE_LEGS + 1), amountMinor: 1, legs: many }))
      .toBe('TOO_MANY_LEGS')
    const wide = Array.from({ length: MAX_ROUTE_PARTICIPANTS }, (_, i) => leg(person(i), person(i + 1), 1))
    expect(validateRouteShape({ kind: 'TRANSFER', payerUid: person(0), receiverUid: person(MAX_ROUTE_PARTICIPANTS), amountMinor: 1, legs: wide }))
      .toBe('TOO_MANY_PARTICIPANTS')
  })
})

describe('caps fallback (only when a route cannot fit)', () => {
  it('a debt chain through more people than a route allows falls back to direct transfers', () => {
    const pairwise: Pairwise = {}
    for (let i = 0; i < 35; i++) pairwise[person(i)] = { [person(i + 1)]: 100 }
    const routes = planSettlementRoutes(pairwise)
    expectValidPlan(pairwise, routes)
    for (const r of routes) {
      expect(r.legs.length).toBeLessThanOrEqual(MAX_ROUTE_LEGS)
      expect(routeParticipants(r.legs).length).toBeLessThanOrEqual(MAX_ROUTE_PARTICIPANTS)
    }
    expect(routeForPayment(pairwise, person(0), person(35), 100)).toBeNull()
  })

  it('many short paths between two people are packed into a few routes', () => {
    // 40 parallel two-hop paths a → m_i → z: one logical transfer with 80
    // legs over 42 people, split into routes that each fit.
    const pairwise: Pairwise = { a: {} }
    for (let i = 0; i < 40; i++) {
      pairwise.a![`m${i}`] = 10
      pairwise[`m${i}`] = { z: 10 }
    }
    const routes = planSettlementRoutes(pairwise)
    expectValidPlan(pairwise, routes)
    expect(routes.every(r => r.kind === 'TRANSFER' && r.payerUid === 'a' && r.receiverUid === 'z')).toBe(true)
    expect(routes.length).toBeLessThanOrEqual(3)
  })

  it('stays within caps on trips larger than one route can span', () => {
    // Past the 10-person target the planner slows down (~0.3s at 30 people)
    // but must stay correct.
    for (let seed = 1; seed <= 3; seed++) {
      const pairwise = randomTrip(seed, 34, 70)
      expectValidPlan(pairwise, planSettlementRoutes(pairwise))
    }
  }, 60_000)
})

describe('route ids', () => {
  it('derives leg ids from the route id and canonical leg order', () => {
    expect(routeLegId('r1', 0)).toBe('r1-00')
    expect(routeLegId('r1', 44)).toBe('r1-44')
    const legs = [{ fromUid: 'b', toUid: 'c' }, { fromUid: 'a', toUid: 'b' }]
    expect(canonicalRouteLegs(legs)).toEqual([{ fromUid: 'a', toUid: 'b' }, { fromUid: 'b', toUid: 'c' }])
  })
})
