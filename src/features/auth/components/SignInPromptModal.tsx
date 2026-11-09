// src/features/auth/components/SignInPromptModal.tsx
// Shared sign-in prompt for demo-mode write attempts. Lives as a BottomSheet
// so it can be invoked from inside another modal (e.g. CreateTripModal) or
// directly from a page. Auth SDK is lazy-loaded — the sheet only pulls it
// when `isOpen` becomes true.
import { useEffect, useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import GoogleSignInButton from './GoogleSignInButton'
import { useAuth, type AuthState } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'
import { DEV_EMULATOR_USERS, signInWithEmulatorRole, type EmulatorRole } from '@/services/emulatorAuth'
import { FIREBASE_EMULATOR_MODE } from '@/services/firebase'

interface Props {
  isOpen:   boolean
  onClose:  () => void
  /** Context-specific hook, e.g. "若要建立旅程，" or "若要儲存費用，" */
  reason?:  string
  /** Called after a successful sign-in — caller can retry the pending action. */
  onSignedIn?: () => void
}

/** Once-per-open completion. Two paths can report success (the sign-in call
 *  returning, and the auth observer flipping state); whichever comes first
 *  wins, and a result landing after this open closed is dropped. */
function createCompletion() {
  let live = true
  let done = false
  return {
    /** Mount effect: live while mounted (re-armed on StrictMode remount). */
    attach: () => {
      live = true
      return () => { live = false }
    },
    claim: () => {
      if (!live || done) return false
      done = true
      return true
    },
  }
}

export default function SignInPromptModal({ isOpen, ...rest }: Props) {
  // Mounted only while open, so every open is a fresh instance.
  const { state } = useAuth(isOpen)
  if (!isOpen) return null
  return <SignInPromptSheet state={state} {...rest} />
}

function SignInPromptSheet({ state, onClose, reason, onSignedIn }: Omit<Props, 'isOpen'> & { state: AuthState }) {
  // Google and DEV sign-in block each other: never two at once.
  const [googleBusy, setGoogleBusy] = useState(false)
  const [devBusy,    setDevBusy]    = useState(false)
  const [{ attach, claim }] = useState(createCompletion)
  useEffect(attach, [attach])

  function complete() {
    if (!claim()) return
    onSignedIn?.()
    onClose()
  }

  async function handleDevSignIn(role: EmulatorRole) {
    setDevBusy(true)
    try {
      await signInWithEmulatorRole(role)
      complete()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'DEV 登入失敗')
    } finally { setDevBusy(false) }
  }

  // Signed in (observer fired first, or state hydrated while opening):
  // finish this open and let the caller proceed.
  if (state.status === 'signed-in') {
    queueMicrotask(complete)
    return null
  }

  return (
    <BottomSheet isOpen onClose={onClose} title="需要登入">
      <div className="py-4 text-center">
        <div className="text-[44px] leading-none mb-3">☁️</div>
        <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
          {reason ?? '若要將資料儲存到雲端，'}<br />
          請使用 Google 帳戶登入。
        </p>
        <GoogleSignInButton
          onSignedIn={complete}
          disabled={devBusy || state.status === 'loading'}
          onBusyChange={setGoogleBusy}
        />
        {import.meta.env.DEV && FIREBASE_EMULATOR_MODE && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-semibold text-muted">Emulator role login</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(Object.entries(DEV_EMULATOR_USERS) as Array<[EmulatorRole, { email: string; label: string }]>).map(([role, account]) => (
                <button
                  key={role}
                  type="button"
                  disabled={devBusy || googleBusy}
                  onClick={() => void handleDevSignIn(role)}
                  className="h-8 rounded-full border border-border bg-app px-2 text-[10px] font-semibold text-ink disabled:opacity-50"
                >
                  {account.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="mt-5 text-[10.5px] text-muted leading-[1.6] tracking-[0.02em] max-w-[280px] mx-auto">
          登入後，預覽中的示範資料會<br />
          改為你自己的旅程。
        </p>
      </div>
    </BottomSheet>
  )
}
