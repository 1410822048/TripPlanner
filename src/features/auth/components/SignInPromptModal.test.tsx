// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { GoogleSignInResult } from '@/hooks/useAuth'

const h = vi.hoisted(() => ({
  state: { status: 'signed-out' } as { status: string; user?: { uid: string } },
  signInWithGoogle: vi.fn(),
  signInWithEmulatorRole: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ state: h.state, signInWithGoogle: h.signInWithGoogle }),
}))
vi.mock('@/services/firebase', () => ({ FIREBASE_EMULATOR_MODE: true }))
vi.mock('@/services/emulatorAuth', () => ({
  DEV_EMULATOR_USERS: { owner: { email: 'o@x', label: 'Owner' } },
  signInWithEmulatorRole: h.signInWithEmulatorRole,
}))
vi.mock('@/shared/toast', () => ({ toast: { error: h.toastError } }))

import SignInPromptModal from './SignInPromptModal'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const googleButton = () => screen.getByRole('button', { name: /Google 登入|登入中/ })

beforeEach(() => {
  h.state = { status: 'signed-out' }
  h.signInWithGoogle.mockReset()
  h.signInWithEmulatorRole.mockReset()
  h.toastError.mockReset()
})

describe('SignInPromptModal completion', () => {
  it('completes once when the sign-in call returns before the auth observer', async () => {
    const onSignedIn = vi.fn(); const onClose = vi.fn()
    h.signInWithGoogle.mockResolvedValue('signed-in')
    const view = render(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    fireEvent.click(googleButton())
    await flush()
    // Parent has not closed yet; the observer now reports signed-in.
    h.state = { status: 'signed-in', user: { uid: 'u1' } }
    view.rerender(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('completes once when the auth observer fires before the sign-in call returns', async () => {
    const onSignedIn = vi.fn(); const onClose = vi.fn()
    const call = deferred<GoogleSignInResult>()
    h.signInWithGoogle.mockReturnValue(call.promise)
    const view = render(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    fireEvent.click(googleButton())
    h.state = { status: 'signed-in', user: { uid: 'u1' } }
    view.rerender(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    await flush()
    await act(async () => { call.resolve('signed-in'); await call.promise })
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drops a late result from a closed open instead of acting on the reopened modal', async () => {
    const onSignedIn = vi.fn(); const onClose = vi.fn()
    const call = deferred<GoogleSignInResult>()
    h.signInWithGoogle.mockReturnValue(call.promise)
    const view = render(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    fireEvent.click(googleButton())
    view.rerender(<SignInPromptModal isOpen={false} onClose={onClose} onSignedIn={onSignedIn} />)
    view.rerender(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    await act(async () => { call.resolve('signed-in'); await call.promise })
    await flush()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // The reopened sheet is a fresh instance: not stuck busy.
    expect((googleButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it.each(['superseded', 'redirecting'] as const)('runs no success action on %s and stays busy', async (result) => {
    const onSignedIn = vi.fn(); const onClose = vi.fn()
    h.signInWithGoogle.mockResolvedValue(result)
    render(<SignInPromptModal isOpen onClose={onClose} onSignedIn={onSignedIn} />)
    fireEvent.click(googleButton())
    await flush()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect((googleButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('closed popup: no toast, no callback, busy restored', async () => {
    const onSignedIn = vi.fn()
    h.signInWithGoogle.mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/popup-closed-by-user' }))
    render(<SignInPromptModal isOpen onClose={vi.fn()} onSignedIn={onSignedIn} />)
    fireEvent.click(googleButton())
    await flush()
    expect(h.toastError).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect((googleButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Google and DEV sign-in mutually exclusive', async () => {
    const call = deferred<GoogleSignInResult>()
    h.signInWithGoogle.mockReturnValue(call.promise)
    render(<SignInPromptModal isOpen onClose={vi.fn()} />)
    fireEvent.click(googleButton())
    expect((screen.getByRole('button', { name: 'Owner' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { call.resolve('superseded'); await call.promise })
  })
})
