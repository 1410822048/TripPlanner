# TripMate Push Notifications Implementation Spec v1

日期：2026-06-29

狀態：可拆 ticket 的實作規格。此文件補足 `push-notifications-p1.md` 的工程細節；仍不代表已開始改產品程式碼。

## 0. 結論

P1 採用 Firebase Cloud Functions v2 Firestore triggers + Firebase Cloud Messaging Web。

不採用 MagicBell / OneSignal；不把推播做成第二套 unread inbox；不使用 `trip.lastActivityByFeature` 當 push source。

P1 實作範圍收斂為：

- expense create / update / soft-delete
- settlement create / delete
- booking create / update
- member joined

P1 不推：

- schedule：保留資料模型與偏好欄位，但 trigger 不啟用。行程通常有多人連續編輯，P1 先避免噪音。
- wish vote：只用紅點。
- planning toggle：只用紅點。

## 1. 目前專案約束

### 1.1 既有 PWA

目前 `vite.config.ts` 使用 `VitePWA({ workbox: ... })` 的 generateSW 模式。FCM background push 需要 service worker handler；若另外放根目錄 `firebase-messaging-sw.js`，會跟現有 root-scope service worker 競爭。

決策：

- 將 VitePWA 改成 `injectManifest`。
- 建立單一自訂 `src/sw.ts`，同時負責 Workbox precache/runtime cache 與 FCM background handler。
- 不新增 `public/firebase-messaging-sw.js`。

### 1.2 既有 Firebase lazy loading

目前 `src/services/firebase.ts` 已把 Firestore / Auth / Storage 拆成 lazy bundle。Messaging 必須照同樣模式處理，不能讓未登入 / demo 使用者載入 messaging SDK。

決策：

- 新增 `getFirebaseMessaging()`。
- 只在 Account notification settings 或 foreground message listener 需要時載入。
- 未登入不載入 messaging。

### 1.3 既有紅點

`useFeatureBadges` 讀 `trip.lastActivityByFeature`。該欄位目前是 client-writable，而且 `by` 欄位刻意沒有 server-side 強驗證。

決策：

- 紅點繼續使用 `lastActivityByFeature`。
- 推播絕不從 `lastActivityByFeature` 觸發。
- 推播從 entity document write trigger re-derive。

### 1.4 既有 Worker

`workers/ocr` 是 Cloudflare Worker，已有 admin service account、rate limit、membership、expense、booking、settlement write endpoints。

決策：

- 不新增 `/notify-*` Worker endpoint 作為 P1 主路徑。
- 原因：目前仍有 client SDK 直寫的 entity，Worker endpoint 無法完整觀察所有寫入。
- 若未來所有 entity write 都改 Worker-authoritative，可再評估把 push delivery 移進 Worker 或 shared server package。

### 1.5 既有 `functions/`

`functions/` 目前是 Cloudflare Pages Functions，處理 Firebase Auth helper path，不是 Firebase Cloud Functions。

決策：

- 新增 `firebase-functions/` 作為 Firebase Functions source。
- 不把 Firebase Functions 放進現有 `functions/`，避免 runtime/tsconfig 混淆。

## 2. 官方文件約束

實作需要遵守以下事實：

- FCM Web 支援前景與背景不同處理。前景由頁面 `onMessage` 處理；背景或頁面關閉時由 service worker background handler 處理。
- FCM Web `getToken` 可以傳入既有 `ServiceWorkerRegistration`。不傳時才要求根目錄 `firebase-messaging-sw.js`。
- Server 發送使用 Firebase Admin SDK 或 FCM HTTP v1。P1 在 Firebase Functions 裡使用 Admin SDK。
- Firestore triggers v2 支援 document written/created/updated/deleted 與 Auth Context。delete 事件優先用 auth context 判斷 actor；Worker/admin 寫入再 fallback 到文件欄位。
- Notification permission 必須由使用者互動觸發。
- iOS/iPadOS Web Push 只支援加入 Home Screen 的 Web App。
- VitePWA `injectManifest` 允許自訂 service worker 並注入 precache manifest。

參考：

- https://firebase.google.com/docs/cloud-messaging/web/get-started
- https://firebase.google.com/docs/cloud-messaging/web/receive-messages
- https://firebase.google.com/docs/cloud-messaging/send/admin-sdk
- https://firebase.google.com/docs/firestore/extend-with-functions-2nd-gen
- https://firebase.google.com/docs/functions/firestore-events
- https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.firestore
- https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://vite-pwa-org.netlify.app/guide/inject-manifest

