// Single source of truth for travel-time estimates and schedule feasibility,
// shared by the React timeline, the route preview and the route Worker.
//
// Callers own the measurements: the timeline uses a cheap straight-line
// approximation, the Worker uses ORS walking-network data. Persisted data
// (Schedule.travelToNext) stores only those measurements; every derived
// value — the segment class, the transit range, the feasibility verdict —
// is computed here at read time, so changing a constant re-evaluates every
// stored route without re-optimizing it.

export interface TransitEstimateRange {
  minMinutes: number
  maxMinutes: number
}

export interface Coordinate {
  lat: number
  lng: number
}

/** Walking at or under this is shown as walking only. */
export const WALKING_DIRECT_THRESHOLD_MINUTES = 15
/** Walking up to this is ambiguous: both walking and transit are shown. */
export const EITHER_MAX_WALKING_MINUTES = 30
/** Straight-line distance beyond which no number is offered. Straight line,
 * not walking network: a route's class must not flip when ORS detours. */
export const LONG_DISTANCE_STRAIGHT_METERS = 80_000
/** Worst-case slack below this marks an arrival as tight. */
export const TIGHT_SLACK_MINUTES = 10

// Door-to-door transit: walk to the station + wait + walk out, then urban
// rail/bus for the first 10 km and express rail beyond it. Calibrated
// against 13 reference routes in Tokyo / Kyoto / Osaka (calibration.test.ts):
// every reference falls inside the range; the documented misses are
// station-to-station hops, Kyoto city buses and JR Special Rapid corridors.
const TRANSIT_ACCESS_MINUTES = 10
const TRANSIT_URBAN_SPAN_METERS = 10_000
const TRANSIT_URBAN_MINUTES_PER_KM = 2.4
const TRANSIT_EXPRESS_MINUTES_PER_KM = 0.6
const TRANSIT_RANGE_LOW_FACTOR = 0.8
const TRANSIT_RANGE_HIGH_FACTOR = 1.25
const TRANSIT_RANGE_STEP_MINUTES = 5
const TRANSIT_MIN_MINUTES = 10

