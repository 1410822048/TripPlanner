// src/features/account/notificationOpen.ts
// 推播通知點擊的 client 端處理器。SW 不再自己導航（`client.navigate()` 是整頁
// 導覽，會清掉草稿與暫停中的 mutation），而是把 { scope, route, tripId,
// targetUid } 交給這裡：
//   - 已開視窗：SW `postMessage({ type: 'NOTIFICATION_OPEN', ... })`
//   - 冷啟動：網址只帶 `?notify=<nonce>`，啟動後以 MessageChannel 向 SW 索取
// 兩條路徑都進同一個 pending store，由同一個決策函式處理：
//   1. Zod 驗證 route / scope（白名單），不合法直接忽略
//   2. 等 auth 解析完成；targetUid 缺失或與目前登入者不符 → 不導航、不切旅程
//   3. trip scope：等旅程清單就緒 → 必須仍是成員 → 無開著的草稿 → 切旅程 + 導航
//      account scope（member.removed_self）：不要求成員、不切旅程，導向 /account；
//      草稿保護同樣適用
import { useEffect, useSyncExternalStore } from 'react'
import type { To } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '@/hooks/useAuth'
import { isAnyDraftModalOpen } from '@/hooks/draftModalRegistry'
import { useMyTrips } from '@/features/trips/hooks/useTrips'
import { useTripStore } from '@/store/tripStore'
import { toast } from '@/shared/toast'
import { NotificationRouteSchema, NotificationScopeSchema, type NotificationRoute } from '@/types/notification'
import {
  NOTIFICATION_OPEN_MESSAGE,
  NOTIFICATION_PAYLOAD_REQUEST,
  NOTIFICATION_PAYLOAD_RESPONSE,
  hasNotifyParam,
  readNotifyNonce,
  stripNotifyParam,
} from '@/services/notificationOpenProtocol'

// ─── Schema ────────────────────────────────────────────────────────

export const NotificationOpenPayloadSchema = z.object({
  scope:     NotificationScopeSchema,
  route:     NotificationRouteSchema,
  tripId:    z.string().min(1).max(200),
  targetUid: z.string().max(128).optional(),
}).refine(p => (p.scope === 'account') === (p.route === '/account'), {
  message: 'scope / route mismatch',
})
export type NotificationOpenIntent = z.infer<typeof NotificationOpenPayloadSchema>

// ─── 文案 ──────────────────────────────────────────────────────────

export const NOTIFICATION_OPEN_COPY = {
  unknownRecipient: '無法確認這則通知的收件帳號，請從通知收件匣查看',
  otherAccount:     '這則通知屬於其他帳號，請切換帳號後再查看',
  signedOut:        '請先登入通知所屬的帳號再查看',
  authError:        '目前無法確認登入狀態，請稍後再從通知收件匣查看',
  tripsError:       '無法載入旅程清單，請稍後再從通知收件匣查看',
  notMember:        '你已不是這個旅程的成員，無法開啟這則通知',
  draftOpen:        '有尚未儲存的表單，已保留目前畫面；儲存或關閉後再從通知收件匣查看',
} as const

// ─── 決策（純函式）─────────────────────────────────────────────────

export type NotificationOpenAuth =
  | { status: 'loading' }
  | { status: 'signed-in'; uid: string }
  | { status: 'signed-out' }
  | { status: 'error' }

export type NotificationOpenTrips =
  | { status: 'pending' }
  | { status: 'error' }
  | { status: 'ready'; tripIds: readonly string[] }

export type NotificationOpenDecision =
  | { kind: 'wait' }
  | { kind: 'reject'; message: string; tone: 'info' | 'error' }
  | { kind: 'navigate'; route: NotificationRoute; tripId: string | null }

