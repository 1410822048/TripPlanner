import { afterEach, describe, expect, it, vi } from 'vitest'
import { initBookingFormState, type BookingFormState } from '../bookingFormState'

const captureError = vi.fn()

vi.mock('@/services/firebase', () => ({
  getFirebaseAuth: async () => ({ auth: { currentUser: { getIdToken: async () => 'token' } } }),
}))
vi.mock('@/services/workerBase', () => ({ WORKER_BASE_URL: 'https://worker.test' }))
vi.mock('./bookingPdfText', () => ({ extractBookingPdfText: async () => ({ lines: [] }) }))
vi.mock('@/services/sentry', () => ({ captureError: (...args: unknown[]) => captureError(...args) }))

import {
  BookingPdfExtractError,
  bookingPdfCandidateToCreateInput,
  bookingPdfExtractToDraftPatch,
  extractBookingPdfAutofill,
  type BookingPdfExtractCandidate,
} from './bookingPdfExtractService'

function state(over: Partial<BookingFormState> = {}): BookingFormState {
  return initBookingFormState(null, over)
}

function field(value: string, confidence = 0.9, evidence = value) {
  return { value, confidence, evidence }
}

function result(over: Partial<BookingPdfExtractCandidate> = {}): BookingPdfExtractCandidate {
  const emptyField = field('', 0, '')
  return {
    bookingType:      'hotel',
    segmentRole:      'single',
    title:            field('Hotel Sakura'),
    provider:         field('Booking.com'),
    confirmationCode: field('ABC123'),
    origin:           emptyField,
    destination:      emptyField,
    originIataCode:   emptyField,
    destinationIataCode: emptyField,
    checkIn:          field('2026-07-01'),
    checkOut:         field('2026-07-03'),
    address:          field('東京都台東区浅草1-1-1'),
    link:             field('https://example.com/reservation'),
    ...over,
  }
}

describe('bookingPdfExtractToDraftPatch', () => {
  it('prefills blank create forms and flips the default flight type to hotel', () => {
    expect(bookingPdfExtractToDraftPatch(state(), result(), { isEdit: false })).toEqual({
      appliedCount: 8,
      patch: {
        type:             'hotel',
        title:            'Hotel Sakura',
        provider:         'Booking.com',
        confirmationCode: 'ABC123',
        checkIn:          '2026-07-01',
        checkOut:         '2026-07-03',
        address:          '東京都台東区浅草1-1-1',
        link:             'https://example.com/reservation',
      },
    })
  })

  it('does not overwrite fields the user already typed while extraction was running', () => {
    const out = bookingPdfExtractToDraftPatch(
      state({
        type:             'hotel',
        title:            'Manual hotel',
        provider:         'Manual provider',
        confirmationCode: 'MANUAL',
      }),
      result(),
      { isEdit: false },
    )

    expect(out.patch).not.toMatchObject({
      title:            'Hotel Sakura',
      provider:         'Booking.com',
      confirmationCode: 'ABC123',
    })
    expect(out.patch).toMatchObject({
      checkIn:  '2026-07-01',
      checkOut: '2026-07-03',
      address:  '東京都台東区浅草1-1-1',
    })
  })

  it('does not overwrite a manually selected non-default type', () => {
    const out = bookingPdfExtractToDraftPatch(
      state({ type: 'other' }),
      result(),
      { isEdit: false },
    )

    expect(out.patch.type).toBeUndefined()
  })

  it('requires high-confidence address evidence and ignores invalid links', () => {
    const out = bookingPdfExtractToDraftPatch(
      state(),
      result({
        address: field('Directions from the station', 0.7),
        link:    field('javascript:alert(1)', 0.99),
      }),
      { isEdit: false },
    )

    expect(out.patch.address).toBeUndefined()
    expect(out.patch.link).toBeUndefined()
  })

  it('prefills transport route fields from flight candidates', () => {
    const out = bookingPdfExtractToDraftPatch(
      state(),
      result({
        bookingType: 'flight',
        segmentRole: 'outbound',
        title: field('MM626'),
        provider: field('Peach Aviation'),
        origin: field('Taipei'),
        destination: field('Tokyo'),
        originIataCode: field('TPE'),
        destinationIataCode: field('NRT'),
        checkIn: field('2026-09-18'),
        checkOut: field('2026-09-18'),
        address: field('東京都台東区浅草1-1-1', 0.99),
      }),
      { isEdit: false },
    )

    expect(out.patch).toMatchObject({
      title:       'MM626',
      provider:    'Peach Aviation',
      origin:      'TPE',
      destination: 'NRT',
      checkIn:     '2026-09-18',
    })
    expect(out.patch.type).toBeUndefined()
    expect(out.patch.checkOut).toBeUndefined()
    expect(out.patch.address).toBeUndefined()
  })

  it('converts valid transport candidates into create inputs', () => {
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'flight',
      segmentRole: 'outbound',
      title: field('MM626'),
      provider: field('Peach Aviation'),
      origin: field('Taipei'),
      destination: field('Tokyo'),
      originIataCode: field('TPE'),
      destinationIataCode: field('NRT'),
      checkIn: field('2026-09-18'),
      checkOut: field('2026-09-18'),
      address: field('東京都台東区浅草1-1-1', 0.99),
    }))).toMatchObject({
      type:        'flight',
      title:       'MM626',
      provider:    'Peach Aviation',
      origin:      'TPE',
      destination: 'NRT',
      checkIn:     '2026-09-18',
    })
  })

  it('formats any valid flight IATA code without city-specific aliases', () => {
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'flight',
      segmentRole: 'outbound',
      title: field('SQ12'),
      provider: field('Singapore Airlines'),
      origin: field('Singapore'),
      destination: field('Los Angeles'),
      originIataCode: field('SIN'),
      destinationIataCode: field('LAX'),
      checkIn: field('2026-10-01'),
    }))).toMatchObject({
      type:        'flight',
      origin:      'SIN',
      destination: 'LAX',
    })
  })

  it('never falls back to airport names when a flight IATA code is missing or uncertain', () => {
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'flight',
      origin: field('Taiwan Taoyuan International Airport'),
      destination: field('Narita International Airport'),
      originIataCode: field('', 0, ''),
      destinationIataCode: field('NRT', 0.69),
    }))).toBeNull()

    const out = bookingPdfExtractToDraftPatch(state(), result({
      bookingType: 'flight',
      origin: field('Taiwan Taoyuan International Airport'),
      destination: field('Narita International Airport'),
      originIataCode: field('', 0, ''),
      destinationIataCode: field('NRT', 0.69),
    }), { isEdit: false })
    expect(out.patch.origin).toBeUndefined()
    expect(out.patch.destination).toBeUndefined()
  })

  it('keeps full station names for non-flight transport', () => {
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'train',
      title: field('Nozomi 21'),
      origin: field('Tokyo Station'),
      destination: field('Kyoto Station'),
    }))).toMatchObject({
      type: 'train',
      origin: 'Tokyo Station',
      destination: 'Kyoto Station',
    })
  })

  it('rejects unsaveable batch candidates before create', () => {
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'flight',
      origin: field('臺灣桃園國際機場 T1'),
      destination: field('', 0, ''),
    }))).toBeNull()
    expect(bookingPdfCandidateToCreateInput(result({
      bookingType: 'hotel',
      title: field('', 0, ''),
    }))).toBeNull()
  })
})

