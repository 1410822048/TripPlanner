import { z } from 'zod'
import { stableHash } from './route-security'

export interface RouteProviderEnv {
  GEOAPIFY_API_KEY?: string
  ORS_API_KEY?: string
}

interface RouteProviderCacheStore {
  match(request: RequestInfo | URL): Promise<Response | undefined>
  put(request: RequestInfo | URL, response: Response): Promise<void>
}

export interface RouteProviderCacheRuntime {
  cache: RouteProviderCacheStore
  cacheOrigin: string
  waitUntil: (promise: Promise<unknown>) => void
}

export interface PlaceCandidate {
  provider: 'geoapify' | 'google-maps'
  providerPlaceId: string
  name: string
  address?: string
  lat: number
  lng: number
  timeZone: string
  countryCode: string
}

export interface GeoapifyPinMetadata {
  timeZone: string
  countryCode: string
  nearbyRailStationNames: string[]
}

export interface PlaceSearchOptions {
  biasCountryCode?: string
  normalizationCountryCode?: string
  proximity?: { lat: number; lng: number }
}

export interface GoogleMapsPlaceTarget {
  query?: string
  coordinates?: { lat: number; lng: number }
  placeTypeHint?: 'train_station'
}

export interface OrsMatrixResult {
  durationsMinutes: Array<Array<number | null>>
  distancesMeters: Array<Array<number | null>>
}

export interface OrsDirectionsLeg {
  durationMinutes: number
  distanceMeters: number
  coordinates: [number, number][]
}

export interface OrsDirectionsResult {
  durationMinutes: number
  distanceMeters: number
  coordinates: [number, number][]
  legs: OrsDirectionsLeg[]
}

export class RouteProviderError extends Error {
  readonly status: number
  readonly provider: string
  readonly reason: string | undefined
  constructor(provider: string, status: number, message: string, reason?: string) {
    super(message)
    this.name = 'RouteProviderError'
    this.provider = provider
    this.status = status
    this.reason = reason
  }
}

const PROVIDER_RESPONSE_MAX_BYTES = 2_000_000
const PROVIDER_CACHE_TTL_SECONDS = 300
const PROVIDER_CACHE_VERSION = 1

const MatrixCellSchema = z.number().finite().nonnegative().nullable()
const OrsMatrixResponseSchema = z.object({
  durations: z.array(z.array(MatrixCellSchema)),
  distances: z.array(z.array(MatrixCellSchema)),
})

const OrsDirectionsResponseSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'),
    properties: z.object({
      summary: z.object({ duration: z.number().finite().nonnegative(), distance: z.number().finite().nonnegative() }),
      segments: z.array(z.object({
        duration: z.number().finite().nonnegative(),
        distance: z.number().finite().nonnegative(),
      })),
      way_points: z.array(z.number().int().nonnegative()),
    }),
    geometry: z.object({
      type: z.literal('LineString'),
      coordinates: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2),
    }),
  })).min(1),
})

const GeoapifyFeaturesSchema = z.array(z.object({
  properties: z.object({
    place_id: z.string().min(1),
    name: z.string().optional(),
    formatted: z.string().optional(),
    address_line1: z.string().optional(),
    suburb: z.string().optional(),
    district: z.string().optional(),
    city: z.string().optional(),
    result_type: z.enum([
      'unknown', 'amenity', 'building', 'street', 'suburb', 'district',
      'postcode', 'city', 'county', 'state', 'country',
    ]).optional(),
    category: z.string().max(200).optional(),
    lat: z.number().finite(),
    lon: z.number().finite(),
    timezone: z.object({ name: z.string().min(1) }).optional(),
    time_zone: z.object({ name: z.string().min(1) }).optional(),
    country_code: z.string().optional(),
  }),
}))

type GeoapifyProperties = z.infer<typeof GeoapifyFeaturesSchema>[number]['properties']

