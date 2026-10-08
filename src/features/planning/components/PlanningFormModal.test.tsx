// @vitest-environment jsdom
// The planning form owns its write (useAwaitedSave): busy state, the failure
// banner and closing belong to this open. A write that settles after the
// form was dismissed must not close or mark whatever is open by then.
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, children, onSave, saveError, isSaving }: {
    isOpen: boolean; children: ReactNode; onSave: () => void; saveError?: string | null; isSaving: boolean
  }) => (isOpen ? (
    <div data-saving={String(isSaving)}>
      {saveError && <p role="alert">{saveError}</p>}
      {children}
      <button onClick={onSave}>save</button>
    </div>
  ) : null),
}))
vi.mock('@/components/ui/DeleteConfirm', () => ({
  default: ({ onDelete, disabled }: { onDelete: () => void; disabled?: boolean }) =>
    <button onClick={onDelete} disabled={disabled}>delete</button>,
}))

import PlanningFormModal from './PlanningFormModal'
import type { CreatePlanItemInput, PlanItem } from '@/types'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderForm(props: {
  onSave?: (d: CreatePlanItemInput, r: () => boolean) => void | Promise<unknown>
  onDelete?: () => void | Promise<unknown>
  editTarget?: PlanItem | null
  saveError?: string | null
}) {
  const onClose = vi.fn()
  const element = (saveError: string | null | undefined) => (
    <PlanningFormModal
      editTarget={props.editTarget ?? null} defaultCategory="essentials" isOpen saveError={saveError}
      onClose={onClose} onSave={props.onSave ?? vi.fn()} onDelete={props.onDelete}
    />
  )
  const view = render(element(props.saveError))
  const setPageError = (msg: string | null) => view.rerender(element(msg))
  // The title is the first text field; it must be non-empty to submit.
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Passport' } })
  return { ...view, onClose, setPageError }
}

describe('PlanningFormModal awaited write', () => {
  it('a newer refusal from the page is not hidden by an older failed save', async () => {
    // 1st save fails → own banner. The trip then switches; the 2nd tap is
    // refused by the page synchronously (no write) with its own reason.
    const onSave = vi.fn<(d: CreatePlanItemInput, r: () => boolean) => void | Promise<unknown>>()
      .mockReturnValueOnce(Promise.reject(new Error('儲存失敗了')))
      .mockReturnValueOnce(undefined)
    const { setPageError } = renderForm({ onSave })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(screen.getByRole('alert').textContent).toBe('儲存失敗了')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    setPageError('旅程或帳號已切換，請關閉表單後重新開啟')
    expect(screen.getByRole('alert').textContent).toBe('旅程或帳號已切換，請關閉表單後重新開啟')
  })

  it('cannot delete while its save is in flight', async () => {
    const d = deferred()
    const onDelete = vi.fn(() => Promise.resolve())
    const target = { id: 'p1', title: 'Passport', category: 'essentials' } as PlanItem
    renderForm({ editTarget: target, onSave: () => d.promise, onDelete })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect((screen.getByRole('button', { name: 'delete' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'delete' }))
    expect(onDelete).not.toHaveBeenCalled()
    await act(async () => { d.resolve() })
  })

  it('stays open and busy while saving, shows a failure in its own banner', async () => {
    const d = deferred()
    const onSave = vi.fn((_: CreatePlanItemInput, _r: () => boolean) => d.promise)
    const { container, onClose } = renderForm({ onSave })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })

    expect(typeof onSave.mock.calls[0]![1]).toBe('function')
    expect(container.querySelector('[data-saving]')!.getAttribute('data-saving')).toBe('true')
    await act(async () => { d.reject(new Error('無法寫入')) })
    expect(screen.getByRole('alert').textContent).toBe('無法寫入')
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('[data-saving]')!.getAttribute('data-saving')).toBe('false')
  })

  it('closes itself when the save succeeds', async () => {
    const { onClose } = renderForm({ onSave: async () => {} })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a save that settles after the form was dismissed closes nothing', async () => {
    const d = deferred()
    const onSave = vi.fn((_: CreatePlanItemInput, _r: () => boolean) => d.promise)
    const { unmount, onClose } = renderForm({ onSave })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    const reportInForm = onSave.mock.calls[0]![1]

    unmount()
    expect(reportInForm()).toBe(false)   // global toast takes over
    await act(async () => { d.resolve() })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a delete that settles after the form was dismissed closes nothing', async () => {
    const d = deferred()
    const target = { id: 'p1', title: 'Passport', category: 'essentials' } as PlanItem
    const { unmount, onClose } = renderForm({ editTarget: target, onDelete: () => d.promise })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'delete' })) })
    unmount()
    await act(async () => { d.resolve() })
    expect(onClose).not.toHaveBeenCalled()
  })
})
