import { describe, expect, it } from 'vitest'
import { RECEIPT_OCR_PROVIDERS } from '../src/ocr-providers'

describe('receipt OCR provider roles', () => {
  it('pins the Worker routes to the model names shown by the client', () => {
    expect(RECEIPT_OCR_PROVIDERS).toEqual({
      primary:  'qwen',
      fallback: 'claude',
    })
  })
})
