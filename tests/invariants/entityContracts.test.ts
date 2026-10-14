// Repo invariant: firestore.rules caps the same booking / wish / schedule /
// planning fields the
// app and the Worker cap through @tripmate/entity-contracts. Rules can't
// import, so compare the numbers from source text, per match block. A cap
// the rules enforce more tightly breaks client writes the form allowed; a
// looser one lets raw-SDK writes past what the Worker would accept.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOOKING_LIMITS,
  PLANNING_LIMITS,
  SCHEDULE_LIMITS,
  TRAVEL_MEASUREMENT_LIMITS,
  WISH_LIMITS,
} from '@tripmate/entity-contracts'

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
    ['schedules', SCHEDULE_LIMITS, {}],
    ['planning', PLANNING_LIMITS, {}],
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

describe('firestore.rules validTravelToNext matches TRAVEL_MEASUREMENT_LIMITS', () => {
  // The Worker writes (ApplyRouteLegSchema) and the app reads with these
  // bounds; a rules bound that drifts would make every client edit of a
  // schedule with an applied route fail, or let a looser value persist.
  it('bounds each measurement with the shared maximum', () => {
    const start = RULES.indexOf('function validTravelToNext(value)')
    expect(start).toBeGreaterThan(-1)
    const body = RULES.slice(start, RULES.indexOf('}', start))
    for (const [field, max] of Object.entries(TRAVEL_MEASUREMENT_LIMITS)) {
      const caps = [...body.matchAll(new RegExp(`value\\.${field} <= (\\d+)`, 'g'))].map(m => Number(m[1]))
      expect({ field, caps }).toEqual({ field, caps: [max] })
    }
  })
})
