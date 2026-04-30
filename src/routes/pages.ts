// src/routes/pages.ts
// All lazy-loaded page components in one place. Separated from routes/index
// so that file only exports the `router` data object — satisfies the
// react-refresh/only-export-components rule which complains when a module
// mixes component and non-component exports.
import { lazy } from 'react'

// ExpensePage was eager early on because the original "core" tabs were
// Schedule + Expense. In practice users land on /schedule (the start_url)
// and most don't switch to /expense in their first session. Splitting it
// off shaves ~30 KB gz from the initial bundle without a visible delay
// when they do tap the tab — the chunk fetches in the background while
// the user is still on Schedule.
export const ExpensePage  = lazy(() => import('@/features/expense/components/ExpensePage'))
export const BookingsPage = lazy(() => import('@/features/bookings/components/BookingsPage'))
export const WishPage     = lazy(() => import('@/features/wish/components/WishPage'))
export const PlanningPage = lazy(() => import('@/features/planning/components/PlanningPage'))
export const AccountPage  = lazy(() => import('@/features/account/components/AccountPage'))
