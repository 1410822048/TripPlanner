import { getAdminToken } from './admin'
import { readString, type FsValue } from './firestore'
import { requireTripMember } from './membership-shared'
import { runFirestoreTransaction, TxCancelled, type TxReadDoc } from './firestore-tx'
import {
  createRoutePreviewDeadline,
  estimateStaticTransitRange,
  isDirectWalkingLeg,
  optimizeAnchoredRoute,
  type StaticTransitEstimate,
  type RoutePreviewDeadline,
} from './route-core'
import {
  geoapifyForwardGeocode,
  geoapifyReverseGeocodeMetadata,
  geoapifyAutocompleteWithAliases,
  cleanGoogleMapsPlaceQuery,
  japaneseStationNameFromPinLabel,
  matchesJapaneseStationQuery,
  normalizePlaceQuery,
  orsDirections,
  orsMatrix,
  RouteProviderError,
  resolveGoogleMapsUrl,
  type OrsDirectionsResult,
  type PlaceCandidate,
  type RouteProviderCacheRuntime,
  type RouteProviderEnv,
} from './route-provider'
import { createPreviewToken, stableHash } from './route-security'
import { TimeSchema, type RouteAutocompleteRequest, type RoutePreviewRequest, type RouteResolvePlaceRequest } from './route-schema'

export class RouteValidationError extends Error {
  readonly status: number
  readonly field: string
  readonly code: string
  constructor(status: number, field: string, code: string, message: string) {
    super(message)
    this.name = 'RouteValidationError'
    this.status = status
    this.field = field
    this.code = code
  }
}

export function routeValidationErrorCatcher(error: unknown): {
  log: string
  body: unknown
  status: number
  precommit: true
} | null {
  return error instanceof RouteValidationError
    ? {
        log: `validation: ${error.code} ${error.field} ${error.message}`,
        body: { error: error.message, code: error.code, field: error.field },
        status: error.status,
        precommit: true,
      }
    : null
}

/** Worker writes bypass Firestore Rules, so route endpoints must mirror the
 * rules-layer removal gate explicitly. */
function assertRouteMemberActive(member: TxReadDoc): void {
  if ('removingAt' in member.fields) {
    throw new RouteValidationError(403, 'membership', 'ROUTE_MEMBER_INACTIVE', 'caller is leaving the trip')
  }
}

export interface RouteDisplayGeometry {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: {
      provider: 'ors' | 'reference'
      mode: 'walking' | 'transit-check'
      legIndex: number
    }
    geometry: { type: 'LineString'; coordinates: [number, number][] }
  }>
}

export interface RouteSchedule {
  id: string
  order: number
  timeMode: 'fixed' | 'preferred' | 'flexible'
  startTime?: string
  durationMinutes: number
  location: PlaceCandidate
}

interface RoutePreviewLegBase {
  legIndex: number
  fromId: string
  toId: string
  walkingMinutes: number
  geometryAvailable: boolean
}

export type RoutePreviewLeg = RoutePreviewLegBase & (
  | { kind: 'walking' }
  | { kind: 'transit-check'; transitEstimate: StaticTransitEstimate }
)

export interface RoutePreviewResponse {
  previewRevision: string
  scheduleInputHash: string
  payloadHash: string
  previewToken: string
  expiresAt: string
  canApply: boolean
  routeChanged: boolean
  geometryDegraded: boolean
  confidence: 'walking-verified' | 'transit-unverified'
  timeConflictScheduleIds: string[]
  applyPlan: {
    revision: string
    date: string
    schedules: Array<{ id: string; order: number }>
  }
  display: RouteDisplayGeometry
  legs: RoutePreviewLeg[]
}

