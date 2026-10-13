// Tests for SettlementDocSchema — every settlement is a routed-settlement
// leg: an ordinary from → to amount plus the shared `route` header. The
// schema parses Firestore docs on read; its invariants keep the history UI
// and the chronological replay from ever seeing a half-populated record,
// and route a Worker bug / raw admin write through the same
// firestoreDocFromSchema Sentry path as other doc-shape regressions.
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { SettlementDocSchema } from './settlement'

const NOW = Timestamp.fromDate(new Date('2026-06-01T00:00:00Z'))

function transferHeader(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'route-1', legIndex: 0, legCount: 2, kind: 'TRANSFER',
    participantUids: ['alice-uid', 'bob-uid', 'carol-uid'],
    payerUid: 'alice-uid', receiverUid: 'carol-uid', amountMinor: 9750,
    ...over,
  }
}

function offsetHeader(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'route-2', legIndex: 1, legCount: 3, kind: 'OFFSET',
    participantUids: ['alice-uid', 'bob-uid', 'carol-uid'],
    ...over,
  }
}

/** A trip-currency transfer leg. Record<string, unknown> so fixtures can
 *  add / override fields freely. */
function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tripId:      'trip-1',
    fromUid:     'alice-uid',
    toUid:       'bob-uid',
    amountMinor: 9750,
    currency:    'JPY',
    settledBy:   'carol-uid',
    route:       transferHeader(),
    createdAt:   NOW,
    deletedAt:   null,
    ...overrides,
  }
}

/** USD 65.00 received for JPY 9750 @ 150. */
const baseFx = {
  provider:             'frankfurter-v2' as const,
  baseCurrency:         'USD',
  quoteCurrency:        'JPY',
  requestedDate:        '2026-06-01',
  rateDate:             '2026-06-01',
  rateDecimal:          '150',
  sourceAmountMinor:    6500,
  convertedAmountMinor: 9750,
  fetchedAt:            NOW,
}
const fxGroup = { sourceCurrency: 'USD', sourceAmountMinor: 6500, settledOn: '2026-06-01', fxSnapshot: baseFx }
const parse = (doc: Record<string, unknown>) => SettlementDocSchema.safeParse(doc).success

describe('SettlementDocSchema — legs', () => {
  it('parses a transfer leg and an offset leg', () => {
    expect(parse(baseDoc())).toBe(true)
    expect(parse(baseDoc({ route: offsetHeader() }))).toBe(true)
  })

  it('requires the route header: no write path produces a settlement without one', () => {
    expect(parse(baseDoc({ route: undefined }))).toBe(false)
  })

  it('keeps the header, ignoring header fields it does not know (forward compatible)', () => {
    const parsed = SettlementDocSchema.parse(baseDoc({ route: transferHeader({ note: '晚餐', ownerRecorded: true, futureField: 1 }) }))
    expect(parsed.route).toMatchObject({ id: 'route-1', kind: 'TRANSFER', note: '晚餐', ownerRecorded: true })
    expect(parsed.route).not.toHaveProperty('futureField')
  })

  it('a transfer needs payer, receiver and amount; an offset must have none', () => {
    expect(parse(baseDoc({ route: transferHeader({ payerUid: undefined }) }))).toBe(false)
    expect(parse(baseDoc({ route: offsetHeader({ amountMinor: 5 }) }))).toBe(false)
  })

  it('rejects a leg index outside the route', () => {
    expect(parse(baseDoc({ route: transferHeader({ legIndex: 2 }) }))).toBe(false)
  })

  it('parses Worker-derived lineage (appliedSources / appliedExpenseIds)', () => {
    expect(parse(baseDoc({
      appliedSources: [{ expenseId: 'expense-1', expenseTitle: 'Dinner', itemId: 'item-1', itemName: 'Noodles', amountMinor: 750 }],
      appliedExpenseIds: ['expense-1', 'expense-2'],
    }))).toBe(true)
  })

  it('still parses lineage with a 101–200 char expense title (listener must not die)', () => {
    expect(parse(baseDoc({ appliedSources: [{ expenseId: 'expense-1', expenseTitle: '店'.repeat(150), amountMinor: 750 }] }))).toBe(true)
  })

  it('rejects half-populated appliedSources item identity, a bad currency code and a zero amount', () => {
    expect(parse(baseDoc({ appliedSources: [{ expenseId: 'expense-1', expenseTitle: 'Dinner', itemId: 'item-1', amountMinor: 750 }] }))).toBe(false)
    expect(parse(baseDoc({ currency: 'jpy' }))).toBe(false)
    expect(parse(baseDoc({ amountMinor: 0 }))).toBe(false)
  })
})

describe('SettlementDocSchema — deletedAt / deletedBy soft-delete invariant', () => {
  it('active: no deletedBy; cancelled: deletedBy present', () => {
    expect(parse(baseDoc())).toBe(true)
    expect(parse(baseDoc({ deletedAt: NOW, deletedBy: 'carol-uid' }))).toBe(true)
  })

  it('rejects deletedAt without deletedBy, and deletedBy on an active leg', () => {
    expect(parse(baseDoc({ deletedAt: NOW }))).toBe(false)
    expect(parse(baseDoc({ deletedBy: 'carol-uid' }))).toBe(false)
  })
})

describe('SettlementDocSchema — foreign currency on the route header', () => {
  const foreign = (fx: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    baseDoc({ route: transferHeader(fx), ...over })

  it('parses a full group', () => {
    expect(parse(foreign(fxGroup))).toBe(true)
  })

  it.each(['sourceCurrency', 'sourceAmountMinor', 'fxSnapshot', 'settledOn'])('rejects the group missing %s', field => {
    expect(parse(foreign({ ...fxGroup, [field]: undefined }))).toBe(false)
  })

  it('rejects parts that disagree with the snapshot', () => {
    expect(parse(foreign({ ...fxGroup, sourceCurrency: 'EUR' }))).toBe(false)
    expect(parse(foreign({ ...fxGroup, sourceAmountMinor: 6501 }))).toBe(false)
    expect(parse(foreign({ ...fxGroup, settledOn: '2026-05-31' }))).toBe(false)
  })

  it('rejects a snapshot quoted in another currency than the leg', () => {
    expect(parse(foreign(fxGroup, { currency: 'TWD' }))).toBe(false)
  })

  it('accepts a forward conversion below the cleared amount (display only, decoupled from the ledger)', () => {
    expect(parse(foreign({ ...fxGroup, fxSnapshot: { ...baseFx, convertedAmountMinor: 9748 } }))).toBe(true)
  })

  it('an offset moves no money and carries no foreign group', () => {
    expect(parse(baseDoc({ route: offsetHeader(fxGroup) }))).toBe(false)
  })
})