export function parseGeoapifyPinMetadata(
  raw: unknown,
  coordinates: { lat: number; lng: number },
): GeoapifyPinMetadata | undefined {
  const parsed = GeoapifyFeaturesSchema.safeParse(raw)
  if (!parsed.success) throw new RouteProviderError('geoapify', 502, 'provider returned invalid place results')

  let metadata: Omit<GeoapifyPinMetadata, 'nearbyRailStationNames'> | undefined
  const nearbyRailStationNames: string[] = []
  for (const { properties } of parsed.data) {
    const timeZone = properties.timezone?.name || properties.time_zone?.name
    const countryCode = properties.country_code?.toUpperCase()
    if (!timeZone || !isValidTimeZone(timeZone) || !countryCode || !/^[A-Z]{2}$/.test(countryCode)) continue
    metadata ??= { timeZone, countryCode }
    const stationName = properties.name?.trim() || properties.address_line1?.trim()
    if (stationName
        && countryCode === metadata.countryCode
        && coordinateDistanceMeters(coordinates, { lat: properties.lat, lng: properties.lon }) <= 50
        && /(?:^|[._-])(?:railway|train|subway|metro|tram|light_rail|monorail)(?:$|[._-])/iu.test(properties.category ?? '')) {
      nearbyRailStationNames.push(stationName)
    }
  }
  return metadata ? { ...metadata, nearbyRailStationNames } : undefined
}

export function parseOrsMatrixResponse(raw: unknown, expectedSize: number): OrsMatrixResult {
  const parsed = OrsMatrixResponseSchema.safeParse(raw)
  if (!parsed.success
      || parsed.data.durations.length !== expectedSize
      || parsed.data.distances.length !== expectedSize
      || parsed.data.durations.some(row => row.length !== expectedSize)
      || parsed.data.distances.some(row => row.length !== expectedSize)) {
    throw new RouteProviderError('ors', 502, 'provider returned invalid matrix')
  }
  return {
    durationsMinutes: parsed.data.durations.map(row => row.map(value => value === null ? null : value / 60)),
    distancesMeters: parsed.data.distances,
  }
}

export function parseOrsDirectionsResponse(raw: unknown): OrsDirectionsResult {
  const parsed = OrsDirectionsResponseSchema.safeParse(raw)
  if (!parsed.success) throw new RouteProviderError('ors', 502, 'provider returned invalid directions')
  const route = parsed.data.features[0]!
  const { segments, way_points: wayPoints } = route.properties
  if (segments.length < 1 || wayPoints.length !== segments.length + 1) {
    throw new RouteProviderError('ors', 502, 'provider returned invalid directions')
  }

  const legs: OrsDirectionsLeg[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const start = wayPoints[index]
    const end = wayPoints[index + 1]
    const segment = segments[index]
    if (start === undefined || end === undefined || !segment
        || end <= start || end >= route.geometry.coordinates.length) {
      throw new RouteProviderError('ors', 502, 'provider returned invalid directions')
    }
    const coordinates = route.geometry.coordinates.slice(start, end + 1)
    if (coordinates.length < 2) throw new RouteProviderError('ors', 502, 'provider returned invalid directions')
    legs.push({
      durationMinutes: segment.duration / 60,
      distanceMeters: segment.distance,
      coordinates,
    })
  }

  return {
    durationMinutes: route.properties.summary.duration / 60,
    distanceMeters: route.properties.summary.distance,
    coordinates: route.geometry.coordinates,
    legs,
  }
}

function normalizePlaceMatchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/江(?:之|の|ノ)島/g, '江ノ島')
    .replace(/[\p{White_Space}\p{Punctuation}\p{Symbol}]/gu, '')
}

