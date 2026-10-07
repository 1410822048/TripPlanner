// Repo invariant: firestore.rules caps the same booking / wish fields the
// app and the Worker cap through @tripmate/entity-contracts. Rules can't
// import, so compare the numbers from source text, per match block. A cap
// the rules enforce more tightly breaks client writes the form allowed; a
// looser one lets raw-SDK writes past what the Worker would accept.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOKING_LIMITS, WISH_LIMITS } from '@tripmate/entity-contracts'

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8')

/** Source of one `match /<collection>/{...} {` block (brace-balanced). */
function matchBlock(collection: string): string {
  const start = RULES.search(new RegExp(`match /${collection}/\\{[A-Za-z]+\\} \\{`))
  if (start < 0) throw new Error(`match /${collection} not found in firestore.rules`)
  let depth = 0
  for (let i = RULES.indexOf('{', RULES.indexOf('} {', start) + 1); i < RULES.length; i++) {
    if (RULES[i] === '{') depth++
    else if (RULES[i] === '}' && --depth === 0) return RULES.slice(start, i + 1)
  }
  throw new Error(`unbalanced match /${collection}`)
}

/** Every distinct `<field>.size() <= N` cap in a block. */
function capsIn(block: string, field: string): number[] {
  const re = new RegExp(`request\\.resource\\.data\\.${field}\\.size\\(\\) <= (\\d+)`, 'g')
  return [...new Set([...block.matchAll(re)].map(m => Number(m[1])))]
}

describe('firestore.rules field caps match @tripmate/entity-contracts', () => {
  const cases: Array<[string, Record<string, number>, Record<string, string>]> = [
    ['bookings', BOOKING_LIMITS, { checkIn: 'dateText', checkOut: 'dateText' }],
    ['wishes',   WISH_LIMITS,    {}],
  ]
  for (const [collection, limits, aliases] of cases) {
    it(collection, () => {
      const block = matchBlock(collection)
      const fields = new Set([...Object.keys(limits), ...Object.keys(aliases)])
      for (const field of fields) {
        if (field === 'dateText') continue
        const key = aliases[field] ?? field
        const caps = capsIn(block, field)
        expect({ field, caps }).toEqual({ field, caps: [limits[key]] })
      }
    })
  }
})
