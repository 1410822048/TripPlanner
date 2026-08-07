// Client-side guard for Wish.link. `link` renders straight into an
// <a href> (WishDetailSheet), so the only thing that matters here is
// "http(s) in, every other scheme out". Three copies must agree: this
// one, the firestore.rules `^https?://.+` regex, and the Worker's
// isHttpUrl in field-validation.ts — booking.test.ts pins the same
// contract for the booking side.
import { describe, it, expect } from 'vitest'
import { CreateWishSchema } from './wish'

describe('CreateWishSchema.link', () => {
  const base = { category: 'place' as const, title: 'X' }

  it('accepts a valid https link', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'https://tabelog.com/tokyo/' }).success).toBe(true)
  })

  it('accepts an absent link', () => {
    expect(CreateWishSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a javascript: link', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('rejects a data: link', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'data:text/html,<script>' }).success).toBe(false)
  })

  // The rules regex is case-sensitive and its `.` never matches a newline,
  // so anything looser here writes fine via the Worker's admin SDK and then
  // jams every later client update.
  it('rejects an uppercase scheme (rules regex is lowercase-only)', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'HTTPS://example.com' }).success).toBe(false)
  })

  it('rejects embedded whitespace / newline', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'https://ex ample.com' }).success).toBe(false)
    expect(CreateWishSchema.safeParse({ ...base, link: 'https://a.com/x\njavascript:alert(1)' }).success).toBe(false)
  })

  it('rejects a link over 500 chars', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: 'https://e.com/' + 'x'.repeat(500) }).success).toBe(false)
  })

  // Unlike booking, wish has NO '' clear sentinel: wishService runs
  // stripEmpty before both the client setDoc and the Worker call, so an
  // empty string never reaches a schema. Pinning the rejection keeps the
  // asymmetry deliberate rather than accidental.
  it('rejects the empty string (wish has no clear sentinel; stripEmpty drops it first)', () => {
    expect(CreateWishSchema.safeParse({ ...base, link: '' }).success).toBe(false)
  })
})
