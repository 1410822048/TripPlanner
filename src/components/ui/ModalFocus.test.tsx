import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BottomSheet from './BottomSheet'
import PickerDialog from './pickers/PickerDialog'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe.each(['center', 'bottom'] as const)('nested %s picker', placement => {
  it('traps focus in the picker, closes only it on Escape, and returns focus to its invoker', () => {
    const parentClose = vi.fn()
    function Example() {
      const [open, setOpen] = useState(false)
      return <BottomSheet isOpen title="表單" onClose={parentClose}>
        <button type="button" onClick={() => setOpen(true)}>開啟選擇器</button>
        <PickerDialog isOpen={open} onClose={() => setOpen(false)} title="選擇器" placement={placement}>
          <button type="button">第一個</button><button type="button">最後一個</button>
        </PickerDialog>
      </BottomSheet>
    }
    render(<Example />)
    act(() => vi.advanceTimersByTime(50))
    const invoker = screen.getByRole('button', { name: '開啟選擇器' })
    invoker.focus()
    fireEvent.click(invoker)
    act(() => vi.advanceTimersByTime(50))
    const first = screen.getByRole('button', { name: '第一個' })
    const last = screen.getByRole('button', { name: '最後一個' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '選擇器' })).toBeNull()
    expect(parentClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(invoker)
    fireEvent.keyDown(invoker, { key: 'Escape' })
    expect(parentClose).toHaveBeenCalledOnce()
  })
})

it('updates dismissibility and callbacks without resetting focus on a parent rerender', () => {
  const oldClose = vi.fn()
  const newClose = vi.fn()
  const view = render(<BottomSheet isOpen title="表單" onClose={oldClose}><input aria-label="草稿" /></BottomSheet>)
  act(() => vi.advanceTimersByTime(50))
  const input = screen.getByRole('textbox', { name: '草稿' })
  input.focus()
  view.rerender(<BottomSheet isOpen title="表單" dismissible={false} onClose={newClose}><input aria-label="草稿" /></BottomSheet>)
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(newClose).not.toHaveBeenCalled()
  view.rerender(<BottomSheet isOpen title="表單" onClose={newClose}><input aria-label="草稿" /></BottomSheet>)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(newClose).toHaveBeenCalledOnce()
  expect(oldClose).not.toHaveBeenCalled()
})
