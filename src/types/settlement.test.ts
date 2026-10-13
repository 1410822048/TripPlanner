// Tests for SettlementDocSchema — every settlement is a route stored as one
// doc with its legs inside. The schema parses Firestore docs on read; its
// invariants keep the history UI and the chronological replay from ever
// seeing a half-populated record, and route a Worker bug / raw admin write
// through the same firestoreDocFromSchema Sentry path as other doc-shape
// regressions.
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { SettlementDocSchema, legSources, lockedExpenseIds } from './settlement'

const NOW = Timestamp.fromDate(new Date('2026-06-01T00:00:00Z'))

/** A → C via B: a trip-currency transfer with two legs. Record<string,
 *  unknown> so fixtures can add / override fields freely. */
function transfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tripId:          'trip-1',
    kind:            'TRANSFER',
    currency:        'JPY',
    participantUids: ['alice-uid', 'bob-uid', 'carol-uid'],
    legs: [
      { fromUid: 'alice-uid', toUid: 'bob-uid', amountMinor: 9750 },
      { fromUid: 'bob-uid', toUid: 'carol-uid', amountMinor: 9750 },
    ],
    payerUid:    'alice-uid',
    receiverUid: 'carol-uid',
    amountMinor: 9750,
    settledBy:   'carol-uid',
    createdAt:   NOW,
    deletedAt:   null,
    ...overrides,
  }
}

function offset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return transfer({
    kind: 'OFFSET', payerUid: undefined, receiverUid: undefined, amountMinor: undefined,
    legs: [
      { fromUid: 'alice-uid', toUid: 'bob-uid', amountMinor: 500 },
      { fromUid: 'bob-uid', toUid: 'carol-uid', amountMinor: 500 },
      { fromUid: 'carol-uid', toUid: 'alice-uid', amountMinor: 500 },
    ],
    ...overrides,
  })
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

describe('SettlementDocSchema — shape', () => {
  it('parses a transfer and an offset', () => {
    expect(parse(transfer())).toBe(true)
    expect(parse(offset())).toBe(true)
  })

  it('requires at least one leg, and no leg may clear a debt to oneself', () => {
    expect(parse(transfer({ legs: [] }))).toBe(false)
    expect(parse(transfer({ legs: undefined }))).toBe(false)
    expect(parse(transfer({ legs: [{ fromUid: 'alice-uid', toUid: 'alice-uid', amountMinor: 1 }] }))).toBe(false)
    expect(parse(transfer({ legs: [{ fromUid: 'alice-uid', toUid: 'bob-uid', amountMinor: 0 }] }))).toBe(false)
  })

  it('a transfer needs payer, receiver and amount; an offset must have none', () => {
    expect(parse(transfer({ payerUid: undefined }))).toBe(false)
    expect(parse(offset({ amountMinor: 5 }))).toBe(false)
  })

  it('ignores fields it does not know (forward compatible)', () => {
    const parsed = SettlementDocSchema.parse(transfer({ note: '晚餐', ownerRecorded: true, futureField: 1 }))
    expect(parsed).toMatchObject({ kind: 'TRANSFER', note: '晚餐', ownerRecorded: true })
    expect(parsed).not.toHaveProperty('futureField')
  })

  it('rejects a bad currency code and a note past the cap', () => {
    expect(parse(transfer({ currency: 'jpy' }))).toBe(false)
    expect(parse(transfer({ note: 'x'.repeat(201) }))).toBe(false)
  })
})

