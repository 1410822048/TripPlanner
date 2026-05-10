// src/layouts/AppLayout.tsx
import { Suspense } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CalendarDays, Ticket, Receipt, Heart, ListChecks, UserCircle } from 'lucide-react'
import LoadingText from '@/components/ui/LoadingText'
import PwaUpdatePrompt from '@/components/PwaUpdatePrompt'
import PwaInstallPrompt from '@/components/PwaInstallPrompt'
import { useCurrentTripSync } from '@/features/trips/hooks/useCurrentTripSync'
import { usePrefetchBookings } from '@/features/bookings/hooks/usePrefetchBookings'

// Single source of truth for the bottom-nav height. Used by:
//   - <main>'s `bottom` (so content doesn't scroll under the nav)
//   - <nav>'s `height`
//   - PWA banners' `bottom` offset (read via the --nav-h var below)
// Keeping it as one constant means changing the nav height (e.g. for
// a redesign) is a one-line edit; the previous setup hard-coded `h-16`
// in two places + a magic 64px in each banner.
const NAV_H = '4rem'

const TABS = [
  { path: '/schedule', label: '行程', Icon: CalendarDays },
  { path: '/bookings', label: '訂單', Icon: Ticket       },
  { path: '/expense',  label: '費用', Icon: Receipt      },
  { path: '/wish',     label: 'Wish', Icon: Heart        },
  { path: '/planning', label: '規劃', Icon: ListChecks  },
  { path: '/account',  label: '我的', Icon: UserCircle   },
] as const

export default function AppLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Trip rehydration runs at layout level so a hard reload landing on
  // /bookings, /expense, etc. picks the user's last trip without forcing
  // them through /schedule first. The hook is a no-op in demo mode.
  useCurrentTripSync()

  // Cache-warming: kicks off the bookings query as soon as a currentTrip is
  // known, in parallel with whatever page the user is on. When they
  // navigate to /bookings, the list resolves from cache — closes the
  // visible "header showing but list still loading" gap on cold load.
  usePrefetchBookings()

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
      <main
        className="absolute top-0 inset-x-0 overflow-y-auto overflow-x-hidden bg-app"
        style={{ bottom: 'var(--nav-h)' }}
      >
        <Suspense fallback={
          <div className="flex items-center justify-center h-full text-muted text-[13px]">
            <LoadingText />
          </div>
        }>
          <Outlet />
        </Suspense>
      </main>

      <nav
        aria-label="主要ナビゲーション"
        className="absolute bottom-0 inset-x-0 flex items-center border-t border-border/60 px-1 z-10"
        style={{
          height: 'var(--nav-h)',
          background: 'rgba(253,250,245,0.94)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
        }}
      >
        {TABS.map(({ path, label, Icon }) => {
          const active = pathname.startsWith(path)
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex-1 h-full flex flex-col items-center justify-center gap-[3px] p-0 border-none bg-transparent cursor-pointer transition-colors',
                'focus-visible:outline-2 focus-visible:outline-accent',
                active ? 'text-accent' : 'text-[#B8B4AE] hover:text-ink',
              ].join(' ')}
            >
              <div className={[
                'w-10 h-[26px] rounded-[13px] flex items-center justify-center transition-colors',
                active ? 'bg-accent-pale' : 'bg-transparent',
              ].join(' ')}>
                <Icon size={17} strokeWidth={active ? 2.2 : 1.6} />
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