function geoapifyNameMatchScore(value: string, query: string): number {
  const normalizedValue = normalizePlaceMatchText(value)
  const normalizedQuery = normalizePlaceMatchText(query)
  if (!normalizedValue || !normalizedQuery) return 0
  if (normalizedValue === normalizedQuery) return 3_000
  if (normalizedValue.startsWith(normalizedQuery)) return 2_000
  if (normalizedValue.includes(normalizedQuery)) return 1_000
  return 0
}

export function matchesJapaneseStationQuery(name: string, query: string): boolean {
  const normalizedName = normalizePlaceMatchText(name)
  const normalizedQuery = normalizePlaceMatchText(query)
  if (normalizedName === normalizedQuery) return true
  return normalizedQuery.endsWith('駅')
    && normalizedName === normalizedQuery.slice(0, -1)
}

export function japaneseStationNameFromPinLabel(query: string): string | undefined {
  const label = query.trim()
  if (!label || label.length > 80
      || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(label)
      || /〒|\d{3}-?\d{4}/u.test(label)
      || /(?:都|道|府|県|縣).*(?:市|区|區|町|村)/u.test(label)) return undefined
  return label.endsWith('駅') ? label : `${label}駅`
}

function isRomanizedStationName(name: string): boolean {
  return /(?:^|[\s_-])(?:eki|station)$/iu.test(name)
}

function selectGeoapifyName(
  properties: z.infer<typeof GeoapifyFeaturesSchema>[number]['properties'],
  query?: string,
): string {
  if (query?.trim()) {
    const isPoi = properties.result_type === 'amenity' || properties.result_type === 'building'
    const formattedName = properties.formatted?.split(',')[0]?.trim()
    const fields = [
      { value: properties.name, priority: isPoi ? 50 : 30 },
      { value: formattedName, priority: 45 },
      { value: properties.address_line1, priority: 40 },
      { value: properties.suburb, priority: 35 },
      { value: properties.district, priority: 20 },
      { value: properties.city, priority: 10 },
    ]
    let best: { value: string; score: number } | undefined
    for (const field of fields) {
      const value = field.value?.trim()
      if (!value) continue
      const matchScore = geoapifyNameMatchScore(value, query)
      if (matchScore === 0) continue
      const score = matchScore + field.priority
      if (!best || score > best.score) best = { value, score }
    }
    if (best) return best.value
  }

  const resultTypeName = properties.result_type === 'suburb' ? properties.suburb
    : properties.result_type === 'district' ? properties.district
      : properties.result_type === 'city' ? properties.city
        : undefined
  return resultTypeName?.trim()
    || properties.name?.trim()
    || properties.address_line1?.trim()
    || properties.formatted?.split(',')[0]?.trim()
    || properties.place_id
}

function geoapifyCandidateRelevanceScore(candidate: PlaceCandidate, query?: string): number {
  if (!query?.trim()) return 0
  const nameScore = geoapifyNameMatchScore(candidate.name, query)
  if (nameScore > 0) return 10_000 + nameScore
  return candidate.address ? geoapifyNameMatchScore(candidate.address, query) : 0
}

interface ParsedGeoapifyCandidate {
  candidate: PlaceCandidate
  properties: GeoapifyProperties
  relevanceScore: number
  originalIndex: number
}

function normalizedGeoapifyCandidates(raw: unknown, query?: string): ParsedGeoapifyCandidate[] {
  const parsed = GeoapifyFeaturesSchema.safeParse(raw)
  if (!parsed.success) throw new RouteProviderError('geoapify', 502, 'provider returned invalid place results')
  return parsed.data.flatMap(({ properties }, originalIndex) => {
    const timeZone = properties.timezone?.name || properties.time_zone?.name
    const countryCode = properties.country_code?.toUpperCase()
    // Never invent UTC when the provider omitted the IANA zone.
    if (!timeZone || !isValidTimeZone(timeZone) || !countryCode || !/^[A-Z]{2}$/.test(countryCode)) return []
    const candidate: PlaceCandidate = {
      provider: 'geoapify',
      providerPlaceId: properties.place_id,
      name: selectGeoapifyName(properties, query),
      ...(properties.formatted ? { address: properties.formatted } : {}),
      lat: properties.lat,
      lng: properties.lon,
      timeZone,
      countryCode,
    }
    return [{
      candidate,
      properties,
      relevanceScore: geoapifyCandidateRelevanceScore(candidate, query),
      originalIndex,
    }]
  })
}

