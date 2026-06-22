import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Timestamp } from 'firebase/firestore'
import type { Booking } from '@/types'

const harness = vi.hoisted(() => ({
  bookings: [] as Booking[],
  uid: 'u1',
  canWrite: true,
  openAdd: vi.fn(),
  openEdit: vi.fn(),
  closeModal: vi.fn(),
  openSignIn: vi.fn(),
  closeSignIn: vi.fn(),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  deleteBooking: vi.fn(),
  modalOpen: false,
  formInitialDraft: null as Record<string, unknown> | null,
}))

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({
    isOpen,
    title,
    children,
    footer,
  }: {
    isOpen: boolean
    title: string
    children: ReactNode
    footer?: ReactNode
  }) => (
    isOpen
      ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}{footer}</div>
      : null
  ),
}))

vi.mock('./AttachmentPreviewModal', () => ({
  default: ({ fileName, onClose }: { fileName: string; onClose: () => void }) => (
    <div role="dialog" aria-label="attachment-preview">
      preview:{fileName}
      <button type="button" onClick={onClose}>preview close</button>
    </div>
  ),
}))

vi.mock('./BookingFormModal', () => ({
  default: (props: {
    isOpen: boolean
    initialDraft?: Record<string, unknown>
  }) => {
    harness.formInitialDraft = props.initialDraft ?? null
    return props.isOpen ? <div role="dialog" aria-label="booking-form" /> : null
  },
}))

vi.mock('@/hooks/useFeatureListPage', () => ({
  useFeatureListPage: () => ({
    ctx: {
      status: 'cloud',
      trip: {
        id: 'trip-1',
        title: 'Tokyo',
        startDate: { toDate: () => new Date('2026-06-17T00:00:00') },
        endDate: { toDate: () => new Date('2026-06-20T00:00:00') },
      },
    },
    uid: harness.uid,
    cloudTripId: 'trip-1',
    mutationTripId: 'trip-1',
    isDemo: false,
    canWrite: harness.canWrite,
    modal: {
      isOpen: harness.modalOpen,
      key: 'closed',
      editTarget: null,
      openAdd: harness.openAdd,
      openEdit: harness.openEdit,
      close: harness.closeModal,
    },
    signIn: {
      isOpen: false,
      open: harness.openSignIn,
      close: harness.closeSignIn,
    },
  }),
}))

vi.mock('../hooks/useBookings', () => ({
  bookingUpdateMutationKey: ['bookings', 'update'],
  useBookings: () => ({ data: harness.bookings, isLoading: false }),
  useCreateBooking: () => ({ mutate: harness.createBooking }),
  useUpdateBooking: () => ({ mutate: harness.updateBooking }),
  useDeleteBooking: () => ({ mutate: harness.deleteBooking }),
}))

vi.mock('@/hooks/usePendingMutationIds', () => ({
  usePendingMutationIds: () => new Set<string>(),
}))

vi.mock('@/hooks/useAttachmentUrl', () => ({
  useAttachmentUrl: (path: string | null | undefined, opts: { kind: 'thumb' | 'full' }) =>
    path ? `blob:${opts.kind}:${path}` : null,
}))

vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))
vi.mock('@/components/ui/DemoBanner', () => ({ default: () => null }))
vi.mock('@/components/ui/NoTripEmptyState', () => ({ default: () => null }))

import BookingsPage from './BookingsPage'

const TS = {} as unknown as Timestamp

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'b1',
    tripId: 'trip-1',
    type: 'flight',
    title: 'NH102',
    origin: 'NRT',
    destination: 'TPE',
    confirmationCode: 'ABC123',
    provider: 'ANA',
    checkIn: '2026-06-17T09:30',
    memberIds: ['u1'],
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  }
}

function bookingWithAttachment(overrides: Partial<Booking> = {}): Booking {
  return booking({
    attachment: {
      filePath: 'trips/trip-1/bookings/b1/confirmation.pdf',
      fileType: 'application/pdf',
    },
    ...overrides,
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/bookings')
  harness.bookings = [bookingWithAttachment()]
  harness.uid = 'u1'
  harness.canWrite = true
  harness.openAdd.mockReset()
  harness.openEdit.mockReset()
  harness.closeModal.mockReset()
  harness.openSignIn.mockReset()
  harness.closeSignIn.mockReset()
  harness.createBooking.mockReset()
  harness.updateBooking.mockReset()
  harness.deleteBooking.mockReset()
  harness.modalOpen = false
  harness.formInitialDraft = null
  harness.openAdd.mockImplementation(() => { harness.modalOpen = true })
})

describe('BookingsPage read-first booking flow', () => {
  it('opens the read-only detail sheet before editing a booking', () => {
    render(<BookingsPage />)

    const detailButton = screen.getByRole('button', { name: 'NRT → TPEの詳細を表示' })
    expect(detailButton.tagName).toBe('BUTTON')
    fireEvent.click(detailButton)

    const detail = screen.getByRole('dialog', { name: '予約詳細' })
    expect(within(detail).getAllByText('NRT → TPE').length).toBeGreaterThan(0)
    expect(within(detail).getByRole('button', { name: '編集' })).toBeTruthy()
    expect(harness.openEdit).not.toHaveBeenCalled()
  })

  it('opens edit only from the detail footer', () => {
    render(<BookingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'NRT → TPEの詳細を表示' }))
    fireEvent.click(screen.getByRole('button', { name: '編集' }))

    expect(harness.openEdit).toHaveBeenCalledWith(harness.bookings[0])
    expect(screen.queryByRole('dialog', { name: '予約詳細' })).toBeNull()
  })

  it('opens attachment preview from detail and returns to detail on close', () => {
    render(<BookingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'NRT → TPEの詳細を表示' }))
    fireEvent.click(screen.getByRole('button', { name: '添付を表示: confirmation.pdf' }))

    expect(screen.getByRole('dialog', { name: 'attachment-preview' })).toBeTruthy()
    expect(screen.getByText('preview:NRT → TPE')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '予約詳細' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'preview close' }))

    expect(screen.getByRole('dialog', { name: '予約詳細' })).toBeTruthy()
  })

  it('lets viewers open detail without exposing edit', () => {
    harness.canWrite = false

    render(<BookingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'NRT → TPEの詳細を表示' }))

    const detail = screen.getByRole('dialog', { name: '予約詳細' })
    expect(detail).toBeTruthy()
    expect(within(detail).queryByRole('button', { name: '編集' })).toBeNull()
  })

  it('opens add form with a draft from PWA share target params', async () => {
    window.history.replaceState(
      null,
      '',
      '/bookings?title=Dormy%20Inn&url=https%3A%2F%2Fwww.booking.com%2Fhotel%2Fjp%2Fabc.html',
    )

    render(<BookingsPage />)

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'booking-form' })).toBeTruthy())
    expect(harness.openAdd).toHaveBeenCalledTimes(1)
    expect(harness.formInitialDraft).toMatchObject({
      type:     'hotel',
      title:    'Dormy Inn',
      provider: 'Booking.com',
      link:     'https://www.booking.com/hotel/jp/abc.html',
    })
    expect(window.location.pathname + window.location.search).toBe('/bookings')
  })
})
