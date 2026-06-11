// src/features/trips/queryKeys.ts
// Pure TanStack Query key factory for the Trip aggregate. Extracted from
// useTrips.ts so non-trips modules (e.g. members hooks invalidating trip
// caches after owner-transfer) can import the keys WITHOUT pulling in the
// whole useTrips hook module — which itself imports members services, so a
// members→useTrips import would risk a cross-feature dependency cycle.
export const tripKeys = {
  mine:  (uid: string) => ['trips', 'mine', uid] as const,
  myIds: (uid: string) => ['trips', 'my-ids', uid] as const,
}
