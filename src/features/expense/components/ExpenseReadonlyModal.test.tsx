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
  { id: 'a', displayName: 'Alice', avatarLabel: 'A', color: '#000', bg: '#fff' },
  { id: 'b', displayName: 'Bob', avatarLabel: 'B',   color: '#000', bg: '#fff' },
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
    expect(screen.getByText('適用範圍：サンドイッチ')).toBeTruthy()
  })

  // The two scopes apply DIFFERENT split rules to an otherwise identical-looking
  // row, and this modal is the only view the non-author members get — so the
  // scope has to be legible here or the amounts can't be audited.
  describe('adjustment scope disclosure', () => {
    // Alice pays and is on the splits; the adjustment targets an item that is
    // allocated to Bob ALONE. That separation is what makes "only the target
    // item's allocations appear" a real assertion rather than a coincidence.
    function renderWithAdjustment(overrides: {
      allocations: { memberId: string; shares: number }[]
    }) {
      return render(
        <ExpenseReadonlyModal
          isOpen currency="JPY" members={members} onClose={() => {}}
          expense={expense({
            items: [
              { id: 'i1', name: '天ぷら', amountMinor: 600, allocations: overrides.allocations },
            ],
            adjustments: [{
              id: 'adj1', label: 'クーポン値引', kind: 'COUPON',
              scope: 'ITEM', amountMinor: 100, targetItemId: 'i1',
            }],
          })}
        />,
      )
    }

    /** The 影響 row only — scoped because Alice legitimately appears elsewhere
     *  in the modal (payer + split), so a whole-document query would pass on
     *  the wrong element. */
    const affectedRow = () => screen.getByText('影響').parentElement!

    it('states the rule for expense-scoped adjustments instead of naming an item', () => {
      render(
        <ExpenseReadonlyModal
          isOpen currency="JPY" members={members} onClose={() => {}}
          expense={expense({
            items: [{
              id: 'i1', name: '天ぷら', amountMinor: 600,
              allocations: [{ memberId: 'a', shares: 1 }],
            }],
            adjustments: [{
              id: 'adj1', label: '全体割引', kind: 'COUPON',
              scope: 'EXPENSE', amountMinor: 100,
            }],
          })}
        />,
      )
      expect(screen.getByText('適用範圍：整筆費用')).toBeTruthy()
      // Deliberately NOT "全體": the delta is apportioned across items by their
      // adjusted amount, so a member allocated to nothing is untouched.
      expect(screen.getByText('依各項目調整後金額比例分攤')).toBeTruthy()
      // No per-member list, because expense scope has no single target item.
      expect(screen.queryByText('影響')).toBeNull()
    })

    it('lists only the target item’s allocations, not every trip member', () => {
      renderWithAdjustment({ allocations: [{ memberId: 'b', shares: 1 }] })
      expect(affectedRow().textContent).toContain('Bob')
      expect(affectedRow().textContent).not.toContain('Alice')
    })

    it('keeps a departed member’s allocation visible instead of dropping it', () => {
      // 'zz' is absent from `members`. ExpensePage now ghost-expands the
      // roster before passing it, but this component must not DEPEND on that:
      // a members.filter() implementation would silently drop the allocation
      // for any caller that doesn't, under-reporting who the discount reached.
      renderWithAdjustment({
        allocations: [{ memberId: 'b', shares: 1 }, { memberId: 'zz', shares: 1 }],
      })
      expect(affectedRow().textContent).toContain('Bob')
      expect(affectedRow().textContent).toContain('已退出')
    })

    it('collapses a long allocation list so one row cannot become a roster', () => {
      renderWithAdjustment({
        allocations: ['a', 'b', 'c1', 'c2', 'c3'].map(memberId => ({ memberId, shares: 1 })),
      })
      // 3 shown + "+2" — and the overflow keeps the hidden names reachable
      // via title rather than dropping them from the audit trail entirely.
      const plus = screen.getByText('+2')
      expect(plus.getAttribute('title')).toContain('c2')
      expect(plus.getAttribute('title')).toContain('c3')
    })

    it('truncates visually but keeps the whole name in title for audit', () => {
      const long = 'ながい'.repeat(20)   // 60 chars, well past the visual cap
      render(
        <ExpenseReadonlyModal
          isOpen currency="JPY" onClose={() => {}}
          members={[{ id: 'x', displayName: long, avatarLabel: 'な', color: '#000', bg: '#fff' }]}
          expense={expense({
            paidBy: 'x',
            splits: [{ memberId: 'x', amountMinor: 5000 }],
            items: [{
              id: 'i1', name: '天ぷら', amountMinor: 600,
              allocations: [{ memberId: 'x', shares: 1 }],
            }],
            adjustments: [{
              id: 'adj1', label: 'クーポン値引', kind: 'COUPON',
              scope: 'ITEM', amountMinor: 100, targetItemId: 'i1',
            }],
          })}
        />,
      )
      const nameEl = affectedRow().querySelector(`[title="${long}"]`)
      expect(nameEl).not.toBeNull()
      // Truncation is presentational; the element must not be allowed to
      // stretch the flex row instead of clipping.
      expect(nameEl!.className).toContain('truncate')
      expect(nameEl!.className).toMatch(/max-w-/)
    })
  })
})
