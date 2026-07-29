import { describe, expect, it } from 'vitest'
import {
  parseOcrProvider,
  parseOptionalOcrProvider,
} from '../src/ocr-providers'

describe('ocr provider env parsing', () => {
  it('defaults cleanly when env vars are absent', () => {
    expect(parseOcrProvider(undefined, 'OCR_PRIMARY_PROVIDER', 'qwen')).toBe('qwen')
    expect(parseOptionalOcrProvider(undefined, 'OCR_FALLBACK_PROVIDER', 'claude')).toBe('claude')
  })

  it('accepts only explicit OCR providers / none for fallback', () => {
    expect(parseOcrProvider('claude', 'OCR_PRIMARY_PROVIDER', 'qwen')).toBe('claude')
    expect(parseOcrProvider('qwen', 'OCR_PRIMARY_PROVIDER', 'claude')).toBe('qwen')
    expect(parseOptionalOcrProvider('none', 'OCR_FALLBACK_PROVIDER', 'claude')).toBe('none')
    expect(() => parseOcrProvider('gemini', 'OCR_PRIMARY_PROVIDER', 'qwen')).toThrow(/OCR_PRIMARY_PROVIDER/)
    expect(() => parseOptionalOcrProvider('gemini', 'OCR_FALLBACK_PROVIDER', 'claude')).toThrow(/OCR_FALLBACK_PROVIDER/)
  })
})
