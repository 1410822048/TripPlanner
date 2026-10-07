// Repo invariant: push notifications format money with a copy of the app's
// currency symbols (Cloud Build cannot reach src/). Compare from source text.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENCY_OPTIONS } from '@/utils/currency'

function functionsSymbols(): Record<string, string> {
  const source = readFileSync(join(process.cwd(), 'firebase-functions/src/notifications.ts'), 'utf8')
  const block = source.match(/const CURRENCY_SYMBOLS[^=]*=\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('CURRENCY_SYMBOLS not found in firebase-functions/src/notifications.ts')
  const out: Record<string, string> = {}
  for (const [, code, symbol] of block[1]!.matchAll(/([A-Z]{3})\s*:\s*'([^']*)'/g)) out[code!] = symbol!
  return out
}

describe('currency symbols', () => {
  it('firebase-functions uses the same symbol as the app for every app currency', () => {
    const fn = functionsSymbols()
    expect(Object.fromEntries(CURRENCY_OPTIONS.map(c => [c.code, c.symbol]))).toEqual(fn)
  })
})
