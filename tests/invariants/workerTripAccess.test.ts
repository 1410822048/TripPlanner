// Repo invariant: Worker endpoints authorize through the shared trip-access
// gate (workers/ocr/src/membership-shared.ts). Before it existed, thirteen
// hand-rolled copies drifted in order and wording. A new endpoint that reads
// the caller's member doc must hand it to checkTripAccess / requireTripAccess
// / readTripAccess — or be listed here with the reason it can't.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'workers/ocr/src')

const EXEMPT: Record<string, string> = {
  'membership-shared.ts':  'defines the gate',
  'attachment-content.ts': 'thumbnail GET reads only the member doc on purpose (hot path)',
  'invite-write.ts':       'redeem reads the member doc of a caller who is NOT a member yet',
}

describe('Worker trip access', () => {
  it('every file reading the caller member doc goes through the shared gate', () => {
    const offenders: string[] = []
    for (const file of readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
      if (EXEMPT[file]) continue
      const source = readFileSync(join(SRC, file), 'utf8')
      const readsCallerMember = /(?:tx\.get|getDocFields)\([^)]*members\/\$\{(?:callerUid|uid)\}/.test(source)
      if (readsCallerMember && !/(?:check|require|read)TripAccess\(/.test(source)) offenders.push(file)
      if (source.includes("'caller is not a trip member'")) offenders.push(`${file} (hand-rolled membership error)`)
    }
    expect(offenders).toEqual([])
  })
})
