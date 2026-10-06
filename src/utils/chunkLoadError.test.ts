import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from './chunkLoadError'

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/ExpensePage-abc.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
  ])('recognises %s', msg => {
    expect(isChunkLoadError(new TypeError(msg))).toBe(true)
  })

  it('ignores ordinary render errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
  })
})
