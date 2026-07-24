import { z } from 'zod'
import {
  WORKER_BASE_URL,
  WorkerAmbiguous,
  WorkerRejected,
  preflightIdToken,
  requireWorkerWriteBase,
  workerFetch,
} from '@/services/workerBase'
import { PlaceRefSchema, type PlaceRef } from '@/types/schedule'

const CoordinateSchema = z.tuple([z.number(), z.number()])
const DisplayGeometrySchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'),
    properties: z.object({
      provider: z.enum(['ors', 'reference']),
      mode: z.enum(['walking', 'transit-check']),
      legIndex: z.number().int().nonnegative(),
    }).strict(),
    geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(CoordinateSchema).min(2) }).strict(),
  }).strict()),
}).strict()

const ApplyPlanSchema = z.object({
  revision: z.string().min(16),
  date: z.string(),
  schedules: z.array(z.object({ id: z.string(), order: z.number().int() }).strict()),
}).strict()

const RouteLegBaseSchema = {
  legIndex: z.number().int().nonnegative(),
  fromId: z.string().min(1).max(128),
  toId: z.string().min(1).max(128),
  walkingMinutes: z.number().finite().nonnegative(),
  geometryAvailable: z.boolean(),
}

const RouteLegSchema = z.discriminatedUnion('kind', [
  z.object({ ...RouteLegBaseSchema, kind: z.literal('walking') }).strict(),
  z.object({
    ...RouteLegBaseSchema,
    kind: z.literal('transit-check'),
    transitEstimate: z.object({
      minMinutes: z.number().int().min(1).max(1440),
      maxMinutes: z.number().int().min(1).max(1440),
      basis: z.literal('ors-walking-distance'),
    }).strict().refine(value => value.maxMinutes > value.minMinutes),
  }).strict(),
])

const RoutePreviewSchema = z.object({
  previewRevision: z.string().min(16),
  scheduleInputHash: z.string().min(16),
  payloadHash: z.string().min(16),
  previewToken: z.string().min(32),
  expiresAt: z.string(),
  canApply: z.boolean(),
  routeChanged: z.boolean(),
  geometryDegraded: z.boolean(),
  confidence: z.enum(['walking-verified', 'transit-unverified']),
  timeConflictScheduleIds: z.array(z.string().min(1).max(128)).max(12),
  applyPlan: ApplyPlanSchema,
  display: DisplayGeometrySchema,
  legs: z.array(RouteLegSchema),
}).strict()

export type RoutePreview = z.infer<typeof RoutePreviewSchema>

/** React StrictMode deliberately remounts effects in development. Keep one
 * network request per identical preview input so that verification remounts
 * cannot duplicate paid provider calls or consume a second preview quota. */
const inFlightPreviews = new Map<string, Promise<RoutePreview>>()

export type PlaceCandidate = PlaceRef

const RoutePlaceResolutionSchema = z.object({
  query: z.string().min(1).max(200),
  candidates: z.array(PlaceRefSchema).max(5),
}).strict()

export interface PlaceSearchContext {
  biasCountryCode?: string
  normalizationCountryCode?: string
  proximity?: { lat: number; lng: number }
}

const PLACE_CACHE_TTL_MS = 5 * 60_000
const PLACE_REQUEST_TIMEOUT_MS = 8_000
const placeCache = new Map<string, { expiresAt: number; value: PlaceCandidate[] }>()
const inFlightPlaceRequests = new Map<string, Promise<PlaceCandidate[]>>()
let placeCacheGeneration = 0

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('Worker 回傳的路線資料格式不相容，請確認 Worker 已更新')
  return parsed.data
}

export async function requestRoutePreview(tripId: string, date: string): Promise<RoutePreview> {
  const key = JSON.stringify([tripId, date])
  const existing = inFlightPreviews.get(key)
  if (existing) return existing

  const request = (async () => {
    const token = await preflightIdToken()
    const body = { tripId, date }
    return parseResponse(RoutePreviewSchema, await workerFetch(
      WORKER_BASE_URL,
      token,
      '/route-preview',
      body,
      { timeoutMs: 35_000 },
    ))
  })()
  inFlightPreviews.set(key, request)
  void request.then(
    () => { if (inFlightPreviews.get(key) === request) inFlightPreviews.delete(key) },
    () => { if (inFlightPreviews.get(key) === request) inFlightPreviews.delete(key) },
  )
  return request
}