export function parseGeoapifyFeatures(raw: unknown, query?: string): PlaceCandidate[] {
  const candidates = normalizedGeoapifyCandidates(raw, query)
  candidates.sort((left, right) => {
    const relevance = right.relevanceScore - left.relevanceScore
    return relevance || left.originalIndex - right.originalIndex
  })
  return candidates.map(({ candidate }) => candidate)
}

function reconcileJapaneseStationAlias(
  candidates: PlaceCandidate[],
  query?: string,
  exactTargetCoordinates?: { lat: number; lng: number },
): PlaceCandidate[] {
  if (!query || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return candidates

  const localIndex = candidates.findIndex(candidate =>
    candidate.countryCode === 'JP'
    && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(candidate.name)
    && matchesJapaneseStationQuery(candidate.name, query),
  )
  if (localIndex < 0) {
    const localizedName = japaneseStationNameFromPinLabel(query)
    if (!localizedName || !exactTargetCoordinates) return candidates
    const aliasIndex = candidates.findIndex(candidate =>
      candidate.countryCode === 'JP'
      && isRomanizedStationName(candidate.name)
      && coordinateDistanceMeters(exactTargetCoordinates, candidate) <= 30,
    )
    return aliasIndex < 0
      ? candidates
      : candidates.map((candidate, index) => index === aliasIndex
          ? { ...candidate, name: localizedName }
          : candidate)
  }

  const local = candidates[localIndex]!
  const aliasIndex = candidates.findIndex((candidate, index) =>
    index !== localIndex
    && candidate.countryCode === 'JP'
    && isRomanizedStationName(candidate.name)
    && coordinateDistanceMeters(local, candidate) <= 30,
  )
  if (aliasIndex < 0) return candidates

  return candidates.flatMap((candidate, index) => {
    if (index === aliasIndex) return []
    if (index !== localIndex || candidate.name.endsWith('駅')) return [candidate]
    return [{ ...candidate, name: `${candidate.name}駅` }]
  })
}

export function dedupePlaceCandidates(
  candidates: PlaceCandidate[],
  query?: string,
  exactTargetCoordinates?: { lat: number; lng: number },
): PlaceCandidate[] {
  const placeIds = new Set<string>()
  const coordinateKeys = new Set<string>()
  return reconcileJapaneseStationAlias(candidates, query, exactTargetCoordinates).flatMap(candidate => {
    const coordinateKey = `${candidate.lat.toFixed(6)},${candidate.lng.toFixed(6)}`
    if (placeIds.has(candidate.providerPlaceId) || coordinateKeys.has(coordinateKey)) return []
    placeIds.add(candidate.providerPlaceId)
    coordinateKeys.add(coordinateKey)
    return [candidate]
  }).slice(0, 5)
}

function coordinateDistanceMeters(
  left: { lat: number; lng: number },
  right: { lat: number; lng: number },
): number {
  const radians = Math.PI / 180
  const lat1 = left.lat * radians
  const lat2 = right.lat * radians
  const deltaLat = (right.lat - left.lat) * radians
  const deltaLng = (right.lng - left.lng) * radians
  const sinLat = Math.sin(deltaLat / 2)
  const sinLng = Math.sin(deltaLng / 2)
  const haversine = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  const a = Math.min(1, Math.max(0, haversine))
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return true
  } catch {
    return false
  }
}

