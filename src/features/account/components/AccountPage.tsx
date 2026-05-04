// src/features/account/components/AccountPage.tsx
// "My" tab: centered-hero profile page. Layout:
//   ┌─────────────────────────────────────┐
//   │           ┌────────┐                 │
//   │           │ avatar │                 │
//   │           └────────┘                 │
//   │              名前                     │
//   │              email                   │
//   │        ─────────────────              │
//   │    N 件     N 日      N 年             │
//   │   旅程      日数       利用            │
//   └─────────────────────────────────────┘
//   ┌─────────────┐  ┌─────────────┐
//   │ [stacked    ]│  │ [stacked    ]│
//   │ [lodging ]   │  │ [avatars   ] │
//   │              │  │              │
//   │ 過往の旅程   │  │ 共同編集の仲間│
//   │ 住宿の記録   │  │ N 人         │
//   └─────────────┘  └─────────────┘
//   [Planner promo card]
//   [logout]
//   v0.0.0 · YYYY-MM-DD
//
// Profile uses a centered hero (Instagram/X pattern) rather than a left/
// right split — the vertical hierarchy (avatar → identity → stats) reads
// cleanly and long names don't get truncated in a narrow side column.
// Card #1 routes to /past-lodging; Card #2 aggregates unique non-self
// members across every trip (informational, non-clickable).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import ConfirmSheet from '@/components/ui/ConfirmSheet'
import GoogleIcon from '@/components/icons/GoogleIcon'
import StatCell from './StatCell'
import FeatureCard from './FeatureCard'
import AccountPageSkeleton from './AccountPageSkeleton'
import { StackedEmojiPreview, StackedAvatarPreview } from './StackedPreviews'
import { useAuth } from '@/hooks/useAuth'
import { useAllTripMembers } from '@/features/members/hooks/useAllTripMembers'
import { memberToTripMember } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import { toast } from '@/shared/toast'
import { daysBetween } from '@/utils/dates'
import type { TripMember } from '@/features/trips/types'
import type { Trip } from '@/types'

// Static thumbnail deck for the "過往の旅程" feature card. Intentionally
// decorative — the real listing lives at /past-lodging via
// PastLodgingPage + getMyHotelBookings(). Wiring the actual hotel
// thumbnails into this card was considered but rejected: the card is
// a CTA, not a preview, and the per-card cost (one collection-group
// query on every AccountPage render) outweighs the visual upside.
const PAST_LODGING_EMOJIS = ['🏨', '🛏️', '🏖️']

function tripDays(trip: Trip): number {
  return daysBetween(trip.startDate, trip.endDate)
}

/**
 * Human-readable "member since" label derived from Firebase Auth's
 * `user.metadata.creationTime`. Grows units (日 → か月 → 年) so a 2-day-old
 * account doesn't read as "0 年". Returns null if the metadata is missing
 * (very old sign-ins in some SDK versions).
 */
