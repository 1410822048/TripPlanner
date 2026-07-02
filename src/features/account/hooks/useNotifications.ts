// src/features/account/hooks/useNotifications.ts
// User-scoped, access-aware realtime inbox. Unlike trip-scoped entity
// hooks, this may need multiple Firestore `in` queries when a user has
// more than 30 accessible trips, so it uses a dedicated hook instead of
// createRealtimeListHook's single-query factory.
import { useEffect } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  getNotifications,
  notificationTripIdsFromKey,
  notificationTripIdsKey,
  subscribeToNotifications,
} from '../services/notificationService'
import { captureError } from '@/services/sentry'
import type { Notification } from '@/types'

const notificationKeys = {
  all: (uid: string, tripIdsKey: string) => ['notifications', uid, tripIdsKey] as const,
}

export function useNotifications(
  uid: string | undefined,
  accessibleTripIds: readonly string[] | undefined,
): UseQueryResult<Notification[]> {
  const qc = useQueryClient()
  const tripIdsReady = accessibleTripIds !== undefined
  const tripIdsKey = notificationTripIdsKey(accessibleTripIds ?? [])

  const result = useQuery<Notification[]>({
    queryKey:  notificationKeys.all(uid ?? '', tripIdsKey),
    queryFn:   () => uid ? getNotifications(uid, notificationTripIdsFromKey(tripIdsKey)) : Promise.resolve([]),
    enabled:   !!uid && tripIdsReady,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (!uid || !tripIdsReady) return
    let mounted = true
    let unsub: (() => void) | undefined
    const keyTripIds = notificationTripIdsFromKey(tripIdsKey)

    void subscribeToNotifications(
      uid,
      keyTripIds,
      data => {
        if (mounted) qc.setQueryData<Notification[]>(notificationKeys.all(uid, tripIdsKey), data)
      },
      err => captureError(err, { source: 'useNotifications', uid }),
    ).then(u => {
      if (mounted) unsub = u
      else u()
    }).catch(e => {
      captureError(e, { source: 'useNotifications/subscribe-init', uid })
    })

    return () => {
      mounted = false
      unsub?.()
    }
  }, [uid, tripIdsReady, tripIdsKey, qc])

  return result
}
