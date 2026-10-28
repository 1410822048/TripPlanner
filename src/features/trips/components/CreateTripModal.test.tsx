// @vitest-environment jsdom
// The create draft belongs to the account it was started under: switching
// accounts while the sheet is open refuses the save in place (draft kept),
// mirroring CopyTrip's copyTripOpenedUid check.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

const mocks = vi.hoisted(() => ({
  auth:        { status: 'signed-in', user: { uid: 'uid-a' } } as { status: string; user?: { uid: string } },
  mutateAsync: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ state: mocks.auth, signInWithGoogle: vi.fn() }),
}))
vi.mock('@/features/trips/hooks/useTrips', () => ({
  useCreateTrip: () => ({ mutateAsync: mocks.mutateAsync }),
}))
vi.mock('@/types/trip', () => ({
  CreateTripSchema: { safeParse: () => ({ success: true, data: { title: 'Tokyo' } }) },
}))
vi.mock('@/utils/offlineHandOff', () => ({ isOffline: () => false, OFFLINE_NEEDS_CONNECTION_MESSAGE: 'offline' }))
vi.mock('@/shared/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/services/clientCompatibility', () => ({ getClientWriteBlockReason: () => null }))
vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ isOpen, children, onSave, saveError }: {
    isOpen: boolean; children: ReactNode; onSave: () => void; saveError?: string | null
  }) => (isOpen ? (
    <div>
      {saveError && <p role="alert">{saveError}</p>}
      {children}
      <button onClick={onSave}>save</button>
    </div>
  ) : null),
}))
vi.mock('@/components/ui/pickers', () => ({ DatePicker: () => null }))
vi.mock('@/components/ui/CurrencyPicker', () => ({ default: () => null }))
vi.mock('@/components/ui/CountryPicker', () => ({ default: () => null }))

import CreateTripModal from './CreateTripModal'
import { FORM_SCOPE_CHANGED_MESSAGE } from '@/hooks/useFormModal'
import { useTripStore } from '@/store/tripStore'

beforeEach(() => {
  mocks.auth = { status: 'signed-in', user: { uid: 'uid-a' } }
  mocks.mutateAsync.mockReset().mockReturnValue(new Promise(() => {}))
  useTripStore.setState({ ownerUid: 'uid-a', selectedTripId: null })
})

describe('CreateTripModal account scope', () => {
  it('refuses the save in place after an account switch', () => {
    const view = render(<CreateTripModal isOpen onClose={vi.fn()} />)
    mocks.auth = { status: 'signed-in', user: { uid: 'uid-b' } }
    view.rerender(<CreateTripModal isOpen onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    expect(mocks.mutateAsync).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(FORM_SCOPE_CHANGED_MESSAGE)
  })

  it('adopts the account signed in from inside the sheet', () => {
    mocks.auth = { status: 'signed-out' }
    const view = render(<CreateTripModal isOpen onClose={vi.fn()} />)
    mocks.auth = { status: 'signed-in', user: { uid: 'uid-b' } }
    view.rerender(<CreateTripModal isOpen onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    expect(mocks.mutateAsync).toHaveBeenCalledWith({ input: { title: 'Tokyo' }, user: { uid: 'uid-b' } })
  })

  it('selects the new trip only while the store still belongs to the creating account', async () => {
    let resolve!: (t: { id: string; title: string }) => void
    mocks.mutateAsync.mockReturnValue(new Promise(r => { resolve = r }))
    render(<CreateTripModal isOpen onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    // 寫入途中換帳號：reconcileAccountScope 已把 store 交給 B。
    useTripStore.setState({ ownerUid: 'uid-b' })
    await act(async () => { resolve({ id: 'trip-new', title: 'Tokyo' }) })
    expect(useTripStore.getState().selectedTripId).toBeNull()
  })

  it('selects the new trip when the account is unchanged (positive control)', async () => {
    mocks.mutateAsync.mockResolvedValue({ id: 'trip-new', title: 'Tokyo' })
    render(<CreateTripModal isOpen onClose={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'save' })) })
    expect(useTripStore.getState().selectedTripId).toBe('trip-new')
  })
})
