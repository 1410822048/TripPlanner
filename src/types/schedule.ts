// Schedule data model. Location and timing are deliberately explicit so the
// route Worker never has to infer coordinates or constraints from a title.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { SCHEDULE_LIMITS, TRAVEL_MEASUREMENT_LIMITS } from '@tripmate/entity-contracts'
import { TimestampSchema } from './_shared'
import {
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  type TimeMode,
} from '@/features/schedule/routeModel'

export type { TimeMode } from '@/features/schedule/routeModel'

export interface PlaceRef {
  provider: 'geoapify' | 'google-maps'
  providerPlaceId: string
  name: string
  address?: string
  lat: number
  lng: number
  timeZone: string
  countryCode: string
}

export type ScheduleLocation =
  | { status: 'unresolved'; query: string }
  | { status: 'resolved'; place: PlaceRef }

/** Worker-owned projection of an applied route: ORS walking-network
 * measurements only. Everything derived from them (segment class, transit
 * range, feasibility) is computed at read time by @tripmate/route-estimate-core,
 * so a formula change applies to every stored route without re-optimizing. */
export interface TravelToNext {
  toId: string
  walkingMinutes: number
  walkingDistanceMeters: number
}

export interface Schedule {
  id: string
  tripId: string
  date: string
  order: number
  title: string
  description?: string
  location?: ScheduleLocation
  startTime?: string
  timeMode: TimeMode
  durationMinutes: number
  routeRevision: string | null
  travelToNext: TravelToNext | null
  category: ScheduleCategory
  estimatedCostMinor?: number
  createdBy: string
  updatedBy: string
  memberIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ScheduleCategory =
  | 'transport'
  | 'accommodation'
  | 'food'
  | 'activity'
  | 'shopping'
  | 'other'

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const TimeSchema = z.string().regex(TIME_RE)
const ScheduleIdSchema = z.string().min(1).max(128)

export const PlaceRefSchema = z.object({
  provider:          z.enum(['geoapify', 'google-maps']),
  providerPlaceId:   z.string().min(1).max(200),
  name:              z.string().min(1).max(200),
  address:           z.string().max(500).optional(),
  lat:               z.number().finite().min(-90).max(90),
  lng:               z.number().finite().min(-180).max(180),
  timeZone:          z.string().min(1).max(80),
  countryCode:       z.string().regex(/^[A-Z]{2}$/),
}).strict()

export const ScheduleLocationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unresolved'), query: z.string().min(1).max(200) }).strict(),
  z.object({ status: z.literal('resolved'), place: PlaceRefSchema }).strict(),
])

export function scheduleLocationName(location?: ScheduleLocation): string | undefined {
  if (!location) return undefined
  return location.status === 'resolved' ? location.place.name : location.query
}

export function resolvedPlace(location?: ScheduleLocation): PlaceRef | undefined {
  return location?.status === 'resolved' ? location.place : undefined
}

const TimingFields = {
  startTime:          TimeSchema.optional(),
  timeMode:           z.enum(['fixed', 'preferred', 'flexible']),
  durationMinutes:   z.number().int().min(MIN_DURATION_MINUTES).max(MAX_DURATION_MINUTES),
} as const

/** READ schema. Lenient on purpose: extra fields are stripped, and the
 * document schema turns an unparseable value into null (the timeline falls
 * back to its local estimate) instead of failing the whole schedule. The
 * strict WRITE checks live where the value is written: the Worker's
 * ApplyRouteLegSchema and firestore.rules validTravelToNext. */
export const TravelToNextReadSchema = z.object({
  toId: ScheduleIdSchema,
  walkingMinutes: z.number().int().min(0).max(TRAVEL_MEASUREMENT_LIMITS.walkingMinutes),
  walkingDistanceMeters: z.number().int().min(0).max(TRAVEL_MEASUREMENT_LIMITS.walkingDistanceMeters),
})

const ScheduleInputBase = z.object({
  title:              z.string().trim().min(1).max(SCHEDULE_LIMITS.title),
  date:               DateSchema,
  ...TimingFields,
  category:           z.enum(['transport','accommodation','food','activity','shopping','other']),
  description:        z.string().max(SCHEDULE_LIMITS.description).optional(),
  estimatedCostMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  location:           ScheduleLocationSchema.optional(),
}).strict()

function enforceTimingInvariant<T extends { startTime?: string; timeMode: TimeMode }>(data: T, ctx: z.RefinementCtx): void {
  if (data.timeMode !== 'flexible' && !data.startTime) {
    ctx.addIssue({ code: 'custom', path: ['startTime'], message: `${data.timeMode} schedules require startTime` })
  }
  if (data.timeMode === 'flexible' && data.startTime) {
    ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'flexible schedules cannot retain startTime' })
  }
}

export const CreateScheduleSchema = ScheduleInputBase.superRefine(enforceTimingInvariant)
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>

/** Updates are merged with the stored document before the Worker applies the
 * timing invariant; partial patches stay usable for title-only edits. */
export const UpdateScheduleSchema = ScheduleInputBase.partial().strict()
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>

export const ScheduleDocSchema = z.object({
  tripId:             z.string().min(1).max(60),
  date:               DateSchema,
  order:              z.number().int().min(0),
  title:              z.string().min(1).max(SCHEDULE_LIMITS.title),
  description:        z.string().max(SCHEDULE_LIMITS.description).optional(),
  location:           ScheduleLocationSchema.optional(),
  startTime:          TimeSchema.optional(),
  timeMode:           z.enum(['fixed','preferred','flexible']),
  durationMinutes:    z.number().int().min(MIN_DURATION_MINUTES).max(MAX_DURATION_MINUTES),
  routeRevision:      z.string().min(1).max(128).nullable(),
  travelToNext:       TravelToNextReadSchema.nullable().catch(null),
  category:           z.enum(['transport','accommodation','food','activity','shopping','other']),
  estimatedCostMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  createdBy:          z.string().min(1),
  updatedBy:          z.string().min(1),
  memberIds:          z.array(z.string().min(1)).min(1),
  createdAt:          TimestampSchema,
  updatedAt:          TimestampSchema,
// Not .strict(): unknown top-level fields are stripped on read. The client
// WRITE schemas above stay strict; the nested location schemas are shared
// by reads and writes and stay strict too.
}).superRefine((value, ctx) => {
  if (value.travelToNext && !value.routeRevision) {
    ctx.addIssue({
      code: 'custom',
      path: ['travelToNext'],
      message: 'travelToNext requires routeRevision',
    })
  }
})
