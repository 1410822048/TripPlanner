import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider, useMutation } from '@tanstack/react-query'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const observability = vi.hoisted(() => ({
  captureError: vi.fn(),
  mutationError: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/services/sentry', () => ({ captureError: observability.captureError }))
vi.mock('@/shared/toast', () => ({
  toast: {
    mutationError: observability.mutationError,
    info: observability.info,
  },
}))

import { queryClient } from './queryClient'
import { refreshClientCompatibility } from './clientCompatibility'

const response = (revision: number, minimumWriteEpoch: number) => new Response(
  JSON.stringify({ revision, minimumWriteEpoch }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)

describe('global mutation compatibility guard', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(10_000, 2)))
    await refreshClientCompatibility()
  })

  afterAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(10_001, 1)))
    await refreshClientCompatibility()
    queryClient.getMutationCache().clear()
    vi.unstubAllGlobals()
  })

  it('rejects before local optimistic onMutate and mutationFn without reporting noise', async () => {
    const localOnMutate = vi.fn()
    const mutationFn = vi.fn(async () => 'written')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const mutation = renderHook(() => useMutation({ mutationFn, onMutate: localOnMutate }), { wrapper })

    await act(async () => {
      await mutation.result.current.mutateAsync(undefined).catch(() => undefined)
    })

    await waitFor(() => expect(mutation.result.current.status).toBe('error'))
    expect(localOnMutate).not.toHaveBeenCalled()
    expect(mutationFn).not.toHaveBeenCalled()
    expect(mutation.result.current.isPending).toBe(false)
    expect(observability.captureError).not.toHaveBeenCalled()
    expect(observability.mutationError).not.toHaveBeenCalled()
    expect(observability.info).not.toHaveBeenCalled()
  })
})
