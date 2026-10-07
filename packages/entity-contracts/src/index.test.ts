import { describe, expect, it } from 'vitest'
import { ADJUSTMENT_KINDS, isHttpUrl } from './index'

describe('isHttpUrl', () => {
  it.each(['https://tabelog.com/x', 'http://a.b/c?d=1'])('accepts %s', v => expect(isHttpUrl(v)).toBe(true))
  it.each(['HTTPS://example.com', 'javascript:alert(1)', 'data:text/html,x', 'https://a b', 'https://', ''])(
    'rejects %s', v => expect(isHttpUrl(v)).toBe(false),
  )
})

describe('ADJUSTMENT_KINDS', () => {
  it('is unique', () => expect(new Set(ADJUSTMENT_KINDS).size).toBe(ADJUSTMENT_KINDS.length))
})
