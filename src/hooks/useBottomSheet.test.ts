// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PointerEvent } from 'react'
import { useBottomSheet } from './useBottomSheet'

function pointer(y: number): PointerEvent {
  return { clientY: y, pointerId: 1, currentTarget: {
    setPointerCapture() {}, releasePointerCapture() {},
  } } as unknown as PointerEvent
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('bottom sheet drag lifecycle', () => {
  it('cancels a drag without dismissing even past the close threshold', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useBottomSheet({ isOpen: true, onClose }))
    act(() => { result.current.dragHandlers.onPointerDown(pointer(0)); result.current.dragHandlers.onPointerMove(pointer(600)) })
    act(() => result.current.dragHandlers.onPointerCancel(pointer(600)))
    act(() => vi.advanceTimersByTime(500))
    expect(onClose).not.toHaveBeenCalled()
    expect(result.current.pointerActive).toBe(false)
    expect(result.current.sheetTransform).toBe('translateY(0)')
  })
  it.each(['unmount', 'lock', 'reopen'] as const)('cancels a delayed dismiss on %s', mode => {
    const onClose = vi.fn()
    const { result, rerender, unmount } = renderHook(props => useBottomSheet({ ...props, onClose }),
      { initialProps: { isOpen: true, dismissible: true } })
    act(() => { result.current.dragHandlers.onPointerDown(pointer(0)); result.current.dragHandlers.onPointerMove(pointer(600)) })
    act(() => result.current.dragHandlers.onPointerUp(pointer(600)))
    if (mode === 'unmount') unmount()
    if (mode === 'lock') rerender({ isOpen: true, dismissible: false })
    if (mode === 'reopen') { rerender({ isOpen: false, dismissible: true }); rerender({ isOpen: true, dismissible: true }) }
    act(() => vi.advanceTimersByTime(500))
    expect(onClose).not.toHaveBeenCalled()
    if (mode === 'lock') expect(result.current.sheetTransform).toBe('translateY(0)')
  })
  it('uses the latest close callback during the delayed animation', () => {
    const oldClose = vi.fn()
    const newClose = vi.fn()
    const { result, rerender } = renderHook(onClose => useBottomSheet({ isOpen: true, onClose }), { initialProps: oldClose })
    act(() => { result.current.dragHandlers.onPointerDown(pointer(0)); result.current.dragHandlers.onPointerMove(pointer(600)) })
    act(() => result.current.dragHandlers.onPointerUp(pointer(600)))
    rerender(newClose)
    act(() => vi.advanceTimersByTime(300))
    expect(oldClose).not.toHaveBeenCalled()
    expect(newClose).toHaveBeenCalledOnce()
  })
  it('cancels the inner entry animation frame when closed between frames', () => {
    const { result, rerender } = renderHook(isOpen => useBottomSheet({ isOpen, onClose: vi.fn() }), { initialProps: true })
    act(() => vi.advanceTimersByTime(16))
    rerender(false)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.sheetTransform).toBe('translateY(100%)')
  })
})
