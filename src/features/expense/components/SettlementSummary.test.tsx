// Render tests for SettlementSummary — the orchestration the math tests in
// settlement.test.ts don't reach: the empty-state guard, the receiver-only
// 「済み」record gate (payee sees a button, everyone else a 受取待ち status),
// the signed net balance lines, and the all-settled chip. computeBalancesFull
// / computeSettlementSuggestions run for real (they're pure) — the only
// fixtures are expenses / members / settlements, exactly like the page.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SettlementSummary from './SettlementSummary'
import type { TripMember } from '@/features/trips/types'
import type { Expense } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import { formatMinorAmount } from '@/utils/money'

const A: TripMember = { id: 'u1', label: 'A', color: '#000', bg: '#fff' }
const B: TripMember = { id: 'u2', label: 'B', color: '#000', bg: '#fff' }
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
// Suggestion is B→A 5,000; the receiver (toId) is A (u1).
function base(over: Partial<Props> = {}): Props {
  return {
    expenses: [mkExpense()], members: MEMBERS, settlements: [],
    currency: 'JPY', uid: null, isOwner: false,
    onRecordSettlement: vi.fn(), onDeleteSettlement: vi.fn(),
    ...over,
  }
}

const RECORD_BTN = { name: /記錄已收到/ }

describe('SettlementSummary — empty state', () => {
  it('renders nothing when there are no live expenses and no settlements', () => {
    const { container } = render(<SettlementSummary {...base({ expenses: [], settlements: [] })} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('SettlementSummary — receiver-only record gate', () => {
  it('shows the 済み record button to the payee (receiver)', () => {
    render(<SettlementSummary {...base({ uid: 'u1' })} />) // u1 = payee
    expect(screen.getByRole('button', RECORD_BTN)).toBeTruthy()
    expect(screen.queryByText('等待收款')).toBeNull()
  })

  it('shows a 受取待ち status to the payer, not a button', () => {
    render(<SettlementSummary {...base({ uid: 'u2' })} />) // u2 = payer
    expect(screen.getByText('等待收款')).toBeTruthy()
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })
})

describe('SettlementSummary — balances + all-settled', () => {
  it('renders signed net credit / debit per member', () => {
    render(<SettlementSummary {...base({ uid: null })} />)
    expect(screen.getByText(`+${formatMinorAmount(5000, 'JPY')}`)).toBeTruthy() // payee credit
    expect(screen.getByText(`-${formatMinorAmount(5000, 'JPY')}`)).toBeTruthy() // payer debit
  })

  it('shows the all-settled chip when the balances net out', () => {
    const expenses = [mkExpense({ splits: [{ memberId: 'u1', amountMinor: 10_000 }] })]
    render(<SettlementSummary {...base({ expenses, uid: null })} />)
    expect(screen.getByText('已清算')).toBeTruthy()
    expect(screen.getByText(/所有成員的帳務已平衡/)).toBeTruthy()
    expect(screen.queryByRole('button', RECORD_BTN)).toBeNull()
  })
})
