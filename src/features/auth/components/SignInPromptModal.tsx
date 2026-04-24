// src/features/auth/components/SignInPromptModal.tsx
// Shared sign-in prompt for demo-mode write attempts. Lives as a BottomSheet
// so it can be invoked from inside another modal (e.g. CreateTripModal) or
// directly from a page. Auth SDK is lazy-loaded — the sheet only pulls it
// when `isOpen` becomes true.
import { useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'

interface Props {
  isOpen:   boolean
  onClose:  () => void
  /** Context-specific hook, e.g. "旅程を作成するには" or "費用を保存するには" */
  reason?:  string
  /** Called after a successful sign-in — caller can retry the pending action. */
  onSignedIn?: () => void
}

export default function SignInPromptModal({ isOpen, onClose, reason, onSignedIn }: Props) {
  const { state, signInWithGoogle } = useAuth(isOpen)
  const [signingIn, setSigningIn] = useState(false)

  async function handleSignIn() {
    setSigningIn(true)
    try {
      await signInWithGoogle()
      onSignedIn?.()
      onClose()
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user') {
        toast.error(e instanceof Error ? e.message : 'サインインに失敗しました')
      }
    } finally { setSigningIn(false) }
  }

  if (!isOpen) return null

  // If the user is already signed-in (e.g. state hydrated while sheet
  // was opening), close immediately and let the caller proceed.
  if (state.status === 'signed-in') {
    queueMicrotask(() => { onSignedIn?.(); onClose() })
    return null
  }

  return (
    <BottomSheet isOpen onClose={onClose} title="サインインが必要です">
      <div className="py-4 text-center">
        <div className="text-[44px] leading-none mb-3">☁️</div>
        <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
          {reason ?? 'データをクラウドに保存するには、'}<br />
          Google アカウントでサインインしてください。
        </p>
        <button
          onClick={handleSignIn}
          disabled={signingIn || state.status === 'loading'}
          className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
        >
          <GoogleIcon size={18} />
          {signingIn ? 'サインイン中…' : 'Google でサインイン'}
        </button>
        <p className="mt-5 text-[10.5px] text-muted leading-[1.6] tracking-[0.02em] max-w-[280px] mx-auto">
          サインイン後、プレビュー中のデモデータは<br />
          あなた自身の旅程に置き換わります。
        </p>
      </div>
    </BottomSheet>
  )
}

