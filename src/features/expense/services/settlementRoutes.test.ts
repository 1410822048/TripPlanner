import { describe, expect, it } from 'vitest'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import { computeBalancesFull } from './settlement'
import {
  groupSettlementHistory,
  payersFor,
  paymentRoute,
  pendingLegLocks,
  planRouteSuggestions,
  previewRouteLegs,
  routeLegIds,
  routeRole,
} from './settlementRoutes'

function expense(id: string, paidBy: string, splits: Record<string, number>, over: Partial<Expense> = {}): Expense {
  const amountMinor = Object.values(splits).reduce((s, n) => s + n, 0)
  return {
    id, tripId: 't', title: id, amountMinor, currency: 'JPY', category: 'food', paidBy, date: '2026-06-01',
    splits: Object.entries(splits).map(([memberId, n]) => ({ memberId, amountMinor: n })),
    adjustments: [], createdBy: paidBy, updatedBy: paidBy, memberIds: [], createdAt: TS, updatedAt: TS,
    deletedAt: null, receiptPurgedAt: null, ...over,
  }
}

const members = ['a', 'b', 'c'].map(id => ({ id, displayName: id, avatarLabel: id, color: '#000', bg: '#fff' }))

describe('planRouteSuggestions', () => {
  it('previews which expenses (and receipt items) each leg clears', () => {
    const expenses = [
      expense('dinner', 'b', { a: 300 }, {
        items: [
          { id: 'i1', name: '拉麵', amountMinor: 200, allocations: [{ memberId: 'a', shares: 1 }] },
          { id: 'i2', name: '啤酒', amountMinor: 100, allocations: [{ memberId: 'a', shares: 1 }] },
        ],
      }),
      expense('taxi', 'c', { b: 300 }),
    ]
    const { pairwise } = computeBalancesFull(expenses, members, [])
    const [route] = planRouteSuggestions(pairwise, expenses, [])
    expect(route).toMatchObject({ kind: 'TRANSFER', payerUid: 'a', receiverUid: 'c', amountMinor: 300 })
    expect(route!.legs.map(l => l.sources)).toEqual([
      [
        { expenseId: 'dinner', expenseTitle: 'dinner', itemId: 'i1', itemName: '拉麵', amountMinor: 200 },
        { expenseId: 'dinner', expenseTitle: 'dinner', itemId: 'i2', itemName: '啤酒', amountMinor: 100 },
      ],
      [{ expenseId: 'taxi', expenseTitle: 'taxi', amountMinor: 300 }],
    ])
  })

  it('a partially settled edge previews the sources still open, never the ones already cleared', () => {
    const expenses = [
      expense('e1', 'b', { a: 100 }, { createdAt: { toMillis: () => 1 } as Expense['createdAt'] }),
      expense('e2', 'b', { a: 400 }, { createdAt: { toMillis: () => 2 } as Expense['createdAt'] }),
    ]
    const prior = [{ id: 's', tripId: 't', fromUid: 'a', toUid: 'b', amountMinor: 150, currency: 'JPY', settledBy: 'b', createdAt: { toMillis: () => 3 } as SettlementRecord['createdAt'], deletedAt: null }] as unknown as SettlementRecord[]
    const { pairwise } = computeBalancesFull(expenses, members, prior)
    const [route] = planRouteSuggestions(pairwise, expenses, prior)
    expect(route!.legs[0]!.sources).toEqual([{ expenseId: 'e2', expenseTitle: 'e2', amountMinor: 350 }])
  })

  it('ignores soft-deleted expenses and cancelled settlements in the preview', () => {
    const expenses = [expense('gone', 'b', { a: 999 }, { deletedAt: TS }), expense('live', 'b', { a: 100 })]
    const legs = previewRouteLegs(
      { kind: 'TRANSFER', payerUid: 'a', receiverUid: 'b', amountMinor: 100, legs: [{ fromUid: 'a', toUid: 'b', amountMinor: 100, expectedRemainingMinor: 100 }] },
      expenses,
      [{ id: 'x', fromUid: 'a', toUid: 'b', amountMinor: 100, deletedAt: TS } as unknown as SettlementRecord],
    )
    expect(legs[0]!.sources).toEqual([{ expenseId: 'live', expenseTitle: 'live', amountMinor: 100 }])
  })
})