export function decideNotificationOpen(input: {
  intent:    NotificationOpenIntent
  auth:      NotificationOpenAuth
  trips:     NotificationOpenTrips
  draftOpen: boolean
}): NotificationOpenDecision {
  const { intent, auth, trips, draftOpen } = input
  const reject = (message: string, tone: 'info' | 'error' = 'info'): NotificationOpenDecision =>
    ({ kind: 'reject', message, tone })

  if (auth.status === 'loading') return { kind: 'wait' }
  if (auth.status === 'error') return reject(NOTIFICATION_OPEN_COPY.authError, 'error')
  // 帳號隔離先於一切：別人的通知絕不導航、也不碰 tripStore。
  if (!intent.targetUid) return reject(NOTIFICATION_OPEN_COPY.unknownRecipient)
  if (auth.status === 'signed-out') return reject(NOTIFICATION_OPEN_COPY.signedOut)
  if (auth.uid !== intent.targetUid) return reject(NOTIFICATION_OPEN_COPY.otherAccount)

  if (intent.scope === 'account') {
    if (draftOpen) return reject(NOTIFICATION_OPEN_COPY.draftOpen)
    return { kind: 'navigate', route: '/account', tripId: null }
  }

  if (trips.status === 'pending') return { kind: 'wait' }
  if (trips.status === 'error') return reject(NOTIFICATION_OPEN_COPY.tripsError, 'error')
  if (!trips.tripIds.includes(intent.tripId)) return reject(NOTIFICATION_OPEN_COPY.notMember)
  if (draftOpen) return reject(NOTIFICATION_OPEN_COPY.draftOpen)
  return { kind: 'navigate', route: intent.route, tripId: intent.tripId }
}

// ─── Pending store（module singleton，useSyncExternalStore）─────────

interface PendingNotificationOpen {
  intent:     NotificationOpenIntent
  receivedAt: number
}

/** 等 auth / 旅程清單的上限。超過就靜默放棄，避免很久以後突然被導走。 */
export const PENDING_NOTIFICATION_OPEN_TTL_MS = 2 * 60_000

let pending: PendingNotificationOpen | null = null
const listeners = new Set<() => void>()

function setPending(next: PendingNotificationOpen | null) {
  pending = next
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function getSnapshot(): PendingNotificationOpen | null {
  return pending
}

/** 驗證並排入一筆通知點擊；不合法（含 route 不在白名單）回 false 並忽略。
 *  後到的點擊取代尚未處理的前一筆。 */
export function enqueueNotificationOpen(raw: unknown): boolean {
  const parsed = NotificationOpenPayloadSchema.safeParse(raw)
  if (!parsed.success) return false
  setPending({ intent: parsed.data, receivedAt: Date.now() })
  return true
}

/** Compare-and-clear：只有 store 仍是這一筆時才取走。StrictMode 重跑 effect
 *  或新點擊已取代時回 false，確保一筆點擊最多執行一次。 */
function takePending(expected: PendingNotificationOpen): boolean {
  if (pending !== expected) return false
  setPending(null)
  return true
}

// ─── SW bridge ─────────────────────────────────────────────────────

interface MessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void
}

/** navigator.serviceWorker 的最小子集，測試以假物件注入。 */
export interface ServiceWorkerBridge {
  controller: MessageTarget | null
  ready:      Promise<{ active: MessageTarget | null }>
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  startMessages?(): void
}

export interface NotificationOpenRouter {
  state:    { location: { pathname: string; search: string; hash: string } }
  navigate: (to: To, opts?: { replace?: boolean }) => unknown
}

const LAUNCH_REQUEST_TIMEOUT_MS = 5_000
let launchNonceHandled = false

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/** 以 MessageChannel 向 SW 索取 nonce 對應的 payload；失敗 / 逾時回 null。 */
async function requestLaunchPayload(bridge: ServiceWorkerBridge, nonce: string): Promise<unknown> {
  const target = bridge.controller ?? (await timeout(bridge.ready, LAUNCH_REQUEST_TIMEOUT_MS))?.active ?? null
  if (!target) return null
  return await new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (value: unknown) => {
      clearTimeout(timer)
      channel.port1.onmessage = null
      channel.port1.close()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), LAUNCH_REQUEST_TIMEOUT_MS)
    channel.port1.onmessage = event => {
      const data = event.data as { type?: unknown; payload?: unknown } | null
      finish(data?.type === NOTIFICATION_PAYLOAD_RESPONSE ? data.payload : null)
    }
    try {
      target.postMessage({ type: NOTIFICATION_PAYLOAD_REQUEST, nonce }, [channel.port2])
    } catch {
      finish(null)
    }
  })
}

function stripLaunchQuery(router: NotificationOpenRouter) {
  const { pathname, search, hash } = router.state.location
  if (!hasNotifyParam(search)) return
  void router.navigate({ pathname, search: stripNotifyParam(search), hash }, { replace: true })
}

const listening = new WeakSet<ServiceWorkerBridge>()

/**
 * 掛上 SW → client 的通知訊息監聽（冪等，保留到頁面結束）。
 * 必須在 main.tsx 模組載入時呼叫：client message queue 會在 DOMContentLoaded
 * 自動開啟，晚於此才掛（例如 React effect）會漏掉載入中視窗先收到的訊息。
 */
