// src/App.tsx
// Note: PwaUpdatePrompt + PwaInstallPrompt are rendered INSIDE AppLayout,
// not here. Standalone routes (/invite/:tripId, /past-lodging, etc.)
// don't have a bottom nav, so the banner's bottom-anchored layout has
// no nav to clear; rendering them at app-root would float them awkwardly
// in those pages. Scoping them to AppLayout also lets nav height live
// in one place via a CSS variable, no cross-tree DOM hacks.
import { useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/services/queryClient'
import { router } from '@/routes'
import ErrorBoundary from '@/components/ErrorBoundary'
import Splash from '@/components/Splash'
import Toaster from '@/shared/Toaster'
import PerfStrip from '@/components/ui/PerfStrip'

/**
 * Force every fresh session to land on /schedule, regardless of which page
 * the user was on when they last closed the app. PWA manifests can't
 * control this on resume — iOS specifically restores the last-visited URL
 * over the manifest's `start_url`. We use a sessionStorage flag instead:
 *   • Empty flag → fresh launch (PWA cold start, new browser tab) →
 *     replaceState to /schedule unless the URL is a deep link
 *     (/invite/..., /past-lodging, /social-circle) which carries
 *     transactional intent that mustn't be lost.
 *   • Flag set   → in-session reload or in-app navigation → leave the URL
 *     alone so refresh-on-/account stays on /account.
 *
 * Runs synchronously at module load (before RouterProvider mounts), so
 * RouterProvider sees the corrected URL from its first render — no flash
 * of the previous page.
 */
;(() => {
  const KEY = 'tripmate-session-init'
  if (sessionStorage.getItem(KEY)) return
  sessionStorage.setItem(KEY, '1')

  const path = window.location.pathname
  const isDeepLink =
    path.startsWith('/invite/') ||
    path === '/past-lodging' ||
    path === '/social-circle'
  if (isDeepLink) return
  if (path === '/schedule' || path === '/') return

  // Replace (not push) so the back button doesn't leak the previous URL.
  window.history.replaceState(null, '', '/schedule')
})()

export default function App() {
  const [splashDone, setSplashDone] = useState(false)
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
        <Toaster />
        <PerfStrip />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
