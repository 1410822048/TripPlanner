import { describe, it, expect } from 'vitest'
import { memberToTripMember, membersToTripMembers } from './utils'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Member } from '@/types'

function mkMember(id: string, displayName: string): Member {
  return {
    id, tripId: 'demo', userId: 'u', displayName,
    role: 'editor', joinedAt: TS,
  }
}

describe('memberToTripMember', () => {
  it('extracts first grapheme of displayName (ASCII)', () => {
    expect(memberToTripMember(mkMember('m1', 'Alice')).label).toBe('A')
  })

  it('handles CJK / multi-byte displayNames', () => {
    expect(memberToTripMember(mkMember('m1', '太郎')).label).toBe('太')
    expect(memberToTripMember(mkMember('m2', 'あやな')).label).toBe('あ')
  })

  it('handles emoji (surrogate pairs)', () => {
    expect(memberToTripMember(mkMember('m1', '🗼さん')).label).toBe('🗼')
  })

  it('falls back to ? for whitespace-only names', () => {
    expect(memberToTripMember(mkMember('m1', '   ')).label).toBe('?')
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