export function listenForNotificationOpen(bridge: ServiceWorkerBridge | null = defaultBridge()): void {
  if (!bridge || listening.has(bridge)) return
  listening.add(bridge)
  bridge.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null
    if (data?.type !== NOTIFICATION_OPEN_MESSAGE) return
    enqueueNotificationOpen(data)
  })
  // addEventListener 不會自動開啟 client message queue（onmessage 才會）。
  bridge.startMessages?.()
}

/** 處理冷啟動 nonce（每次頁面載入一次），並確保訊息監聽已掛上。 */
export function attachNotificationOpenBridge(
  router: NotificationOpenRouter,
  bridge: ServiceWorkerBridge | null,
): void {
  if (!launchNonceHandled) {
    const nonce = readNotifyNonce(router.state.location.search)
    if (nonce || hasNotifyParam(router.state.location.search)) {
      launchNonceHandled = true
      void (async () => {
        const payload = nonce && bridge ? await requestLaunchPayload(bridge, nonce) : null
        // 完成後才清 query；取不到 payload / 過期就停在預設頁。
        stripLaunchQuery(router)
        if (payload) enqueueNotificationOpen(payload)
      })()
    }
  }

  listenForNotificationOpen(bridge)
}

function defaultBridge(): ServiceWorkerBridge | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  return navigator.serviceWorker as unknown as ServiceWorkerBridge
}

// ─── Hook ──────────────────────────────────────────────────────────

function applyDecision(decision: Exclude<NotificationOpenDecision, { kind: 'wait' }>, router: NotificationOpenRouter) {
  if (decision.kind === 'reject') {
    if (decision.tone === 'error') toast.error(decision.message)
    else toast.info(decision.message)
    return
  }
  if (decision.tripId) useTripStore.getState().setSelectedTripId(decision.tripId)
  if (router.state.location.pathname !== decision.route) void router.navigate(decision.route)
}

export function useNotificationOpenHandler(
  router: NotificationOpenRouter,
  bridge: ServiceWorkerBridge | null = defaultBridge(),
): void {
  useEffect(() => { attachNotificationOpenBridge(router, bridge) }, [router, bridge])

  const pendingOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // 有待處理的點擊才強制啟動 auth（平常沿用 hint，demo 訪客不載 Auth SDK）。
  const { state } = useAuth(pendingOpen ? true : undefined)
  const uid = state.status === 'signed-in' ? state.user.uid : undefined
  // 只有確認是本人的 trip 通知才讀旅程清單（共用既有 listener）。
  const wantsTrips = pendingOpen?.intent.scope === 'trip' && !!uid && uid === pendingOpen.intent.targetUid
  const trips = useMyTrips(wantsTrips ? uid : undefined)

  useEffect(() => {
    if (!pendingOpen) return
    const remaining = pendingOpen.receivedAt + PENDING_NOTIFICATION_OPEN_TTL_MS - Date.now()
    if (remaining <= 0) {
      takePending(pendingOpen)
      return
    }
    const auth: NotificationOpenAuth =
      state.status === 'signed-in' ? { status: 'signed-in', uid: state.user.uid }
        : state.status === 'loading' ? { status: 'loading' }
          : state.status === 'error' ? { status: 'error' }
            : { status: 'signed-out' }
    const tripsInput: NotificationOpenTrips =
      trips.status === 'error' ? { status: 'error' }
        : trips.data ? { status: 'ready', tripIds: trips.data.map(t => t.id) }
          : { status: 'pending' }
    const decision = decideNotificationOpen({
      intent:    pendingOpen.intent,
      auth,
      trips:     tripsInput,
      draftOpen: isAnyDraftModalOpen(),
    })
    if (decision.kind === 'wait') {
      const timer = setTimeout(() => takePending(pendingOpen), remaining)
      return () => clearTimeout(timer)
    }
    if (!takePending(pendingOpen)) return
    applyDecision(decision, router)
  }, [pendingOpen, state, trips.status, trips.data, router])
}

/** 掛在 App 根層（RouterProvider 之外，涵蓋 standalone 路由）。 */
export function NotificationOpenHandler({ router }: { router: NotificationOpenRouter }): null {
  useNotificationOpenHandler(router)
  return null
}

/** 測試用：重設 module 狀態。 */
export function __resetNotificationOpenForTests(): void {
  pending = null
  launchNonceHandled = false
}
