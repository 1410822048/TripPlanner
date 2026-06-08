// path-only migration: the three attachment schemas must accept docs that
// carry NO download URL (the Worker stops writing url/fileUrl/thumbUrl;
// reads go through getBlob(path) gated by Storage Rules). These pin that a
// url-less doc parses, and that a legacy doc WITH url still parses (so the
// optional fields remain back-compatible during rollout / for old data).
import { describe, it, expect } from 'vitest'
import { ExpenseReceiptSchema } from './expense'
import { BookingAttachmentSchema } from './booking'
import { WishImageSchema } from './wish'

describe('path-only attachment schemas', () => {
  it('ExpenseReceiptSchema accepts a path-only receipt (no url/thumbUrl)', () => {
    expect(ExpenseReceiptSchema.safeParse({
      path:      'trips/t/expenses/e/r.webp',
      type:      'image/webp',
      thumbPath: 'trips/t/expenses/e/r.thumb.webp',
    }).success).toBe(true)
  })

  it('BookingAttachmentSchema accepts a path-only attachment (no fileUrl/thumbUrl)', () => {
    expect(BookingAttachmentSchema.safeParse({
      filePath:  'trips/t/bookings/b/f.webp',
      fileType:  'image/webp',
      thumbPath: 'trips/t/bookings/b/f.thumb.webp',
    }).success).toBe(true)
  })

  it('WishImageSchema accepts a path-only image (no url/thumbUrl)', () => {
    expect(WishImageSchema.safeParse({
      path:      'trips/t/wishes/w/img.webp',
      thumbPath: 'trips/t/wishes/w/img.thumb.webp',
    }).success).toBe(true)
  })

  it('still accepts a legacy doc WITH url (back-compat during rollout)', () => {
    expect(ExpenseReceiptSchema.safeParse({
      url:  'https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media&token=z',
      path: 'trips/t/expenses/e/r.webp',
      type: 'image/webp',
    }).success).toBe(true)
  })
})
