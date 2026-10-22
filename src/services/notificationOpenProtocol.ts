// src/services/notificationOpenProtocol.ts
// Service Worker 與 client 之間「通知點擊」的協定與純函式。
//
// 這個模組同時被 src/sw.ts（vite-plugin-pwa injectManifest 建置）與 client
// import，所以：
//   - 不得引用任何 SW 專屬全域（self.clients / registration / skipWaiting…）；
//     需要的東西（Cache、時鐘、client 清單）一律由呼叫端注入，才能單元測試。
//   - 不 import zod（SW bundle 不需要那份重量）；client 端另以 Zod 再驗一次
//     （features/account/notificationOpen.ts），SW 只做手寫的最小驗證。
//
// 為什麼不再用 `client.navigate(url)`：那是整頁導覽，開著的草稿與暫停中的
// mutation（只存在記憶體）會一起消失。已開視窗改成 postMessage 交給 client
// 處理器決定（帳號比對、成員檢查、草稿保護）；冷啟動的 openWindow 只帶不透明
// nonce，完整 payload 留在 SW，uid 不進網址或瀏覽歷史。
import {
  NOTIFICATION_ROUTES,
  NOTIFICATION_SCOPES,
  type NotificationRoute,
  type NotificationScope,
} from '../types/notificationRoute'

export const NOTIFICATION_OPEN_MESSAGE = 'NOTIFICATION_OPEN'
export const NOTIFICATION_PAYLOAD_REQUEST = 'NOTIFICATION_PAYLOAD_REQUEST'
export const NOTIFICATION_PAYLOAD_RESPONSE = 'NOTIFICATION_PAYLOAD'

/** 冷啟動 URL 的 query key；值是不透明 nonce，本身不帶任何資料。 */
export const NOTIFY_QUERY_PARAM = 'notify'
/** 冷啟動落地頁：nonce 取不到 / 過期時就停在這裡（App 的預設頁）。 */
export const NOTIFY_LAUNCH_PATH = '/schedule'
/** openWindow → client 啟動 → 索取 payload 的窗口。數分鐘足以涵蓋慢速啟動。 */
export const NOTIFY_NONCE_TTL_MS = 5 * 60_000
export const NOTIFY_CACHE_NAME = 'tripmate-notification-open'

const TRIP_ID_MAX = 200
const UID_MAX = 128
const NONCE_PATTERN = /^[A-Za-z0-9-]{16,64}$/

export interface NotificationOpenPayload {
  scope:     NotificationScope
  route:     NotificationRoute
  tripId:    string
  /** 缺失時 client 一律不導航（無法證明這則通知屬於目前登入者）。 */
  targetUid?: string
}

export interface NotificationOpenMessage extends NotificationOpenPayload {
  type: typeof NOTIFICATION_OPEN_MESSAGE
}

export interface NotificationPayloadRequest {
  type:  typeof NOTIFICATION_PAYLOAD_REQUEST
  nonce: string
}

export interface NotificationPayloadResponse {
  type:    typeof NOTIFICATION_PAYLOAD_RESPONSE
  payload: NotificationOpenPayload | null
}

function isRoute(value: unknown): value is NotificationRoute {
  return typeof value === 'string' && (NOTIFICATION_ROUTES as readonly string[]).includes(value)
}

function isScope(value: unknown): value is NotificationScope {
  return typeof value === 'string' && (NOTIFICATION_SCOPES as readonly string[]).includes(value)
}

/**
 * 驗證任意值是否為合法的通知點擊 payload；不合法回 null。
 * scope 與 route 必須配對：account ⇔ /account。account 通知的收件人已失去
 * 旅程存取，trip 通知若指向 /account 則是格式錯誤，兩者都不該被導航。
 */
export function parseNotificationOpenPayload(raw: unknown): NotificationOpenPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isScope(r.scope) || !isRoute(r.route)) return null
  if ((r.scope === 'account') !== (r.route === '/account')) return null
  if (typeof r.tripId !== 'string' || r.tripId.length === 0 || r.tripId.length > TRIP_ID_MAX) return null
  let targetUid: string | undefined
  if (r.targetUid !== undefined && r.targetUid !== null && r.targetUid !== '') {
    if (typeof r.targetUid !== 'string' || r.targetUid.length > UID_MAX) return null
    targetUid = r.targetUid
  }
  const payload: NotificationOpenPayload = { scope: r.scope, route: r.route, tripId: r.tripId }
  if (targetUid !== undefined) payload.targetUid = targetUid
  return payload
}

/** FCM data payload（全部是字串）→ 點擊 payload。Functions 把 route 放在 `url`。 */
export function payloadFromPushData(data: Record<string, string> | undefined): NotificationOpenPayload | null {
  if (!data) return null
  return parseNotificationOpenPayload({
    scope:     data.scope,
    route:     data.url,
    tripId:    data.tripId,
    targetUid: data.targetUid,
  })
}

export function notificationOpenMessage(payload: NotificationOpenPayload): NotificationOpenMessage {
  return { type: NOTIFICATION_OPEN_MESSAGE, ...payload }
}