const EARTH_RADIUS_METERS = 6_371_000

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`)
  }
}

/** Door-to-door transit range for a walking-network distance. */
export function estimateTransitRange(walkingDistanceMeters: number): TransitEstimateRange {
  assertNonNegative(walkingDistanceMeters, 'route distance')

  const urbanKm = Math.min(walkingDistanceMeters, TRANSIT_URBAN_SPAN_METERS) / 1000
  const expressKm = Math.max(0, walkingDistanceMeters - TRANSIT_URBAN_SPAN_METERS) / 1000
  const centralMinutes = TRANSIT_ACCESS_MINUTES
    + urbanKm * TRANSIT_URBAN_MINUTES_PER_KM
    + expressKm * TRANSIT_EXPRESS_MINUTES_PER_KM
  const minMinutes = Math.max(
    TRANSIT_MIN_MINUTES,
    Math.round((centralMinutes * TRANSIT_RANGE_LOW_FACTOR) / TRANSIT_RANGE_STEP_MINUTES) * TRANSIT_RANGE_STEP_MINUTES,
  )
  const maxMinutes = Math.max(
    minMinutes + TRANSIT_RANGE_STEP_MINUTES,
    Math.ceil((centralMinutes * TRANSIT_RANGE_HIGH_FACTOR) / TRANSIT_RANGE_STEP_MINUTES) * TRANSIT_RANGE_STEP_MINUTES,
  )
  return { minMinutes, maxMinutes }
}

export function assertCoordinate({ lat, lng }: Coordinate): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('invalid route coordinate')
  }
}

const radians = (value: number) => value * Math.PI / 180

/** Great-circle (haversine) distance between two coordinates. */
export function straightLineMeters(origin: Coordinate, destination: Coordinate): number {
  assertCoordinate(origin)
  assertCoordinate(destination)
  const latitudeDelta = radians(destination.lat - origin.lat)
  const longitudeDelta = radians(destination.lng - origin.lng)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(origin.lat)) * Math.cos(radians(destination.lat)) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

export interface SegmentMeasurement {
  walkingMinutes: number
  walkingDistanceMeters: number
  straightLineMeters: number
  /** The segment starts at a transport schedule (a train, a flight). Its one
   * location is where it departs; where it arrives is unknown. */
  originIsTransport: boolean
}

export type SegmentEstimate =
  | { kind: 'unknown' }
  | { kind: 'long-distance' }
  | { kind: 'walking'; walkingMinutes: number }
  | { kind: 'either'; walkingMinutes: number; transit: TransitEstimateRange }
  | { kind: 'transit'; walkingMinutes: number; transit: TransitEstimateRange }

/** Classify one segment from its measurements. Order matters: an unknown
 * origin beats everything, and a long trip gets no number at all. */
export function classifySegment(measurement: SegmentMeasurement): SegmentEstimate {
  assertNonNegative(measurement.walkingMinutes, 'walking minutes')
  assertNonNegative(measurement.walkingDistanceMeters, 'route distance')
  assertNonNegative(measurement.straightLineMeters, 'straight-line distance')

  if (measurement.originIsTransport) return { kind: 'unknown' }
  if (measurement.straightLineMeters > LONG_DISTANCE_STRAIGHT_METERS) return { kind: 'long-distance' }
  const { walkingMinutes } = measurement
  if (walkingMinutes <= WALKING_DIRECT_THRESHOLD_MINUTES) return { kind: 'walking', walkingMinutes }
  const transit = estimateTransitRange(measurement.walkingDistanceMeters)
  return walkingMinutes <= EITHER_MAX_WALKING_MINUTES
    ? { kind: 'either', walkingMinutes, transit }
    : { kind: 'transit', walkingMinutes, transit }
}

export interface TravelTimeRange {
  min: number
  /** Infinity when the segment has no estimate. */
  max: number
}

/** Fastest / slowest plausible travel time for a segment. An unknown
 * segment is [0, ∞): travel is never negative, so its lower bound still
 * supports definite conclusions (an overlap) even without an estimate. */
export function segmentTimeRange(estimate: SegmentEstimate): TravelTimeRange {
  switch (estimate.kind) {
    case 'walking':
      return { min: estimate.walkingMinutes, max: estimate.walkingMinutes }
    case 'either':
      return {
        min: Math.min(estimate.walkingMinutes, estimate.transit.minMinutes),
        max: Math.min(estimate.walkingMinutes, estimate.transit.maxMinutes),
      }
    case 'transit':
      return { min: estimate.transit.minMinutes, max: estimate.transit.maxMinutes }
    case 'long-distance':
    case 'unknown':
      return { min: 0, max: Number.POSITIVE_INFINITY }
  }
}

export interface FeasibilityItem {
  /** Minutes after local midnight; undefined for a flexible schedule. */
  startMinutes?: number
  durationMinutes: number
}

export type ArrivalFeasibility =
  /** Starts before the previous anchor starts: the order contradicts the
   * times, so durations and travel say nothing useful. */
  | { status: 'out-of-order' }
  /** Even with zero travel the previous anchor (plus any flexible stops in
   * between) ends after this one starts. */
  | { status: 'overlap'; overflowMinutes: number; flexibleBetween: number }
  /** Even the fastest estimate arrives late. */
  | { status: 'late'; lateMinutes: number }
  /** A segment on the way has no estimate, and no overlap or definite
   * lateness was found. */
  | { status: 'unknown' }
  /** On time at best, late at worst. */
  | { status: 'possibly-late'; maxLateMinutes: number }
  /** On time even at worst, with less than TIGHT_SLACK_MINUTES to spare.
   * Never reported when the stretch needs no travel at all (same place):
   * the buffer exists to absorb travel uncertainty. */
  | { status: 'tight'; minSlack: number; maxSlack: number }
  | { status: 'ok'; minSlack: number; maxSlack: number }

/**
 * Judge every timed schedule (an anchor) against the previous anchor's
 * PLANNED end: can it be reached on time? Each verdict is independent —
 * lateness never cascades, and an unknown segment only clouds the stretch
 * up to the next anchor. Flexible schedules have no verdict of their own;
 * their durations push the stretch they sit in.
 *
 * Returns one entry per item: the verdict for arriving AT that item, or
 * undefined when it is not evaluated (flexible, or no earlier anchor).
 */
export function dayFeasibility(
  items: FeasibilityItem[],
  segments: TravelTimeRange[],
): Array<ArrivalFeasibility | undefined> {
  if (items.length > 0 && segments.length !== items.length - 1) {
    throw new Error('dayFeasibility needs exactly one segment between consecutive items')
  }

  const verdicts: Array<ArrivalFeasibility | undefined> = items.map(() => undefined)
  let anchor: { index: number; start: number; end: number } | undefined

  items.forEach((item, index) => {
    if (item.startMinutes === undefined) return
    const start = item.startMinutes
    if (anchor && start < anchor.start) {
      verdicts[index] = { status: 'out-of-order' }
    } else if (anchor) {
      let floor = anchor.end
      let fastest = 0
      let slowest = 0
      for (let k = anchor.index + 1; k <= index; k += 1) {
        const segment = segments[k - 1]!
        fastest += segment.min
        slowest += segment.max
        if (k < index) floor += items[k]!.durationMinutes
      }
      verdicts[index] = judgeArrival(start, floor, floor + fastest, floor + slowest, index - anchor.index - 1)
    }
    anchor = { index, start, end: start + item.durationMinutes }
  })

  return verdicts
}

function judgeArrival(
  start: number,
  floor: number,
  earliestArrival: number,
  latestArrival: number,
  flexibleBetween: number,
): ArrivalFeasibility {
  if (start < floor) return { status: 'overlap', overflowMinutes: floor - start, flexibleBetween }
  const bestSlack = start - earliestArrival
  if (bestSlack < 0) return { status: 'late', lateMinutes: -bestSlack }
  if (!Number.isFinite(latestArrival)) return { status: 'unknown' }
  const worstSlack = start - latestArrival
  if (worstSlack < 0) return { status: 'possibly-late', maxLateMinutes: -worstSlack }
  return worstSlack < TIGHT_SLACK_MINUTES && latestArrival > floor
    ? { status: 'tight', minSlack: worstSlack, maxSlack: bestSlack }
    : { status: 'ok', minSlack: worstSlack, maxSlack: bestSlack }
}
