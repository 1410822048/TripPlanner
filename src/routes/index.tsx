// src/routes/index.tsx
// SchedulePage is the only eager-loaded tab — it's the start_url and the
// landing page after sign-in, so loading it on demand would always cost
// the user a Suspense flash on first paint. Every other tab (Expense,
// Bookings, Wish, Planning, Account) is lazy; each is a separate chunk
// fetched on first navigation and shares the Suspense fallback in AppLayout.
// Standalone top-level routes (invite / past-lodging / social-circle) are
// lazy too: they are deep-link flows, not /schedule first-paint requirements.
//
// Error handling: each standalone route wraps its component in an
// ErrorBoundary with a route-scoped fallback. A crash inside one page (bad
// Firestore doc, thrown in a hook, etc.) then shows a recoverable screen
// instead of unmounting the whole app. AppLayout and its tabs use
// `errorElement` instead: React Router's data router puts its OWN boundary
// around every route, so the App-level ErrorBoundary never sees their
// throws (they used to land on RR's default English error screen).
import { Suspense, type ReactNode } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'
import ErrorBoundary from '@/components/ErrorBoundary'
import PageLoadingSkeleton from '@/components/ui/PageLoadingSkeleton'
import RouteErrorFallback from './RouteErrorFallback'
import RouteErrorElement from './RouteErrorElement'
import SchedulePage from '@/features/schedule/components/SchedulePage'
import {
  ExpensePage,
  BookingsPage,
  WishPage,
  PlanningPage,
  AccountPage,
  InvitePage,
  PastLodgingPage,
  SocialCirclePage,
} from './pages'

function withBoundary(node: ReactNode): ReactNode {
  return (
    <ErrorBoundary fallback={(error, reset) => <RouteErrorFallback error={error} reset={reset} />}>
      <Suspense fallback={<PageLoadingSkeleton />}>
        {node}
      </Suspense>
    </ErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteErrorElement />,
    children: [
      { index: true,      element: <Navigate to="/schedule" replace /> },
      { path: 'schedule', element: <SchedulePage />, errorElement: <RouteErrorElement /> },
      { path: 'expense',  element: <ExpensePage  />, errorElement: <RouteErrorElement /> },
      { path: 'bookings', element: <BookingsPage />, errorElement: <RouteErrorElement /> },
      { path: 'wish',     element: <WishPage     />, errorElement: <RouteErrorElement /> },
      { path: 'planning', element: <PlanningPage />, errorElement: <RouteErrorElement /> },
      { path: 'account',  element: <AccountPage  />, errorElement: <RouteErrorElement /> },
    ],
  },
  // Token lives in the URL fragment (`#`), not the path, so it never enters
  // the HTTP request line → no server / CDN / referrer logs capture it.
  { path: '/invite/:tripId', element: withBoundary(<InvitePage />) },
  { path: '/past-lodging',   element: withBoundary(<PastLodgingPage />) },
  { path: '/social-circle',  element: withBoundary(<SocialCirclePage />) },
])
