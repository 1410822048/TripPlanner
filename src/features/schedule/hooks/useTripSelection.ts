// src/features/schedule/hooks/useTripSelection.ts
// Demo 模式下的 trips 清單選取 + CRUD + 排序邏輯。
// 狀態來自 useDemoTripStore（僅記憶體，不持久化）。登入後路徑會切到 useMyTrips。
import { useDemoTripStore, useSelectedDemoTrip } from '@/store/demoTripStore'
import type { TripItem } from '../types'

export interface UseTripSelectionResult {
  trips:          TripItem[]
  selectedTrip:   TripItem
  selectedTripId: string
  selectTrip:  (trip: TripItem) => void
  saveTrip:    (data: TripItem) => void
  deleteTrip:  (tripId: string) => void
  reorderTrips:(fromIdx: number, toIdx: number) => void
}

export function useTripSelection(
  onTripChanged?: () => void,
): UseTripSelectionResult {
  const trips          = useDemoTripStore(s => s.trips)
  const selectedTripId = useDemoTripStore(s => s.selectedTripId)
  const setTrips          = useDemoTripStore(s => s.setTrips)
  const setSelectedTripId = useDemoTripStore(s => s.setSelectedTripId)

  // Selection fallbacks handled inside useSelectedDemoTrip (initial seed
  // guards against an empty `trips`). The store's UI contract keeps at
  // least one entry via TripSwitcher's delete guard, so the fallback path
  // is defensive.
  const selectedTrip = useSelectedDemoTrip()

  function selectTrip(trip: TripItem) {
    setSelectedTripId(trip.id)
    onTripChanged?.()
  }

  function saveTrip(data: TripItem) {
    setTrips(prev => prev.map(t => t.id === data.id ? data : t))
    // 日期範圍可能變動 → 相依 state 需重置
    onTripChanged?.()
  }

  function deleteTrip(deletedId: string) {
    const next = trips.filter(t => t.id !== deletedId)
    setTrips(next)
    if (deletedId === selectedTripId && next[0]) {
      setSelectedTripId(next[0].id)
    }
    onTripChanged?.()
  }

  function reorderTrips(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    setTrips(prev => {
      const next = [...prev]
      const moved = next.splice(fromIdx, 1)[0]
      if (!moved) return prev
      next.splice(toIdx, 0, moved)
      return next
    })
  }

  return { trips, selectedTrip, selectedTripId, selectTrip, saveTrip, deleteTrip, reorderTrips }
}
