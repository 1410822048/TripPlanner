// Render tests for SettlementSummary — the orchestration the math tests in
// settlement.test.ts / settlement-core don't reach: the empty-state guard,
// the record gate per route kind (receiver / offset participant / owner for
// departed), the intermediate's explanation, 「記錄收款」, route-grouped
// history and whole-route cancel. computeBalancesFull and the planner run
// for real (they're pure) — the only fixtures are expenses / members /
// settlements, exactly like the page.
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import SettlementSummary from './SettlementSummary'
import type { TripMember } from '@/features/trips/types'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import { formatMinorAmount } from '@/utils/money'

const member = (id: string, name: string): TripMember => ({ id, displayName: name, avatarLabel: name[0]!, color: '#000', bg: '#fff' })
const A = member('u1', 'Alice')
const B = member('u2', 'Bob')
const C = member('u3', 'Carol')
const MEMBERS = [A, B]

function mkExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'e1', tripId: 't1', title: 't', amountMinor: 10_000, currency: 'JPY',
    category: 'food', paidBy: 'u1', date: '2026-06-01',
    splits: [{ memberId: 'u1', amountMinor: 5000 }, { memberId: 'u2', amountMinor: 5000 }],
    adjustments: [], createdBy: 'u1', updatedBy: 'u1',
    memberIds: ['u1', 'u2'], createdAt: TS, updatedAt: TS,
    deletedAt: null, receiptPurgedAt: null,
    ...over,
  }
}

type Props = Parameters<typeof SettlementSummary>[0]
// Default fixture: A paid 10,000 split 5k/5k → B owes A 5,000.
function base(over: Partial<Props> = {}): Props {
  return {
    expenses: [mkExpense()], members: MEMBERS, settlements: [], formerMemberNames: {},
    currency: 'JPY', uid: null, canDeleteAnySettlement: false,
    onRecord: vi.fn(), onDeleteSettlement: vi.fn(),
    ...over,
  }
}

// A → B → C chain: Bob paid for Alice (A owes B 3000), Carol paid for Bob
// (B owes C 3000) → simplified to "Alice pays Carol 3000 via Bob".
const CHAIN = [
  mkExpense({ id: 'dinner', title: '晚餐', paidBy: 'u2', amountMinor: 3000, splits: [{ memberId: 'u1', amountMinor: 3000 }] }),
  mkExpense({ id: 'taxi', title: '計程車', paidBy: 'u3', amountMinor: 3000, splits: [{ memberId: 'u2', amountMinor: 3000 }] }),
]

const RECORD_BTN = { name: /記錄已收到/ }