## 3. 檔案變更清單

### 3.1 Root config

修改：

- `package.json`
  - `workspaces` 加入 `firebase-functions`。
  - scripts 新增：
    - `functions:build`
    - `functions:test`
    - `functions:artifacts:keep-one`
    - `functions:revisions:keep-one`
    - `functions:deploy`
    - `notifications:clear`
    - `deploy:prod`
- `package-lock.json`
  - npm install 後更新。
- `firebase.json`
  - 新增 `"functions"` block。
- `firestore.rules`
  - 新增 users/pushTokens rules。
  - 新增 `_pushEvents` default deny。
- `firestore.indexes.json`
  - P1 不需要新 index，除非後續 `_pushEvents` 做 query dashboard。
- `.env.example` 或 README env section
  - 新增 `VITE_FIREBASE_VAPID_KEY`。

### 3.2 Client

修改：

- `src/services/firebase.ts`
  - 新增 Messaging lazy bundle。
- `src/features/account/components/AccountPage.tsx`
  - 加入 `NotificationSettings`。
- `src/layouts/AppLayout.tsx`
  - 掛 foreground push listener，或由獨立 `PushMessageBridge` 掛在 layout。
- `vite.config.ts`
  - `VitePWA` 改 `strategies: 'injectManifest'`。
  - 把現有 Workbox runtime cache 移到 `src/sw.ts`。

新增：

- `src/features/account/components/NotificationSettings.tsx`
- `src/features/account/hooks/usePushNotifications.ts`
- `src/features/account/services/pushTokenService.ts`
- `src/features/account/services/pushTokenService.test.ts`
- `src/services/pushMessaging.ts`
- `src/services/pushRoutes.ts`
- `src/sw.ts`
- `src/sw-env.d.ts`

### 3.3 Firebase Functions

新增：

```text
firebase-functions/
  package.json
  tsconfig.json
  src/
    index.ts
    app.ts
    events.ts
    eventId.ts
    payload.ts
    prefs.ts
    recipients.ts
    tokens.ts
    send.ts
    templates.ts
    firestore.ts
    logger.ts
    __tests__/
      eventId.test.ts
      payload.test.ts
      prefs.test.ts
      recipients.test.ts
      templates.test.ts
```

### 3.4 Rules tests

新增或修改：

- `tests/rules/firestore.test.ts`
  - push token own-read/write allow。
  - other-user token read/write deny。
  - prefs own-read/write allow。
  - `_pushEvents` client read/write deny。
  - token field type/length/enum deny。

## 4. Dependency plan

Root client side already has `firebase`.

Firebase Functions package：

```json
{
  "name": "tripmate-firebase-functions",
  "private": true,
  "type": "module",
  "engines": {
    "node": "22"
  },
  "main": "lib/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "firebase-admin": "latest",
    "firebase-functions": "latest",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "~6.0.2",
    "vitest": "^4.1.8"
  }
}
```

Node runtime：

- 先用 Firebase CLI 確認可用 runtime。
- 若 `nodejs22` 可用，使用 Node 22。
- 若本機或專案 CLI 不支援，退回 Node 20，不影響 P1 設計。

## 5. Env and secrets

Client env：

```text
VITE_FIREBASE_VAPID_KEY=<FCM Web Push certificate public key>
```

Firebase Functions：

- 使用 Firebase Admin SDK 的 Application Default Credentials。
- 不需要把 FCM server key 放到 client。
- 不需要 Cloudflare Worker secret。

Firebase Console：

- Cloud Messaging -> Web Push certificates -> Generate key pair。
- VAPID public key 放進 Cloudflare Pages env 與本地 `.env`。

## 6. Firestore data model

### 6.1 Push token

```ts
interface PushTokenDoc {
  token: string
  tokenHash: string
  platform: 'web'
  provider: 'fcm'
  permission: 'granted'
  swScope: string
  appVersion?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  lastSeenAt: Timestamp
  disabledAt: Timestamp | null
  disabledReason?: 'user-disabled' | 'permission-revoked' | 'fcm-unregistered' | 'send-failed'
}
```

Path：

```text
users/{uid}/pushTokens/{tokenHash}
```

Rules intent：

