import { describe, expect, test } from 'vitest'
import { buildInviteUrl, parseInviteUrl } from './inviteUrl'

const TOKEN = 'a'.repeat(64)

describe('inviteUrl', () => {
  test('builds the existing fragment-token invite URL', () => {
    expect(buildInviteUrl('trip_1', TOKEN, 'https://tripmate.example')).toBe(
      `https://tripmate.example/invite/trip_1#${TOKEN}`,
    )
  })

  test('parses same-origin absolute and relative invite URLs', () => {
    expect(parseInviteUrl(`https://tripmate.example/invite/trip-1#${TOKEN}`, 'https://tripmate.example')).toEqual({
      tripId: 'trip-1',
      token: TOKEN,
    })
    expect(parseInviteUrl(`/invite/trip_2#${TOKEN}`, 'https://tripmate.example')).toEqual({
      tripId: 'trip_2',
      token: TOKEN,
    })
  })

  test('accepts production and preview Pages invite origins', () => {
    expect(parseInviteUrl(`https://tripmate-2wg.pages.dev/invite/trip-1#${TOKEN}`, 'https://feat-a.tripmate-2wg.pages.dev')).toEqual({
      tripId: 'trip-1',
      token: TOKEN,
    })
    expect(parseInviteUrl(`https://feat-a.tripmate-2wg.pages.dev/invite/trip-2#${TOKEN}`, 'https://tripmate-2wg.pages.dev')).toEqual({
      tripId: 'trip-2',
      token: TOKEN,
    })
  })

  test('rejects external origins and malformed tokens', () => {
    expect(parseInviteUrl(`https://evil.example/invite/trip-1#${TOKEN}`, 'https://tripmate.example')).toBeNull()
    expect(parseInviteUrl(`https://tripmate-2wg.pages.dev.evil.example/invite/trip-1#${TOKEN}`, 'https://tripmate-2wg.pages.dev')).toBeNull()
    expect(parseInviteUrl('https://tripmate.example/invite/trip-1#short', 'https://tripmate.example')).toBeNull()
  })
})
