// src/hooks/useFeatureListPage.ts
// Common state plumbing shared by list-style feature pages
// (BookingsPage, ExpensePage, WishPage, PlanningPage). Each page
// previously hand-rolled the same five things:
//
//   const ctx = useTripContext()
//   const uid = useUid()
//   const modal = useFormModal<T>()
//   const [signInOpen, setSignInOpen] = useState(false)
//   const cloudTripId = ctx.status === 'cloud' ? ctx.trip.id : undefined
//   const mutationTripId = cloudTripId ?? ''
//
// This hook collapses that boilerplate. Pages still own their own
// list rendering, mutation handlers, and form modal — the abstraction
// is intentionally narrow so future divergent pages don't have to
// fight a one-size-fits-all shell.
import { useCallback, useState } from 'react'
import { useUid } from './useAuth'
import { useTripContext, type TripContext } from './useTripContext'
import { useFormModal, type UseFormModalResult } from './useFormModal'

interface Identifiable { id: string }

export interface FeatureListPageState<T extends Identifiable> {
  ctx: TripContext
  uid: string | undefined
  /** The trip id when the user is on a real cloud trip; undefined in
   *  loading / no-trip / demo. Pass to query hooks that should disable
   *  themselves outside cloud mode. */
  cloudTripId: string | undefined
  /** `cloudTripId ?? ''` — convenient for mutation hooks whose call
   *  sites are gated on isDemo before firing, so the empty string is
   *  never actually used. */
  mutationTripId: string
  isDemo: boolean
  modal: UseFormModalResult<T>
  signIn: {
    isOpen:  boolean
    open:    () => void
    close:   () => void
  }
}

export function useFeatureListPage<T extends Identifiable>(): FeatureListPageState<T> {
  const ctx = useTripContext()
  const uid = useUid()
  const modal = useFormModal<T>()
  const [signInOpen, setSignInOpen] = useState(false)

  const openSignIn  = useCallback(() => setSignInOpen(true), [])
  const closeSignIn = useCallback(() => setSignInOpen(false), [])

  const cloudTripId    = ctx.status === 'cloud' ? ctx.trip.id : undefined
  const mutationTripId = cloudTripId ?? ''
  const isDemo         = ctx.status === 'demo'

  return {
    ctx,
    uid,
    cloudTripId,
    mutationTripId,
    isDemo,
    modal,
    signIn: { isOpen: signInOpen, open: openSignIn, close: closeSignIn },
  }
}
