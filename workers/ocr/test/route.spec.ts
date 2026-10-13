import { describe, expect, test, vi } from 'vitest'
import {
  createRoutePreviewDeadline,
  optimizeAnchoredRoute,
  ROUTE_PREVIEW_DEADLINE_MS,
} from '../src/route-core'

describe('route core worker fixtures', () => {
  // Segment classification and transit ranges live in
  // @tripmate/route-estimate-core (tested there); the Worker only measures.

  test('finds the exact shorter order while keeping the first and last stops', () => {
    const result = optimizeAnchoredRoute([
      [0, 10, 1, 99],
      [10, 0, 1, 1],
      [1, 1, 0, 10],
      [99, 1, 10, 0],
    ], [])

    expect(result.order).toEqual([0, 2, 1, 3])
    expect(result.improved).toBe(true)
    expect(result.optimizedDistanceMeters).toBeLessThan(result.originalDistanceMeters)
  })

  test('keeps fixed anchors at their original indexes and optimizes each side independently', () => {
    const result = optimizeAnchoredRoute([
      [0, 10, 1, 99, 99, 99],
      [10, 0, 1, 1, 99, 99],
      [1, 1, 0, 10, 99, 99],
      [99, 1, 10, 0, 10, 1],
      [99, 99, 99, 10, 0, 1],
      [99, 99, 99, 1, 1, 0],
    ], [3])

    expect(result.order).toEqual([0, 2, 1, 3, 4, 5])
    expect(result.order[3]).toBe(3)
  })

  test('does not churn the order when no strictly shorter route exists', () => {
    const result = optimizeAnchoredRoute([
      [0, 1, 2],
      [1, 0, 1],
      [2, 1, 0],
    ], [])

    expect(result).toMatchObject({ order: [0, 1, 2], improved: false })
  })

  test('route preview deadline aborts provider work at 30 seconds', () => {
    vi.useFakeTimers()
    const deadline = createRoutePreviewDeadline()
    expect(ROUTE_PREVIEW_DEADLINE_MS).toBe(30_000)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(ROUTE_PREVIEW_DEADLINE_MS)
    expect(deadline.signal.aborted).toBe(true)
    deadline.dispose()
    vi.useRealTimers()
  })
})
