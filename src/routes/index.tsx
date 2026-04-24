// src/routes/index.tsx
// Core routes (Schedule, Expense) are eager — they're on the initial-render
// path and prefetch races caused first-click delay in testing. The four
// placeholder / tab pages (Bookings / Journal / Planning / Account) stay
// lazy and share the single Suspense fallback that lives inside AppLayout.
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
import ExpensePage  from '@/features/expense/components/ExpensePage'
import InvitePage       from '@/features/schedule/components/InvitePage'
import PastLodgingPage  from '@/features/bookings/components/PastLodgingPage'
import SocialCirclePage from '@/features/members/components/SocialCirclePage'
import { BookingsPage, JournalPage, PlanningPage, AccountPage } from './pages'

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
      { path: 'journal',  element: <JournalPage  /> },
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