- user 只能管理自己的 token。
- user 不能讀其他人的 token。
- token 長度 cap 4096。
- `platform/provider/permission` enum 固定。
- client create 時 `disabledAt` 必須為 null。
- client update 只能 refresh `lastSeenAt/updatedAt/appVersion`、re-enable 同一 token、或 user-disable。
- server invalid-token cleanup 走 Admin SDK bypass rules。

### 6.2 Default prefs

```ts
interface NotificationPrefsDoc {
  enabled: boolean
  types: {
    memberJoined: boolean
    expense: boolean
    settlement: boolean
    booking: boolean
    schedule: boolean
  }
  updatedAt: Timestamp
}
```

Path：

```text
users/{uid}/notificationPrefs/default
```

P1 defaults：

```ts
const DEFAULT_PREFS = {
  enabled: true,
  types: {
    memberJoined: true,
    expense: true,
    settlement: true,
    booking: true,
    schedule: false,
  },
}
```

### 6.3 Per-trip prefs

```ts
interface TripNotificationPrefsDoc {
  enabled: boolean
  mutedUntil: Timestamp | null
  types?: Partial<NotificationPrefsDoc['types']>
  updatedAt: Timestamp
}
```

Path：

```text
users/{uid}/tripNotificationPrefs/{tripId}
```

Rules intent：

- user 只能管理自己的 trip prefs。
- user 必須仍是 `trips/{tripId}.memberIds` 成員。
- 若離開 trip，client 不能再更新該 trip prefs；舊 doc 可由 server cleanup 或保留。

### 6.4 Push event dedupe

```ts
interface PushEventDoc {
  eventId: string
  tripId: string
  entityType: 'expense' | 'settlement' | 'booking' | 'member'
  entityId: string
  action: 'created' | 'updated' | 'deleted' | 'joined'
  actorUid: string
  recipientUids: string[]
  createdAt: Timestamp
  status: 'pending' | 'sent' | 'partial' | 'failed'
  sentCount: number
  failedCount: number
  errorCodes?: Record<string, number>
}
```

Path：

```text
_pushEvents/{eventId}
```

Rules：

- client read/write 全部 deny。
- Functions admin SDK only。

## 7. Firestore rules shape

正式 patch 時不要直接貼草案；要拆 create/update/delete，並補 rules tests。

```js
match /users/{userId} {
  allow read, write: if false;

  function isSelfUser() {
    return isSignedIn() && userId == uid();
  }

  function validPushTokenCreate() {
    return request.resource.data.keys().hasOnly([
      'token','tokenHash','platform','provider','permission','swScope',
      'appVersion','createdAt','updatedAt','lastSeenAt',
      'disabledAt','disabledReason'
    ])
    && request.resource.data.token is string
    && request.resource.data.token.size() > 20
    && request.resource.data.token.size() <= 4096
    && request.resource.data.tokenHash is string
    && request.resource.data.tokenHash.size() == 64
    && request.resource.data.platform == 'web'
    && request.resource.data.provider == 'fcm'
    && request.resource.data.permission == 'granted'
    && request.resource.data.swScope is string
    && request.resource.data.swScope.size() <= 200
    && request.resource.data.createdAt == request.time
    && request.resource.data.updatedAt == request.time
    && request.resource.data.lastSeenAt == request.time
    && request.resource.data.disabledAt == null
    && (!('disabledReason' in request.resource.data));
  }

  function validPushTokenRefresh() {
    return unchanged('token')
      && unchanged('tokenHash')
      && unchanged('platform')
      && unchanged('provider')
      && unchanged('permission')
      && unchanged('createdAt')
      && changedOnly(['updatedAt','lastSeenAt','appVersion'])
      && request.resource.data.updatedAt == request.time
      && request.resource.data.lastSeenAt == request.time;
  }

  function validPushTokenUserDisable() {
    return unchanged('token')
      && unchanged('tokenHash')
      && unchanged('platform')
      && unchanged('provider')
      && unchanged('permission')
      && unchanged('createdAt')
      && changedOnly(['updatedAt','disabledAt','disabledReason'])
      && request.resource.data.updatedAt == request.time
      && request.resource.data.disabledAt == request.time
      && request.resource.data.disabledReason in ['user-disabled','permission-revoked'];
  }

  match /pushTokens/{tokenId} {
    allow get, list: if isSelfUser();
    allow create: if isSelfUser()
      && tokenId == request.resource.data.tokenHash
      && validPushTokenCreate();
    allow update: if isSelfUser()
      && (validPushTokenRefresh() || validPushTokenUserDisable());
    allow delete: if isSelfUser();
  }

  match /notificationPrefs/{prefId} {
    allow get, list: if isSelfUser();
    allow create, update: if isSelfUser()
      && prefId == 'default'
      && validNotificationPrefs();
    allow delete: if isSelfUser()
      && prefId == 'default';
  }

  match /tripNotificationPrefs/{tripId} {
    allow get, list: if isSelfUser();
    allow create, update: if isSelfUser()
      && uid() in get(tripPath(tripId)).data.memberIds
      && validTripNotificationPrefs();
    allow delete: if isSelfUser();
  }
}

match /_pushEvents/{eventId} {
  allow read, write: if false;
}
```