export function isNotificationPayloadRequest(data: unknown): data is NotificationPayloadRequest {
  return typeof data === 'object' && data !== null
    && (data as { type?: unknown }).type === NOTIFICATION_PAYLOAD_REQUEST
}

export function isValidNotifyNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce)
}

/** 冷啟動 openWindow 的相對 URL：只有落地頁 + 不透明 nonce。 */
export function notifyLaunchUrl(nonce: string): string {
  return `${NOTIFY_LAUNCH_PATH}?${NOTIFY_QUERY_PARAM}=${encodeURIComponent(nonce)}`
}

/** 從 location.search 讀出 nonce；格式不符視同沒有。 */
export function readNotifyNonce(search: string): string | null {
  const nonce = new URLSearchParams(search).get(NOTIFY_QUERY_PARAM)
  return isValidNotifyNonce(nonce) ? nonce : null
}

export function hasNotifyParam(search: string): boolean {
  return new URLSearchParams(search).has(NOTIFY_QUERY_PARAM)
}

/** 移除 notify 參數、保留其他 query（回傳含 '?' 或空字串）。 */
export function stripNotifyParam(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(NOTIFY_QUERY_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

// ─── 已開視窗的選擇 ────────────────────────────────────────────────

export interface WindowClientLike {
  url:              string
  focused?:         boolean
  visibilityState?: DocumentVisibilityState
}

/** 優先已 focus 的視窗，其次可見的，最後任一同源視窗；沒有則 undefined。 */
export function chooseWindowClient<T extends WindowClientLike>(clients: readonly T[], origin: string): T | undefined {
  const sameOrigin = clients.filter(c => {
    try { return new URL(c.url).origin === origin } catch { return false }
  })
  return sameOrigin.find(c => c.focused)
    ?? sameOrigin.find(c => c.visibilityState === 'visible')
    ?? sameOrigin[0]
}

// ─── 冷啟動 nonce 暫存 ─────────────────────────────────────────────

/** Cache Storage 的最小子集，方便以假物件測試。 */
export interface CacheLike {
  put(request: string, response: Response): Promise<void>
  match(request: string): Promise<Response | undefined>
  delete(request: string): Promise<boolean>
  keys(): Promise<readonly { url: string }[]>
}

interface StoredRecord {
  payload:   NotificationOpenPayload
  expiresAt: number
}

const EXPIRES_HEADER = 'x-tripmate-expires-at'

export interface NotificationNonceStore {
  save(nonce: string, payload: NotificationOpenPayload): Promise<void>
  /** 一次性：取得即刪除（記憶體與 Cache 都刪），過期或不存在回 null。 */
  take(nonce: string): Promise<NotificationOpenPayload | null>
}

/**
 * 記憶體 Map 為主、Cache Storage 為備援：SW 可能在 openWindow 之後、client
 * 來索取之前被瀏覽器終止，記憶體就沒了。Cache 寫入 / 讀取失敗（配額、隱私
 * 模式）一律吞掉 —— 最差結果是停在預設頁，不影響正確性。
 */
export function createNotificationNonceStore(options: {
  openCache?: () => Promise<CacheLike>
  now?:       () => number
  ttlMs?:     number
} = {}): NotificationNonceStore {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? NOTIFY_NONCE_TTL_MS
  const memory = new Map<string, StoredRecord>()
  const keyFor = (nonce: string) => `/__notification-open/${nonce}`

  async function withCache<R>(fn: (cache: CacheLike) => Promise<R>): Promise<R | undefined> {
    if (!options.openCache) return undefined
    try { return await fn(await options.openCache()) } catch { return undefined }
  }

  function pruneMemory(at: number) {
    for (const [nonce, record] of memory) if (record.expiresAt <= at) memory.delete(nonce)
  }

  async function pruneCache(cache: CacheLike, at: number) {
    for (const request of await cache.keys()) {
      const res = await cache.match(request.url)
      const expiresAt = Number(res?.headers.get(EXPIRES_HEADER))
      if (!Number.isFinite(expiresAt) || expiresAt <= at) await cache.delete(request.url)
    }
  }

  return {
    async save(nonce, payload) {
      const at = now()
      pruneMemory(at)
      const record: StoredRecord = { payload, expiresAt: at + ttlMs }
      memory.set(nonce, record)
      await withCache(async cache => {
        await pruneCache(cache, at)
        await cache.put(keyFor(nonce), new Response(JSON.stringify(record), {
          headers: { 'content-type': 'application/json', [EXPIRES_HEADER]: String(record.expiresAt) },
        }))
      })
    },

    async take(nonce) {
      const at = now()
      let record = memory.get(nonce)
      memory.delete(nonce)
      const cached = await withCache(async cache => {
        const res = await cache.match(keyFor(nonce))
        await cache.delete(keyFor(nonce))
        return res ? await res.json() as unknown : undefined
      })
      if (!record && typeof cached === 'object' && cached !== null) {
        const c = cached as { payload?: unknown; expiresAt?: unknown }
        const payload = parseNotificationOpenPayload(c.payload)
        if (payload && typeof c.expiresAt === 'number') record = { payload, expiresAt: c.expiresAt }
      }
      if (!record || record.expiresAt <= at) return null
      return record.payload
    },
  }
}
