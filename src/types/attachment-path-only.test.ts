// path-only attachment schemas: the three media schemas persist ONLY
// Storage paths (path / thumbPath / filePath), never a bearer download
// URL. Reads go through getBlob(path) gated by Storage Rules. These pin
// that a path-only doc parses, and that any stray legacy url/fileUrl/
// thumbUrl key is dropped on parse (never carried into the typed model)
// so a bearer URL can't leak back into an entity.
import { describe, it, expect } from 'vitest'
import { ExpenseReceiptSchema } from './expense'
import { BookingAttachmentSchema } from './booking'
import { WishImageSchema } from './wish'

describe('path-only attachment schemas', () => {
  it('ExpenseReceiptSchema accepts a path-only receipt', () => {
    expect(ExpenseReceiptSchema.safeParse({
      path:      'trips/t/expenses/e/r.webp',
      type:      'image/webp',
      thumbPath: 'trips/t/expenses/e/r.thumb.webp',
    }).success).toBe(true)
  })

  it('BookingAttachmentSchema accepts a path-only attachment', () => {
    expect(BookingAttachmentSchema.safeParse({
      filePath:  'trips/t/bookings/b/f.webp',
      fileType:  'image/webp',
      thumbPath: 'trips/t/bookings/b/f.thumb.webp',
    }).success).toBe(true)
  })

  it('WishImageSchema accepts a path-only image', () => {
    expect(WishImageSchema.safeParse({
      path:      'trips/t/wishes/w/img.webp',
      thumbPath: 'trips/t/wishes/w/img.thumb.webp',
    }).success).toBe(true)
  })

  it('drops a stray legacy url/thumbUrl key (no bearer URL in the parsed model)', () => {
    const parsed = ExpenseReceiptSchema.parse({
      url:      'https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media&token=z',
      path:     'trips/t/expenses/e/r.webp',
      type:     'image/webp',
      thumbUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/y.thumb?alt=media&token=z',
    })
    expect(parsed).not.toHaveProperty('url')
    expect(parsed).not.toHaveProperty('thumbUrl')
    expect(parsed.path).toBe('trips/t/expenses/e/r.webp')
  })
})
