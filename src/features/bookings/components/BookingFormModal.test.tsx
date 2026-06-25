import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import BookingFormModal from './BookingFormModal'
import { ATTACHMENT_SIZE_ERROR } from '@/hooks/useAttachment'
import type { BookingPdfExtractResult } from '../services/bookingPdfExtractService'

const bookingPdfExtractMocks = vi.hoisted(() => ({
  extractBookingPdfAutofill: vi.fn(),
}))

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

vi.mock('../services/bookingPdfExtractService', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/bookingPdfExtractService')>()
  return {
    ...actual,
    extractBookingPdfAutofill: bookingPdfExtractMocks.extractBookingPdfAutofill,
  }
})

Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: vi.fn(() => 'blob:test'),
})
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn(),
})

function emptyPdfResult(): BookingPdfExtractResult {
  const emptyField = { value: '', confidence: 0, evidence: '' }
  return {
    bookingType:      'hotel',
    title:            emptyField,
    provider:         emptyField,
    confirmationCode: emptyField,
    checkIn:          emptyField,
    checkOut:         emptyField,
    address:          emptyField,
    link:             emptyField,
    warnings:         [],
  }
}

function fileInput(container: HTMLElement, accept: string): HTMLInputElement {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    .find(el => el.accept === accept)
  expect(input).toBeTruthy()
  return input!
}

beforeEach(() => {
  bookingPdfExtractMocks.extractBookingPdfAutofill.mockReset()
  bookingPdfExtractMocks.extractBookingPdfAutofill.mockResolvedValue(emptyPdfResult())
})

describe('BookingFormModal link defaults', () => {
  test('shows provider placeholders for every booking type', () => {
    render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(screen.getByPlaceholderText('ANA')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'ホテル' }))
    expect(screen.getByPlaceholderText('Booking.com')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '電車' }))
    expect(screen.getByPlaceholderText('JR東日本')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'バス' }))
    expect(screen.getByPlaceholderText('WILLER EXPRESS')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'その他' }))
    expect(screen.getByPlaceholderText('Klook')).toBeTruthy()
  })

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

describe('BookingFormModal PDF autofill intent', () => {
  test('does not run PDF autofill when the user only attaches a confirmation file', () => {
    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    const file = new File(['%PDF-1.7'], 'booking.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'image/*,application/pdf'), { target: { files: [file] } })

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill).not.toHaveBeenCalled()
  })

  test('runs PDF autofill only from the explicit PDF autofill action', () => {
    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: /PDFから自動入力/ })).toBeTruthy()

    const file = new File(['%PDF-1.7'], 'booking.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [file] } })

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill)
      .toHaveBeenCalledWith(file, expect.any(AbortSignal))
  })

  test('can read and re-read the current attached PDF', async () => {
    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    const file = new File(['%PDF-1.7'], 'booking.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'image/*,application/pdf'), { target: { files: [file] } })

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /PDFを読み取る/ }))

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill)
      .toHaveBeenCalledWith(file, expect.any(AbortSignal))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /もう一度読み取る/ })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /もう一度読み取る/ }))

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill).toHaveBeenCalledTimes(2)
    expect(bookingPdfExtractMocks.extractBookingPdfAutofill.mock.calls[1]?.[0]).toBe(file)
  })

  test('treats each successful PDF pick as a fresh autofill source', async () => {
    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    const file = new File(['%PDF-1.7'], 'booking.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /もう一度読み取る/ })).toBeTruthy()
    })

    fireEvent.change(fileInput(container, 'image/*,application/pdf'), { target: { files: [file] } })

    expect(screen.getByRole('button', { name: /PDFを読み取る/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /もう一度読み取る/ })).toBeNull()
    expect(bookingPdfExtractMocks.extractBookingPdfAutofill).toHaveBeenCalledTimes(1)
  })

  test('shows oversize PDF autofill errors near the PDF autofill action', () => {
    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    const file = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'large-booking.pdf',
      { type: 'application/pdf' },
    )
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [file] } })

    expect(bookingPdfExtractMocks.extractBookingPdfAutofill).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(ATTACHMENT_SIZE_ERROR)
  })
})