注意：

- `unchanged()` / `changedOnly()` 已在現有 rules 定義，可沿用。
- `validNotificationPrefs()` / `validTripNotificationPrefs()` 要明確 gate keys 與 bool type。
- 如果 rules simulator 對 `request.time` + create/update 有測試 friction，可先用 serverTimestamp 寫入，再在 tests 中使用 emulator API 驗證。

## 8. Client implementation details

### 8.1 Messaging lazy loader

`src/services/firebase.ts` 新增：

```ts
import type { Messaging } from 'firebase/messaging'
import type * as messagingModule from 'firebase/messaging'

export type MessagingModule = typeof messagingModule

export interface MessagingBundle extends MessagingModule {
  messaging: Messaging
}

let messagingBundlePromise: Promise<MessagingBundle | null> | null = null

export function getFirebaseMessaging(): Promise<MessagingBundle | null> {
  if (messagingBundlePromise) return messagingBundlePromise
  messagingBundlePromise = (async () => {
    const [app, msg] = await Promise.all([getApp(), import('firebase/messaging')])
    const supported = await msg.isSupported().catch(() => false)
    if (!supported) return null
    return { messaging: msg.getMessaging(app), ...msg }
  })()
  return messagingBundlePromise
}
```

### 8.2 Token hash

`src/features/account/services/pushTokenService.ts`：

```ts
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
```

### 8.3 Service worker registration

Token flow 必須使用現有 PWA registration：

```ts
const registration = await navigator.serviceWorker.ready
const token = await getToken(messaging, {
  vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
  serviceWorkerRegistration: registration,
})
```

禁止：

- 不要省略 `serviceWorkerRegistration`。
- 不要新增第二個 root service worker。

### 8.4 Hook state machine

`usePushNotifications` 回傳：

```ts
type PushSupport =
  | 'checking'
  | 'supported'
  | 'unsupported'
  | 'ios-not-installed'

type PushPermission =
  | 'default'
  | 'granted'
  | 'denied'
  | 'unknown'

type PushSubscriptionState =
  | 'signed-out'
  | 'unsupported'
  | 'blocked'
  | 'not-enabled'
  | 'enabling'
  | 'enabled'
  | 'disabling'
  | 'error'

interface UsePushNotificationsResult {
  support: PushSupport
  state: PushSubscriptionState
  error: string | null
  enable(): Promise<void>
  disable(): Promise<void>
  refresh(): Promise<void>
}
```

狀態轉移：

| From | Event | To | Side effect |
|---|---|---|---|
| signed-out | user signs in | not-enabled / enabled | read own token docs |
| not-enabled | enable click | enabling | request permission |
| enabling | permission denied | blocked | no token write |
| enabling | permission granted + token saved | enabled | write pushTokens doc |
| enabled | disable click | disabling | mark own token disabled |
| disabling | write ok | not-enabled | local state reset |
| any | unsupported detected | unsupported | no prompt |
| enabled | permission revoked detected | blocked | mark token permission-revoked |

Permission prompt rules：

- `Notification.requestPermission()` 只能在 `enable()` 裡呼叫。
- 不在 page load、render、effect 中自動呼叫。
- `denied` 後只顯示靜態狀態，不再主動彈 prompt。

### 8.5 UI

`NotificationSettings` 放在 Account signed-in profile card 下方，樣式遵守現有 operational UI：

- 不做 hero。
- 使用 `Bell`, `BellOff`, `Loader2`, `AlertCircle` lucide icons。
- 主 row 顯示：
  - title：`通知`
  - subtitle：
    - unsupported：`この環境では通知を利用できません`
    - ios not installed：`ホーム画面に追加すると通知を利用できます`
    - denied：`ブラウザで通知がブロックされています`
    - enabled：`重要な更新を通知します`
    - disabled：`通知はオフです`
