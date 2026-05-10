// src/utils/tempId.ts
// Stable client-side id for optimistic mutation rows. Used in onMutate to
// stamp rows the server hasn't acknowledged yet, so React's reconciler
// has a key while the real id is still in flight. Once the realtime
// snapshot listener delivers the server-issued doc, the optimistic row
// is replaced (the temp id never makes it back to Firestore).
//
// Format: `temp-{ms}-{rand}` — sortable by creation time within a session
// and easy to spot in DevTools when debugging. Collision odds are
// vanishingly small for the use-case (only competes against
// other temp rows in the same render).
export const tempId = (): string =>
  `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
