import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  isDemo:         false,
  roleCanWrite:   true,
  roleIsOwner:    true,
  updateRequired: false,
}))

vi.mock('./useAuth', () => ({ useUid: () => 'uid-1' }))
vi.mock('./useTripContext', () => ({
  useTripContext: () => harness.isDemo
    ? { status: 'demo',  trip: { id: 'demo-trip' } }
    : { status: 'cloud', trip: { id: 'trip-1' } },
}))
vi.mock('@/features/trips/hooks/useTripRole', () => ({
  useCanWrite:    () => harness.roleCanWrite,
  useIsTripOwner: () => harness.roleIsOwner,
}))
vi.mock('./useClientCompatibility', () => ({
  useClientCompatibility: () => ({ updateRequired: harness.updateRequired }),
}))

import { useFeatureListPage } from './useFeatureListPage'

const gates = () => renderHook(() => useFeatureListPage<{ id: string }>()).result.current

beforeEach(() => {
  harness.isDemo         = false
  harness.roleCanWrite   = true
  harness.roleIsOwner    = true
  harness.updateRequired = false
})

describe('useFeatureListPage write gates', () => {
  // The (role, epoch) truth table. `roleCanWrite` is exposed unfolded so a
  // blocked state can be worded by its true cause: a viewer stays a viewer
  // after updating, so the role must always be blamed before the epoch.
  it('grants every gate to a compatible owner', () => {
    const { canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible } = gates()

    expect({ canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible }).toEqual({
      canWrite: true, roleCanWrite: true, isOwner: true, canOwnerWrite: true, writeCompatible: true,
    })
  })

  it('closes the write gates but preserves role and ownership identity when out of date', () => {
    harness.updateRequired = true

    const { canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible } = gates()

    // `isOwner` and `roleCanWrite` MUST stay true: identity drives lock
    // overrides and readonly redirects, and the unfolded role is what lets
    // the empty states say "update the app" instead of "you are a viewer".
    expect({ canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible }).toEqual({
      canWrite: false, roleCanWrite: true, isOwner: true, canOwnerWrite: false, writeCompatible: false,
    })
  })

  it('keeps role and epoch distinguishable so a page can word the right message', () => {
    harness.roleCanWrite = false
    harness.roleIsOwner  = false

    const { canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible } = gates()

    // Viewer on an up-to-date bundle: gates closed, but not because of the app
    // version — a page must be able to tell these two apart.
    expect({ canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible }).toEqual({
      canWrite: false, roleCanWrite: false, isOwner: false, canOwnerWrite: false, writeCompatible: true,
    })
  })

  it('reports the role as the blocker for a viewer whose bundle is ALSO stale', () => {
    harness.roleCanWrite   = false
    harness.roleIsOwner    = false
    harness.updateRequired = true

    const { canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible } = gates()

    // Both blockers at once: roleCanWrite=false is what the empty states key
    // on, so this viewer is never promised that updating will let them add.
    expect({ canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible }).toEqual({
      canWrite: false, roleCanWrite: false, isOwner: false, canOwnerWrite: false, writeCompatible: false,
    })
  })

  it('leaves demo affordances open so the sign-in prompt stays reachable', () => {
    harness.isDemo         = true
    harness.updateRequired = true

    const { canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible } = gates()

    // Demo writes never reach Firestore; gating them would only break the
    // sign-in CTA that every demo affordance exists to trigger.
    expect({ canWrite, roleCanWrite, isOwner, canOwnerWrite, writeCompatible }).toEqual({
      canWrite: true, roleCanWrite: true, isOwner: true, canOwnerWrite: true, writeCompatible: true,
    })
  })
})