- control：
  - enabled -> toggle on
  - disabled -> toggle off
  - enabling/disabling -> spinner

不要在 UI 寫教學長文；狀態文字短句即可。

### 8.6 Foreground messages（P2 起移除，見下）

~~新增 `useForegroundPushMessages()`：~~

- ~~掛在 signed-in layout。~~
- ~~`onMessage(messaging, payload => ...)`。~~
- ~~若 `payload.data.route` 是目前路由，只顯示更低干擾 toast 或不顯示。~~
- ~~不呼叫 `new Notification()`。~~
- ~~toast 使用既有 `toast`，不新增 notification UI stack。~~

**2026-07-01 P2 更新**：`useForegroundPushMessages` 已整支移除。持久訊息匣上線後，前景不再 toast；鈴鐺的已讀/未讀改由 `users/{uid}/notifications` 的獨立 realtime listener 驅動（`useNotifications`），不依賴 FCM `onMessage` 事件本身——該 listener 在 Functions 寫入通知 doc 後即會更新，時序上不晚於 FCM 送達，因此 `onMessage` 監聽器移除後鈴鐺狀態沒有任何缺口。連帶移除的還有 `PUSH_TOKEN_ENABLED_EVENT` / `announcePushTokenEnabled()`（原本唯一的用途就是讓這支 hook 在使用者剛開啟權限後重新 attach）。

## 9. Service worker implementation details

### 9.1 VitePWA config target

`vite.config.ts` 改為：

```ts
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',
  includeAssets: [...existing],
  manifest: { ...existing },
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    globIgnores: [
      '**/vendor-sentry-*.js',
      '**/vendor-firebase-firestore-*.js',
      '**/vendor-firebase-auth-*.js',
    ],
  },
})
```

注意：

- generateSW 的 `workbox.runtimeCaching` 不會自動搬到 injectManifest。
- 現有 runtimeCaching 要在 `src/sw.ts` 手寫 `registerRoute`。

### 9.2 `src/sw.ts`

主要內容：

```ts
import { initializeApp } from 'firebase/app'
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare let self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  /^https:\/\/fonts\.googleapis\.com\/.*/i,
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 })],
  }),
)

registerRoute(
  /\/assets\/vendor-sentry-.*\.js$/,
  new CacheFirst({
    cacheName: 'vendor-sentry-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 3, maxAgeSeconds: 90 * 24 * 60 * 60 })],
  }),
)

registerRoute(
  /\/assets\/vendor-firebase-(firestore|auth)-.*\.js$/,
  new CacheFirst({
    cacheName: 'vendor-firebase-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 90 * 24 * 60 * 60 })],
  }),
)

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})

const messaging = getMessaging(app)

onBackgroundMessage(messaging, payload => {
  const title = payload.notification?.title ?? 'TripMate'
  const body = payload.notification?.body ?? '更新があります'
  const route = payload.data?.route ?? '/schedule'

  self.registration.showNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    badge: '/favicon-32x32.png',
    data: { route, eventId: payload.data?.eventId },
  })
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const route = typeof event.notification.data?.route === 'string'
    ? event.notification.data.route
    : '/schedule'
  event.waitUntil(openOrFocusClient(route))
})
```

`openOrFocusClient(route)`：

- `clients.matchAll({ type: 'window', includeUncontrolled: true })`
- 若已有同 origin client，focus 並 `client.navigate(route)`。
- 否則 `clients.openWindow(route)`。

### 9.3 SW QA 必測

- install prompt 還能出現。
- PwaUpdatePrompt 還能提示更新，不自動 reload。
- offline shell 還能載入。
- Firebase auth/firestore chunk runtime cache 還存在。
- notification click 可以 focus existing window。
- notification click 可以 open new window。

## 10. Server implementation details

### 10.1 Trigger style

使用 Auth Context triggers：

```ts
import {
  onDocumentWrittenWithAuthContext,
  onDocumentCreatedWithAuthContext,
} from 'firebase-functions/v2/firestore'
```

若本機 SDK 版本 API 名稱不同，以官方 reference 為準，但必須保留 Auth Context 能力。

### 10.2 Actor resolution

```ts
function resolveActorUid(eventAuth: AuthContext | undefined, after: Entity | null, before: Entity | null): string | null {
  if (eventAuth?.authType === 'user' && eventAuth.authId) return eventAuth.authId
  return after?.updatedBy
    ?? after?.createdBy
    ?? after?.settledBy
    ?? before?.updatedBy
    ?? before?.createdBy
    ?? before?.settledBy
    ?? null
}
```

