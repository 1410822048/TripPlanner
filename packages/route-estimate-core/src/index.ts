// Single source of truth for the display-only transit estimate shared by
// the React timeline and the route Worker. Callers own the distance source:
// the timeline uses a cheap local approximation, while the Worker uses ORS
// walking-network distance. Keeping only the pure range math here prevents
// the constants and rounding policy from drifting across those runtimes.

export interface TransitEstimateRange {
  minMinutes: number
  maxMinutes: number
}

export const WALKING_DIRECT_THRESHOLD_MINUTES = 15

const TRANSIT_WAIT_MINUTES = 5
const TRANSIT_REFERENCE_SPEED_KMH = 40
const TRANSIT_RANGE_STEP_MINUTES = 5

export function estimateTransitRange(distanceMeters: number): TransitEstimateRange {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error('route distance must be a finite non-negative number')
  }

  const centralMinutes = TRANSIT_WAIT_MINUTES
    + (distanceMeters / 1000 / TRANSIT_REFERENCE_SPEED_KMH) * 60
  const minMinutes = Math.max(
    10,
    Math.round((centralMinutes * 0.85) / TRANSIT_RANGE_STEP_MINUTES) * TRANSIT_RANGE_STEP_MINUTES,
  )
  const maxMinutes = Math.max(
    minMinutes + TRANSIT_RANGE_STEP_MINUTES,
    Math.ceil((centralMinutes * 1.3) / TRANSIT_RANGE_STEP_MINUTES) * TRANSIT_RANGE_STEP_MINUTES,
  )
  return { minMinutes, maxMinutes }
}
