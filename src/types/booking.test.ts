// Client-side guards for Booking.link. The Worker has its own verbatim
// copy of this scheme check (workers/ocr/test/booking-write.spec.ts) and
// firestore.rules pins the `^https?://.+` regex — this file pins the
// CLIENT copy so the three stay in lockstep. link renders into an
// <a href>, so the only thing that matters here is "http(s) in, every
// other scheme out".
import { describe, it, expect } from 'vitest'
import { isHttpUrl, CreateBookingSchema } from './booking'

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://www.booking.com/x')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
  })

  it('rejects non-http(s) schemes and garbage', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,<script>')).toBe(false)
    expect(isHttpUrl('ftp://files.example.com')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })

  // Drift guard: new URL() lowercases the scheme + strips embedded
  // whitespace, so it would accept these — but the firestore.rules
  // `^https?://.+` regex (case-sensitive, . excludes \n) rejects them.
  // isHttpUrl must match the rules, not new URL, or the value writes via
  // the Worker admin path then jams later client updates.
  it('rejects an uppercase scheme (rules regex is lowercase-only)', () => {
    expect(isHttpUrl('HTTPS://example.com')).toBe(false)
    expect(isHttpUrl('Http://example.com')).toBe(false)
  })

  it('rejects embedded whitespace / newline', () => {
    expect(isHttpUrl('https://ex ample.com')).toBe(false)
    expect(isHttpUrl('https://a.com/x\njavascript:alert(1)')).toBe(false)
  })
})

describe('CreateBookingSchema.link', () => {
  const base = { type: 'hotel' as const, title: 'X' }

  it('accepts a valid https link', () => {
    expect(CreateBookingSchema.safeParse({ ...base, link: 'https://airbnb.com/rooms/1' }).success).toBe(true)
  })

  it('accepts omitted link (optional)', () => {
    expect(CreateBookingSchema.safeParse(base).success).toBe(true)
  })

  it('accepts empty string (the clear sentinel — stripped before Firestore)', () => {
    // updateBooking translates a cleared link (undefined) → '' on the
    // Worker path; the schema must not reject the sentinel. '' never
    // lands in a doc (stripEmpty on create, deleteField on update).
    expect(CreateBookingSchema.safeParse({ ...base, link: '' }).success).toBe(true)
  })

  it('rejects a javascript: link', () => {
    expect(CreateBookingSchema.safeParse({ ...base, link: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('rejects an uppercase scheme (must match the lowercase rules regex)', () => {
    expect(CreateBookingSchema.safeParse({ ...base, link: 'HTTPS://example.com' }).success).toBe(false)
  })

  it('rejects a link over 500 chars', () => {
    expect(CreateBookingSchema.safeParse({ ...base, link: 'https://e.com/' + 'x'.repeat(500) }).success).toBe(false)
  })
})