規則：

- user-auth client write：優先 auth context。
- Worker/admin write：auth context 可能是 service account，改用 doc fields。
- actor 無法解析：skip push，寫 `_pushEvents.status = failed` 或 log error，不要發給所有人。

### 10.3 Event normalization

```ts
type PushEntityType = 'expense' | 'settlement' | 'booking' | 'member'
type PushAction = 'created' | 'updated' | 'deleted' | 'joined'

interface NormalizedPushEvent {
  eventId: string
  tripId: string
  entityType: PushEntityType
  entityId: string
  action: PushAction
  actorUid: string
  recipientHint?: 'trip-members' | 'settlement-parties'
  route: '/expense' | '/bookings' | '/schedule'
  templateKey:
    | 'expense.created'
    | 'expense.updated'
    | 'expense.deleted'
    | 'settlement.created'
    | 'settlement.deleted'
    | 'booking.created'
    | 'booking.updated'
    | 'member.joined'
}
```

### 10.4 Event ID

Preferred：

```ts
eventId = cloudEvent.id
```

Fallback：

```ts
eventId = `${entityType}:${tripId}:${entityId}:${action}:${updatedAtMillis ?? createdAtMillis ?? Date.now()}`
```

Dedupe：

- Transaction create `_pushEvents/{eventId}`。
- 若 doc exists，return early。
- 寫入 `pending` 後才送。
- 送完 update `sent/partial/failed`。

### 10.5 Recipients

Trip-member event：

```ts
recipients = trip.memberIds.filter(uid => uid !== actorUid)
```

Settlement event：

```ts
recipients = unique([settlement.fromUid, settlement.toUid]).filter(uid => uid !== actorUid)
```

Member joined：

```ts
recipients = trip.memberIds.filter(uid => uid !== joinedUid)
```

注意：

- 不信任 client 傳 recipients。
- 不從 `_pushEvents.recipientUids` 反推權限，該欄位只是 audit output。
- `memberIds` 缺失或空陣列：skip and log，避免錯發。

### 10.6 Pref filtering

Pseudo：

```ts
async function canSendTo(uid: string, tripId: string, type: PushType, now: Timestamp): Promise<boolean> {
  const defaultPrefs = await loadDefaultPrefs(uid)
  if (!defaultPrefs.enabled) return false
  if (!defaultPrefs.types[type]) return false

  const tripPrefs = await loadTripPrefs(uid, tripId)
  if (!tripPrefs) return true
  if (!tripPrefs.enabled) return false
  if (tripPrefs.mutedUntil && tripPrefs.mutedUntil.toMillis() > now.toMillis()) return false
  if (tripPrefs.types?.[type] === false) return false
  return true
}
```

Missing prefs：

- default = enabled with P1 defaults。
- tripPrefs missing = inherit default。

### 10.7 Token filtering

Query：

```text
users/{uid}/pushTokens where disabledAt == null
```

若 subcollection query per recipient 成本太高，P1 可直接 list each recipient tokens；N 通常很小。不要先做 denormalized global token index，避免資料外洩面增加。

### 10.8 FCM send

使用 Firebase Admin SDK：

```ts
await getMessaging().sendEach(tokens.map(record => ({
  token: record.token,
  data: {
    title: 'TripMate',
    body,
    url: route,
    tag: `${tripId}:${entityType}:${entityId}`,
    tripId,
    entityType,
    entityId,
    eventId,
    targetUid: record.uid,
  },
})))
```

注意：

- 使用 data-only message；系統通知由 `src/sw.ts` 決定是否顯示，避免 FCM/browser 自動顯示繞過 owner gate。
- 使用 `sendEach`，讓同一批次內每個 token 都能帶自己的 `targetUid`。
- FCM batch 上限依 Admin SDK 文件限制實作 chunking；保守用 500 messages per batch。
- data values 必須是 string。

### 10.9 Invalid token cleanup

若單筆 response error code 是：

- `messaging/registration-token-not-registered`
- `messaging/invalid-registration-token`
- `messaging/invalid-argument` 且 token 明顯 invalid

則用 Admin SDK update：

```ts
disabledAt = FieldValue.serverTimestamp()
disabledReason = 'fcm-unregistered'
```