describe('SettlementDocSchema — lineage', () => {
  it('parses sources tagged with their leg, and the lock set', () => {
    expect(parse(transfer({
      appliedSources: [
        { legIndex: 0, expenseId: 'expense-1', expenseTitle: 'Dinner', itemId: 'item-1', itemName: 'Noodles', amountMinor: 750 },
        { legIndex: 1, expenseId: 'expense-2', expenseTitle: 'Taxi', amountMinor: 9750 },
      ],
      lockedExpenses: [{ expenseId: 'expense-1', legIndexes: [0] }, { expenseId: 'expense-2', legIndexes: [0, 1] }],
    }))).toBe(true)
  })

  it('rejects a lock naming no leg or a leg past the last one', () => {
    expect(parse(transfer({ lockedExpenses: [{ expenseId: 'e', legIndexes: [] }] }))).toBe(false)
    expect(parse(transfer({ lockedExpenses: [{ expenseId: 'e', legIndexes: [2] }] }))).toBe(false)
  })

  it('lockedExpenseIds lists every locked expense once', () => {
    expect(lockedExpenseIds({ lockedExpenses: [{ expenseId: 'a', legIndexes: [0, 1] }, { expenseId: 'b', legIndexes: [1] }] })).toEqual(['a', 'b'])
    expect(lockedExpenseIds({})).toEqual([])
  })

  it('rejects a source pointing past the last leg', () => {
    expect(parse(transfer({ appliedSources: [{ legIndex: 2, expenseId: 'e', expenseTitle: 't', amountMinor: 1 }] }))).toBe(false)
  })

  it('still parses lineage with a 101–200 char expense title (listener must not die)', () => {
    expect(parse(transfer({ appliedSources: [{ legIndex: 0, expenseId: 'expense-1', expenseTitle: '店'.repeat(150), amountMinor: 750 }] }))).toBe(true)
  })

  it('rejects half-populated item identity', () => {
    expect(parse(transfer({ appliedSources: [{ legIndex: 0, expenseId: 'expense-1', expenseTitle: 'Dinner', itemId: 'item-1', amountMinor: 750 }] }))).toBe(false)
  })

  it('legSources returns one leg\'s sources without the leg tag, in stored order', () => {
    const record = {
      appliedSources: [
        { legIndex: 1, expenseId: 'b', expenseTitle: 'B', amountMinor: 2 },
        { legIndex: 0, expenseId: 'a', expenseTitle: 'A', itemId: 'i', itemName: 'I', amountMinor: 1 },
        { legIndex: 1, expenseId: 'c', expenseTitle: 'C', amountMinor: 3 },
      ],
    }
    expect(legSources(record, 1)).toEqual([
      { expenseId: 'b', expenseTitle: 'B', amountMinor: 2 },
      { expenseId: 'c', expenseTitle: 'C', amountMinor: 3 },
    ])
    expect(legSources(record, 0)).toEqual([{ expenseId: 'a', expenseTitle: 'A', itemId: 'i', itemName: 'I', amountMinor: 1 }])
    expect(legSources({}, 0)).toEqual([])
  })
})

describe('SettlementDocSchema — deletedAt / deletedBy soft-delete invariant', () => {
  it('active: no deletedBy; cancelled: deletedBy present', () => {
    expect(parse(transfer())).toBe(true)
    expect(parse(transfer({ deletedAt: NOW, deletedBy: 'carol-uid' }))).toBe(true)
  })

  it('rejects deletedAt without deletedBy, and deletedBy on an active settlement', () => {
    expect(parse(transfer({ deletedAt: NOW }))).toBe(false)
    expect(parse(transfer({ deletedBy: 'carol-uid' }))).toBe(false)
  })
})

describe('SettlementDocSchema — foreign currency', () => {
  it('parses a full group', () => {
    expect(parse(transfer(fxGroup))).toBe(true)
  })

  it.each(['sourceCurrency', 'sourceAmountMinor', 'fxSnapshot', 'settledOn'])('rejects the group missing %s', field => {
    expect(parse(transfer({ ...fxGroup, [field]: undefined }))).toBe(false)
  })

  it('rejects parts that disagree with the snapshot', () => {
    expect(parse(transfer({ ...fxGroup, sourceCurrency: 'EUR' }))).toBe(false)
    expect(parse(transfer({ ...fxGroup, sourceAmountMinor: 6501 }))).toBe(false)
    expect(parse(transfer({ ...fxGroup, settledOn: '2026-05-31' }))).toBe(false)
  })

  it('rejects a snapshot quoted in another currency than the settlement', () => {
    expect(parse(transfer({ ...fxGroup, currency: 'TWD' }))).toBe(false)
  })

  it('accepts a forward conversion below the cleared amount (display only, decoupled from the ledger)', () => {
    expect(parse(transfer({ ...fxGroup, fxSnapshot: { ...baseFx, convertedAmountMinor: 9748 } }))).toBe(true)
  })

  it('an offset moves no money and carries no foreign group', () => {
    expect(parse(offset(fxGroup))).toBe(false)
  })
})
