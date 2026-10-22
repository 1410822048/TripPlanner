// @vitest-environment jsdom
// Pointer capture timing. Capturing on pointerdown made Chromium retarget
// the following MOUSE click to the row (the capturing element), so buttons
// inside a swipeable row never received it — touch taps were unaffected,
// which is why the touch-first app shipped with it. Capture must only be
// taken once the gesture is recognised as a horizontal swipe.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSwipeRow } from './useSwipeRow'
import { MOVE_THRESHOLD, SWIPE_WIDTH, FG_TRANSITION, BG_TRANSITION } from '@/components/ui/swipeConstants'

function Row({ onAction, onOutsideTap, onOpen, onClose, isOpen }: {
  onAction: () => void; onOutsideTap: () => void
  onOpen: () => void; onClose: () => void; isOpen: boolean
}) {
  const { bindFg, bindBg, pointerProps, wrapTap, openX } = useSwipeRow({ isOpen, onOpen, onClose })
  return (
    // The page wrapper's close-on-outside-tap, as every list page wires it.
    <div onClick={onOutsideTap}>
      <div ref={bindBg} data-testid="bg" />
      <div ref={bindFg} {...pointerProps} data-testid="fg" style={{ transform: `translate3d(${openX}px,0,0)` }}>
        <button type="button" onClick={wrapTap(onAction)}>act</button>
      </div>
    </div>
  )
}

function renderRow(isOpen = false) {
  const onAction = vi.fn()
  const onOutsideTap = vi.fn()
  const onOpen = vi.fn()
  const onClose = vi.fn()
  render(<Row onAction={onAction} onOutsideTap={onOutsideTap} onOpen={onOpen} onClose={onClose} isOpen={isOpen} />)
  const fg = screen.getByTestId('fg')
  const bg = screen.getByTestId('bg')
  // jsdom has no pointer capture; install spies the handlers can call.
  const setCapture = vi.fn()
  Object.assign(fg, { setPointerCapture: setCapture, releasePointerCapture: vi.fn() })
  return { fg, bg, onAction, onOutsideTap, onOpen, onClose, setCapture }
}

describe('useSwipeRow pointer capture', () => {
  it('does not capture on pointerdown, so a plain click still reaches the inner button', () => {
    const { fg, onAction, setCapture } = renderRow()

    fireEvent.pointerDown(fg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(fg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'act' }))

    expect(setCapture).not.toHaveBeenCalled()
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('captures the pointer once the movement is recognised as a horizontal swipe', () => {
    const { fg, setCapture } = renderRow()

    fireEvent.pointerDown(fg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(fg, { pointerId: 1, clientX: 100 - MOVE_THRESHOLD - 1, clientY: 100 })

    expect(setCapture).toHaveBeenCalledWith(1)
  })

  it('swallows the click a mouse swipe ends with, so the page wrapper cannot close the row', () => {
    const { fg, onOutsideTap } = renderRow()

    fireEvent.pointerDown(fg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(fg, { pointerId: 1, clientX: 100 - MOVE_THRESHOLD - 1, clientY: 100 })
    fireEvent.pointerUp(fg, { pointerId: 1, clientX: 20, clientY: 100 })
    // With the pointer captured mid-swipe, Chromium targets this click at
    // the row itself, where no inner wrapTap can swallow it.
    fireEvent.click(fg)

    expect(onOutsideTap).not.toHaveBeenCalled()

    // The next plain tap is a real tap again.
    fireEvent.pointerDown(fg, { pointerId: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(fg, { pointerId: 2, clientX: 100, clientY: 100 })
    fireEvent.click(fg)
    expect(onOutsideTap).toHaveBeenCalledTimes(1)
  })

  it('never captures on a vertical scroll', () => {
    const { fg, setCapture } = renderRow()

    fireEvent.pointerDown(fg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(fg, { pointerId: 1, clientX: 100, clientY: 100 + MOVE_THRESHOLD + 1 })

    expect(setCapture).not.toHaveBeenCalled()
  })

  it.each([false, true])('cancels a pre-capture exit without changing the open state (%s)', isOpen => {
    const { fg, bg, setCapture, onOpen, onClose } = renderRow(isOpen)
    const pointer = { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 79, buttons: 1 }
    fireEvent.pointerDown(fg, pointer)
    // Leave by only 3px; release occurs outside, so the row sees no pointerup.
    fireEvent.pointerLeave(fg, { ...pointer, clientY: 82 })
    expect(fg.style.willChange).toBe('')
    expect(bg.style.willChange).toBe('')
    expect(fg.style.transition).toBe(FG_TRANSITION)
    expect(bg.style.transition).toBe(BG_TRANSITION)
    fireEvent.pointerMove(fg, { ...pointer, buttons: 0, clientX: 140 })
    fireEvent.pointerMove(fg, { ...pointer, buttons: 0, clientX: 80 })
    expect(fg.style.transform).toBe(`translate3d(${isOpen ? -SWIPE_WIDTH : 0}px,0,0)`)
    expect(setCapture).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('aborts a missed mouse release even without a pointerleave, then accepts a fresh click', () => {
    const { fg, bg, onAction, onOpen } = renderRow()
    const pointer = { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 40, buttons: 1 }
    fireEvent.pointerDown(fg, pointer)
    fireEvent.pointerMove(fg, { ...pointer, clientX: 150 })
    fireEvent.pointerMove(fg, { ...pointer, clientX: 80 })
    // E.g. a release outside the browser window: no local pointerup.
    fireEvent.pointerMove(fg, { ...pointer, clientX: 60, buttons: 0 })
    expect(fg.style.transform).toBe('translate3d(0px,0,0)')
    expect(bg.style.pointerEvents).toBe('none')
    expect(fg.style.willChange).toBe('')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.pointerDown(fg, pointer)
    fireEvent.pointerUp(fg, { ...pointer, buttons: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'act' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('cancels a touch swipe past the open threshold without opening the row', () => {
    const { fg, bg, onOpen } = renderRow()
    const pointer = { pointerId: 1, pointerType: 'touch', clientX: 160, clientY: 40, buttons: 1 }
    fireEvent.pointerDown(fg, pointer)
    fireEvent.pointerMove(fg, { ...pointer, clientX: 150 })
    fireEvent.pointerMove(fg, { ...pointer, clientX: 80 })
    fireEvent.pointerCancel(fg, { ...pointer, buttons: 0 })
    expect(fg.style.transform).toBe('translate3d(0px,0,0)')
    expect(fg.style.willChange).toBe('')
    expect(bg.style.willChange).toBe('')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps a recognised mouse swipe active when leaving the row', () => {
    const { fg, onOpen, setCapture } = renderRow()
    const pointer = { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 40, buttons: 1 }
    fireEvent.pointerDown(fg, pointer)
    fireEvent.pointerMove(fg, { ...pointer, clientX: 150 })
    fireEvent.pointerLeave(fg, pointer)
    fireEvent.pointerMove(fg, { ...pointer, clientX: 80 })
    fireEvent.pointerUp(fg, { ...pointer, clientX: 80, buttons: 0 })
    expect(setCapture).toHaveBeenCalledWith(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(fg.style.transform).toBe(`translate3d(${-SWIPE_WIDTH}px,0,0)`)
  })
})
