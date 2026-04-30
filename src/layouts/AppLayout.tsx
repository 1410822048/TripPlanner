// src/layouts/AppLayout.tsx
import { Suspense } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { CalendarDays, Ticket, Receipt, Heart, ListChecks, UserCircle } from 'lucide-react'
import LoadingText from '@/components/ui/LoadingText'
import { useCurrentTripSync } from '@/features/trips/hooks/useCurrentTripSync'
import { usePrefetchBookings } from '@/features/bookings/hooks/usePrefetchBookings'

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
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app">
      <main className="absolute top-0 bottom-16 inset-x-0 overflow-y-auto overflow-x-hidden bg-app">
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
        className="absolute bottom-0 inset-x-0 h-16 flex items-center border-t border-border/60 px-1 z-10"
        style={{
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
    </div>
  )
}
