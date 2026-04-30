// src/features/trips/invites/InvitePage.tsx
// Redeem page rendered at /invite/:tripId#<token>. The trip id lives in the
// URL path, but the invite token lives in the fragment (`#...`). Fragments
// are never sent in HTTP request lines, so the token stays out of server
// logs, CDN logs, and Referer headers even when the link is shared across
// third-party messaging apps.
//
// Flow:
//   1. Auth bootstrapping → spinner.
//   2. Signed-out → Google sign-in CTA. After sign-in the same component
//      re-renders with a resolved user.
//   3. Signed-in → TanStack Query fetches the invite (throws InviteError on
//      not-found/expired). On valid invite → render trip card + Accept.
//   4. Accept → acceptInvite. On success navigate to /schedule; the
//      invalidated useMyTrips picks up the new trip. If the user is already
//      a member, acceptInvite returns 'already-member' and we still navigate
//      with a gentle toast — reusable links can be re-clicked by the same
//      user without producing an error.
//
// Layout: standalone (no AppLayout tabs) so the redeem flow feels
// transactional and doesn't expose nav to a user who isn't yet a member.
import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { useAuth } from '@/hooks/useAuth'
import { useAcceptInvite } from './useInvites'
import { getInvite, InviteError, formatInviteExpiry } from './inviteService'
import { toast } from '@/shared/toast'
import type { Invite } from '@/types'

export default function InvitePage() {
  const { tripId } = useParams<{ tripId: string }>()
  const location   = useLocation()
  const navigate   = useNavigate()
  const { state, signInWithGoogle } = useAuth(true)
  const acceptMut  = useAcceptInvite()

  // Strip the leading '#' from location.hash. React Router's `hash` always
  // starts with '#' when present. Memoised on hash so the query key is stable.
  const token = useMemo(
    () => (location.hash.startsWith('#') ? location.hash.slice(1) : location.hash) || undefined,
    [location.hash],
  )

  const uid = state.status === 'signed-in' ? state.user.uid : undefined

  // Invite fetch via useQuery. Enabled once we have all three inputs; retry
  // disabled because InviteError is terminal (not-found/expired won't
  // recover on retry) and we want the error to surface immediately.
  const inviteQ = useQuery<Invite, Error>({
    queryKey: ['invite', tripId, token],
    queryFn:  () => getInvite(tripId!, token!),
    enabled:  !!tripId && !!token && !!uid,
    retry:    false,
    gcTime:   0,  // don't cache — stale invite state could mislead between visits
  })

  const [signingIn, setSigningIn] = useState(false)

  async function handleSignIn() {
    setSigningIn(true)
    try { await signInWithGoogle() }
    catch (e) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user') {
        toast.error(e instanceof Error ? e.message : 'サインインに失敗しました')
      }
    } finally { setSigningIn(false) }
  }

  async function handleAccept() {
    if (state.status !== 'signed-in' || !inviteQ.data || !tripId || !token) return
    try {
      const outcome = await acceptMut.mutateAsync({ tripId, token, user: state.user })
      toast.success(outcome === 'already-member' ? '既に参加中です' : '旅程に参加しました')
      navigate('/schedule', { replace: true })
    } catch (e) {
      toast.error(e instanceof Error ? `参加に失敗：${e.message}` : '参加に失敗しました')
    }
  }

  const paramsInvalid = !tripId || !token
  const errorMessage  = paramsInvalid
    ? '不正な招待リンクです'
    : inviteQ.error instanceof InviteError
      ? messageFor(inviteQ.error.code)
      : inviteQ.error instanceof Error
        ? inviteQ.error.message
        : '読み込みに失敗しました'

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app flex flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-10 flex flex-col justify-center">

        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-[10.5px] font-bold text-muted tracking-[0.14em] uppercase mb-1">
            Trip Invitation
          </div>
          <h1 className="m-0 text-[22px] font-black text-teal -tracking-[0.3px]">
            旅への招待
          </h1>
        </div>

        {paramsInvalid && (
          <ErrorCard message={errorMessage} onHome={() => navigate('/schedule', { replace: true })} />
        )}

        {!paramsInvalid && state.status === 'loading' && <LoadingCard />}

        {!paramsInvalid && state.status === 'signed-out' && (
          <SignInCard signingIn={signingIn} onSignIn={handleSignIn} />
        )}

        {!paramsInvalid && state.status === 'error' && (
          <ErrorCard
            message="認証に失敗しました"
            onHome={() => navigate('/schedule', { replace: true })}
          />
        )}

        {!paramsInvalid && state.status === 'signed-in' && inviteQ.isPending && <LoadingCard />}

        {!paramsInvalid && state.status === 'signed-in' && inviteQ.isError && (
          <ErrorCard
            message={errorMessage}
            onHome={() => navigate('/schedule', { replace: true })}
          />
        )}

        {!paramsInvalid && state.status === 'signed-in' && inviteQ.isSuccess && (
          <ReadyCard
            invite={inviteQ.data}
            accepting={acceptMut.isPending}
            onAccept={handleAccept}
            onCancel={() => navigate('/schedule', { replace: true })}
          />
        )}
      </div>
    </div>
  )
}

