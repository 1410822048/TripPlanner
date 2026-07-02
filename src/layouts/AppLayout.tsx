// src/layouts/AppLayout.tsx
import { Suspense, startTransition, useState, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CalendarDays, Ticket, Receipt, Heart, ListChecks, UserCircle } from 'lucide-react'
import PageLoadingSkeleton from '@/components/ui/PageLoadingSkeleton'
import OfflineBanner from '@/components/ui/OfflineBanner'
import PwaUpdatePrompt from '@/components/PwaUpdatePrompt'
import PwaInstallPrompt from '@/components/PwaInstallPrompt'
import { useCurrentTripSync } from '@/features/trips/hooks/useCurrentTripSync'
import { usePrefetchBookings } from '@/features/bookings/hooks/usePrefetchBookings'
import { readAuthHint, useAuth } from '@/hooks/useAuth'
import { useFeatureBadges } from '@/hooks/useFeatureBadges'
import { writePushOwnerUid } from '@/features/account/services/pushOwnerStore'
import { useLastViewedStore, type BadgeFeature } from '@/store/lastViewedStore'
import { useTripStore } from '@/store/tripStore'

// Single source of truth for the bottom-nav height. Used by:
//   - <main>'s `bottom` (so content doesn't scroll under the nav)
//   - <nav>'s `height`
//   - PWA banners' `bottom` offset (read via the --nav-h var below)
//
// On Face-ID iPhones running as PWAs, `env(safe-area-inset-bottom)`
// reports the home-indicator strip (~34px). Without accounting for it
// the nav's icon row sat *underneath* the indicator and tap targets
// were cropped. We bake the safe-area into the nav HEIGHT (not into
// a separate offset) so:
//   - main content's bottom stays clear of indicator + nav
//   - PWA banners auto-shift up too (they read --nav-h)
//   - <nav>'s `padding-bottom` pushes the icon row above the indicator
//     while the indicator zone keeps the nav's blurred background, so
//     visually it reads as one unbroken bar.
// Android / desktop / pre-iPhone-X resolve safe-area to 0, so they get
// the original 4rem behaviour for free.
const NAV_H = 'calc(4rem + env(safe-area-inset-bottom))'

const TABS = [
  { path: '/schedule', label: '行程', Icon: CalendarDays, feature: 'schedule' as const },
  { path: '/bookings', label: '訂單', Icon: Ticket,       feature: 'bookings' as const },
  { path: '/expense',  label: '費用', Icon: Receipt,      feature: 'expense'  as const },
  { path: '/wish',     label: 'Wish', Icon: Heart,        feature: 'wish'     as const },
  { path: '/planning', label: '規劃', Icon: ListChecks,   feature: 'planning' as const },
  { path: '/account',  label: '我的', Icon: UserCircle,   feature: null },
] as const

function pathToFeature(pathname: string): BadgeFeature | null {
  const tab = TABS.find(t => pathname.startsWith(t.path))
  return tab?.feature ?? null
}

