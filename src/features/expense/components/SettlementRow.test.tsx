// Render + fireEvent tests for SettlementRow — the single「清算済み」record
// row extracted from SettlementSummary. Covers the branches a pure fn can't:
// trip- vs foreign-currency amount lines, the orphan reason chip + its
// source hint, the canDelete gate, and the two-tap delete latch. The row is
// pure presentation (no store / network / portal), so nothing is mocked —
// the tests pass exactly the fixtures the parent (SettlementHistory) would.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettlementRow from './SettlementRow'
import { ORPHAN_REASON_COPY } from './settlementOrphanCopy'
import type { OrphanSettlement } from '../services/settlement'
import type { TripMember } from '@/features/trips/types'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import { formatMinorAmount } from '@/utils/money'

const FROM: TripMember = { id: 'u1', label: 'A', color: '#000', bg: '#fff' }
const TO:   TripMember = { id: 'u2', label: 'B', color: '#000', bg: '#fff' }

function rec(over: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: 's1', tripId: 't1', fromUid: 'u1', toUid: 'u2',
    amountMinor: 5000, currency: 'JPY', settledBy: 'u2', createdAt: TS,
    deletedAt: null,
    ...over,
  }
}

function orphan(over: Partial<OrphanSettlement> = {}): OrphanSettlement {
  return { fromUserId: 'u1', toUserId: 'u2', amountMinor: 5000, settlementId: 's1', reason: 'EXPENSE_DELETED', ...over }
}

function mkExpense(over: Partial<Expense>): Expense {
  return {
    id: 'e1', tripId: 't1', title: 't', amountMinor: 5000, currency: 'JPY',
    category: 'food', paidBy: 'u1', splits: [], date: '2026-06-01',
    adjustments: [], createdBy: 'u1', updatedBy: 'u1',
    memberIds: ['u1', 'u2'], createdAt: TS, updatedAt: TS, ...over,
  }
}

type RowProps = Parameters<typeof SettlementRow>[0]
function renderRow(props: Partial<RowProps> = {}) {
  const onDelete = props.onDelete ?? vi.fn()
  render(
    <SettlementRow
      record={rec()} from={FROM} to={TO} currency="JPY"
      expenses={[]} canDelete onDelete={onDelete}
      {...props}
    />,
  )
  return onDelete
}

describe('SettlementRow — amount rendering', () => {
  it('renders the trip-currency ledger amount on a single line', () => {
    renderRow()
    expect(screen.getByText(formatMinorAmount(5000, 'JPY'))).toBeTruthy()
  })

  it('renders the foreign source amount above the trip-currency ledger amount', () => {
    renderRow({ record: rec({ sourceCurrency: 'TWD', sourceAmountMinor: 11_000, amountMinor: 5000 }) })
    expect(screen.getByText(formatMinorAmount(11_000, 'TWD'))).toBeTruthy() // received-in source line
    expect(screen.getByText(formatMinorAmount(5000, 'JPY'))).toBeTruthy()   // ledger line
  })
})

describe('SettlementRow — delete affordance', () => {
  it('arms on first tap and only fires onDelete on the second', () => {
    const onDelete = renderRow()
    fireEvent.click(screen.getByRole('button', { name: '清算記録を削除' }))
    expect(onDelete).not.toHaveBeenCalled()
    const armed = screen.getByRole('button', { name: '清算記録の削除を確認' })
    expect(armed.textContent).toContain('確認')
    fireEvent.click(armed)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('hides the delete button when canDelete is false', () => {
    renderRow({ canDelete: false })
    expect(screen.queryByRole('button', { name: '清算記録を削除' })).toBeNull()
  })
})

describe('SettlementRow — orphan chip + source hint', () => {
  it('renders the reason chip with the short label + full copy in the title', () => {
    renderRow({ orphan: orphan({ reason: 'EXPENSE_DELETED', amountMinor: 5000 }) })
    const chip = screen.getByTitle(ORPHAN_REASON_COPY.EXPENSE_DELETED)
    expect(chip.getAttribute('aria-label')).toContain('已刪除')
    expect(chip.getAttribute('aria-label')).toContain(formatMinorAmount(5000, 'JPY'))
  })

  it('derives a source hint from a deleted source expense', () => {
    renderRow({
      orphan: orphan(),
      expenses: [mkExpense({ id: 'e1', deletedAt: TS })],
      record: rec({ appliedSources: [{ expenseId: 'e1', expenseTitle: 'Lunch', amountMinor: 5000 }] }),
    })
    expect(screen.getByText(/來源：Lunch/)).toBeTruthy()
  })

  it('falls back to a generic note when the source expense + item are still present', () => {
    renderRow({
      orphan: orphan(),
      expenses: [mkExpense({ id: 'e1' })],
      record: rec({ appliedSources: [{ expenseId: 'e1', expenseTitle: 'Lunch', amountMinor: 5000 }] }),
    })
    expect(screen.getByText('清算後可能有費用被變更過。')).toBeTruthy()
  })

  it('shows no source hint when the row is not orphan', () => {
    renderRow({ record: rec({ appliedSources: [{ expenseId: 'e1', expenseTitle: 'Lunch', amountMinor: 5000 }] }) })
    expect(screen.queryByText(/來源/)).toBeNull()
  })
})
