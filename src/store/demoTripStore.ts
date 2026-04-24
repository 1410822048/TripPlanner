// src/store/demoTripStore.ts
// Demo 模式下的本地 trips 清單 + 選取狀態（signed-out 或尚無雲端行程時）。
// 當使用者登入並建立雲端 trip 後，SchedulePage 會切到 useTripStore / useMyTrips。
import { create } from 'zustand'
import type { TripItem } from '@/features/schedule/types'
import { INITIAL_TRIPS } from '@/features/schedule/mocks'

interface DemoTripStore {
  trips:          TripItem[]
  selectedTripId: string
  setTrips:          (updater: TripItem[] | ((prev: TripItem[]) => TripItem[])) => void
  setSelectedTripId: (id: string) => void
}

// INITIAL_TRIPS is a non-empty constant (see schedule/mocks.ts). Assert once
// here rather than scattering `!` at every call site — any future mock-data
// refactor that accidentally empties the list will fail loudly on module
// import, not silently at the first store read.
const FIRST_INITIAL_TRIP: TripItem = (() => {
  const first = INITIAL_TRIPS[0]
  if (!first) throw new Error('demoTripStore: INITIAL_TRIPS must not be empty')
  return first
})()

export const useDemoTripStore = create<DemoTripStore>((set) => ({
  trips:          INITIAL_TRIPS,
  selectedTripId: FIRST_INITIAL_TRIP.id,
  setTrips: (updater) =>
    set((s) => ({
      trips: typeof updater === 'function' ? updater(s.trips) : updater,
    })),
  setSelectedTripId: (id) => set({ selectedTripId: id }),
}))

/**
 * Read the currently selected demo trip. Fallbacks:
 *   1. Selected id matches a current entry → that entry.
 *   2. Otherwise the first entry, if the store still holds any.
 *   3. Otherwise the initial seed, because the UI contract assumes a trip
 *      always exists in demo mode.
 */
export function useSelectedDemoTrip(): TripItem {
  const trips = useDemoTripStore(s => s.trips)
  const id    = useDemoTripStore(s => s.selectedTripId)
  return trips.find(t => t.id === id) ?? trips[0] ?? FIRST_INITIAL_TRIP
}
