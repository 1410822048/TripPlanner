import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSwipeOpen } from './useSwipeOpen'

describe('useSwipeOpen capability gate', () => {
  it('clears an open row when the capability disappears', () => {
    const hook = renderHook(
      ({ enabled }) => useSwipeOpen(enabled),
      { initialProps: { enabled: true } },
    )

    act(() => hook.result.current.bindRow('row-1').onOpen())
    expect(hook.result.current.swipedId).toBe('row-1')

    hook.rerender({ enabled: false })
    expect(hook.result.current.swipedId).toBeNull()
    expect(hook.result.current.bindRow('row-1').isOpen).toBe(false)

    hook.rerender({ enabled: true })
    expect(hook.result.current.swipedId).toBeNull()
    expect(hook.result.current.bindRow('row-1').isOpen).toBe(false)
  })

  it('ignores attempts to open a row while disabled', () => {
    const hook = renderHook(() => useSwipeOpen(false))

    act(() => hook.result.current.bindRow('row-1').onOpen())

    expect(hook.result.current.swipedId).toBeNull()
  })
})
