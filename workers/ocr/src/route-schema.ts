import { z } from 'zod'

export const TripIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/)
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)

const PlaceBiasSchema = z.object({
  city: z.string().trim().max(120).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  normalizationCountryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  proximity: z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  }).strict().optional(),
}).strict()

export const RouteAutocompleteRequestSchema = z.object({
  tripId: TripIdSchema,
  query: z.string().trim().min(2).max(120),
  bias: PlaceBiasSchema.optional(),
}).strict()
export type RouteAutocompleteRequest = z.infer<typeof RouteAutocompleteRequestSchema>

export const RouteResolvePlaceRequestSchema = z.object({
  tripId: TripIdSchema,
  query: z.string().trim().min(2).max(200).optional(),
  googleMapsUrl: z.string().url().max(2048).optional(),
  bias: PlaceBiasSchema.optional(),
}).strict().refine(value => Boolean(value.query || value.googleMapsUrl), { message: 'query or googleMapsUrl is required' })
export type RouteResolvePlaceRequest = z.infer<typeof RouteResolvePlaceRequestSchema>

export const RoutePreviewRequestSchema = z.object({
  tripId: TripIdSchema,
  date: DateSchema,
}).strict()
export type RoutePreviewRequest = z.infer<typeof RoutePreviewRequestSchema>

export const ApplyScheduleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  order: z.number().int().min(0).max(100),
}).strict()

export const RouteApplyRequestSchema = z.object({
  tripId: TripIdSchema,
  revision: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  date: DateSchema,
  previewToken: z.string().min(32).max(2048),
  schedules: z.array(ApplyScheduleSchema).min(2).max(12),
}).strict()
export type RouteApplyRequest = z.infer<typeof RouteApplyRequestSchema>

export const RouteApplyStatusRequestSchema = z.object({
  tripId: TripIdSchema,
  revision: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict()
export type RouteApplyStatusRequest = z.infer<typeof RouteApplyStatusRequestSchema>