不要 delete，保留 audit 與避免短期反覆建立。

## 11. Payload schema

### 11.1 Data payload

```ts
const PushDataSchema = z.object({
  type: z.enum(['memberJoined', 'expense', 'settlement', 'booking']),
  tripId: z.string().min(1).max(128),
  entityType: z.enum(['member', 'expense', 'settlement', 'booking']),
  entityId: z.string().min(1).max(128),
  route: z.enum(['/schedule', '/expense', '/bookings']),
  eventId: z.string().min(1).max(256),
})
```

### 11.2 Notification copy

P1 server-side templates：

```ts
const TEMPLATES = {
  'member.joined': {
    body: 'メンバーが参加しました',
    route: '/schedule',
  },
  'expense.created': {
    body: '費用が追加されました',
    route: '/expense',
  },
  'expense.updated': {
    body: '費用が更新されました',
    route: '/expense',
  },
  'expense.deleted': {
    body: '費用が削除されました',
    route: '/expense',
  },
  'settlement.created': {
    body: '精算が記録されました',
    route: '/expense',
  },
  'settlement.deleted': {
    body: '精算記録が削除されました',
    route: '/expense',
  },
  'booking.created': {
    body: '予約情報が追加されました',
    route: '/bookings',
  },
  'booking.updated': {
    body: '予約情報が更新されました',
    route: '/bookings',
  },
} as const
```

禁止放進 notification/body/data：

- 金額
- 店名
- 住宿地址
- confirmation code
- invite token
- receipt path/url
- user email
- Google photo URL
- 任意 client-provided title/body

## 12. Entity trigger rules

### 12.1 Expense

Path：

```text
trips/{tripId}/expenses/{expenseId}
```

Trigger：

- written with auth context。

Action：

- before missing, after exists, `deletedAt == null` -> `expense.created`
- before exists alive, after exists alive, meaningful fields changed -> `expense.updated`
- before exists alive, after exists tombstoned -> `expense.deleted`
- receiptPurgedAt-only update -> skip
- settlementLockIds-only update -> skip

Actor：

- auth context user if present
- else `after.updatedBy`
- delete fallback `before.updatedBy`

Recipients：

- trip members except actor。

### 12.2 Settlement

Path：

```text
trips/{tripId}/settlements/{settlementId}
```

Trigger：

- written with auth context。

Action：

- create -> `settlement.created`
- delete -> `settlement.deleted`
- update should not happen; if happens, skip and log。

Actor：

- auth context user if present
- else `after.settledBy`
- delete fallback `before.settledBy`

Recipients：

- P1 only `[fromUid, toUid] - actorUid`。

### 12.3 Booking

Path：

```text
trips/{tripId}/bookings/{bookingId}
```

Trigger：

- written with auth context。

Action：

- create -> `booking.created`
- update meaningful fields -> `booking.updated`
- delete -> P1 skip。Booking delete 可以只走紅點，避免 delete actor fallback 失真與通知噪音。

Meaningful fields：

- type/title/origin/destination/provider/checkIn/checkOut/address/link/note/coverImage/document/sortDate

Skip：

- memberIds-only cascade。
- updatedAt-only no-op。

Recipients：

- trip members except actor。

### 12.4 Member joined

Path：

```text
trips/{tripId}/members/{memberId}
```

Trigger：

- created with auth context。

Action：

- if role owner bootstrap and trip newly created -> skip。避免建立旅程時通知自己。
- otherwise `member.joined`。

Actor：

- `memberId` / `after.userId`。

Recipients：

- trip members except joined uid。

## 13. Test plan

### 13.1 Rules tests

新增 cases：

- signed-in user can create own push token with valid shape。
- signed-in user cannot create token under another uid。
- signed-in user cannot set `disabledReason = fcm-unregistered` on create。
- signed-in user can refresh own `lastSeenAt`。
- signed-in user cannot mutate token string after create。
- signed-in user can user-disable own token。
- signed-in user cannot read another user's token。
- client cannot read/write `_pushEvents`。
- user can update own default prefs with valid bool map。
- user cannot add arbitrary pref key。
- user cannot create trip prefs for trip they are not a member of。

### 13.2 Client unit tests

- `sha256Hex` stable output。
- unsupported browser returns `unsupported` and never calls permission prompt。
- enable denied -> state blocked, no Firestore write。
- enable granted -> calls `getToken` with `serviceWorkerRegistration`。
- disable -> writes `disabledAt` path。
- revoked permission detection -> disables token as permission-revoked。

