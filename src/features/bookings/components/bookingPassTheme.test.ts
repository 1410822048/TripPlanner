import { describe, it, expect } from 'vitest'
import type { Booking } from '@/types'
import { bookingPassTheme, isLightHex } from './bookingPassTheme'

function booking(overrides: Partial<Booking>): Booking {
  const now = {} as Booking['createdAt']
  return {
    id: 'b1',
    tripId: 't1',
    type: 'flight',
    title: 'NH802',
    provider: undefined,
    origin: 'TPE',
    destination: 'NRT',
    checkIn: '2026-05-01T07:30',
    checkOut: undefined,
    address: undefined,
    confirmationCode: undefined,
    note: undefined,
    attachment: undefined,
    memberIds: [],
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('isLightHex', () => {
  it('flags bright yellow / orange brand accents as light', () => {
    // 命名的低對比案例(soft pill 會糊):SQ / TR / 5J / Tigerair / Choice
    for (const hex of ['#F99F1B', '#FFCD00', '#FFC72C', '#F5821F', '#FF8200']) {
      expect(isLightHex(hex)).toBe(true)
    }
  })

  it('keeps dark / saturated accents on accent color', () => {
    // navy / 深綠 / 深紅 —— accent 當字在淺底上可讀,不需改色
    for (const hex of ['#13448F', '#225F4D', '#C8102E', '#0E0E0E']) {
      expect(isLightHex(hex)).toBe(false)
    }
  })

  it('returns false on malformed input', () => {
    expect(isLightHex('#fff')).toBe(false) // 3 碼非 accent 格式
    expect(isLightHex('teal')).toBe(false)
  })
})

describe('bookingPassTheme', () => {
  it('lets OTA platform brands override type fallback for flight bookings', () => {
    const theme = bookingPassTheme(booking({ type: 'flight', provider: 'Trip.com' }))
    expect(theme.brand?.label).toBe('Trip')
    expect(theme.accent).toBe('#287DFC')
  })

  it('falls back to the type-specific brand when no platform matches', () => {
    const theme = bookingPassTheme(booking({ type: 'flight', provider: 'ANA' }))
    expect(theme.brand?.label).toBe('ANA')
    expect(theme.accent).toBe('#13448F')
  })
})
