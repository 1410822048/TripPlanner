// Behavior test for ExpenseItemAllocationSheet — the item-level allocation
// editor. Handlers are mocked (no state feedback), so each test asserts the
// exact onToggleAllocation / onSetAllocationShares calls a click produces.
// The component portals to document.body, so `screen` queries reach it.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExpenseItemAllocationSheet from './ExpenseItemAllocationSheet'
import type { FormItem } from '../../hooks/useExpenseItems'
import type { TripMember } from '@/features/trips/types'

const members: TripMember[] = [
  { id: 'a', label: 'Alice', color: '#000', bg: '#fff' },
  { id: 'b', label: 'Bob',   color: '#000', bg: '#fff' },
  { id: 'c', label: 'Carol', color: '#000', bg: '#fff' },
]

// Alice=2 shares, Bob=1 share, Carol unselected — exercises every branch.
function item(): FormItem {
  return {
    id: 'item-1', name: 'コーラ', amountMinor: 600, amountText: '600',
    allocations: [{ memberId: 'a', shares: 2 }, { memberId: 'b', shares: 1 }],
  }
}

function renderSheet() {
  const onToggleAllocation = vi.fn()
  const onSetAllocationShares = vi.fn()
  render(
    <ExpenseItemAllocationSheet
      isOpen item={item()} index={0} members={members} currency="JPY"
      onClose={() => {}}
      onToggleAllocation={onToggleAllocation}
      onSetAllocationShares={onSetAllocationShares}
    />,
  )
  return { onToggleAllocation, onSetAllocationShares }
}

describe('ExpenseItemAllocationSheet', () => {
  it('全員 1 份: sets existing allocations to 1, adds unselected members', () => {
    const { onToggleAllocation, onSetAllocationShares } = renderSheet()
    fireEvent.click(screen.getByText('全員 1 份'))
    // a & b already allocated → forced to shares 1
    expect(onSetAllocationShares.mock.calls).toEqual([[0, 'a', 1], [0, 'b', 1]])
    // c unselected → toggled in
    expect(onToggleAllocation.mock.calls).toEqual([[0, 'c']])
  })

  it('クリア: removes every current allocation, touches nothing else', () => {
    const { onToggleAllocation, onSetAllocationShares } = renderSheet()
    fireEvent.click(screen.getByText('クリア'))
    expect(onToggleAllocation.mock.calls).toEqual([[0, 'a'], [0, 'b']])
    expect(onSetAllocationShares).not.toHaveBeenCalled()
  })

  it('minus on shares>1 decrements; minus on shares=1 removes the member', () => {
    const { onToggleAllocation, onSetAllocationShares } = renderSheet()
    fireEvent.click(screen.getByLabelText('Alice の分担数を減らす')) // shares 2 → 1
    expect(onSetAllocationShares).toHaveBeenCalledWith(0, 'a', 1)
    expect(onToggleAllocation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Bob の分担数を減らす'))   // shares 1 → remove
    expect(onToggleAllocation).toHaveBeenCalledWith(0, 'b')
  })

  it('plus increments shares', () => {
    const { onSetAllocationShares } = renderSheet()
    fireEvent.click(screen.getByLabelText('Alice の分担数を増やす')) // 2 → 3
    expect(onSetAllocationShares).toHaveBeenCalledWith(0, 'a', 3)
  })

  it('追加: adds an unselected member', () => {
    const { onToggleAllocation } = renderSheet()
    fireEvent.click(screen.getByText('追加')) // only Carol is unselected
    expect(onToggleAllocation).toHaveBeenCalledWith(0, 'c')
  })
})