type RouteOperation = 'preview' | 'apply'

const ROUTE_ERROR_COPY: Readonly<Record<string, string>> = {
  PREVIEW_STALE: '行程已變更，請重新產生預覽',
  ROUTE_MEMBER_INACTIVE: '你目前無法編輯此旅程',
  ROUTE_EDITOR_REQUIRED: '你沒有整理此行程的權限',
  ROUTE_SCHEDULE_COUNT_INVALID: '當日需有 2–12 個行程才能整理',
  ROUTE_SCHEDULES_INVALID: '請先補齊行程時間與已驗證地點',
  ROUTE_TIMEZONE_MISMATCH: '同一天的地點時區不同，請先拆分行程',
  ROUTE_ORDER_INVALID: '路線排序結果不完整，請重新產生預覽',
  ROUTE_PREVIEW_DEADLINE: '路線預覽逾時，請稍後再試',
  ROUTE_PROVIDER_ERROR: '路線服務暫時無法使用，請稍後再試',
  ROUTE_NOT_CONFIGURED: '路線服務尚未完成設定',
  PREVIEW_TOKEN_INVALID: '預覽已過期，請重新產生預覽',
  PREVIEW_ACTOR_MISMATCH: '此預覽不屬於目前登入的帳號',
  PREVIEW_PAYLOAD_MISMATCH: '預覽內容已變更，請重新產生預覽',
  REVISION_CONFLICT: '此預覽版本已被其他內容使用，請重新產生預覽',
  FORBIDDEN: '你沒有整理此行程的權限',
}

/** Convert the typed Worker protocol into stable user-facing copy. Backend
 * details stay available on the error for diagnostics but never render in UI. */
export function routeErrorMessage(reason: unknown, operation: RouteOperation): string {
  if (reason instanceof WorkerRejected) {
    const stableCopy = reason.code ? ROUTE_ERROR_COPY[reason.code] : undefined
    if (stableCopy) return stableCopy
    if (reason.status === 401) return '登入狀態已失效，請重新登入後再試'
    if (reason.status === 403) return '你沒有整理此行程的權限'
    if (reason.status === 429) return '操作太頻繁，請稍後再試'
    if (reason.status === 504) return '路線預覽逾時，請稍後再試'
  }
  if (reason instanceof WorkerAmbiguous) {
    return operation === 'apply'
      ? '套用結果尚在確認中，請稍後重新整理'
      : '路線服務暫時沒有回應，請稍後再試'
  }
  if (reason instanceof Error && reason.message.startsWith('Worker 回傳的路線資料格式不相容')) {
    return reason.message
  }
  return operation === 'apply'
    ? '無法套用行程順序，請重新預覽後再試'
    : '無法產生路線預覽，請稍後再試'
}

function placeBias(context: PlaceSearchContext): Record<string, unknown> | undefined {
  const bias = {
    ...(context.biasCountryCode ? { countryCode: context.biasCountryCode } : {}),
    ...(context.normalizationCountryCode ? { normalizationCountryCode: context.normalizationCountryCode } : {}),
    ...(context.proximity ? { proximity: context.proximity } : {}),
  }
  return Object.keys(bias).length > 0 ? bias : undefined
}

function placeRequestKey(mode: string, tripId: string, query: string, context: PlaceSearchContext): string {
  return JSON.stringify([mode, tripId, query.trim(), placeBias(context) ?? null])
}

function cachedPlaceRequest(key: string, load: () => Promise<PlaceCandidate[]>): Promise<PlaceCandidate[]> {
  const now = Date.now()
  const cached = placeCache.get(key)
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value)
  if (cached) placeCache.delete(key)
  const existing = inFlightPlaceRequests.get(key)
  if (existing) return existing

  const generation = placeCacheGeneration
  const request = load().then(value => {
    if (placeCacheGeneration === generation) {
      placeCache.set(key, { expiresAt: Date.now() + PLACE_CACHE_TTL_MS, value })
    }
    return value
  })
  inFlightPlaceRequests.set(key, request)
  void request.then(
    () => { if (inFlightPlaceRequests.get(key) === request) inFlightPlaceRequests.delete(key) },
    () => { if (inFlightPlaceRequests.get(key) === request) inFlightPlaceRequests.delete(key) },
  )
  return request
}

function observeCallerAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    void request.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function clearRoutePlaceSearchCache(): void {
  placeCacheGeneration += 1
  placeCache.clear()
  inFlightPlaceRequests.clear()
}

export function requestRouteAutocomplete(
  tripId: string,
  query: string,
  signal: AbortSignal,
  context: PlaceSearchContext = {},
): Promise<PlaceCandidate[]> {
  const key = placeRequestKey('autocomplete', tripId, query, context)
  const request = cachedPlaceRequest(key, async () => {
    const token = await preflightIdToken()
    const bias = placeBias(context)
    const response = await fetch(`${WORKER_BASE_URL}/route-autocomplete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId, query, ...(bias ? { bias } : {}) }),
      signal: AbortSignal.timeout(PLACE_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`地點搜尋失敗 (${response.status})`)
    const body: unknown = await response.json()
    return parseResponse(z.array(PlaceRefSchema), body)
  })
  return observeCallerAbort(request, signal)
}

export async function requestRoutePlaceResolution(
  tripId: string,
  googleMapsUrl: string,
  signal: AbortSignal,
  context: PlaceSearchContext = {},
): Promise<PlaceCandidate[]> {
  const key = placeRequestKey('google-maps', tripId, googleMapsUrl, context)
  const request = cachedPlaceRequest(key, async () => {
    const token = await preflightIdToken()
    const bias = placeBias(context)
    const response = await fetch(`${WORKER_BASE_URL}/route-resolve-place`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId, googleMapsUrl, ...(bias ? { bias } : {}) }),
      signal: AbortSignal.timeout(PLACE_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Google Maps 連結解析失敗 (${response.status})`)
    const body: unknown = await response.json()
    return parseResponse(RoutePlaceResolutionSchema, body).candidates
  })
  return observeCallerAbort(request, signal)
}

export async function applyRoutePreview(tripId: string, preview: RoutePreview): Promise<{ status: 'applied' | 'already_applied'; revision: string }> {
  const token = await preflightIdToken()
  const base = requireWorkerWriteBase()
  try {
    const result = await workerFetch(base, token, '/route-apply', {
      tripId,
      revision: preview.applyPlan.revision,
      date: preview.applyPlan.date,
      previewToken: preview.previewToken,
      schedules: preview.applyPlan.schedules,
    })
    return parseResponse(z.object({ status: z.enum(['applied', 'already_applied']), revision: z.string() }).strict(), result)
  } catch (reason) {
    if (!(reason instanceof WorkerAmbiguous)) throw reason
    for (const delayMs of [0, 300]) {
      if (delayMs > 0) await new Promise(resolve => window.setTimeout(resolve, delayMs))
      try {
        const recovered = await fetchRouteApplyStatus(base, token, tripId, preview.applyPlan.revision)
        if (recovered.status === 'applied') {
          return { status: 'already_applied', revision: recovered.revision }
        }
      } catch {
        // A failed status read cannot prove whether the transaction committed.
        break
      }
    }
    // Preserve the original ambiguous apply result after bounded recovery.
    throw reason
  }
}

export async function getRouteApplyStatus(tripId: string, revision: string): Promise<{ status: 'applied' | 'not_found'; revision: string }> {
  const token = await preflightIdToken()
  return fetchRouteApplyStatus(requireWorkerWriteBase(), token, tripId, revision)
}

async function fetchRouteApplyStatus(
  base: string,
  token: string,
  tripId: string,
  revision: string,
): Promise<{ status: 'applied' | 'not_found'; revision: string }> {
  return parseResponse(
    z.object({ status: z.enum(['applied', 'not_found']), revision: z.string(), appliedAt: z.string().optional() }).strict(),
    await workerFetch(base, token, '/route-apply-status', { tripId, revision }),
  )
}
