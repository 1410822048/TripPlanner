import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExpenseAdjustmentRow from './ExpenseAdjustmentRow'
import type { ExpenseAdjustment } from '@/types/expense'
import type { FormItem } from '../../hooks/useExpenseItems'
import type { TripMember } from '@/features/trips/types'

const adjustment: ExpenseAdjustment = {
  id:           'adjustment-1',
  label:        'GW 附加費',
  kind:         'SURCHARGE',
  scope:        'ITEM',
  amountMinor:  197,
  targetItemId: 'item-1',
}

const items: FormItem[] = [{
  id:          'item-1',
  name:        '可口可樂',
  amountMinor: 322,
  amountText:  '322',
  allocations: [{ memberId: 'member-1', shares: 1 }],
}]

const members: TripMember[] = [{
  id:    'member-1',
  label: '我',
  color: '#000',
  bg:    '#fff',
}]

describe('ExpenseAdjustmentRow', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('uses the shared picker for kind, scope, and target item', () => {
    const onSetKind = vi.fn()
    const onSetScope = vi.fn()
    const onSetTarget = vi.fn()

    render(
      <ExpenseAdjustmentRow
        index={0}
        adjustment={adjustment}
        items={items}
        members={members}
        symbol="¥"
        tripCurrency="JPY"
        amountValue="197"
        convertedAdjustmentAmount={undefined}
        onSetLabel={vi.fn()}
        onSetAmount={vi.fn()}
        onSetKind={onSetKind}
        onSetScope={onSetScope}
        onSetTarget={onSetTarget}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.queryByRole('combobox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '調整 1 種類：加 附加費' }))
    fireEvent.click(screen.getByRole('option', { name: '折 折扣' }))
    expect(onSetKind).toHaveBeenCalledWith('adjustment-1', 'DISCOUNT')

    fireEvent.click(screen.getByRole('button', { name: '調整 1 適用範圍：項 指定項目' }))
    fireEvent.click(screen.getByRole('option', { name: '全 整筆費用' }))
    expect(onSetScope).toHaveBeenCalledWith('adjustment-1', 'EXPENSE', ['item-1'])

    fireEvent.click(screen.getByRole('button', { name: '調整 1 適用項目：1 可口可樂' }))
    fireEvent.click(screen.getByRole('option', { name: '1 可口可樂' }))
    expect(onSetTarget).toHaveBeenCalledWith('adjustment-1', 'item-1')
  })
})
