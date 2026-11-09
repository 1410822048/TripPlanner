// src/features/auth/components/GoogleSignInButton.tsx
// The one Google sign-in button: busy state, error toast, and the result
// contract of signInWithGoogle. Only 'signed-in' runs `onSignedIn`.
import { useRef, useState } from 'react'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'
import { userErrorMessage } from '@/utils/errorMessage'

interface Props {
  onSignedIn?:   () => void
  /** Blocks the button, e.g. while another sign-in method is running. */
  disabled?:     boolean
  /** Lets a parent block its other sign-in methods while this one runs. */
  onBusyChange?: (busy: boolean) => void
}

export default function GoogleSignInButton({ onSignedIn, disabled = false, onBusyChange }: Props) {
  const { signInWithGoogle } = useAuth(true)
  const [busy, setBusyState] = useState(false)
  // A ref, not `busy`, so a same-tick second tap is blocked before re-render.
  const inFlight = useRef(false)

  function setBusy(next: boolean) {
    inFlight.current = next
    setBusyState(next)
    onBusyChange?.(next)
  }

  async function handleClick() {
    if (inFlight.current || disabled) return
    setBusy(true)
    // Redirecting: the page is leaving, stay busy. Superseded can only come
    // from another button's popup (the ref blocks our own), so release.
    let keepBusy = false
    try {
      const result = await signInWithGoogle()
      keepBusy = result === 'redirecting'
      if (result === 'signed-in') onSignedIn?.()
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user') {
        toast.error(userErrorMessage(e, '登入失敗'))
      }
    } finally { if (!keepBusy) setBusy(false) }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy || disabled}
      className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
      style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
    >
      <GoogleIcon size={18} />
      {busy ? '登入中…' : '使用 Google 登入'}
    </button>
  )
}