function accountAgeLabel(creationTime: string | undefined): string | null {
  if (!creationTime) return null
  const createdAt = new Date(creationTime)
  if (Number.isNaN(createdAt.getTime())) return null
  const diffMs = Date.now() - createdAt.getTime()
  const days   = Math.floor(diffMs / 86_400_000)
  if (days < 30)  return `${Math.max(1, days)} 日`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} か月`
  return `${Math.floor(months / 12)} 年`
}

export default function AccountPage() {
  const { state, signInWithGoogle, signOut } = useAuth(true)
  const navigate = useNavigate()

  const uid = state.status === 'signed-in' ? state.user.uid : undefined
  const { trips, memberResults } = useAllTripMembers(uid)

  // Aggregations memoised on the upstream data — without these they
  // re-ran on every signing-state toggle / logout-sheet open / etc.
  const totalDays = useMemo(
    () => (trips ?? []).reduce((s, t) => s + tripDays(t), 0),
    [trips],
  )
  const { collaboratorChips, collaboratorCount } = useMemo(() => {
    const seen  = new Set<string>()
    const chips: TripMember[] = []
    let   count = 0
    for (const r of memberResults) {
      for (const m of r.data ?? []) {
        if (m.userId === uid || seen.has(m.userId)) continue
        seen.add(m.userId)
        count++
        if (chips.length < 3) chips.push(memberToTripMember(m))
      }
    }
    return { collaboratorChips: chips, collaboratorCount: count }
  }, [memberResults, uid])

  const [signingIn,  setSigningIn]  = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)

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

  // Confirm flow happens inside LogoutConfirmSheet; this is the commit step
  // called from the sheet's 「ログアウト」 button.
  async function handleSignOut() {
    setSigningOut(true)
    try {
      // Clear the persisted trip selection first — otherwise on next cold
      // start the rehydration effect in SchedulePage would try to fetch a
      // trip whose rules now deny read access, producing a stuck spinner.
      useTripStore.getState().clearTrip()
      await signOut()
      setLogoutOpen(false)
      toast.success('ログアウトしました')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'ログアウトに失敗しました')
    } finally { setSigningOut(false) }
  }

  function openPastLodging() {
    navigate('/past-lodging')
  }

  function openSocialCircle() {
    navigate('/social-circle')
  }

  // Three-way split of the auth state:
  //   'loading'  → skeleton mirroring the signed-in layout. Avoids a CTA
  //                flash on cold-start for users who ARE signed in, while
  //                also avoiding the bare "loading…" spinner that used to
  //                show for signed-out users. The skeleton reads as "we're
  //                deciding what to render" regardless of final state.
  //   'signed-in' → real profile (below).
  //   'signed-out' | 'error' → CTA card.
  if (state.status === 'loading') {
    return <AccountPageSkeleton />
  }

  if (state.status !== 'signed-in') {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-10 text-center">
        <div className="text-[44px] leading-none mb-3">☁️</div>
        <h2 className="m-0 mb-2 text-[18px] font-bold text-ink tracking-[0.02em] font-serif-ja">
          アカウント
        </h2>
        <p className="m-0 mb-6 text-[12.5px] text-muted leading-[1.7] tracking-[0.02em] max-w-[260px]">
          サインインして、自分の旅程をクラウドに保存しましょう。
        </p>
        <button
          onClick={handleSignIn}
          disabled={signingIn}
          className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
        >
          <GoogleIcon size={18} />
          {signingIn ? 'サインイン中…' : 'Google でサインイン'}
        </button>
        <div className="mt-10 text-[10.5px] text-muted opacity-70 tracking-[0.04em]">
          TripMate v{__APP_VERSION__} · {__BUILD_DATE__}
        </div>
      </div>
    )
  }

  const user = state.user
  const initial   = (user.displayName ?? user.email ?? '?').trim().charAt(0).toUpperCase() || '?'
  const tripCount = trips?.length ?? 0
  const ageLabel  = accountAgeLabel(user.metadata.creationTime)


  return (
    <div className="bg-app min-h-full pb-10">
      {/* Header */}
      <div className="px-5 pt-6 pb-5">
        <h1 className="m-0 text-[26px] font-black text-ink -tracking-[0.4px] leading-[1.1]">
          マイページ
        </h1>
      </div>

      {/* Profile card — vertically stacked, centered hero layout.
          Rationale: a left-right split with avatar-on-left + stacked-stats-
          on-right creates vertical-height asymmetry (stats cluster is
          taller), narrows the name column (long names truncate), and forces
          the two sides into tug-of-war. Instagram / X / most modern profile
          pages solve this with a centered hero — avatar → identity → stats —
          which reads as a clear top-to-bottom hierarchy and keeps the name
          full-width. */}
      <div className="mx-4">
        <div className="bg-surface border border-border rounded-[22px] px-5 pt-6 pb-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          {/* Avatar — visual hero */}
          <div className="flex justify-center">
            <div className="w-[88px] h-[88px] rounded-full bg-tile flex items-center justify-center overflow-hidden shadow-[0_2px_10px_rgba(0,0,0,0.1)]">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-[34px] font-bold text-muted">{initial}</span>
              )}
            </div>
          </div>

          {/* Identity — centered, full-width so long names don't truncate */}
          <div className="mt-3 text-center px-2">
            <div className="text-[17px] font-black text-ink -tracking-[0.2px] truncate">
              {user.displayName ?? 'ユーザー'}
            </div>
            {user.email && (
              <div className="text-[11px] text-muted truncate mt-0.5">
                {user.email}
              </div>
            )}
          </div>

          {/* Stats — horizontal row, divider above + between; each cell is
              centered with the label beneath the number (matches Instagram/
              X profile metric rows). */}
          <div className="mt-5 pt-4 border-t border-border flex divide-x divide-border">
            <StatCell label="旅程"  value={tripCount} unit="件" />
            <StatCell label="日数"  value={totalDays} unit="日" />
            {ageLabel && <StatCell label="利用" rawValue={ageLabel} />}
          </div>
        </div>
      </div>

      {/* 2-column feature grid */}
      <div className="mx-4 mt-3 grid grid-cols-2 gap-3">
        <FeatureCard
          label="過往の旅程"
          sublabel="住宿の記録"
          onClick={openPastLodging}
        >
          <StackedEmojiPreview emojis={PAST_LODGING_EMOJIS} />
        </FeatureCard>

        <FeatureCard
          label="共同編集の仲間"
          sublabel={collaboratorCount > 0 ? `${collaboratorCount} 人` : 'まだいません'}
          onClick={openSocialCircle}
          disabled={collaboratorCount === 0}
        >
          {collaboratorChips.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[11px] text-muted">
              旅伴を招待しよう
            </div>
          ) : (
            <StackedAvatarPreview chips={collaboratorChips} extra={collaboratorCount - collaboratorChips.length} />
          )}
        </FeatureCard>
      </div>

      {/* Planner promo — wide card matching the Airbnb "成為房東" pattern.
          Tap navigates to /schedule AND deep-links into the create-trip
          modal via location.state.openCreateTrip — SchedulePage consumes
          the flag once and clears it on first render. */}
      <div className="mx-4 mt-3">
        <button
          onClick={() => navigate('/schedule', { state: { openCreateTrip: true } })}
          className="w-full bg-surface border border-border rounded-[22px] px-5 py-4 flex items-center gap-4 text-left cursor-pointer transition-all hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(0,0,0,0.08)] shadow-[0_2px_12px_rgba(0,0,0,0.05)]"
        >
          <div className="w-[72px] h-[72px] rounded-2xl shrink-0 flex items-center justify-center text-[40px] bg-accent-pale shadow-[inset_0_1px_3px_rgba(0,0,0,0.06)]">
            🧭
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-black text-ink -tracking-[0.2px]">
              旅程の作成者 / Planner
            </div>
            <div className="text-[11.5px] text-muted mt-1 leading-[1.5] tracking-[0.02em]">
              新しい旅を計画して、仲間と一緒に共有しましょう。
            </div>
          </div>
        </button>
      </div>

      {/* Actions */}
      <div className="mx-4 mt-5">
        <button
          onClick={() => setLogoutOpen(true)}
          disabled={signingOut}
          className="w-full h-12 rounded-xl border border-border bg-surface text-[#A04040] text-[13.5px] font-semibold flex items-center justify-center gap-2 cursor-pointer transition-all hover:bg-danger-pale hover:border-[#E9C5C5] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <LogOut size={14} strokeWidth={2} />
          {signingOut ? 'ログアウト中…' : 'ログアウト'}
        </button>
      </div>

      <ConfirmSheet
        isOpen={logoutOpen}
        title="ログアウトしますか？"
        description={
          <>
            ログアウトすると、選択中の旅程は解除されます。<br />
            再度サインインすればクラウドのデータを取り戻せます。
          </>
        }
        icon={
          <div className="w-14 h-14 rounded-2xl bg-danger-pale flex items-center justify-center">
            <LogOut size={22} strokeWidth={2} className="text-[#A04040]" />
          </div>
        }
        confirmLabel={signingOut ? 'ログアウト中…' : 'ログアウト'}
        tone="danger"
        loading={signingOut}
        onClose={() => setLogoutOpen(false)}
        onConfirm={handleSignOut}
      />

      {/* Version footer */}
      <div className="mt-8 text-center text-[10.5px] text-muted opacity-70 tracking-[0.04em]">
        TripMate v{__APP_VERSION__} · {__BUILD_DATE__}
      </div>
    </div>
  )
}

