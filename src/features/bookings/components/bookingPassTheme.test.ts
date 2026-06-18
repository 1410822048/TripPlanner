import { describe, it, expect } from 'vitest'
import { isLightHex } from './bookingPassTheme'

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
