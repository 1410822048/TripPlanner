import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useFormModal, type FormModalScope } from './useFormModal'

const renderModal = (scope?: FormModalScope) =>
  renderHook(
    ({ scope }: { scope?: FormModalScope }) => useFormModal<{ id: string }>(scope),
    { initialProps: { scope } },
  )

describe('useFormModal scope capture', () => {
  it('stays clean while the live scope matches the one captured at open', () => {
    const { result, rerender } = renderModal({ tripId: 'trip-a', uid: 'u1' })

    act(() => result.current.openAdd())
    rerender({ scope: { tripId: 'trip-a', uid: 'u1' } })

    expect(result.current.scopeChanged).toBe(false)
  })

  it('flags a trip switched out from under an open form', () => {
    const { result, rerender } = renderModal({ tripId: 'trip-a', uid: 'u1' })

    act(() => result.current.openAdd())
    // Background reselect (kicked / trip deleted elsewhere) swaps the trip
    // while the modal stays mounted.
    rerender({ scope: { tripId: 'trip-b', uid: 'u1' } })

    expect(result.current.scopeChanged).toBe(true)
  })

  it('flags an account change even when the trip id stays the same', () => {
    const { result, rerender } = renderModal({ tripId: 'trip-a', uid: 'u1' })

    act(() => result.current.openEdit({ id: 'row-1' }))
    rerender({ scope: { tripId: 'trip-a', uid: 'u2' } })

    // A draft composed under one account must not be saved under another.
    expect(result.current.scopeChanged).toBe(true)
  })

  it('flags the demo → signed-in transition (undefined → real ids)', () => {
    const { result, rerender } = renderModal({ tripId: undefined, uid: undefined })

    act(() => result.current.openAdd())
    rerender({ scope: { tripId: 'trip-a', uid: 'u1' } })

    // A draft composed against demo members must not land in a real trip.
    expect(result.current.scopeChanged).toBe(true)
  })

  it('resets on close so the next open captures fresh', () => {
    const { result, rerender } = renderModal({ tripId: 'trip-a', uid: 'u1' })

    act(() => result.current.openAdd())
    rerender({ scope: { tripId: 'trip-b', uid: 'u1' } })
    expect(result.current.scopeChanged).toBe(true)

    act(() => result.current.close())
    expect(result.current.scopeChanged).toBe(false)

    // Reopening under trip B captures trip B — no stale carry-over.
    act(() => result.current.openAdd())
    expect(result.current.scopeChanged).toBe(false)
  })

  it('never flags when the hook was created without a scope', () => {
    const { result } = renderModal(undefined)

    act(() => result.current.openAdd())

    expect(result.current.scopeChanged).toBe(false)
  })

  it('fails closed when a captured scope loses its live counterpart', () => {
    const { result, rerender } = renderModal({ tripId: 'trip-a', uid: 'u1' })

    act(() => result.current.openAdd())
    // A call site that stops providing the live scope must not silently
    // regain write access — treat "nothing to compare against" as changed.
    rerender({ scope: undefined })

    expect(result.current.scopeChanged).toBe(true)
  })
})
