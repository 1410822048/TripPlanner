// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { GoogleSignInResult } from '@/hooks/useAuth'

const h = vi.hoisted(() => ({ signInWithGoogle: vi.fn(), toastError: vi.fn() }))

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ signInWithGoogle: h.signInWithGoogle }) }))
vi.mock('@/shared/toast', () => ({ toast: { error: h.toastError } }))

import GoogleSignInButton from './GoogleSignInButton'

const button = () => screen.getByRole('button') as HTMLButtonElement
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const authError = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => {
  h.signInWithGoogle.mockReset()
  h.toastError.mockReset()
})

describe('GoogleSignInButton', () => {
  it("calls onSignedIn once on 'signed-in' and reports busy around the call", async () => {
    const onSignedIn = vi.fn(); const onBusyChange = vi.fn()
    h.signInWithGoogle.mockResolvedValue('signed-in')
    render(<GoogleSignInButton onSignedIn={onSignedIn} onBusyChange={onBusyChange} />)
    fireEvent.click(button())
    await flush()
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(button().disabled).toBe(false)
  })

  it.each(['superseded', 'redirecting'] as GoogleSignInResult[])('does not call onSignedIn on %s', async (result) => {
    const onSignedIn = vi.fn()
    h.signInWithGoogle.mockResolvedValue(result)
    render(<GoogleSignInButton onSignedIn={onSignedIn} />)
    fireEvent.click(button())
    await flush()
    expect(onSignedIn).not.toHaveBeenCalled()
    // Redirecting: the page is leaving, so the button stays busy.
    expect(button().disabled).toBe(result === 'redirecting')
  })

  it('closed popup: no toast, no callback, busy restored', async () => {
    const onSignedIn = vi.fn()
    h.signInWithGoogle.mockRejectedValue(authError('auth/popup-closed-by-user'))
    render(<GoogleSignInButton onSignedIn={onSignedIn} />)
    fireEvent.click(button())
    await flush()
    expect(h.toastError).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(button().disabled).toBe(false)
  })

  it('other failure: toast once, busy restored', async () => {
    h.signInWithGoogle.mockRejectedValue(authError('auth/network-request-failed'))
    render(<GoogleSignInButton />)
    fireEvent.click(button())
    await flush()
    expect(h.toastError).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(false)
  })

  it('blocks a second sign-in while one is pending, even in the same tick', async () => {
    h.signInWithGoogle.mockReturnValue(new Promise(() => {}))
    render(<GoogleSignInButton />)
    const el = button()
    fireEvent.click(el)
    fireEvent.click(el)
    expect(h.signInWithGoogle).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('登入中')
  })

  it('does nothing when disabled', () => {
    render(<GoogleSignInButton disabled />)
    fireEvent.click(button())
    expect(h.signInWithGoogle).not.toHaveBeenCalled()
  })
})
