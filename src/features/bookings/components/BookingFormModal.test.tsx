import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import BookingFormModal from './BookingFormModal'

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({
    isOpen, title, children, footer,
  }: {
    isOpen: boolean
    title: string
    children: ReactNode
    footer?: ReactNode
  }) => (isOpen ? <div><h2>{title}</h2>{children}{footer}</div> : null),
}))

describe('BookingFormModal link defaults', () => {
  test('autofills blank create form from a reservation URL', () => {
    const onSave = vi.fn()
    render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    )

    const link = 'https://www.booking.com/hotel/jp/abc.html'
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: link } })
    fireEvent.blur(screen.getByPlaceholderText('https://...'))

    expect(screen.getAllByDisplayValue('Booking.com')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '予約を追加' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        type:     'hotel',
        title:    'Booking.com',
        provider: 'Booking.com',
        link,
      }),
    }))
  })

  test('does not overwrite a title or provider the user already entered', () => {
    const onSave = vi.fn()
    render(
      <BookingFormModal
        editTarget={null}
        initialDraft={{
          type:     'other',
          title:    'Manual title',
          provider: 'Manual provider',
        }}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    )

    const link = 'https://www.trip.com/orders/123'
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: link } })
    fireEvent.blur(screen.getByPlaceholderText('https://...'))

    expect(screen.getByDisplayValue('Manual title')).toBeTruthy()
    expect(screen.getByDisplayValue('Manual provider')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '予約を追加' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        type:     'other',
        title:    'Manual title',
        provider: 'Manual provider',
        link,
      }),
    }))
  })
})
