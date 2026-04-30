// src/App.tsx
import { useState } from 'react'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from '@/routes'
import ErrorBoundary from '@/components/ErrorBoundary'
import PwaUpdatePrompt from '@/components/PwaUpdatePrompt'
import Splash from '@/components/Splash'
import Toaster from '@/shared/Toaster'
import { initAuth } from '@/hooks/useAuth'

// Kick the auth observer off before React mounts so the SDK chunk downloads
// during splash. By the time SchedulePage renders, onAuthStateChanged has
// usually already fired — eliminating the demo-data flash on cold load, and
// making the first sign-in tap skip a bundle download round-trip.
void initAuth()

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:  1000 * 60 * 5,   // 5 min
      gcTime:     1000 * 60 * 30,  // 30 min
      retry:      2,
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  const [splashDone, setSplashDone] = useState(false)
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
        <Toaster />
        <PwaUpdatePrompt />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
