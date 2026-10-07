// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Member } from '@/types'

const harness = vi.hoisted(() => ({ members: [] as Partial<Member>[] }))

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'me' }))
vi.mock('@/features/members/hooks/useMembers', () => ({ useMembers: () => ({ data: harness.members }) }))
vi.mock('@/features/trips/hooks/useCurrentTrip', () => ({ useCurrentTrip: () => null }))

import { useCanWrite, useTripRole } from './useTripRole'

describe('useTripRole', () => {
  it('returns the caller role', () => {
    harness.members = [{ userId: 'me', role: 'editor' }]
    expect(renderHook(() => useTripRole('t1')).result.current).toBe('editor')
    expect(renderHook(() => useCanWrite('t1', false)).result.current).toBe(true)
  })

  it('treats a member who is being removed as having no role', () => {
    harness.members = [{ userId: 'me', role: 'editor', removingAt: {} as Member['removingAt'] }]
    expect(renderHook(() => useTripRole('t1')).result.current).toBeNull()
    expect(renderHook(() => useCanWrite('t1', false)).result.current).toBe(false)
  })
})