export default function AppLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Optimistic active-tab state — wraps tab navigation in startTransition
  // so the new page render is deferred (concurrent), but the BottomNav
  // active highlight paints immediately from this synchronous state.
  // Without this, INP on tab-switch was driven by the next page's full
  // render (~200ms peak); with it, INP = AppLayout re-render only.
  // Pattern matches Vercel rerender-transitions for non-urgent updates.
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  // Clear pendingPath the render after pathname catches up — derived
  // during render (React-official "compare prev prop" pattern) instead
  // of useEffect+setState, which the set-state-in-effect lint rightly
  // flags as a cascade.
  if (pendingPath && pathname.startsWith(pendingPath)) {
    setPendingPath(null)
  }
  function handleTabClick(path: string) {
    if (pathname.startsWith(path)) return
    setPendingPath(path)
    startTransition(() => navigate(path))
  }

  // Trip rehydration runs at layout level so a hard reload landing on
  // /bookings, /expense, etc. picks the user's last trip without forcing
  // them through /schedule first. The hook is a no-op in demo mode.
  useCurrentTripSync()

  // Cache-warming: kicks off the bookings query as soon as a currentTrip is
  // known, in parallel with whatever page the user is on. When they
  // navigate to /bookings, the list resolves from cache — closes the
  // visible "header showing but list still loading" gap on cold load.
  usePrefetchBookings()

  const { state: pushOwnerAuthState } = useAuth()
  const pushOwnerUid = pushOwnerAuthState.status === 'signed-in'
    ? pushOwnerAuthState.user.uid
    : pushOwnerAuthState.status === 'loading' && readAuthHint()
      ? undefined
      : null
  useEffect(() => {
    if (pushOwnerUid === undefined) return
    void writePushOwnerUid(pushOwnerUid)
  }, [pushOwnerUid])

  // Per-tab unread dots read from the trip doc's `lastActivityByFeature`
  // denormalisation. No extra listeners — piggybacks on the existing
  // trip-doc subscription mounted by useCurrentTripSync above. Each
  // service mutation calls bumpTripActivity() so reads are O(1) regardless
  // of how many entities a member edits. See useFeatureBadges for the
  // history (previously 5 always-on collection listeners).
  const { badges, activity } = useFeatureBadges()

  // Mark the active tab's feature as viewed, watermarking lastViewed to
  // the latest known item activity. The activity dep makes the effect
  // re-fire on cache push, so a user's own mutation on the current tab
  // doesn't flash a phantom badge after they navigate away — without
  // it, lastViewed = enter-time would be older than the just-created
  // item's serverTimestamp.
  const tripId = useTripStore(s => s.selectedTripId)
  const activeFeature = pathToFeature(pathname)
  const activeActivity = activeFeature ? activity[activeFeature] : 0
  useEffect(() => {
    if (!tripId || !activeFeature) return
    // +1 ensures lastViewed strictly exceeds the latest item ts.
    const watermark = Math.max(activeActivity + 1, Date.now())
    useLastViewedStore.getState().markViewed(tripId, activeFeature, watermark)
  }, [tripId, activeFeature, activeActivity])

  // Preview-first: layout renders for everyone. Auth is prompted per action
  // (create trip / save schedule / save expense) inside each feature page;
  // the auth SDK never loads until the user actually triggers a write.

  return (
    <div
      className="fixed inset-0 max-w-[430px] mx-auto bg-app"
      // Expose nav height as a CSS variable so descendant overlays
      // (PwaUpdatePrompt / PwaInstallPrompt below) read the same value
      // their layout depends on, no magic number duplication.
      style={{ '--nav-h': NAV_H } as React.CSSProperties}
    >
      {/* Skip link — 鍵盤使用者首個 Tab focus 即可跳過 BottomNav 直達主內容。 */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded focus:bg-accent focus:text-white focus:text-sm focus:font-medium focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        本文へスキップ
      </a>

      <main
        id="main"
        tabIndex={-1}
        className="absolute top-0 inset-x-0 overflow-y-auto overflow-x-hidden bg-app focus:outline-none"
        style={{ bottom: 'var(--nav-h)' }}
      >
        {/* 接在 main 內最頂部 — 跟頁面一起捲動,進頁面必看到一次,
            離線時持續存在不自動消失,回線後短暫顯示「同期しました」綠
            條 2 秒。 */}
        <OfflineBanner />
        <Suspense fallback={<PageLoadingSkeleton />}>
          <Outlet />
        </Suspense>
      </main>

      <nav
        aria-label="主要ナビゲーション"
        className="absolute bottom-0 inset-x-0 flex items-stretch border-t border-border/60 px-1 z-10"
        style={{
          height: 'var(--nav-h)',
          // Padding-bottom carves out the home-indicator strip so the
          // 6 nav buttons stretch into the TOP 4rem only. items-stretch
          // (replacing items-center) makes flex children fill the
          // padding box's content area — i.e. 4rem regardless of
          // safe-area size — so icons stay vertically centred in the
          // visible row, not pushed down by the indicator gap.
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: 'rgba(253,250,245,0.94)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
        }}
      >
        {TABS.map(({ path, label, Icon, feature }) => {
          // Active highlight reads from pendingPath OR pathname so the
          // visual feedback paints synchronously on click, even though
          // the new page render is in a transition.
          const active = pathname.startsWith(path) || pendingPath === path
          // Only non-active feature tabs can show unread dot — opening
          // the tab marks-viewed, and the account tab has no data.
          const showDot = !active && feature !== null && badges[feature]
          return (
            <button
              key={path}
              onClick={() => handleTabClick(path)}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex-1 flex flex-col items-center justify-center gap-[3px] p-0 border-none bg-transparent cursor-pointer transition-colors',
                'focus-visible:outline-2 focus-visible:outline-accent',
                active ? 'text-accent' : 'text-[#B8B4AE] hover:text-ink',
              ].join(' ')}
            >
              <div className={[
                'relative w-10 h-[26px] rounded-[13px] flex items-center justify-center transition-colors',
                active ? 'bg-accent-pale' : 'bg-transparent',
              ].join(' ')}>
                <Icon size={17} strokeWidth={active ? 2.2 : 1.6} />
                {showDot && (
                  <span
                    aria-label="未読の更新があります"
                    className="absolute top-[1px] right-[7px] w-[7px] h-[7px] rounded-full bg-danger border-2 border-[#FDFAF5]"
                  />
                )}
              </div>
              <span className={[
                'text-[9.5px] tracking-[0.04em]',
                active ? 'font-semibold' : 'font-normal',
              ].join(' ')}>
                {label}
              </span>
            </button>
          )
        })}
      </nav>

      {/* PWA prompts: scoped to AppLayout so they only appear on routes
          that have a bottom nav. Standalone routes (invite redeem,
          past lodging, social circle) keep their canvas clean for
          their transactional flow. Both banners read --nav-h from the
          parent <div> to position themselves above the nav. */}
      <PwaUpdatePrompt />
      <PwaInstallPrompt />
    </div>
  )
}
