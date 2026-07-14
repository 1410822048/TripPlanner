// Render test for ExpenseReadonlyModal — proves the settlement-locked detail
// view is genuinely READ-ONLY (no editable inputs / save button) and surfaces
// the key fields incl. the foreign source amount. BottomSheet (portal/anim)
// is stubbed; everything else renders for real.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Timestamp } from 'firebase/firestore'

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: ReactNode }) =>
    (isOpen ? <div><h2>{title}</h2>{children}</div> : null),
}))

import ExpenseReadonlyModal from './ExpenseReadonlyModal'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { formatMinorAmount } from '@/utils/money'

const members: TripMember[] = [
  { id: 'a', label: 'Alice', color: '#000', bg: '#fff' },
  { id: 'b', label: 'Bob',   color: '#000', bg: '#fff' },
]

// The modal never calls Timestamp methods, so an empty cast is safe.
const TS = {} as unknown as Timestamp

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1', tripId: 't1', title: '寿司ランチ', amountMinor: 5000, currency: 'JPY',
    category: 'food', paidBy: 'a',
    splits: [{ memberId: 'a', amountMinor: 2500 }, { memberId: 'b', amountMinor: 2500 }],
    date: '2026-06-01', adjustments: [],
    createdBy: 'a', updatedBy: 'a', memberIds: ['a', 'b'],
    createdAt: TS, updatedAt: TS,
    deletedAt: null,
    receiptPurgedAt: null,
    ...overrides,
  }
}

describe('ExpenseReadonlyModal', () => {
  it('renders the settlement-locked detail with NO editable inputs / save button', () => {
    render(<ExpenseReadonlyModal isOpen isLocked expense={expense()} members={members} currency="JPY" onClose={() => {}} />)
    expect(screen.getByText('已清算')).toBeTruthy()    // lock banner
    expect(screen.getByText('寿司ランチ')).toBeTruthy()  // title
    // Alice is both the payer and a split member, so she appears more than
    // once — assert presence rather than uniqueness.
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    // Read-only: nothing editable, nothing to save.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('button', { name: /儲存|記錄|變更|新增/ })).toBeNull()
  })

  it('shows the foreign source amount when sourceCurrency differs from trip currency', () => {
    render(
      <ExpenseReadonlyModal
        isOpen currency="JPY" members={members} onClose={() => {}}
        expense={expense({ sourceCurrency: 'TWD', sourceAmountMinor: 110000 })}
      />,
    )
    // Use the (separately-tested) formatter as the oracle — assert the modal
    // renders exactly what it produces for the source amount.
    expect(screen.getByText(formatMinorAmount(110000, 'TWD'))).toBeTruthy()
  })

  it('shows the target item for item-scoped adjustments', () => {
    render(
      <ExpenseReadonlyModal
        isOpen currency="JPY" members={members} onClose={() => {}}
        expense={expense({
          items: [
            {
              id: 'i1',
              name: 'サンドイッチ',
              amountMinor: 600,
              allocations: [{ memberId: 'a', shares: 1 }],
            },
          ],
          adjustments: [
            {
              id: 'adj1',
              label: 'クーポン値引',
              kind: 'COUPON',
              scope: 'ITEM',
              amountMinor: 100,
              targetItemId: 'i1',
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('クーポン値引')).toBeTruthy()
    expect(screen.getByText('対象: サンドイッチ')).toBeTruthy()
  })
})