### 13.3 Functions unit tests

- eventId dedupe returns skip on existing doc。
- actor resolution prefers auth context user。
- actor resolution falls back to `updatedBy` for admin writes。
- expense receiptPurgedAt-only update skip。
- expense soft-delete sends deleted。
- settlement sends only from/to, not all trip members。
- booking memberIds-only update skip。
- template output never includes entity title/amount/address。
- invalid token cleanup marks disabled。

### 13.4 Emulator / integration tests

- Firestore write to expense create creates `_pushEvents` and calls mocked messaging send。
- Duplicate trigger event does not send twice。
- user with trip muted receives no send。
- user with default disabled receives no send。
- actor does not receive own notification。

### 13.5 Manual QA

Chrome desktop：

- permission default -> enable -> token doc exists。
- foreground message -> toast only。
- background tab -> system notification。
- closed PWA/window -> notification if browser supports it。
- notification click focuses existing window。
- notification click opens new window。

Android Chrome：

- installed PWA enable。
- background notification。
- click deep-link。

iOS/iPadOS 16.4+：

- Safari tab not installed -> unsupported or Home Screen hint。
- Home Screen app -> permission request from button。
- background notification。
- click opens Home Screen app route。

Regression：

- install prompt still works。
- update prompt still works。
- offline shell still works。
- auth redirect `/__/auth/*` still bypasses SPA fallback。

## 14. Deployment plan

### 14.1 Phase order

1. Rules/data model + tests。
2. Client token opt-in behind UI。
3. SW injectManifest migration without server push enabled。
4. Functions deploy with only test notification callable or dev trigger。
5. Enable P1 triggers。
6. Rollout to production。

### 14.2 Commands

Preflight：

```powershell
npx.cmd -y firebase-tools@latest login
npx.cmd -y firebase-tools@latest firestore:databases:list
npx.cmd -y firebase-tools@latest firestore:databases:get "(default)"
```

Build/test：

```powershell
npm run typecheck
npm run build
npm run test:rules
npm --prefix firebase-functions run build
npm --prefix firebase-functions test
```

Deploy：

```powershell
npm run deploy:prod                   # pages build -> indexes -> functions -> prune -> rules -> pages upload
npm run functions:deploy              # push functions only + prune revisions/images
npm run functions:artifacts:keep-one  # 手動修剪 Artifact Registry runtime images；需 gcloud CLI
npm run functions:revisions:keep-one  # 手動修剪 Cloud Run revisions；需 gcloud CLI
```

### 14.3 Rollback

If client SW breaks：

- Revert VitePWA injectManifest commit。
- Redeploy Pages。
- Existing bad SW may remain until update; use PwaUpdatePrompt/manual reload path。

If Functions spam：

- `firebase functions:delete <functionName>` or deploy env flag disabling triggers。
- Keep client token docs; no need to delete。

If rules block token writes：

- Deploy rules rollback。
- Client shows toast/error; no data corruption。

## 15. Open decisions closed for P1

### 15.1 Schedule push

Decision：P1 不啟用。

Reason：schedule 編輯頻率高，容易變成噪音。紅點足夠。

### 15.2 Settlement recipients

Decision：只通知 `fromUid` / `toUid` 雙方。

Reason：清算是雙邊行為，通知全旅程成員是過度打擾。

### 15.3 iOS unsupported UI

Decision：顯示短狀態，不做教學頁。

Text：`ホーム画面に追加すると通知を利用できます`

### 15.4 App icon badge

Decision：P1 不做。

Reason：先把 push delivery、SW migration、token lifecycle 做穩；badge 可獨立 P1.1。

## 16. Definition of Done

P1 完成必須同時滿足：

- 未登入與 demo 不載入 messaging bundle。
- 不點 Account 通知開關，不請求 permission。
- FCM token doc 只能自己讀寫。
- 自己新增 expense 不收到自己的 push。
- 其他成員依 prefs 收到 expense push。
- settlement 只通知雙方。
- foreground 只 toast，不彈系統通知。
- background notification click deep-link 正確。
- duplicate trigger 不重複送。
- invalid token 會被 disabled。
- `trip.lastActivityByFeature` 沒有被任何 push trigger 使用。
- `firebase-messaging-sw.js` 沒有新增。
- PWA install/update/offline 沒退化。
- rules tests、Functions tests、client tests、build 全過。
