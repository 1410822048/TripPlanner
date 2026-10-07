// Repo invariant: Firebase Functions formats notification amounts with its
// own copy of the currency fraction-digit table, because Cloud Build cannot
// reach packages/fx-core. A drift would print every amount in that currency
// off by a factor of 10ⁿ in push notifications. Compare the two tables from
// source text (the Functions package is outside this suite's module graph).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currencyFractionDigits } from '@tripmate/fx-core'

const REPO_ROOT = process.cwd()

function functionsTable(): Record<string, number> {
  const source = readFileSync(join(REPO_ROOT, 'firebase-functions/src/notifications.ts'), 'utf8')
  const block = source.match(/const FRACTION_DIGITS[^=]*=\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('FRACTION_DIGITS table not found in firebase-functions/src/notifications.ts')
  const table: Record<string, number> = {}
  for (const [, code, digits] of block[1]!.matchAll(/([A-Z]{3})\s*:\s*(\d+)/g)) {
    table[code!] = Number(digits)
  }
  return table
}

describe('currency fraction digits', () => {
  it('firebase-functions agrees with @tripmate/fx-core for every listed currency', () => {
    const table = functionsTable()
    expect(Object.keys(table).length).toBeGreaterThan(5)
    for (const [code, digits] of Object.entries(table)) {
      expect({ code, digits }).toEqual({ code, digits: currencyFractionDigits(code) })
    }
  })
})
