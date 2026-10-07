import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Member, Trip } from '@/types'

const fetched = vi.hoisted(() => [] as string[])

vi.mock('../services/memberService', () => ({
  getMembersByTrip: vi.fn(async (tripId: string) => {
    fetched.push(tripId)
    const ids: Record<string, string[]> = { t1: ['me', 'a', 'b'], t2: ['me', 'b', 'c', 'd'], t3: ['me', 'e'] }
    return (ids[tripId] ?? []).map(userId => ({ id: userId, userId, displayName: userId.toUpperCase(), role: 'editor' }) as unknown as Member)
  }),
}))

import { useCollaboratorSummary } from './useCollaboratorSummary'

const trip = (id: string, memberIds: string[]) => ({ id, memberIds }) as unknown as Trip

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: qc }, children)
}

describe('useCollaboratorSummary', () => {
  it('counts collaborators from trip.memberIds and only fetches trips needed for three chips', async () => {
    const trips = [trip('t1', ['me', 'a', 'b']), trip('t2', ['me', 'b', 'c', 'd']), trip('t3', ['me', 'e'])]
    const { result } = renderHook(() => useCollaboratorSummary('me', trips), { wrapper })
    expect(result.current.count).toBe(5)
    await waitFor(() => expect(result.current.chips.map(c => c.id)).toEqual(['a', 'b', 'c']))
    expect(fetched.sort()).toEqual(['t1', 't2'])
  })
})
