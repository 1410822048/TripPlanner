// src/routes/pages.ts
// All lazy-loaded page components in one place. Separated from routes/index
// so that file only exports the `router` data object — satisfies the
// react-refresh/only-export-components rule which complains when a module
// mixes component and non-component exports.
import { lazy } from 'react'

export const BookingsPage = lazy(() => import('@/features/bookings/components/BookingsPage'))
export const JournalPage  = lazy(() => import('@/features/journal/components/JournalPage'))
export const PlanningPage = lazy(() => import('@/features/planning/components/PlanningPage'))
export const AccountPage  = lazy(() => import('@/features/account/components/AccountPage'))
