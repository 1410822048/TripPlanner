import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import BookingFormModal from './BookingFormModal'
import { ATTACHMENT_SIZE_ERROR } from '@/hooks/useAttachment'
import type { BookingPdfExtractCandidate, BookingPdfExtractResult } from '../services/bookingPdfExtractService'

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

const EMPTY_PDF_FIELD = { value: '', confidence: 0, evidence: '' }

function emptyPdfResult(): BookingPdfExtractResult {
  return {
    bookings: [{
      bookingType:      'hotel',
      segmentRole:      'single',
      title:            EMPTY_PDF_FIELD,
      provider:         EMPTY_PDF_FIELD,
      confirmationCode: EMPTY_PDF_FIELD,
      origin:           EMPTY_PDF_FIELD,
      destination:      EMPTY_PDF_FIELD,
      originIataCode:   EMPTY_PDF_FIELD,
      destinationIataCode: EMPTY_PDF_FIELD,
      checkIn:          EMPTY_PDF_FIELD,
      checkOut:         EMPTY_PDF_FIELD,
      address:          EMPTY_PDF_FIELD,
      link:             EMPTY_PDF_FIELD,
    }],
    warnings:         [],
  }
}

function flightCandidate(over: Partial<BookingPdfExtractCandidate> = {}): BookingPdfExtractCandidate {
  return {
    bookingType:      'flight',
    segmentRole:      'outbound',
    title:            { value: 'MM626', confidence: 0.95, evidence: 'MM626' },
    provider:         { value: 'Peach Aviation', confidence: 0.9, evidence: 'Peach Aviation' },
    confirmationCode: { value: 'KATR7X', confidence: 0.9, evidence: 'KATR7X' },
    origin:           { value: 'Taipei', confidence: 0.9, evidence: 'Departure Taiwan Taoyuan International Airport T1' },
    destination:      { value: 'Tokyo', confidence: 0.9, evidence: 'Arrival Narita International Airport T1' },
    originIataCode:   { value: 'TPE', confidence: 0.9, evidence: 'Taiwan Taoyuan International Airport T1' },
    destinationIataCode: { value: 'NRT', confidence: 0.9, evidence: 'Narita International Airport T1' },
    checkIn:          { value: '2026-09-18', confidence: 0.9, evidence: '2026 年 9 月 18 日' },
    checkOut:         EMPTY_PDF_FIELD,
    address:          EMPTY_PDF_FIELD,
    link:             EMPTY_PDF_FIELD,
    ...over,
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

    fireEvent.click(screen.getByRole('button', { name: '手動予約を追加' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        type:     'hotel',
        title:    'Booking.com',
        provider: 'Booking.com',
        link,
      }),
    }))
  })

  test('hotel title ticket editor writes the booking title', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'ホテル' }))
    fireEvent.change(screen.getByLabelText(/hotel accommodation/i), {
      target: { value: '星のや東京 / Hoshinoya' },
    })
    fireEvent.click(screen.getByRole('button', { name: '手動予約を追加' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        type:  'hotel',
        title: '星のや東京 / Hoshinoya',
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

    fireEvent.click(screen.getByRole('button', { name: '手動予約を追加' }))

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
      expect(screen.getByRole('button', { name: /再読取/ })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /再読取/ }))

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
      expect(screen.getByRole('button', { name: /再読取/ })).toBeTruthy()
    })

    fireEvent.change(fileInput(container, 'image/*,application/pdf'), { target: { files: [file] } })

    expect(screen.getByRole('button', { name: /PDFを読み取る/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /再読取/ })).toBeNull()
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

  test('creates selected extracted booking candidates in one action', async () => {
    const onCreateMany = vi.fn()
    bookingPdfExtractMocks.extractBookingPdfAutofill.mockResolvedValueOnce({
      bookings: [
        flightCandidate(),
        flightCandidate({
          segmentRole: 'return',
          title:       { value: 'JX803', confidence: 0.95, evidence: 'JX803' },
          provider:    { value: 'STARLUX Airlines', confidence: 0.9, evidence: 'STARLUX Airlines' },
          origin:      { value: 'Tokyo', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destination: { value: 'Taipei', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          originIataCode: { value: 'NRT', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destinationIataCode: { value: 'TPE', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          checkIn:     { value: '2026-09-26', confidence: 0.9, evidence: 'September 26, 2026' },
        }),
      ],
      warnings: [],
    })

    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
        onCreateMany={onCreateMany}
      />,
    )

    const file = new File(['%PDF-1.7'], 'roundtrip.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('2件の予約候補')
    })

    expect(screen.queryByDisplayValue('MM626')).toBeNull()

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(checkboxes[1]!)
    fireEvent.click(screen.getByRole('button', { name: '選択した予約を追加' }))

    expect(onCreateMany).toHaveBeenCalledWith({
      document: file,
      inputs: [expect.objectContaining({
        type:        'flight',
        title:       'MM626',
        provider:    'Peach Aviation',
        origin:      'Taipei (TPE)',
        destination: 'Tokyo (NRT)',
        checkIn:     '2026-09-18',
      })],
    })
  })

  test('clears stale batch candidates when a replacement PDF is rejected', async () => {
    const onCreateMany = vi.fn()
    bookingPdfExtractMocks.extractBookingPdfAutofill.mockResolvedValueOnce({
      bookings: [
        flightCandidate(),
        flightCandidate({
          segmentRole: 'return',
          title:       { value: 'JX803', confidence: 0.95, evidence: 'JX803' },
          provider:    { value: 'STARLUX Airlines', confidence: 0.9, evidence: 'STARLUX Airlines' },
          origin:      { value: 'Tokyo', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destination: { value: 'Taipei', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          originIataCode: { value: 'NRT', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destinationIataCode: { value: 'TPE', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          checkIn:     { value: '2026-09-26', confidence: 0.9, evidence: 'September 26, 2026' },
        }),
      ],
      warnings: [],
    })

    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
        onCreateMany={onCreateMany}
      />,
    )

    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), {
      target: { files: [new File(['%PDF-1.7'], 'roundtrip.pdf', { type: 'application/pdf' })] },
    })

    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2))

    const largeFile = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'large-booking.pdf',
      { type: 'application/pdf' },
    )
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [largeFile] } })

    expect(screen.getByRole('status').textContent).toBe(ATTACHMENT_SIZE_ERROR)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '選択した予約を追加' })).toBeNull()
  })

  test('keeps the candidate picker usable when only one batch candidate is createable', async () => {
    const onCreateMany = vi.fn()
    bookingPdfExtractMocks.extractBookingPdfAutofill.mockResolvedValueOnce({
      bookings: [
        flightCandidate({
          destination: { value: '', confidence: 0, evidence: '' },
          destinationIataCode: { value: '', confidence: 0, evidence: '' },
        }),
        flightCandidate({
          segmentRole: 'return',
          title:       { value: 'JX803', confidence: 0.95, evidence: 'JX803' },
          provider:    { value: 'STARLUX Airlines', confidence: 0.9, evidence: 'STARLUX Airlines' },
          origin:      { value: 'Tokyo', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destination: { value: 'Taipei', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          originIataCode: { value: 'NRT', confidence: 0.9, evidence: 'Departure 成田國際機場 T2' },
          destinationIataCode: { value: 'TPE', confidence: 0.9, evidence: 'Arrival 臺灣桃園國際機場 T1' },
          checkIn:     { value: '2026-09-26', confidence: 0.9, evidence: 'September 26, 2026' },
        }),
      ],
      warnings: [],
    })

    const { container } = render(
      <BookingFormModal
        editTarget={null}
        isOpen
        isSaving={false}
        onClose={() => {}}
        onSave={() => {}}
        onCreateMany={onCreateMany}
      />,
    )

    const file = new File(['%PDF-1.7'], 'roundtrip.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput(container, 'application/pdf,.pdf'), { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('1件の予約候補')
    })

    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '選択した予約を追加' }))

    expect(onCreateMany).toHaveBeenCalledWith({
      document: file,
      inputs: [expect.objectContaining({
        type:        'flight',
        title:       'JX803',
        provider:    'STARLUX Airlines',
        origin:      'Tokyo (NRT)',
        destination: 'Taipei (TPE)',
        checkIn:     '2026-09-26',
      })],
    })
  })
})
