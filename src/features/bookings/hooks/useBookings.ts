// src/features/bookings/hooks/useBookings.ts
// Mirrors the optimistic-update pattern from useExpenses / useSchedules:
//   - onMutate patches the cache immediately
//   - onError rolls back to the snapshot
//   - onSettled invalidates so the server's authoritative state replaces
//     any temp-id row
// Attachment uploads are awaited inside the mutationFn — the optimistic
// patch can't render the URL anyway (the file is local), so we keep the
// optimistic row attachment-less and let the invalidation refetch surface
// the final URL.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getBookingsByTrip,
  createBooking,
  updateBooking,
  deleteBooking,
} from '../services/bookingService'
import type { Booking, CreateBookingInput } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const bookingKeys = {
  all: (tripId: string) => ['bookings', tripId] as const,
}

function tempId() { return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

function patchCache(
  qc: ReturnType<typeof useQueryClient>,
  tripId: string,
  fn: (prev: Booking[]) => Booking[],
): { prev: Booking[] | undefined } {
  const key  = bookingKeys.all(tripId)
  const prev = qc.getQueryData<Booking[]>(key)
  qc.setQueryData<Booking[]>(key, fn(prev ?? []))
  return { prev }
}

export function useBookings(tripId: string | undefined) {
  return useQuery({
    queryKey: bookingKeys.all(tripId ?? ''),
    queryFn:  () => getBookingsByTrip(tripId!),
    enabled:  !!tripId,
  })
}

export function useCreateBooking(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, file }: { input: CreateBookingInput; file: File | null }) =>
      createBooking(tripId, input, file),
    onMutate: ({ input }) =>
      patchCache(qc, tripId, prev => {
        const optimistic: Booking = {
          id:        tempId(),
          tripId,
          createdAt: MOCK_TIMESTAMP,
          ...input,
        }
        return [optimistic, ...prev]
      }),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(bookingKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `予約の追加に失敗：${err.message}` : '予約の追加に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: bookingKeys.all(tripId) }),
  })
}

export function useUpdateBooking(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      bookingId, updates, attachment, existing,
    }: {
      bookingId:  string
      updates:    Partial<CreateBookingInput>
      attachment: File | null | undefined
      existing:   { filePath?: string; thumbPath?: string }
    }) => updateBooking(tripId, bookingId, updates, attachment, existing),
    onMutate: ({ bookingId, updates }) =>
      patchCache(qc, tripId, prev =>
        prev.map(b => b.id === bookingId ? { ...b, ...updates } : b),
      ),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(bookingKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: bookingKeys.all(tripId) }),
  })
}

export function useDeleteBooking(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ bookingId, paths }: {
      bookingId: string
      paths:     { filePath?: string; thumbPath?: string }
    }) => deleteBooking(tripId, bookingId, paths),
    onMutate: ({ bookingId }) =>
      patchCache(qc, tripId, prev => prev.filter(b => b.id !== bookingId)),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(bookingKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: bookingKeys.all(tripId) }),
  })
}
