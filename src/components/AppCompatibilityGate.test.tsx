import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  updateRequired: false,
  needRefresh: true,
  checkingForUpdate: false,
  requestUpdate: vi.fn(),
  dismissUpdate: vi.fn(),
  activateUpdate: vi.fn(),
}))

vi.mock('@/hooks/useClientCompatibility', () => ({
  useClientCompatibility: () => ({ updateRequired: harness.updateRequired }),
}))
vi.mock('@/hooks/usePwaUpdate', () => ({
  usePwaUpdate: () => ({
    needRefresh: harness.needRefresh,
    checkingForUpdate: harness.checkingForUpdate,
    requestUpdate: harness.requestUpdate,
    dismissUpdate: harness.dismissUpdate,
    activateUpdate: harness.activateUpdate,
  }),
}))

import AppCompatibilityGate from './AppCompatibilityGate'
import PwaUpdatePrompt from './PwaUpdatePrompt'

beforeEach(() => {
  harness.updateRequired = false
  harness.needRefresh = true
  harness.checkingForUpdate = false
  harness.requestUpdate.mockReset()
  harness.dismissUpdate.mockReset()
  harness.activateUpdate.mockReset()
})

describe('PWA compatibility prompts', () => {
  it('suppresses the optional update banner while the mandatory gate owns the CTA', () => {
    harness.updateRequired = true

    const optional = render(<PwaUpdatePrompt />)
    expect(screen.queryByRole('status')).toBeNull()
    optional.unmount()

    render(<AppCompatibilityGate />)
    expect(screen.getByRole('alert', { name: 'App 版本需要更新' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '稍後再說' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
    expect(harness.requestUpdate).toHaveBeenCalledOnce()
  })

  it('keeps the regular prompt dismissible while this client remains compatible', () => {
    render(<PwaUpdatePrompt />)

    fireEvent.click(screen.getByRole('button', { name: '稍後再說' }))
    expect(harness.dismissUpdate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
