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
import { useState } from 'react'
import { useUid } from './useAuth'
import { useTripContext, type TripContext } from './useTripContext'
import { useFormModal, type UseFormModalResult } from './useFormModal'
import { useCanWrite, useIsTripOwner } from '@/features/trips/hooks/useTripRole'
import { useClientCompatibility } from './useClientCompatibility'

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
  /** Owner / editor — gates create / update / delete affordances on
   *  schedule / booking / expense pages (mirrors `canWrite` in
   *  firestore.rules). True in demo (no real ownership concept).
   *  Also folds in `writeCompatible`. */
  canWrite: boolean
  /** Role-only half of `canWrite`, with NO epoch folded in. Use it to
   *  word blocked states: a viewer stays a viewer after updating the
   *  app, so the role must be blamed before the epoch — otherwise a
   *  stale-bundle viewer is promised "update and you can add", which
   *  the update cannot deliver. */
  roleCanWrite: boolean
  /** Trip owner — PURE identity, never folded with `writeCompatible`.
   *  Read it for "is this person the owner" questions: lock overrides,
   *  readonly-redirect decisions, wording. Folding compatibility in here
   *  would make an owner stop being an owner mid-edit and tear down the
   *  form they were typing in. Mirrors `isTripOwner` in firestore.rules.
   *  True in demo. */
  isOwner: boolean
  /** `isOwner && writeCompatible` — use for owner-only WRITE affordances
   *  (invite link, trip metadata edit, settlement delete). */
  canOwnerWrite: boolean
  /** False when this bundle's schema epoch is below the deployed
   *  minimum — every write would be refused by the global mutation
   *  guard, so write affordances must not be offered. Kept separate
   *  from the role gates above so a page can still tell "you lack
   *  permission" apart from "your app is out of date" when wording a
   *  message. True in demo: demo writes never reach Firestore. */
  writeCompatible: boolean
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

  // Compiler memoises these — no manual useCallback needed.
  const openSignIn  = () => setSignInOpen(true)
  const closeSignIn = () => setSignInOpen(false)

  const cloudTripId    = ctx.status === 'cloud' ? ctx.trip.id : undefined
  const mutationTripId = cloudTripId ?? ''
  const isDemo         = ctx.status === 'demo'

  // Role gates baked into the abstraction so individual pages don't
  // each re-derive them (the duplicated `useCanWrite(cloudTripId, isDemo)`
  // / `currentTrip.ownerId === uid` patterns we previously had on every
  // list page).
  const roleCanWrite = useCanWrite(cloudTripId, isDemo)
  const roleIsOwner  = useIsTripOwner(cloudTripId, isDemo)

  // Schema compatibility is orthogonal to role, so the role hooks stay pure
  // and the two capabilities are composed here. Demo passes through: those
  // writes never reach Firestore, and gating them would break the sign-in CTA
  // that every demo affordance exists to trigger.
  const { updateRequired } = useClientCompatibility()
  const writeCompatible = isDemo || !updateRequired

  return {
    ctx,
    uid,
    cloudTripId,
    mutationTripId,
    isDemo,
    canWrite: roleCanWrite && writeCompatible,
    roleCanWrite,
    isOwner:  roleIsOwner,
    canOwnerWrite: roleIsOwner && writeCompatible,
    writeCompatible,
    modal,
    signIn: { isOpen: signInOpen, open: openSignIn, close: closeSignIn },
  }
}