describe('SettlementSummary — empty state', () => {
  it('renders nothing when there are no live expenses and no settlements', () => {
    const { container } = render(<SettlementSummary {...base({ expenses: [], settlements: [] })} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('SettlementSummary — receiver-only record gate', () => {
  it('shows the 已收款 record button to the payee (receiver)', () => {
    render(<SettlementSummary {...base({ uid: 'u1' })} />)
    expect(screen.getByRole('button', RECORD_BTN)).toBeTruthy()
    expect(screen.queryByText('等待收款')).toBeNull()
  })

  it('shows a 等待收款 status to the payer, not a button', () => {
    render(<SettlementSummary {...base({ uid: 'u2' })} />)
    expect(screen.getByText('等待收款')).toBeTruthy()
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })

  it('still offers the button when the payer has left the trip', () => {
    render(<SettlementSummary {...base({ members: [A], uid: 'u1' })} />)
    expect(screen.getByRole('button', RECORD_BTN)).toBeTruthy()
  })

  it('lets the trip owner record for a payee who has LEFT the trip', () => {
    render(<SettlementSummary {...base({ members: [B, C], uid: 'u3', canRecordForDeparted: true, formerMemberNames: { u1: 'Alice' } })} />)
    expect(screen.getByRole('button', { name: /代 .*記錄已收到/ })).toBeTruthy()
  })

  it('a non-owner gets no 代記 button for a departed payee', () => {
    render(<SettlementSummary {...base({ members: [B, C], uid: 'u3', formerMemberNames: { u1: 'Alice' } })} />)
    expect(screen.queryByRole('button', { name: /記錄已收到/ })).toBeNull()
  })

  it('withholds the button from a PAYEE who has been removed', () => {
    render(<SettlementSummary {...base({ members: [B], uid: 'u1' })} />)
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })
})

describe('SettlementSummary — simplified routes', () => {
  const chain = (over: Partial<Props> = {}) => base({ expenses: CHAIN, members: [A, B, C], ...over })

  it('shows one payment through the middle person, not two pair payments', () => {
    const onRecord = vi.fn()
    render(<SettlementSummary {...chain({ uid: 'u3', onRecord })} />)
    expect(screen.getByText(/付款建議（1 筆付款）/)).toBeTruthy()
    expect(screen.getByText('經 Bob')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', RECORD_BTN))
    expect(onRecord).toHaveBeenCalledWith({
      kind: 'TRANSFER', mode: 'suggestion', payerUid: 'u1', receiverUid: 'u3', amountMinor: 3000,
      planned: {
        kind: 'TRANSFER', payerUid: 'u1', receiverUid: 'u3', amountMinor: 3000,
        legs: [
          { fromUid: 'u1', toUid: 'u2', amountMinor: 3000, expectedRemainingMinor: 3000 },
          { fromUid: 'u2', toUid: 'u3', amountMinor: 3000, expectedRemainingMinor: 3000 },
        ],
      },
    })
  })

  it('tells the intermediate they pay nothing and why', () => {
    render(<SettlementSummary {...chain({ uid: 'u2' })} />)
    expect(screen.getByText(/你不用付款/)).toBeTruthy()
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })

  it('expands to the legs and the expenses each one clears', () => {
    render(<SettlementSummary {...chain({ uid: null })} />)
    fireEvent.click(screen.getByRole('button', { name: /明細（2 段）/ }))
    expect(screen.getByText(`來源：晚餐 ${formatMinorAmount(3000, 'JPY')}`)).toBeTruthy()
    expect(screen.getByText(`來源：計程車 ${formatMinorAmount(3000, 'JPY')}`)).toBeTruthy()
  })

  it('a debt cycle is an offset only its participants can record', () => {
    const cycle = [
      ...CHAIN,
      mkExpense({ id: 'hotel', title: '住宿', paidBy: 'u1', amountMinor: 3000, splits: [{ memberId: 'u3', amountMinor: 3000 }] }),
    ]
    const onRecord = vi.fn()
    render(<SettlementSummary {...base({ expenses: cycle, members: [A, B, C], uid: 'u2', onRecord })} />)
    expect(screen.getByText(/互相抵銷 · 不需付款/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /記錄 .* 互相抵銷/ }))
    expect(onRecord.mock.calls[0]![0]).toMatchObject({ kind: 'OFFSET', route: { participantUids: ['u1', 'u2', 'u3'] } })
  })

  it('an outsider cannot record someone else\'s offset', () => {
    const D = member('u4', 'Dan')
    const cycle = [
      ...CHAIN,
      mkExpense({ id: 'hotel', paidBy: 'u1', amountMinor: 3000, splits: [{ memberId: 'u3', amountMinor: 3000 }] }),
    ]
    render(<SettlementSummary {...base({ expenses: cycle, members: [A, B, C, D], uid: 'u4', canRecordForDeparted: true })} />)
    expect(screen.queryByRole('button', { name: /互相抵銷/ })).toBeNull()
    expect(screen.getByText('等待確認')).toBeTruthy()
  })
})

describe('SettlementSummary —「記錄收款」', () => {
  it('is offered to someone the ledger owes, and opens a payment intent', () => {
    const onRecord = vi.fn()
    render(<SettlementSummary {...base({ uid: 'u1', onRecord })} />)
    fireEvent.click(screen.getByRole('button', { name: /記錄收款/ }))
    expect(onRecord).toHaveBeenCalledWith({ kind: 'TRANSFER', mode: 'payment', receiverUid: 'u1' })
  })

  it('is not offered to someone nobody owes', () => {
    render(<SettlementSummary {...base({ uid: 'u2' })} />)
    expect(screen.queryByRole('button', { name: /記錄收款/ })).toBeNull()
  })
})

describe('SettlementSummary — route history', () => {
  const header = { id: 'r1', legCount: 2, kind: 'TRANSFER' as const, participantUids: ['u1', 'u2', 'u3'], payerUid: 'u1', receiverUid: 'u3', amountMinor: 3000 }
  const leg = (i: number, from: string, to: string): SettlementRecord => ({
    id: `r1-0${i}`, tripId: 't1', fromUid: from, toUid: to, amountMinor: 3000, currency: 'JPY',
    settledBy: 'u3', createdAt: TS, deletedAt: null, route: { ...header, legIndex: i },
    appliedSources: [{ expenseId: i === 0 ? 'dinner' : 'taxi', expenseTitle: i === 0 ? '晚餐' : '計程車', amountMinor: 3000 }],
  })
  const settled = [leg(0, 'u1', 'u2'), leg(1, 'u2', 'u3')]

  it('shows one row per route, and cancelling it hides every leg', () => {
    const onDeleteSettlement = vi.fn()
    render(<SettlementSummary {...base({ expenses: CHAIN, members: [A, B, C], settlements: settled, uid: 'u3', onDeleteSettlement })} />)
    expect(screen.getByText(/已清算紀錄（1 筆）/)).toBeTruthy()
    const history = screen.getByText(/已清算紀錄/).parentElement!.parentElement!
    expect(within(history).getByText('經 Bob')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刪除清算紀錄' }))
    fireEvent.click(screen.getByRole('button', { name: /確認刪除整筆清算紀錄/ }))
    expect(onDeleteSettlement).toHaveBeenCalledWith('r1-00', ['r1-00', 'r1-01'])
    // The ledger is settled by the route: no suggestion left.
    expect(screen.getByText(/所有成員的帳務已平衡/)).toBeTruthy()
  })

  it('neither the payer nor the intermediate may cancel it', () => {
    for (const uid of ['u1', 'u2']) {
      const { unmount } = render(<SettlementSummary {...base({ expenses: CHAIN, members: [A, B, C], settlements: settled, uid })} />)
      expect(screen.queryByRole('button', { name: '刪除清算紀錄' })).toBeNull()
      unmount()
    }
  })
})

describe('SettlementSummary — balances + all-settled', () => {
  it('renders signed net credit / debit per member', () => {
    render(<SettlementSummary {...base({ uid: null })} />)
    expect(screen.getByText(`+${formatMinorAmount(5000, 'JPY')}`)).toBeTruthy()
    expect(screen.getByText(`-${formatMinorAmount(5000, 'JPY')}`)).toBeTruthy()
  })

  it('shows the all-settled chip when the balances net out', () => {
    const expenses = [mkExpense({ splits: [{ memberId: 'u1', amountMinor: 10_000 }] })]
    render(<SettlementSummary {...base({ expenses, uid: null })} />)
    expect(screen.getByText('已清算')).toBeTruthy()
    expect(screen.getByText(/所有成員的帳務已平衡/)).toBeTruthy()
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })
})
