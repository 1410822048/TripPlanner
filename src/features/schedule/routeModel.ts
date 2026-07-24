/** Canonical timing rules shared by the Schedule form and route preview. */
import type { ScheduleLocation } from '@/types/schedule'

export const MIN_DURATION_MINUTES = 1
export const MAX_DURATION_MINUTES = 720

export type TimeMode = 'fixed' | 'preferred' | 'flexible'

export interface ScheduleTimingInput {
  startTime?: string | null
  timeMode?: TimeMode | null
  durationMinutes?: number | null
}

export interface NormalizedScheduleTiming {
  startTime?: string
  timeMode: TimeMode
  durationMinutes: number
}

export interface LocationAutocompleteInput {
  isOpen: boolean
  query: string
  location?: ScheduleLocation | null
}

export type ScheduleTimingErrorCode =
  | 'INVALID_TIME'
  | 'START_TIME_REQUIRED'
  | 'DURATION_INVALID'
  | 'CROSSES_MIDNIGHT'

export class ScheduleTimingError extends Error {
  readonly code: ScheduleTimingErrorCode

  constructor(code: ScheduleTimingErrorCode, message: string) {
    super(message)
    this.name = 'ScheduleTimingError'
    this.code = code
  }
}

/** Autocomplete remains available for legacy/unresolved text until a place is verified. */
export function shouldRequestLocationAutocomplete(input: LocationAutocompleteInput): boolean {
  return input.isOpen && input.query.trim().length >= 2 && input.location?.status !== 'resolved'
}

export type RouteOptimizationBlockedReason =
  | 'too-many-schedules'
  | 'unresolved-locations'
  | 'mixed-time-zones'

export type RouteOptimizationAvailability =
  | { status: 'hidden' }
  | { status: 'ready' }
  | { status: 'blocked'; reason: 'too-many-schedules'; count: number }
  | { status: 'blocked'; reason: 'unresolved-locations'; count: number }
  | { status: 'blocked'; reason: 'mixed-time-zones' }

/** Demo keeps its sign-in CTA. Cloud mode preflights the same prerequisites
 * enforced by the Worker so the UI never sends a request guaranteed to fail. */
export function routeOptimizationAvailability(input: {
  canWrite: boolean
  hasDate: boolean
  isDemo: boolean
  locations: Array<ScheduleLocation | null | undefined>
}): RouteOptimizationAvailability {
  const scheduleCount = input.locations.length
  if (!input.canWrite || !input.hasDate || scheduleCount < 2) return { status: 'hidden' }
  if (input.isDemo) return { status: 'ready' }
  if (scheduleCount > 12) return { status: 'blocked', reason: 'too-many-schedules', count: scheduleCount }

  const resolved = input.locations.filter(
    (location): location is Extract<ScheduleLocation, { status: 'resolved' }> => location?.status === 'resolved',
  )
  const unresolvedCount = scheduleCount - resolved.length
  if (unresolvedCount > 0) {
    return { status: 'blocked', reason: 'unresolved-locations', count: unresolvedCount }
  }

  const timeZones = new Set(resolved.map(location => location.place.timeZone))
  if (timeZones.size !== 1) return { status: 'blocked', reason: 'mixed-time-zones' }
  return { status: 'ready' }
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function toMinutes(value: string): number {
  if (!TIME_RE.test(value)) throw new ScheduleTimingError('INVALID_TIME', 'time must use HH:mm')
  const [hours = 0, minutes = 0] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Normalize form timing into the canonical persisted model. End time is
 * always derived from startTime + durationMinutes and never accepted as input. */
export function validateScheduleTiming(input: ScheduleTimingInput): NormalizedScheduleTiming {
  const inferredMode: TimeMode = input.timeMode ?? (input.startTime ? 'preferred' : 'flexible')
  const startTime = input.startTime || undefined
  if (inferredMode !== 'flexible' && !startTime) {
    throw new ScheduleTimingError('START_TIME_REQUIRED', `${inferredMode} schedules require startTime`)
  }
  const startMinutes = startTime ? toMinutes(startTime) : undefined

  const durationMinutes = input.durationMinutes
  if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes)
    || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    throw new ScheduleTimingError(
      'DURATION_INVALID',
      `durationMinutes must be an integer between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`,
    )
  }
  if (startMinutes !== undefined && startMinutes + durationMinutes >= 1440) {
    throw new ScheduleTimingError('CROSSES_MIDNIGHT', 'schedule must start and end on the same day')
  }
  return {
    timeMode: inferredMode,
    durationMinutes,
    startTime: inferredMode === 'flexible' ? undefined : startTime,
  }
}

export function effectiveEndTime(input: Pick<ScheduleTimingInput, 'startTime' | 'durationMinutes'>): string | undefined {
  const start = input.startTime || undefined
  const durationMinutes = input.durationMinutes
  if (!start || typeof durationMinutes !== 'number') return undefined
  const endMinutes = toMinutes(start) + durationMinutes
  return endMinutes < 1440 ? toTime(endMinutes) : undefined
}
