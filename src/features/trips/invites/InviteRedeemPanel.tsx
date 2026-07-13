import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, RotateCcw, X } from 'lucide-react'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { useAuth } from '@/hooks/useAuth'
import { useTripStore } from '@/store/tripStore'
import { toast } from '@/shared/toast'
import { useAcceptInvite } from './useInvites'
import { getInvite, InviteError, formatInviteExpiry } from './inviteService'
import type { Invite } from '@/types'

interface InviteRedeemPanelProps {
  tripId:            string | undefined
  token:             string | undefined
  onDone:            () => void
  onCancel:          () => void
  isCurrent?:        () => boolean
  onAcceptingChange?: (accepting: boolean) => void
}

export default function InviteRedeemPanel({
  tripId,
  token,
  onDone,
  onCancel,
  isCurrent,
  onAcceptingChange,
}: InviteRedeemPanelProps) {
  const { state, signInWithGoogle } = useAuth(true)
  const acceptMut = useAcceptInvite()
  const uid = state.status === 'signed-in' ? state.user.uid : undefined

  const inviteQ = useQuery<Invite, Error>({
    queryKey: ['invite', tripId, token],
    queryFn:  () => getInvite(tripId!, token!),
    enabled:  !!tripId && !!token && !!uid,
    retry:    false,
    gcTime:   0,
  })

  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    onAcceptingChange?.(acceptMut.isPending)
  }, [acceptMut.isPending, onAcceptingChange])

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
      const { outcome, trip } = await acceptMut.mutateAsync({ tripId, token, user: state.user })
      if (isCurrent && !isCurrent()) return
      useTripStore.getState().setSelectedTripId(trip?.id ?? tripId)
      toast.success(outcome === 'already-member' ? '既に参加中です' : '旅程に参加しました')
      onDone()
    } catch (e) {
      if (isCurrent && !isCurrent()) return
      toast.error(e instanceof Error ? `参加に失敗：${e.message}` : '参加に失敗しました')
    }
  }

  const paramsInvalid = !tripId || !token
  const inviteError = inviteQ.error instanceof InviteError ? inviteQ.error : null
  const errorMessage  = paramsInvalid
    ? '不正な招待リンクです'
    : inviteError
      ? messageFor(inviteError.code)
      : inviteQ.error instanceof Error
        ? inviteQ.error.message
        : '読み込みに失敗しました'

  if (paramsInvalid) return <ErrorCard message={errorMessage} onHome={onCancel} />
  if (state.status === 'loading') return <LoadingCard />
  if (state.status === 'signed-out') return <SignInCard signingIn={signingIn} onSignIn={handleSignIn} />
  if (state.status === 'error') return <ErrorCard message="認証に失敗しました" onHome={onCancel} />
  if (inviteQ.isPending) return <LoadingCard />
  if (inviteQ.isError) {
    const canRetry = inviteError?.code === 'unavailable'
    return (
      <ErrorCard
        message={errorMessage}
        onHome={onCancel}
        onRetry={canRetry ? () => { void inviteQ.refetch() } : undefined}
        retrying={inviteQ.isFetching}
      />
    )
  }
  return (
    <ReadyCard
      invite={inviteQ.data}
      accepting={acceptMut.isPending}
      onAccept={handleAccept}
      onCancel={onCancel}
    />
  )
}

function messageFor(code: InviteError['code']): string {
  switch (code) {
    case 'not-found': return 'この招待リンクは見つかりません'
    case 'expired':   return 'この招待リンクは期限切れです'
    case 'unavailable': return '招待を確認できません。通信状況を確認して再試行してください'
    case 'failed': return '招待を読み込めませんでした'
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

function ErrorCard({
  message, onHome, onRetry, retrying = false,
}: {
  message: string
  onHome:  () => void
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-6 text-center">
      <div className="text-[40px] leading-none mb-3">⚠️</div>
      <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="w-full max-w-[280px] h-11 mb-2 rounded-chip border border-border bg-surface text-ink text-[13px] font-semibold cursor-pointer hover:bg-app transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <RotateCcw size={14} strokeWidth={2.2} />
          {retrying ? '再試行中…' : '再試行'}
        </button>
      )}
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