function parseAllowedGoogleMapsUrl(rawUrl: string): URL {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new RouteProviderError('google-maps', 400, 'invalid Google Maps URL') }
  if (url.protocol !== 'https:') {
    throw new RouteProviderError('google-maps', 400, 'Google Maps URL must use HTTPS')
  }

  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const isShortLink = host === 'maps.app.goo.gl' || (host === 'goo.gl' && path.startsWith('/maps'))
  const isGoogleDomain =
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    /(?:^|\.)google\.(?:com?\.)?[a-z]{2,3}$/.test(host)
  const isMapsPage = isGoogleDomain && (host.startsWith('maps.google.') || path.startsWith('/maps'))
  if (!isShortLink && !isMapsPage) {
    throw new RouteProviderError('google-maps', 400, 'Google Maps URL hostname is not allowed')
  }
  return url
}

function parseCoordinates(latRaw: string, lngRaw: string): { lat: number; lng: number } | undefined {
  const lat = Number(latRaw)
  const lng = Number(lngRaw)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined
  return { lat, lng }
}

/**
 * Google 的日本地址標籤可能以前置國名與郵遞碼開頭。只移除可明確辨識的
 * 郵遞前綴，不拆解縣／市／區，避免破壞「大阪市立美術館」等正式名稱。
 */
export function cleanGoogleMapsPlaceQuery(query: string): string {
  const trimmed = query.trim()
  const postalPrefix = /^(?:日本[\s,、，]*)?〒\s*\d{3}-?\d{4}[\s,、，]*/u
  const cleaned = trimmed.replace(postalPrefix, '').trim()
  return cleaned || trimmed
}

const GOOGLE_PLACE_TYPE_PAYLOAD_MAX_LENGTH = 1_024

/**
 * `!15s` 是 Google 分享網址內的不穩定 protobuf 片段，只能作搜尋提示。
 * 僅接受有界、合法的 base64/base64url，且只辨識完整的車站 token；
 * 任何格式差異都回到既有 label + pin 流程，不能讓 URL 解析失敗。
 */
