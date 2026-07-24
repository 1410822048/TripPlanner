import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import BottomSheet from './BottomSheet'

describe('BottomSheet dismissal lock', () => {
  test('blocks backdrop, close button, Escape, and drag dismissal while non-dismissible', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet isOpen title="套用中" onClose={onClose} dismissible={false}>
        <button type="button">內容</button>
      </BottomSheet>,
    )

    const dialog = screen.getByRole('dialog', { name: '套用中' })
    const backdrop = container.firstElementChild as HTMLElement
    fireEvent.click(backdrop)
    fireEvent.click(screen.getByRole('button', { name: '關閉' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(dialog.firstElementChild as HTMLElement, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(dialog.firstElementChild as HTMLElement, { pointerId: 1, clientY: 500 })
    fireEvent.pointerUp(dialog.firstElementChild as HTMLElement, { pointerId: 1, clientY: 500 })

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '關閉' }).hasAttribute('disabled')).toBe(true)
  })
})
