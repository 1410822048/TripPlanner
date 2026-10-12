import { describe, expect, it } from 'vitest'
import {
  computePairwiseRemaining,
  maxPayable,
  planSettlementRoutes,
  routeForPayment,
  validateRouteShape,
  type CoreExpense,
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

/** Every invariant the Worker relies on, for any plan. */
function expectValidPlan(pairwise: Pairwise, routes: SettlementRoute[]) {
  const edges = edgesOf(pairwise)
  for (const r of routes) {
    expect(validateRouteShape(r)).toBeNull()
    for (const l of r.legs) {
      const key = `${l.fromUid}>${l.toUid}`
      // Only real debt edges, never more than they carry.
      expect(edges.has(key)).toBe(true)
      expect(l.expectedRemainingMinor).toBe(edges.get(key))
      expect(l.amountMinor).toBeLessThanOrEqual(l.expectedRemainingMinor)
    }
  }
  // The plan clears the whole ledger exactly — nothing left, nothing extra.
  expect(clearedPerEdge(routes)).toEqual(edges)
}

/** Deterministic PRNG (mulberry32) so property cases are reproducible. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A plausible trip: `n` people, `count` expenses, each paid by one person
 *  and split evenly (largest remainder) among a random subset. */
function randomTrip(seed: number, n: number, count: number): Pairwise {
  const r = rng(seed)
  const people = Array.from({ length: n }, (_, i) => `u${String(i).padStart(2, '0')}`)
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
  return computePairwiseRemaining(expenses, [])
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
    expect(routes[0]).toMatchObject({ kind: 'OFFSET', participantUids: ['a', 'b', 'c'], amountMinor: 500 })
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

  it('disconnected groups settle independently', () => {
    const pairwise = { a: { b: 300 }, c: { d: 400 } }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(2)
    expectValidPlan(pairwise, routes)
  })

  it('an empty ledger plans nothing', () => {
    expect(planSettlementRoutes({})).toEqual([])
  })

  it('is deterministic for the same ledger', () => {
    const pairwise = randomTrip(7, 10, 40)
    expect(planSettlementRoutes(pairwise)).toEqual(planSettlementRoutes(pairwise))
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

  it('recording any one planned route leaves a ledger the rest still clears', () => {
    // Any order works: each route only needs its own edges to still carry
    // what it takes, which the shared-edge split guarantees.
    for (const seed of seeds.slice(0, 50)) {
      const pairwise = randomTrip(seed, 10, 40)
      const routes = planSettlementRoutes(pairwise)
      for (const recorded of routes) {
        const after: Pairwise = JSON.parse(JSON.stringify(pairwise))
        for (const l of recorded.legs) {
          after[l.fromUid]![l.toUid]! -= l.amountMinor
          if (after[l.fromUid]![l.toUid] === 0) delete after[l.fromUid]![l.toUid]
        }
        for (const other of routes) {
          if (other === recorded) continue
          for (const l of other.legs) {
            expect(after[l.fromUid]?.[l.toUid] ?? 0).toBeGreaterThanOrEqual(l.amountMinor)
          }
        }
      }
    }
  })
})

describe('routeForPayment / maxPayable', () => {
  const pairwise = { a: { b: 1000 }, b: { c: 600 }, d: { c: 200 } }

  it('routes an arbitrary payment through the debt chain', () => {
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

  it('refuses unreachable pairs and self payments', () => {
    expect(maxPayable(pairwise, 'c', 'a')).toBe(0)
    expect(routeForPayment(pairwise, 'c', 'a', 1)).toBeNull()
    expect(routeForPayment(pairwise, 'a', 'a', 1)).toBeNull()
  })
})

describe('validateRouteShape', () => {
  const leg = (fromUid: string, toUid: string, amountMinor: number) => ({ fromUid, toUid, amountMinor })
  const transfer = (legs: ReturnType<typeof leg>[], amountMinor = 100) =>
    ({ kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor, legs })

  it('accepts a conserved transfer and a conserved offset', () => {
    expect(validateRouteShape(transfer([leg('a', 'b', 100), leg('b', 'c', 100)]))).toBeNull()
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'a', 5)] })).toBe('DUPLICATE_PAIR')
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'c', 5), leg('c', 'a', 5)] })).toBeNull()
  })

  it('rejects an intermediate that does not net to zero', () => {
    // b receives 100 but only passes on 60: b would lose 40 of receivable.
    expect(validateRouteShape(transfer([leg('a', 'b', 100), leg('b', 'c', 60)]))).toBe('NOT_CONSERVED')
  })

  it('rejects malformed legs', () => {
    expect(validateRouteShape(transfer([]))).toBe('NO_LEGS')
    expect(validateRouteShape(transfer([leg('a', 'a', 100)]))).toBe('SELF_LEG')
    expect(validateRouteShape(transfer([leg('a', 'c', 0)]))).toBe('BAD_AMOUNT')
    expect(validateRouteShape(transfer([leg('a', 'c', 1.5)], 1.5))).toBe('BAD_AMOUNT')
    expect(validateRouteShape(transfer([leg('a', 'c', 100), leg('a', 'c', 100)], 200))).toBe('DUPLICATE_PAIR')
    expect(validateRouteShape({ ...transfer([leg('a', 'c', 100)]), receiverUid: 'a' })).toBe('BAD_ENDPOINTS')
  })

  it('rejects an offset with any non-zero net', () => {
    expect(validateRouteShape({ kind: 'OFFSET', legs: [leg('a', 'b', 5), leg('b', 'c', 4)] })).toBe('NOT_CONSERVED')
  })
})

describe('planSettlementRoutes — offsets', () => {
  it('folds every cycle into a single offset (one confirmation)', () => {
    // Two disjoint cycles.
    const pairwise = {
      a: { b: 100 }, b: { c: 100 }, c: { a: 100 },
      d: { e: 200 }, e: { f: 200 }, f: { d: 200 },
    }
    const routes = planSettlementRoutes(pairwise)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'OFFSET', participantUids: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expectValidPlan(pairwise, routes)
  })

  it('leaves at most one offset on random trips', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const routes = planSettlementRoutes(randomTrip(seed, 10, 80))
      expect(routes.filter(r => r.kind === 'OFFSET').length).toBeLessThanOrEqual(1)
    }
  })
})
