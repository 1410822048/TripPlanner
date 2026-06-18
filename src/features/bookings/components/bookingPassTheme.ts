import type { Booking } from '@/types'
import { BOOKING_PASS_TONE, type BookingPassTone } from '../passStyle'
import { airlineBrand, hotelBrand, railBrand, type Brand } from './cards/brandMeta'

export interface BookingPassTheme {
  tone: BookingPassTone
  brand: Brand | null
  accent: string
  accentInk: string
}

interface BookingPassHeroChrome {
  background: string
  color: string
  borderTop?: string
  isBranded: boolean
}

function matchedBrand(booking: Booking): Brand | null {
  const brand =
    booking.type === 'flight' ? airlineBrand(booking.provider)
    : booking.type === 'hotel' ? hotelBrand(booking.provider)
    : booking.type === 'train' ? railBrand(booking.provider)
    : null

  return brand && brand.aliases.length > 0 ? brand : null
}

export function bookingPassTheme(booking: Booking): BookingPassTheme {
  const tone = BOOKING_PASS_TONE[booking.type]
  const brand = matchedBrand(booking)

  return {
    tone,
    brand,
    accent: brand?.bg ?? tone.from,
    accentInk: brand?.fg ?? tone.ink,
  }
}

export function bookingPassHeroChrome(theme: BookingPassTheme): BookingPassHeroChrome {
  if (!theme.brand) {
    return {
      background: `linear-gradient(135deg, ${theme.tone.from}, ${theme.tone.to})`,
      color: theme.tone.ink,
      isBranded: false,
    }
  }

  return {
    background: `linear-gradient(135deg, ${colorWithAlpha(theme.accent, '14')}, #FDFAF5 58%, ${colorWithAlpha(theme.accent, '08')})`,
    color: '#2E2B27',
    borderTop: `3px solid ${theme.accent}`,
    isBranded: true,
  }
}

export function colorWithAlpha(hex: string, alpha: string): string {
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    const [, r, g, b] = hex
    return `#${r}${r}${g}${g}${b}${b}${alpha}`
  }
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex
}

// 感知亮度(YIQ)。亮色 accent 直接當文字色貼在淺底(白 / accent-18)上
// 對比不足 —— 黃 / 亮橘品牌(SQ / TR / 5J / Tigerair…)會糊。> 140 視為亮色,
// 由呼叫端改用深色 ink。accent 永遠是 6 碼(brand.bg / tone.from)。
export function isLightHex(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (r * 299 + g * 587 + b * 114) / 1000 > 140
}
