// src/routes/index.tsx
// SchedulePage is the only eager-loaded tab — it's the start_url and the
// landing page after sign-in, so loading it on demand would always cost
// the user a Suspense flash on first paint. Every other tab (Expense,
// Bookings, Wish, Planning, Account) is lazy; each is a separate chunk
// fetched on first navigation and shares the Suspense fallback in AppLayout.
// The three standalone top-level routes (invite / past-lodging / social-
// circle) are eager: they're small (<5KB gz each) and eager-loading lets us
// drop the Suspense + fallback wrappers that would otherwise be triplicated
// around each, with no user-visible loading flash.
//
// Error handling: each standalone route wraps its component in an
// ErrorBoundary with a route-scoped fallback. A crash inside one page (bad
// Firestore doc, thrown in a hook, etc.) then shows a recoverable screen
// instead of unmounting the whole app. AppLayout's children share the root
// ErrorBoundary from App.tsx, so don't need per-route wrappers.
import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'
import ErrorBoundary from '@/components/ErrorBoundary'
import RouteErrorFallback from './RouteErrorFallback'
import SchedulePage from '@/features/schedule/components/SchedulePage'
import InvitePage       from '@/features/trips/invites/InvitePage'
import PastLodgingPage  from '@/features/bookings/components/PastLodgingPage'
import SocialCirclePage from '@/features/members/components/SocialCirclePage'
import { ExpensePage, BookingsPage, WishPage, PlanningPage, AccountPage } from './pages'

function withBoundary(node: ReactNode): ReactNode {
  return (
    <ErrorBoundary fallback={(error, reset) => <RouteErrorFallback error={error} reset={reset} />}>
      {node}
    </ErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true,      element: <Navigate to="/schedule" replace /> },
      { path: 'schedule', element: <SchedulePage /> },
      { path: 'expense',  element: <ExpensePage  /> },
      { path: 'bookings', element: <BookingsPage /> },
      { path: 'wish',     element: <WishPage     /> },
      { path: 'planning', element: <PlanningPage /> },
      { path: 'account',  element: <AccountPage  /> },
    ],
  },
  // Token lives in the URL fragment (`#`), not the path, so it never enters
  // the HTTP request line → no server / CDN / referrer logs capture it.
  { path: '/invite/:tripId', element: withBoundary(<InvitePage />) },
  { path: '/past-lodging',   element: withBoundary(<PastLodgingPage />) },
  { path: '/social-circle',  element: withBoundary(<SocialCirclePage />) },
])
