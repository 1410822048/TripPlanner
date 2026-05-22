// src/components/PwaUpdatePrompt.tsx
// Banner shown when the service worker has a new version waiting.
// Clicking "更新" activates the new SW and reloads. The banner is
// dismissible so users mid-task can defer until they're ready.
//
// Integrates with vite-plugin-pwa's `registerType: 'prompt'` mode —
// without that mode the SW auto-updates silently and this prompt
// never fires.
//
// Update-detection triggers (so the banner appears promptly without
// hammering the network):
//   - Initial registration → immediate `r.update()` — covers iOS PWA
//     cold launches, where the previous session was killed by the OS
//     and `visibilitychange` never fires on the way back
//   - visibilitychange → visible — user returns to tab / PWA from
//     background; near-zero latency for the common case
//   - pageshow (persisted) — fired on bfcache restore on iOS Safari
//     (back / forward nav), which doesn't trigger visibilitychange
//   - 3-minute interval (only fires when tab is visible, so background
//     tabs don't keep polling) — fallback for continuously-active
//     sessions that never blur
//
// We deliberately do NOT silent-reload (Linear-style) here. Earlier
// experiments showed too many edge cases that would need an entire
// state-persistence architecture to do safely (lost scroll / activeDate
// / mid-OCR uploads / mid-invite-flow). Banner-driven reload puts the
// user in control — they pick the moment, and we never yank their work.
import { useEffect, useRef } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { captureError } from '@/services/sentry'

const PERIODIC_CHECK_MS = 3 * 60_000   // 3 min

export default function PwaUpdatePrompt() {
  // Listeners + interval registered inside `onRegistered` need a
  // cleanup hook. In production the component is a top-level mount
  // that never unmounts, but HMR / test harnesses re-mount on every
  // hot reload and would otherwise accumulate intervals and
  // visibilitychange listeners (one set per HMR cycle). Hold the
  // teardown thunk in a ref and fire it from the unmount-cleanup
  // useEffect below.
  const teardownRef = useRef<() => void>(() => undefined)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      if (!r) return
      // Immediate check on boot — covers iOS PWA cold launches (when
      // the OS killed the previous session and there's no
      // visibilitychange to ride on). Cheap: if SW.js hasn't changed
      // this is a single HEAD request that gets short-circuited.
      void r.update()
      // Periodic fallback check — gated by visibility so background
      // tabs don't keep waking the network.
      const intervalId = window.setInterval(() => {
        if (document.visibilityState === 'visible') void r.update()
      }, PERIODIC_CHECK_MS)
      // Re-check whenever the tab becomes visible — covers the common
      // "user switched apps, deploy happened, user comes back" case
      // with near-zero latency.
      const onVisibility = () => {
        if (document.visibilityState === 'visible') void r.update()
      }
      document.addEventListener('visibilitychange', onVisibility)
      // bfcache restore (iOS Safari back/forward) — doesn't trigger
      // visibilitychange but the page state is effectively fresh from
      // the user's perspective. `persisted=true` filters out the
      // first-load case where pageshow fires alongside DOMContentLoaded.
      const onPageShow = (e: PageTransitionEvent) => {
        if (e.persisted) void r.update()
      }
      window.addEventListener('pageshow', onPageShow)

      // Single composite teardown. Picked up by the useEffect cleanup
      // below; safe to call multiple times (clearInterval / remove
      // event listener are no-ops on already-cleared / unregistered).
      teardownRef.current = () => {
        clearInterval(intervalId)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pageshow', onPageShow)
      }
    },
    onRegisterError(error) {
      // Non-fatal: if SW registration fails (first visit without SW
      // support, dev mode quirks), the app still works — we just lose
      // PWA features. Forward to Sentry so unexpected SW failures (e.g.
      // CSP regressions breaking Workbox) surface in monitoring instead
      // of silent loss of the offline experience.
      captureError(error, { source: 'pwa-sw-register' })
    },
  })

  // Run teardown on unmount. Empty dep array because teardownRef
  // value is stable across renders (set once inside onRegistered).
  useEffect(() => () => teardownRef.current(), [])

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 z-[300] w-[min(94vw,400px)] bg-surface border border-border rounded-[18px] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.15)] flex items-center gap-3"
      // Sit 12px above the nav's top edge. The nav already spans the
      // viewport's bottom var(--nav-h) — including the iOS home-indicator
      // safe area on standalone PWAs — so layering an extra
      // env(safe-area-inset-bottom) here would double-count that space
      // and push the banner ~34px higher than the user expects on iPhone.
      style={{ bottom: 'calc(var(--nav-h) + 12px)' }}
    >
      <div className="w-9 h-9 rounded-full bg-accent-pale shrink-0 flex items-center justify-center text-accent">
        <RefreshCw size={16} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-bold text-ink tracking-[0.02em]">
          新しいバージョンがあります
        </div>
        <div className="text-[10.5px] text-muted mt-0.5">
          再読み込みでアップデートします
        </div>
      </div>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="あとで"
        className="w-8 h-8 rounded-full text-muted hover:bg-app transition-colors flex items-center justify-center cursor-pointer shrink-0"
      >
        <X size={14} strokeWidth={2} />
      </button>
      <button
        onClick={() => { void updateServiceWorker(true) }}
        className="shrink-0 h-8 px-3 rounded-full bg-accent text-white text-[11.5px] font-bold tracking-[0.04em] border-none cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all"
        style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
      >
        更新
      </button>
    </div>
  )
}
