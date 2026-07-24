export const WALKING_DIRECT_THRESHOLD_MINUTES = 15
export const ROUTE_PREVIEW_DEADLINE_MS = 30_000

export interface RoutePreviewDeadline {
  signal: AbortSignal
  deadlineAt: number
  dispose: () => void
}

/** Shared cancellation budget for every provider call in one preview. */
export function createRoutePreviewDeadline(
  deadlineMs = ROUTE_PREVIEW_DEADLINE_MS,
  now = Date.now(),
): RoutePreviewDeadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('route preview deadline exceeded'), deadlineMs)
  return {
    signal: controller.signal,
    deadlineAt: now + deadlineMs,
    dispose: () => clearTimeout(timer),
  }
}

export function isDirectWalkingLeg(durationMinutes: number): boolean {
  return Number.isFinite(durationMinutes)
    && durationMinutes >= 0
    && durationMinutes <= WALKING_DIRECT_THRESHOLD_MINUTES
}

type DistanceCell = number | null
export type DistanceMatrix = DistanceCell[][]

export interface AnchoredRouteResult {
  order: number[]
  originalDistanceMeters: number
  optimizedDistanceMeters: number
  improved: boolean
}

export interface StaticTransitEstimate {
  minMinutes: number
  maxMinutes: number
  basis: 'ors-walking-distance'
}

const TRANSIT_WAIT_MINUTES = 5
const TRANSIT_REFERENCE_SPEED_KMH = 40
const TRANSIT_RANGE_STEP_MINUTES = 5

/** A display-only range derived from ORS walking-network distance. It is not
 * a timetable, is never used to validate fixed schedules, and does not affect
 * route ordering or the signed apply plan. */
export function estimateStaticTransitRange(distanceMeters: number): StaticTransitEstimate {
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
  return { minMinutes, maxMinutes, basis: 'ors-walking-distance' }
}

interface PathState {
  cost: number
  previous: number
}

function assertSquareMatrix(matrix: DistanceMatrix): void {
  const size = matrix.length
  if (size < 2 || matrix.some(row => row.length !== size)) {
    throw new Error('route distance matrix must be square and contain at least two stops')
  }
}

function edgeCost(matrix: DistanceMatrix, from: number, to: number): number {
  const value = matrix[from]?.[to]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : Number.POSITIVE_INFINITY
}

function pathCost(matrix: DistanceMatrix, order: number[]): number {
  let total = 0
  for (let index = 0; index < order.length - 1; index += 1) {
    total += edgeCost(matrix, order[index]!, order[index + 1]!)
  }
  return total
}

/** Exact Hamiltonian path for one fixed-bounded segment. Both endpoints stay
 * fixed; only the middle stops can move. N is capped at 12 by the API, so the
 * Held-Karp O(k^2 * 2^k) state space is small (k <= 10). */
function solveSegment(matrix: DistanceMatrix, segment: number[]): number[] {
  if (segment.length <= 3) return segment
  const start = segment[0]!
  const end = segment[segment.length - 1]!
  const middle = segment.slice(1, -1)
  const stateCount = 1 << middle.length
  const states: Array<Array<PathState | undefined>> = Array.from(
    { length: stateCount },
    () => Array<PathState | undefined>(middle.length),
  )

  for (let last = 0; last < middle.length; last += 1) {
    states[1 << last]![last] = {
      cost: edgeCost(matrix, start, middle[last]!),
      previous: -1,
    }
  }

  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let last = 0; last < middle.length; last += 1) {
      const state = states[mask]?.[last]
      if (!state || !Number.isFinite(state.cost)) continue
      for (let next = 0; next < middle.length; next += 1) {
        const bit = 1 << next
        if ((mask & bit) !== 0) continue
        const nextMask = mask | bit
        const candidate = state.cost + edgeCost(matrix, middle[last]!, middle[next]!)
        const current = states[nextMask]?.[next]
        // Iterating original indexes in ascending order makes exact ties
        // stable: only a strictly shorter state replaces the existing path.
        if (!current || candidate < current.cost) {
          states[nextMask]![next] = { cost: candidate, previous: last }
        }
      }
    }
  }

  const fullMask = stateCount - 1
  let bestLast = -1
  let bestCost = Number.POSITIVE_INFINITY
  for (let last = 0; last < middle.length; last += 1) {
    const state = states[fullMask]?.[last]
    if (!state) continue
    const candidate = state.cost + edgeCost(matrix, middle[last]!, end)
    if (candidate < bestCost) {
      bestCost = candidate
      bestLast = last
    }
  }
  if (bestLast < 0 || !Number.isFinite(bestCost)) return segment

  const reversed: number[] = []
  let mask = fullMask
  let last = bestLast
  while (last >= 0) {
    reversed.push(middle[last]!)
    const previous = states[mask]?.[last]?.previous ?? -1
    mask &= ~(1 << last)
    last = previous
  }
  const candidate = [start, ...reversed.reverse(), end]
  return bestCost < pathCost(matrix, segment) ? candidate : segment
}

/** Optimize each range independently. Day endpoints and every fixed schedule
 * remain at their original indexes; a segment is changed only when the same
 * ORS distance matrix proves the candidate strictly shorter. */
export function optimizeAnchoredRoute(
  matrix: DistanceMatrix,
  fixedIndexes: number[],
): AnchoredRouteResult {
  assertSquareMatrix(matrix)
  const size = matrix.length
  const anchors = [...new Set([
    0,
    ...fixedIndexes.filter(index => Number.isInteger(index) && index > 0 && index < size - 1),
    size - 1,
  ])].sort((a, b) => a - b)

  const order: number[] = []
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const start = anchors[anchorIndex]!
    const end = anchors[anchorIndex + 1]!
    const segment = Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
    const optimized = solveSegment(matrix, segment)
    order.push(...(anchorIndex === 0 ? optimized : optimized.slice(1)))
  }

  const original = Array.from({ length: size }, (_, index) => index)
  const originalDistanceMeters = pathCost(matrix, original)
  const optimizedDistanceMeters = pathCost(matrix, order)
  const changed = order.some((value, index) => value !== index)
  const improved = changed && optimizedDistanceMeters < originalDistanceMeters

  return {
    order: improved ? order : original,
    originalDistanceMeters,
    optimizedDistanceMeters: improved ? optimizedDistanceMeters : originalDistanceMeters,
    improved,
  }
}