function googleMapsPlaceTypeHint(pathname: string): GoogleMapsPlaceTarget['placeTypeHint'] {
  const encodedMatch = /!15s([^!?#]+)/i.exec(pathname)
  if (!encodedMatch?.[1] || encodedMatch[1].length > GOOGLE_PLACE_TYPE_PAYLOAD_MAX_LENGTH) return undefined

  try {
    const encoded = decodeURIComponent(encodedMatch[1])
    if (!encoded || encoded.length > GOOGLE_PLACE_TYPE_PAYLOAD_MAX_LENGTH
        || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return undefined

    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    if (base64.length % 4 === 1) return undefined
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    return /(?:^|[^A-Za-z0-9_])train_station(?:$|[^A-Za-z0-9_])/.test(decoded)
      ? 'train_station'
      : undefined
  } catch {
    return undefined
  }
}

function googleMapsTarget(url: URL): GoogleMapsPlaceTarget | undefined {
  const query = url.searchParams.get('q') || url.searchParams.get('query')
  const trimmedQuery = query?.trim().slice(0, 200)
  const placeMatch = /\/maps\/place\/([^/]+)/i.exec(url.pathname)
  let placeQuery: string | undefined
  if (placeMatch?.[1]) {
    try {
      placeQuery = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).slice(0, 200)
    } catch {
      throw new RouteProviderError('google-maps', 400, 'Google Maps place query is invalid')
    }
  }
  const queryText = trimmedQuery || placeQuery
  const queryCoordinates = queryText
    ? /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(queryText)
    : null
  const targetQuery = queryCoordinates ? undefined : queryText
  const dataCoordinates = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i.exec(url.pathname)
  const explicitCoordinates = dataCoordinates?.[1] && dataCoordinates[2]
    ? parseCoordinates(dataCoordinates[1], dataCoordinates[2])
    : undefined
  const coordinates = explicitCoordinates || (queryCoordinates?.[1] && queryCoordinates[2]
    ? parseCoordinates(queryCoordinates[1], queryCoordinates[2])
    : undefined)
  const placeTypeHint = googleMapsPlaceTypeHint(url.pathname)
  if (!targetQuery && !coordinates) return undefined
  return {
    ...(targetQuery ? { query: targetQuery } : {}),
    ...(coordinates ? { coordinates } : {}),
    ...(placeTypeHint ? { placeTypeHint } : {}),
  }
}

export function safeGoogleMapsQuery(rawUrl: string): string {
  const target = googleMapsTarget(parseAllowedGoogleMapsUrl(rawUrl))
  const query = target?.query || (target?.coordinates
    ? `${target.coordinates.lat},${target.coordinates.lng}`
    : undefined)
  if (query) return query
  throw new RouteProviderError('google-maps', 400, 'Google Maps URL has no place query')
}

export async function resolveGoogleMapsUrl(rawUrl: string, fetchImpl: FetchLike = fetch): Promise<GoogleMapsPlaceTarget> {
  let current = rawUrl
  for (let hop = 0; hop <= 3; hop += 1) {
    // Validate every redirect before fetching it to keep the resolver SSRF-safe.
    const currentUrl = parseAllowedGoogleMapsUrl(current)
    const target = googleMapsTarget(currentUrl)
    if (target) return target
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location')
      if (!location || hop === 3) throw new RouteProviderError('google-maps', 400, 'Google Maps redirect chain is invalid')
      const next = new URL(location, current).toString()
      parseAllowedGoogleMapsUrl(next)
      current = next
      continue
    }
    if (!response.ok) throw new RouteProviderError('google-maps', response.status, 'Google Maps URL could not be resolved')
    await readBoundedText(response, 64 * 1024, 'google-maps')
    throw new RouteProviderError('google-maps', 400, 'Google Maps URL has no place query')
  }
  throw new RouteProviderError('google-maps', 400, 'Google Maps redirect limit exceeded')
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function readBoundedText(response: Response, maxBytes: number, provider: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RouteProviderError(provider, 502, 'provider response too large')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('provider response too large').catch(() => undefined)
        throw new RouteProviderError(provider, 502, 'provider response too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike = fetch,
  externalSignal?: AbortSignal,
  timeoutMs = 4_000,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromPreview = () => controller.abort()
  if (externalSignal?.aborted) abortFromPreview()
  else externalSignal?.addEventListener('abort', abortFromPreview, { once: true })
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const body = await readBoundedText(response, PROVIDER_RESPONSE_MAX_BYTES, provider)
    if (!response.ok) throw new RouteProviderError(provider, response.status, `provider request failed (${response.status})`)
    try { return JSON.parse(body) as T } catch { throw new RouteProviderError(provider, 502, 'provider returned invalid JSON') }
  } catch (error) {
    if (error instanceof RouteProviderError) throw error
    if (controller.signal.aborted || (error as { name?: string }).name === 'AbortError') {
      throw new RouteProviderError(provider, 504, 'provider timeout')
    }
    throw new RouteProviderError(provider, 503, 'provider unavailable')
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromPreview)
  }
}

async function providerCacheKey(
  runtime: RouteProviderCacheRuntime,
  kind: string,
  requestShape: unknown,
): Promise<Request> {
  const digest = await stableHash({ version: PROVIDER_CACHE_VERSION, kind, requestShape })
  const url = new URL(`/__route-provider-cache/v${PROVIDER_CACHE_VERSION}/${kind}/${digest}`, runtime.cacheOrigin)
  return new Request(url, { method: 'GET' })
}

async function withProviderCache<T>(
  runtime: RouteProviderCacheRuntime | undefined,
  kind: string,
  requestShape: unknown,
  loadRaw: () => Promise<unknown>,
  parse: (raw: unknown) => T,
): Promise<T> {
  if (!runtime) return parse(await loadRaw())
  const key = await providerCacheKey(runtime, kind, requestShape)
  try {
    const cached = await runtime.cache.match(key)
    if (cached) {
      return parse(JSON.parse(await readBoundedText(cached, PROVIDER_RESPONSE_MAX_BYTES, 'route-cache')) as unknown)
    }
  } catch {
    // Cache is an optimization only. Corrupt/missing edge entries must never
    // make a valid provider request fail.
  }

  const raw = await loadRaw()
  const parsed = parse(raw)
  const cacheWrite = runtime.cache.put(key, new Response(JSON.stringify(raw), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${PROVIDER_CACHE_TTL_SECONDS}`,
    },
  })).catch(() => undefined)
  runtime.waitUntil(cacheWrite)
  return parsed
}

function applyGeoapifyBias(url: URL, options?: PlaceSearchOptions): void {
  if (options?.biasCountryCode && /^[A-Z]{2}$/.test(options.biasCountryCode)) {
    url.searchParams.set('bias', `countrycode:${options.biasCountryCode.toLowerCase()}`)
    return
  }
  if (options?.proximity) {
    url.searchParams.set('bias', `proximity:${options.proximity.lng},${options.proximity.lat}`)
  }
}

const GEOAPIFY_LANGUAGE_BY_COUNTRY: Readonly<Record<string, string>> = {
  JP: 'ja',
  TW: 'zh',
  KR: 'ko',
  CN: 'zh',
  HK: 'zh',
  MO: 'zh',
  TH: 'th',
  SG: 'en',
  MY: 'ms',
  ID: 'id',
  PH: 'en',
  VN: 'vi',
  AU: 'en',
  GB: 'en',
  US: 'en',
  CA: 'en',
}

function applyGeoapifyLanguage(url: URL, options?: PlaceSearchOptions): void {
  const countryCode = options?.normalizationCountryCode
  if (!countryCode) return

  const language = GEOAPIFY_LANGUAGE_BY_COUNTRY[countryCode]
  if (language) url.searchParams.set('lang', language)
}

export async function geoapifyAutocomplete(
  query: string,
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  if (!env.GEOAPIFY_API_KEY) throw new RouteProviderError('geoapify', 503, 'Geoapify is not configured')
  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete')
  url.searchParams.set('text', query)
  url.searchParams.set('limit', '5')
  applyGeoapifyBias(url, options)
  applyGeoapifyLanguage(url, options)
  url.searchParams.set('apiKey', env.GEOAPIFY_API_KEY)
  const response = await fetchJson<{ features: unknown[] }>('geoapify', url.toString(), {}, fetchImpl)
  return parseGeoapifyFeatures(response.features, query)
}

export function normalizePlaceQuery(query: string, countryCode?: string): string {
  if (countryCode !== 'JP') return query
  const normalized = query.replaceAll('鐮', '鎌')
  if (normalized === '江之島' || normalized === '江の島') return '江ノ島'
  if (normalized.endsWith('車站')) return `${normalized.slice(0, -2)}駅`
  if (normalized.endsWith('站')) return `${normalized.slice(0, -1)}駅`
  return normalized
}

/** 日本情境先查明確正規化結果；查無結果才以原文重試一次。 */
export async function geoapifyAutocompleteWithAliases(
  query: string,
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  const normalized = normalizePlaceQuery(query, options?.normalizationCountryCode)
  const normalizedResults = await geoapifyAutocomplete(normalized, env, fetchImpl, options)
  if (normalizedResults.length > 0 || normalized === query) return normalizedResults

  return geoapifyAutocomplete(query, env, fetchImpl, options)
}

export async function geoapifyForwardGeocode(
  query: string,
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  if (!env.GEOAPIFY_API_KEY) throw new RouteProviderError('geoapify', 503, 'Geoapify is not configured')
  const url = new URL('https://api.geoapify.com/v1/geocode/search')
  url.searchParams.set('text', query)
  url.searchParams.set('limit', '5')
  applyGeoapifyBias(url, options)
  applyGeoapifyLanguage(url, options)
  url.searchParams.set('apiKey', env.GEOAPIFY_API_KEY)
  const response = await fetchJson<{ features: unknown[] }>('geoapify', url.toString(), {}, fetchImpl)
  return parseGeoapifyFeatures(response.features, query)
}

export async function geoapifyReverseGeocode(
  coordinates: { lat: number; lng: number },
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
  queryHint?: string,
): Promise<PlaceCandidate[]> {
  const features = await fetchGeoapifyReverseFeatures(coordinates, env, fetchImpl, options)
  return parseGeoapifyFeatures(features, queryHint)
}

async function fetchGeoapifyReverseFeatures(
  coordinates: { lat: number; lng: number },
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
): Promise<unknown[]> {
  if (!env.GEOAPIFY_API_KEY) throw new RouteProviderError('geoapify', 503, 'Geoapify is not configured')
  if (!Number.isFinite(coordinates.lat) || coordinates.lat < -90 || coordinates.lat > 90
      || !Number.isFinite(coordinates.lng) || coordinates.lng < -180 || coordinates.lng > 180) {
    throw new RouteProviderError('geoapify', 400, 'reverse geocoding coordinates are invalid')
  }
  const url = new URL('https://api.geoapify.com/v1/geocode/reverse')
  url.searchParams.set('lat', String(coordinates.lat))
  url.searchParams.set('lon', String(coordinates.lng))
  url.searchParams.set('limit', '5')
  applyGeoapifyLanguage(url, options)
  url.searchParams.set('apiKey', env.GEOAPIFY_API_KEY)
  const response = await fetchJson<{ features: unknown[] }>('geoapify', url.toString(), {}, fetchImpl)
  return response.features
}

export async function geoapifyReverseGeocodeMetadata(
  coordinates: { lat: number; lng: number },
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  options?: PlaceSearchOptions,
): Promise<GeoapifyPinMetadata | undefined> {
  const features = await fetchGeoapifyReverseFeatures(coordinates, env, fetchImpl, options)
  return parseGeoapifyPinMetadata(features, coordinates)
}

export async function orsMatrix(
  locations: Array<{ lat: number; lng: number }>,
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
  cacheRuntime?: RouteProviderCacheRuntime,
): Promise<OrsMatrixResult> {
  const apiKey = env.ORS_API_KEY
  if (!apiKey) throw new RouteProviderError('ors', 503, 'ORS is not configured')
  if (locations.length < 2 || locations.length > 12) throw new RouteProviderError('ors', 400, 'route matrix requires 2-12 locations')
  const url = 'https://api.openrouteservice.org/v2/matrix/foot-walking'
  const body = {
    locations: locations.map(location => [location.lng, location.lat]),
    metrics: ['distance', 'duration'],
  }
  return withProviderCache(cacheRuntime, 'ors-matrix-foot-walking', body, () => fetchJson('ors', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify(body),
  }, fetchImpl, signal, 12_000), raw => parseOrsMatrixResponse(raw, locations.length))
}

export async function orsDirections(
  locations: Array<{ lat: number; lng: number }>,
  env: RouteProviderEnv,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
  cacheRuntime?: RouteProviderCacheRuntime,
): Promise<OrsDirectionsResult> {
  const apiKey = env.ORS_API_KEY
  if (!apiKey) throw new RouteProviderError('ors', 503, 'ORS is not configured')
  if (locations.length < 2 || locations.length > 12) throw new RouteProviderError('ors', 400, 'directions require 2-12 locations')
  const url = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson'
  const body = { coordinates: locations.map(location => [location.lng, location.lat]) }
  return withProviderCache(cacheRuntime, 'ors-directions-foot-walking', body, () => fetchJson('ors', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify(body),
  }, fetchImpl, signal, 12_000), parseOrsDirectionsResponse)
}