function messageFor(code: InviteError['code']): string {
  switch (code) {
    case 'not-found': return 'この招待リンクは見つかりません'
    case 'expired':   return 'この招待リンクは期限切れです'
  }
}

function LoadingCard() {
  return (
    <div className="bg-surface border border-border rounded-2xl p-8 text-center text-muted text-[13px]">
      <div className="inline-flex items-center gap-2">
        <div className="w-4 h-4 border-2 border-border border-t-accent rounded-full animate-spin" />
        <span>読み込み中…</span>
      </div>
    </div>
  )
}

function SignInCard({ signingIn, onSignIn }: { signingIn: boolean; onSignIn: () => void }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-6 text-center">
      <div className="text-[40px] leading-none mb-3">☁️</div>
      <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
        招待内容を確認するには、<br />
        Google アカウントでサインインしてください。
      </p>
      <button
        onClick={onSignIn}
        disabled={signingIn}
        className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
        style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
      >
        <GoogleIcon size={18} />
        {signingIn ? 'サインイン中…' : 'Google でサインイン'}
      </button>
    </div>
  )
}

function ErrorCard({ message, onHome }: { message: string; onHome: () => void }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-6 text-center">
      <div className="text-[40px] leading-none mb-3">⚠️</div>
      <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
        {message}
      </p>
      <button
        onClick={onHome}
        className="w-full max-w-[280px] h-11 rounded-chip border border-border bg-app text-ink text-[13px] font-semibold cursor-pointer hover:bg-tile transition-colors"
      >
        ホームに戻る
      </button>
    </div>
  )
}

function ReadyCard({ invite, accepting, onAccept, onCancel }: {
  invite: Invite
  accepting: boolean
  onAccept: () => void
  onCancel: () => void
}) {
  // Snapshot now at mount so the expiry label is stable within this render
  // pass (react-hooks/purity flags Date.now() in the render body).
  const [now] = useState(() => Date.now())
  const expiryLabel = formatInviteExpiry(invite.expiresAt, now)
  const isEditor = invite.role === 'editor'

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden">
      <div className="bg-gradient-to-b from-accent-pale to-surface px-6 pt-8 pb-5 text-center">
        <div className="text-[52px] leading-none mb-2">{invite.tripIcon}</div>
        <h2 className="m-0 text-[20px] font-black text-ink -tracking-[0.3px] mb-1">
          {invite.tripTitle}
        </h2>
        <div className="text-[10.5px] text-muted font-semibold tracking-[0.08em] uppercase">
          {expiryLabel}
        </div>
      </div>

      <div className="px-5 py-4 border-t border-border">
        <div className="flex items-center justify-center gap-2 mb-4">
          <span className="text-[11.5px] text-muted">あなたの権限</span>
          <span
            className={[
              'px-2.5 py-1 rounded-md text-[11px] font-bold tracking-[0.04em]',
              isEditor
                ? 'bg-accent-pale text-accent border border-accent/20'
                : 'bg-app text-muted border border-border',
            ].join(' ')}
          >
            {isEditor ? '編輯者 · 編集可能' : '檢視者 · 閲覧のみ'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={accepting}
            className="flex-1 h-11 rounded-xl border border-border bg-app text-ink text-[13px] font-semibold cursor-pointer hover:bg-tile transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={13} strokeWidth={2.5} />
            キャンセル
          </button>
          <button
            onClick={onAccept}
            disabled={accepting}
            className="flex-1 h-11 rounded-xl bg-accent text-white text-[13px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            style={{ boxShadow: '0 2px 8px rgba(61,139,122,0.25)' }}
          >
            <Check size={13} strokeWidth={2.5} />
            {accepting ? '参加中…' : '参加する'}
          </button>
        </div>
      </div>
    </div>
  )
}

