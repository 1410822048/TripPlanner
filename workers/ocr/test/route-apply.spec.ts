import { describe, expect, test } from 'vitest'
import { applyRoute } from '../src/route-apply'

describe('route apply authentication boundary', () => {
  test('maps malformed preview tokens to a safe 401 before any Firestore call', async () => {
    await expect(applyRoute('u1', {
      tripId: 'trip-1',
      revision: 'revision-1234567890',
      date: '2026-07-15',
      previewToken: 'malformed-preview-token-that-is-long-enough',
      schedules: [
        { id: 'a', order: 0 },
        { id: 'b', order: 1 },
      ],
    }, 'not-used', 'project', 'test-secret-with-at-least-16-bytes')).rejects.toMatchObject({
      status: 401,
      code: 'PREVIEW_TOKEN_INVALID',
    })
  })
})