function readNumber(fields: Record<string, FsValue>, key: string): number | undefined {
  const value = fields[key]
  if (!value) return undefined
  if (typeof value.doubleValue === 'number') return value.doubleValue
  if (typeof value.integerValue === 'number') return value.integerValue
  if (typeof value.integerValue === 'string') {
    const parsed = Number(value.integerValue)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readMap(fields: Record<string, FsValue>, key: string): Record<string, FsValue> | undefined {
  return fields[key]?.mapValue?.fields
}

function readPlace(fields: Record<string, FsValue>): PlaceCandidate | undefined {
  const location = readMap(fields, 'location')
  if (!location || readString(location, 'status') !== 'resolved') return undefined
  const place = readMap(location, 'place')
  if (!place) return undefined
  const provider = readString(place, 'provider')
  const providerPlaceId = readString(place, 'providerPlaceId')
  const name = readString(place, 'name')
  const lat = readNumber(place, 'lat')
  const lng = readNumber(place, 'lng')
  const timeZone = readString(place, 'timeZone')
  const countryCode = readString(place, 'countryCode')
  if (!provider || !['geoapify', 'google-maps'].includes(provider)
      || !providerPlaceId || providerPlaceId.length > 200 || !name || name.length > 200
      || lat === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90
      || lng === undefined || !Number.isFinite(lng) || lng < -180 || lng > 180
      || !timeZone || timeZone.length > 80
      || !countryCode || !/^[A-Z]{2}$/.test(countryCode)) return undefined
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format() } catch { return undefined }
  const address = readString(place, 'address')
  if (address && address.length > 500) return undefined
  return {
    provider: provider as PlaceCandidate['provider'],
    providerPlaceId,
    name,
    lat,
    lng,
    timeZone,
    countryCode,
    ...(address ? { address } : {}),
  }
}

export function scheduleFromDoc(doc: TxReadDoc): RouteSchedule | undefined {
  const id = doc.name.split('/').pop()
  const location = readPlace(doc.fields)
  const order = readNumber(doc.fields, 'order')
  const durationMinutes = readNumber(doc.fields, 'durationMinutes') ?? 60
  const timeMode = readString(doc.fields, 'timeMode')
  if (!id || !location || order === undefined || !Number.isInteger(order) || order < 0
      || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720
      || !['fixed', 'preferred', 'flexible'].includes(timeMode ?? '')) return undefined
  const startTime = readString(doc.fields, 'startTime')
  if (startTime && !TimeSchema.safeParse(startTime).success) return undefined
  if ((timeMode === 'fixed' || timeMode === 'preferred') && !startTime) return undefined
  if (timeMode === 'flexible' && startTime) return undefined
  return {
    id,
    order,
    timeMode: timeMode as RouteSchedule['timeMode'],
    ...(startTime ? { startTime } : {}),
    durationMinutes,
    location,
  }
}

export function routeScheduleFingerprint(schedules: RouteSchedule[]): Promise<string> {
  const canonical = [...schedules].sort((left, right) => {
    const orderDifference = left.order - right.order
    if (orderDifference !== 0) return orderDifference
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
  return stableHash(canonical)
}

function timeMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}

export function findTimeConflictIds(schedules: RouteSchedule[]): string[] {
  const conflicts = new Set<string>()
  let previous: { id: string; minutes: number } | undefined
  for (const schedule of schedules) {
    if (!schedule.startTime) continue
    const current = { id: schedule.id, minutes: timeMinutes(schedule.startTime) }
    if (previous && current.minutes < previous.minutes) {
      conflicts.add(previous.id)
      conflicts.add(current.id)
    }
    previous = current
  }
  return [...conflicts]
}

function matrixValue(
  matrix: Array<Array<number | null>>,
  fromIndex: number,
  toIndex: number,
): number {
  const value = matrix[fromIndex]?.[toIndex]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RouteProviderError('ors', 422, 'route matrix contains an unreachable leg')
  }
  return value
}

export function buildDisplayGeometry(
  schedules: RouteSchedule[],
  legs: RoutePreviewLeg[],
  directions: OrsDirectionsResult | undefined,
): RouteDisplayGeometry {
  return {
    type: 'FeatureCollection',
    features: legs.map((leg, index) => {
      const from = schedules[index]!
      const to = schedules[index + 1]!
      const directionLeg = directions?.legs[index]
      const useOrsGeometry = leg.kind === 'walking' && directionLeg?.coordinates.length
      return {
        type: 'Feature' as const,
        properties: {
          provider: useOrsGeometry ? 'ors' as const : 'reference' as const,
          mode: leg.kind,
          legIndex: leg.legIndex,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: useOrsGeometry
            ? directionLeg.coordinates
            : [[from.location.lng, from.location.lat], [to.location.lng, to.location.lat]],
        },
      }
    }),
  }
}

function providerError(error: unknown): RouteProviderError | null {
  return error instanceof RouteProviderError ? error : null
}

export function routeProviderErrorCatcher(error: unknown): { log: string; body: unknown; status: number; precommit?: boolean } | null {
  const mapped = providerError(error)
  return mapped ? { log: `${mapped.provider}: ${mapped.message}`, body: { error: mapped.message, code: 'ROUTE_PROVIDER_ERROR' }, status: mapped.status, precommit: true } : null
}

export async function resolveRoutePlace(
  input: RouteResolvePlaceRequest,
  env: RouteProviderEnv,
): Promise<{ candidates: PlaceCandidate[]; query: string }> {
  const searchOptions = {
    biasCountryCode: input.bias?.countryCode,
    normalizationCountryCode: input.bias?.normalizationCountryCode,
    proximity: input.bias?.proximity,
  }
  const directQuery = input.query?.trim()
  if (directQuery) {
    const normalized = normalizePlaceQuery(directQuery, input.bias?.normalizationCountryCode)
    let candidates = await geoapifyForwardGeocode(normalized, env, undefined, searchOptions)
    if (candidates.length === 0 && normalized !== directQuery) {
      candidates = await geoapifyForwardGeocode(directQuery, env, undefined, searchOptions)
    }
    return { query: directQuery, candidates }
  }

  const target = await resolveGoogleMapsUrl(input.googleMapsUrl ?? '')
  const query = target.query || (target.coordinates
    ? `${target.coordinates.lat},${target.coordinates.lng}`
    : '')
  // A Google share link is authoritative only when it identifies both the
  // entity label and its exact place pin. Camera centers and coordinate-only
  // links are not silently converted into a nearby Geoapify POI.
  if (!target.query || !target.coordinates) return { query, candidates: [] }

  const metadata = await geoapifyReverseGeocodeMetadata(target.coordinates, env, undefined, searchOptions)
  if (!metadata) return { query, candidates: [] }

  const cleanedName = cleanGoogleMapsPlaceQuery(target.query)
  // A nearby rail feature alone is not entity evidence: station cafés share
  // the same pin area. Accept it only when its provider name matches the
  // Google label after conservative JP normalization, or when Google carries
  // the bounded explicit train_station hint.
  const stationEvidence = target.placeTypeHint === 'train_station'
    || metadata.nearbyRailStationNames.some(name => matchesJapaneseStationQuery(name, cleanedName))
  const normalizedStationName = metadata.countryCode === 'JP' && stationEvidence
    ? japaneseStationNameFromPinLabel(normalizePlaceQuery(cleanedName, 'JP'))
    : undefined
  const name = normalizedStationName ?? cleanedName
  const providerPlaceId = `google-maps:${await stableHash({
    provider: 'google-maps',
    query: target.query,
    coordinates: target.coordinates,
  })}`

  return {
    query,
    candidates: [{
      provider: 'google-maps',
      providerPlaceId,
      name,
      ...target.coordinates,
      timeZone: metadata.timeZone,
      countryCode: metadata.countryCode,
    }],
  }
}

export async function assertRouteEditor(
  uid: string,
  tripId: string,
  serviceAccountJson: string,
  projectId: string,
): Promise<void> {
  const accessToken = await getAdminToken(serviceAccountJson)
  await runFirestoreTransaction(accessToken, projectId, async tx => {
    const { member } = await requireTripMember(tx, tripId, uid)
    assertRouteMemberActive(member)
    const role = readString(member.fields, 'role')
    if (role !== 'owner' && role !== 'editor') {
      throw new RouteValidationError(403, 'role', 'ROUTE_EDITOR_REQUIRED', 'editor permission is required')
    }
    return { writes: [], result: undefined }
  })
}

export async function autocompleteRoutePlace(
  uid: string,
  input: RouteAutocompleteRequest,
  serviceAccountJson: string,
  projectId: string,
  env: RouteProviderEnv,
): Promise<PlaceCandidate[]> {
  await assertRouteEditor(uid, input.tripId, serviceAccountJson, projectId)
  const query = input.bias?.city ? `${input.query}, ${input.bias.city}` : input.query
  return geoapifyAutocompleteWithAliases(query, env, undefined, {
    biasCountryCode: input.bias?.countryCode,
    normalizationCountryCode: input.bias?.normalizationCountryCode,
    proximity: input.bias?.proximity,
  })
}

export async function resolveRoutePlaceForTrip(
  uid: string,
  input: RouteResolvePlaceRequest,
  serviceAccountJson: string,
  projectId: string,
  env: RouteProviderEnv,
): Promise<{ candidates: PlaceCandidate[]; query: string }> {
  await assertRouteEditor(uid, input.tripId, serviceAccountJson, projectId)
  return resolveRoutePlace(input, env)
}

export async function previewRoute(
  uid: string,
  input: RoutePreviewRequest,
  serviceAccountJson: string,
  projectId: string,
  env: RouteProviderEnv & { ROUTE_PREVIEW_HMAC_SECRET?: string },
  cacheRuntime?: RouteProviderCacheRuntime,
): Promise<RoutePreviewResponse> {
  const deadline = createRoutePreviewDeadline()
  try {
    return await previewRouteWithDeadline(uid, input, serviceAccountJson, projectId, env, deadline, cacheRuntime)
  } catch (error) {
    if (deadline.signal.aborted || error instanceof TxCancelled) {
      throw new RouteValidationError(504, 'deadline', 'ROUTE_PREVIEW_DEADLINE', 'route preview deadline exceeded')
    }
    throw error
  } finally {
    deadline.dispose()
  }
}

async function previewRouteWithDeadline(
  uid: string,
  input: RoutePreviewRequest,
  serviceAccountJson: string,
  projectId: string,
  env: RouteProviderEnv & { ROUTE_PREVIEW_HMAC_SECRET?: string },
  deadline: RoutePreviewDeadline,
  cacheRuntime?: RouteProviderCacheRuntime,
): Promise<RoutePreviewResponse> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const loadSchedules = () => runFirestoreTransaction(accessToken, projectId, async tx => {
    const { member } = await requireTripMember(tx, input.tripId, uid)
    assertRouteMemberActive(member)
    const role = readString(member.fields, 'role')
    if (role !== 'owner' && role !== 'editor') {
      throw new RouteValidationError(403, 'role', 'ROUTE_EDITOR_REQUIRED', 'editor permission is required')
    }
    const docs = await tx.runQuery({
      parent: `trips/${input.tripId}`,
      collection: 'schedules',
      filters: [{ fieldPath: 'date', op: 'EQUAL', value: { stringValue: input.date } }],
      orderBy: [{ fieldPath: 'order', direction: 'ASCENDING' }],
      // The sentinel row prevents a 13th schedule from being hidden by the cap.
      limit: 13,
    })
    if (docs.length < 2 || docs.length > 12) {
      throw new RouteValidationError(400, 'schedules', 'ROUTE_SCHEDULE_COUNT_INVALID', 'a route preview needs 2-12 schedules')
    }
    const schedules = docs.map(scheduleFromDoc)
    if (schedules.some(schedule => !schedule)) {
      throw new RouteValidationError(409, 'schedules', 'ROUTE_SCHEDULES_INVALID', 'all schedules need valid timing and resolved locations')
    }
    return {
      writes: [],
      result: (schedules as RouteSchedule[]).sort((a, b) => a.order - b.order),
    }
  }, { signal: deadline.signal })
  const sourceSchedules = await loadSchedules()

  const timeZones = new Set(sourceSchedules.map(schedule => schedule.location.timeZone))
  if (timeZones.size !== 1) {
    throw new RouteValidationError(409, 'timeZone', 'ROUTE_TIMEZONE_MISMATCH', 'mixed time zones must be split before optimizing')
  }

  const scheduleInputHash = await routeScheduleFingerprint(sourceSchedules)
  const matrix = await orsMatrix(sourceSchedules.map(schedule => schedule.location), env, undefined, deadline.signal, cacheRuntime)
  const fixedIndexes = sourceSchedules
    .map((schedule, index) => schedule.timeMode === 'fixed' ? index : -1)
    .filter(index => index > 0 && index < sourceSchedules.length - 1)
  const optimization = optimizeAnchoredRoute(matrix.distancesMeters, fixedIndexes)
  const schedules = optimization.order.map(index => sourceSchedules[index]!)
  const sourceIndexById = new Map(sourceSchedules.map((schedule, index) => [schedule.id, index]))

  let directions: OrsDirectionsResult | undefined
  try {
    directions = await orsDirections(schedules.map(schedule => schedule.location), env, undefined, deadline.signal, cacheRuntime)
    if (directions.legs.length !== schedules.length - 1) {
      throw new RouteProviderError('ors', 502, 'provider returned invalid directions')
    }
  } catch (error) {
    if (!(error instanceof RouteProviderError)) throw error
    console.warn(JSON.stringify({
      message: 'route geometry unavailable',
      provider: error.provider,
      status: error.status,
      reason: error.reason ?? 'unknown',
    }))
  }

  const legs: RoutePreviewLeg[] = schedules.slice(0, -1).map((from, legIndex) => {
    const to = schedules[legIndex + 1]!
    const fromIndex = sourceIndexById.get(from.id)
    const toIndex = sourceIndexById.get(to.id)
    if (fromIndex === undefined || toIndex === undefined) {
      throw new RouteValidationError(500, 'schedules', 'ROUTE_ORDER_INVALID', 'route order contains an unknown schedule')
    }
    const matrixMinutes = matrixValue(matrix.durationsMinutes, fromIndex, toIndex)
    const matrixDistanceMeters = matrixValue(matrix.distancesMeters, fromIndex, toIndex)
    const walkingMinutes = directions?.legs[legIndex]?.durationMinutes ?? matrixMinutes
    const legBase = {
      legIndex,
      fromId: from.id,
      toId: to.id,
      walkingMinutes,
      geometryAvailable: isDirectWalkingLeg(walkingMinutes) && Boolean(directions?.legs[legIndex]?.coordinates.length),
    }
    return isDirectWalkingLeg(walkingMinutes)
      ? { ...legBase, kind: 'walking' as const }
      : {
          ...legBase,
          kind: 'transit-check' as const,
          transitEstimate: estimateStaticTransitRange(matrixDistanceMeters),
        }
  })

  // Provider calls can take several seconds. Re-read the complete routing
  // fingerprint before signing so the user never receives a preview that was
  // already stale when it arrived. Apply performs the same check again inside
  // its transaction; this is an earlier UX guard, not a replacement.
  const latestSchedules = await loadSchedules()
  const latestHash = await routeScheduleFingerprint(latestSchedules)
  if (latestHash !== scheduleInputHash) {
    throw new RouteValidationError(409, 'schedules', 'PREVIEW_STALE', 'schedule constraints changed while previewing')
  }

  const revision = crypto.randomUUID()
  const applyPlan = {
    revision,
    date: input.date,
    schedules: schedules.map((schedule, order) => ({ id: schedule.id, order })),
  }
  const payloadHash = await stableHash(applyPlan)
  const secret = env.ROUTE_PREVIEW_HMAC_SECRET
  if (!secret) throw new RouteProviderError('route', 503, 'preview signing is not configured')
  const previewToken = await createPreviewToken({ uid, tripId: input.tripId, revision, inputHash: scheduleInputHash, payloadHash }, secret)
  const geometryDegraded = legs.some(leg => leg.kind === 'walking' && !leg.geometryAvailable)

  return {
    previewRevision: revision,
    scheduleInputHash,
    payloadHash,
    previewToken,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    canApply: optimization.improved,
    routeChanged: optimization.improved,
    geometryDegraded,
    confidence: legs.some(leg => leg.kind === 'transit-check') ? 'transit-unverified' : 'walking-verified',
    timeConflictScheduleIds: findTimeConflictIds(schedules),
    applyPlan,
    display: buildDisplayGeometry(schedules, legs, directions),
    legs,
  }
}
