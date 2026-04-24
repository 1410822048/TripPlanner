// Unit tests for inviteService pure helpers. Firestore-touching functions
// (create/list/accept/revoke) aren't covered here — they require an emulator
// or integration harness; see manual verification steps in the PR.
import { describe, expect, it } from 'vitest'
import { InviteError, generateToken } from './inviteService'

describe('generateToken', () => {
  it('returns 64 hex characters (256 bits of entropy)', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different token on each call', () => {
    // 50 calls × 256 bits → collision probability ~0; any dup is a bug.
    const set = new Set(Array.from({ length: 50 }, () => generateToken()))
    expect(set.size).toBe(50)
  })
})

describe('InviteError', () => {
  it('carries a discriminator code for UI branching', () => {
    const e = new InviteError('expired', 'expired')
    expect(e.code).toBe('expired')
    expect(e.name).toBe('InviteError')
    expect(e instanceof Error).toBe(true)
  })
})
