import { describe, it, expect } from 'vitest'
import { memberToTripMember, membersToTripMembers, normalizeMemberDisplayName } from './utils'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Member } from '@/types'

function mkMember(id: string, displayName: string): Member {
  return {
    id, tripId: 'demo', userId: 'u', displayName,
    role: 'editor', memberIds: ['u'], joinedAt: TS,
  }
}

describe('memberToTripMember', () => {
  it('extracts first grapheme of displayName (ASCII)', () => {
    expect(memberToTripMember(mkMember('m1', 'Alice')).avatarLabel).toBe('A')
  })

  it('handles CJK / multi-byte displayNames', () => {
    expect(memberToTripMember(mkMember('m1', '太郎')).avatarLabel).toBe('太')
    expect(memberToTripMember(mkMember('m2', 'あやな')).avatarLabel).toBe('あ')
  })

  it('handles emoji (surrogate pairs)', () => {
    expect(memberToTripMember(mkMember('m1', '🗼さん')).avatarLabel).toBe('🗼')
  })

  it('falls back to ? for whitespace-only names', () => {
    expect(memberToTripMember(mkMember('m1', '   ')).avatarLabel).toBe('?')
  })

  it('assigns a stable color/bg pair per id (deterministic)', () => {
    const a1 = memberToTripMember(mkMember('alpha', 'X'))
    const a2 = memberToTripMember(mkMember('alpha', 'Y'))
    expect(a1.color).toBe(a2.color)
    expect(a1.bg).toBe(a2.bg)
  })

  it('yields a non-empty color/bg (chip is always renderable)', () => {
    for (const id of ['a', 'bb', 'ccc', 'd1', 'userLongIdString']) {
      const t = memberToTripMember(mkMember(id, 'N'))
      expect(t.color).toMatch(/^#[0-9A-F]{6}$/i)
      expect(t.bg).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })
})

describe('membersToTripMembers', () => {
  it('maps in order', () => {
    const r = membersToTripMembers([
      mkMember('a', 'Aa'),
      mkMember('b', 'Bb'),
    ])
    expect(r).toHaveLength(2)
    expect(r[0]!.id).toBe('a')
    expect(r[1]!.id).toBe('b')
  })
})

// The member-create rule rejects an empty name and anything over 100, and
// that rejection fails the WHOLE atomic batch (trip + owner member) — the
// user just sees a 403 on "create trip". This runs before the write on both
// creation paths, so the rule is never the thing that discovers the problem.
describe('normalizeMemberDisplayName', () => {
  it('falls back for null, undefined and whitespace-only', () => {
    // `??` would let '' and '   ' through; Firebase Auth can return either.
    expect(normalizeMemberDisplayName(null)).toBe('Me')
    expect(normalizeMemberDisplayName(undefined)).toBe('Me')
    expect(normalizeMemberDisplayName('')).toBe('Me')
    expect(normalizeMemberDisplayName('   ')).toBe('Me')
  })

  it('trims but otherwise leaves a normal name alone', () => {
    expect(normalizeMemberDisplayName('  田中太郎  ')).toBe('田中太郎')
  })

  it('passes a name exactly at the cap through untouched', () => {
    const atCap = 'あ'.repeat(100)
    expect(normalizeMemberDisplayName(atCap)).toBe(atCap)
  })

  it('truncates by code point so an emoji is never split', () => {
    // 99 BMP chars + one astral emoji = 101 UTF-16 units. slice(0, 100)
    // would keep the emoji's high surrogate alone, and Firestore persists
    // that lone half as U+FFFD — silent corruption, not a visible failure.
    const name = 'あ'.repeat(99) + '👍'
    expect(name.length).toBe(101)
    const out = normalizeMemberDisplayName(name)
    expect(out.length).toBeLessThanOrEqual(100)
    // Exact equality is the whole assertion: the emoji is dropped as a unit,
    // so no half of it can have survived. A separate "no unpaired surrogate"
    // regex would be strictly weaker than this and only add a place to get
    // the escape sequence wrong.
    expect(out).toBe('あ'.repeat(99))
  })

  it('keeps a whole emoji when it fits', () => {
    const name = '👍'.repeat(50)          // exactly 100 units
    expect(normalizeMemberDisplayName(name)).toBe(name)
  })
})