// The Worker owns the authoritative schema; these pin the client's half of
// the wire contract, which mocked component tests can't see.
describe('extractBookingPdfAutofill response contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    captureError.mockClear()
  })

  function respondWith(body: unknown) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    }))
  }

  const pdf = () => new File(['%PDF-1.7'], 'booking.pdf', { type: 'application/pdf' })

  it('accepts a full Worker-shaped payload', async () => {
    respondWith({ bookings: [result()], warnings: ['ambiguous check-out'] })

    const parsed = await extractBookingPdfAutofill(pdf())

    expect(parsed.bookings).toHaveLength(1)
    expect(parsed.bookings[0]?.title.value).toBe('Hotel Sakura')
    expect(parsed.warnings).toEqual(['ambiguous check-out'])
  })

  it('tolerates fields a newer Worker adds', async () => {
    respondWith({
      bookings:   [{ ...result(), seatNumber: field('12A') }],
      warnings:   [],
      extraTopLevel: 'ignored',
    })

    const parsed = await extractBookingPdfAutofill(pdf())

    expect(parsed.bookings[0]).not.toHaveProperty('seatNumber')
    expect(parsed.bookings[0]?.confirmationCode.value).toBe('ABC123')
  })

  it('rejects a payload missing a field instead of crashing downstream', async () => {
    const { checkIn: _dropped, ...incomplete } = result()
    respondWith({ bookings: [incomplete], warnings: [] })

    await expect(extractBookingPdfAutofill(pdf())).rejects.toMatchObject({
      name: 'BookingPdfExtractError',
      kind: 'parse',
    } satisfies Partial<BookingPdfExtractError>)
    expect(captureError).toHaveBeenCalledTimes(1)
  })

  it('rejects a candidate-less response', async () => {
    respondWith({ bookings: [], warnings: [] })

    await expect(extractBookingPdfAutofill(pdf())).rejects.toMatchObject({ kind: 'parse' })
    expect(captureError).toHaveBeenCalledTimes(1)
  })
})