describe('paymentRoute / payersFor', () => {
  const ledger = { a: { b: 500 }, b: { c: 500 } }
  const planned = {
    kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor: 500,
    legs: [
      { fromUid: 'a', toUid: 'b', amountMinor: 500, expectedRemainingMinor: 500 },
      { fromUid: 'b', toUid: 'c', amountMinor: 500, expectedRemainingMinor: 500 },
    ],
  }

  it('keeps the planned legs while they still match the ledger', () => {
    expect(paymentRoute(ledger, 'a', 'c', 500, planned)).toBe(planned)
  })

  it('re-routes on the live ledger once the plan is stale, and refuses what it cannot explain', () => {
    const moved = { a: { b: 500 }, b: { c: 400 } }
    expect(paymentRoute(moved, 'a', 'c', 500, planned)).toBeNull()
    expect(paymentRoute(moved, 'a', 'c', 400, planned)?.legs.map(l => l.expectedRemainingMinor)).toEqual([500, 400])
  })

  it('lists who can be recorded as paying me, with their maximum', () => {
    expect(payersFor(ledger, 'c', ['a', 'b', 'c'])).toEqual([{ uid: 'a', maxMinor: 500 }, { uid: 'b', maxMinor: 500 }])
    expect(payersFor(ledger, 'a', ['a', 'b', 'c'])).toEqual([])
  })
})

describe('routeRole', () => {
  const route = {
    kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c',
    legs: [{ fromUid: 'a', toUid: 'b', amountMinor: 70 }, { fromUid: 'b', toUid: 'c', amountMinor: 70 }],
  }
  it('names payer, receiver, intermediate and outsiders', () => {
    expect(routeRole(route, 'a')).toEqual({ kind: 'payer' })
    expect(routeRole(route, 'c')).toEqual({ kind: 'receiver' })
    expect(routeRole(route, 'b')).toEqual({ kind: 'intermediate', amountMinor: 70, fromUids: ['a'], toUids: ['c'] })
    expect(routeRole(route, 'z')).toBeNull()
    expect(routeRole(route, null)).toBeNull()
    expect(routeRole({ kind: 'OFFSET', legs: route.legs }, 'b')).toEqual({ kind: 'offset' })
  })
})

describe('groupSettlementHistory', () => {
  const header = { id: 'r', legCount: 2, kind: 'TRANSFER' as const, participantUids: ['a', 'b', 'c'], payerUid: 'a', receiverUid: 'c', amountMinor: 5 }
  const leg = (i: number): SettlementRecord => ({
    id: `r-0${i}`, tripId: 't', fromUid: 'x', toUid: 'y', amountMinor: 5, currency: 'JPY', settledBy: 'c',
    createdAt: TS, deletedAt: null, route: { ...header, legIndex: i },
  })
  const single: SettlementRecord = {
    id: 's-00', tripId: 't', fromUid: 'a', toUid: 'b', amountMinor: 1, currency: 'JPY', settledBy: 'b', createdAt: TS, deletedAt: null,
    route: { id: 's', legIndex: 0, legCount: 1, kind: 'TRANSFER', participantUids: ['a', 'b'], payerUid: 'a', receiverUid: 'b', amountMinor: 1 },
  }

  it('merges a route\'s legs into one entry in leg order, keeping list order', () => {
    const entries = groupSettlementHistory([leg(1), single, leg(0)])
    expect(entries.map(e => [e.id, e.legs.map(l => l.id), e.complete]))
      .toEqual([['r', ['r-00', 'r-01'], true], ['s', ['s-00'], true]])
  })

  it('marks a route as incomplete while only some legs are visible', () => {
    const [entry] = groupSettlementHistory([leg(1)])
    expect(entry).toMatchObject({ id: 'r', complete: false })
  })

  it('derives every leg id for a whole-route cancel', () => {
    expect(routeLegIds(header)).toEqual(['r-00', 'r-01'])
  })
})

describe('pendingLegLocks', () => {
  it('covers both directions of the leg\'s pair, active expenses only', () => {
    const expenses = [
      expense('fwd', 'b', { a: 1 }),
      expense('rev', 'a', { b: 1 }),
      expense('other', 'c', { a: 1 }),
      expense('dead', 'b', { a: 1 }, { deletedAt: TS }),
    ]
    expect(pendingLegLocks(expenses, { fromUid: 'a', toUid: 'b' })).toEqual(['fwd', 'rev'])
  })
})
