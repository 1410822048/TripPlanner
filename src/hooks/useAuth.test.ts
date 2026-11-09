// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const fb = vi.hoisted(() => ({
  signInWithPopup:    vi.fn(),
  signInWithRedirect: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebaseAuth: async () => ({
    auth: {},
    GoogleAuthProvider: class {},
    signInWithPopup:    fb.signInWithPopup,
    signInWithRedirect: fb.signInWithRedirect,
  }),
}))

import { useAuth } from './useAuth'

const err = (code: string) => Object.assign(new Error(code), { code })

function signIn() {
  // enabled=false: never boots the observer; only the sign-in call is under test.
  return renderHook(() => useAuth(false)).result.current.signInWithGoogle()
}

beforeEach(() => {
  fb.signInWithPopup.mockReset()
  fb.signInWithRedirect.mockReset()
})

describe('signInWithGoogle result contract', () => {
  it("reports 'signed-in' only when the popup signed the user in", async () => {
    fb.signInWithPopup.mockResolvedValue({ user: { uid: 'u1' } })
    await expect(signIn()).resolves.toBe('signed-in')
  })

  it("reports 'superseded' when a newer popup replaced this one", async () => {
    fb.signInWithPopup.mockRejectedValue(err('auth/cancelled-popup-request'))
    await expect(signIn()).resolves.toBe('superseded')
    expect(fb.signInWithRedirect).not.toHaveBeenCalled()
  })

  it("reports 'redirecting' when a blocked popup falls back to redirect", async () => {
    fb.signInWithPopup.mockRejectedValue(err('auth/popup-blocked'))
    fb.signInWithRedirect.mockResolvedValue(undefined)
    await expect(signIn()).resolves.toBe('redirecting')
  })

  it('throws a closed popup and other failures to the caller', async () => {
    fb.signInWithPopup.mockRejectedValue(err('auth/popup-closed-by-user'))
    await expect(signIn()).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' })
  })
})
