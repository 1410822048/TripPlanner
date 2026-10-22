import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import FormModalShell from '@/components/ui/FormModalShell'
import { isAnyDraftModalOpen, registerOpenDraftModal } from './draftModalRegistry'

function Shell({ isOpen }: { isOpen: boolean }) {
  return (
    <FormModalShell isOpen={isOpen} isSaving={false} title="編輯" saveLabel="儲存" onClose={() => {}} onSave={() => {}}>
      <input aria-label="名稱" />
    </FormModalShell>
  )
}

describe('draftModalRegistry', () => {
  it('counts registrations and releases each one once', () => {
    const a = registerOpenDraftModal()
    const b = registerOpenDraftModal()
    a()
    a()
    expect(isAnyDraftModalOpen()).toBe(true)
    b()
    expect(isAnyDraftModalOpen()).toBe(false)
  })

  it('FormModalShell registers only while open and releases on close / unmount', () => {
    const view = render(<Shell isOpen={false} />)
    expect(isAnyDraftModalOpen()).toBe(false)
    view.rerender(<Shell isOpen />)
    expect(isAnyDraftModalOpen()).toBe(true)
    view.rerender(<Shell isOpen={false} />)
    expect(isAnyDraftModalOpen()).toBe(false)
    view.rerender(<Shell isOpen />)
    view.unmount()
    expect(isAnyDraftModalOpen()).toBe(false)
  })
})
