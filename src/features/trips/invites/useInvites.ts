// src/features/trips/invites/useInvites.ts
// TanStack Query wrappers for invite lifecycle. Pattern matches useTrips:
// optimistic cache updates on create/revoke, invalidate-on-error, toast on
// failure. acceptInvite additionally invalidates useMyTrips so the newly-
// joined trip shows up in the switcher immediately.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { User } from 'firebase/auth'
import {
  createInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
  type AcceptOutcome,
} from './inviteService'
import { tripKeys } from '@/features/trips/hooks/useTrips'
import { toast } from '@/shared/toast'
import type { Invite, Trip } from '@/types'

export const inviteKeys = {
  ofTrip: (tripId: string) => ['invites', tripId] as const,
}

/** Owner-only: list every invite (active + expired) for a trip. */
export function useInvites(tripId: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: inviteKeys.ofTrip(tripId ?? ''),
    queryFn:  () => listInvites(tripId!),
    enabled:  !!tripId && enabled,
  })
}

export function useCreateInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ trip, role, user }: {
      trip: Trip
      role: 'editor' | 'viewer'
      user: User
    }) => createInvite(trip, role, user),
    onSuccess: (invite) => {
      // Replace (not prepend) the cache: the service atomically deletes old
      // invites when creating a new one, so after success there should be
      // exactly one invite in the list — the one we just made.
      qc.setQueryData<Invite[]>(inviteKeys.ofTrip(invite.tripId), [invite])
    },
    onError: (err) => {
      toast.error(err instanceof Error ? `邀請連結作成失敗：${err.message}` : '邀請連結作成失敗')
    },
  })
}

export function useRevokeInvite(tripId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => revokeInvite(tripId!, token),
    onMutate: (token) => {
      if (!tripId) return { prev: undefined as Invite[] | undefined }
      const key  = inviteKeys.ofTrip(tripId)
      const prev = qc.getQueryData<Invite[]>(key)
      if (prev) qc.setQueryData<Invite[]>(key, prev.filter(i => i.id !== token))
      return { prev }
    },
    onError: (err, _token, ctx) => {
      if (tripId && ctx?.prev !== undefined) qc.setQueryData(inviteKeys.ofTrip(tripId), ctx.prev)
      toast.error(err instanceof Error ? `取り消しに失敗：${err.message}` : '取り消しに失敗しました')
    },
  })
}

/**
 * Redeem an invite. On success, invalidates the signed-in user's trip list
 * so the newly-joined trip appears in the switcher. Caller (InvitePage)
 * awaits this, then navigates to /schedule.
 */
export function useAcceptInvite() {
  const qc = useQueryClient()
  return useMutation<
    AcceptOutcome,
    Error,
    { tripId: string; token: string; user: User }
  >({
    mutationFn: ({ tripId, token, user }) => acceptInvite(tripId, token, user),
    onSuccess: (_outcome, { user }) => {
      qc.invalidateQueries({ queryKey: tripKeys.mine(user.uid) })
    },
  })
}
