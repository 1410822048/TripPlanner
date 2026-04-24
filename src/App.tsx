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
