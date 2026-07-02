# TripMate Push Notifications P1 規劃書

日期：2026-06-29

## 1. 目標

TripMate 的推播不做行銷平台，不複製所有紅點事件；P1 只做「使用者不在 App 內時，值得被打斷的協作通知」。

P1 目標：

- 使用者可在 Account 頁主動開啟 / 關閉瀏覽器通知。
- App 背景或關閉時，收到高價值協作事件的系統通知。
- App 前景時，不彈系統通知，改用既有 toast / in-app feedback。
- 點通知可 deep-link 回對應 tab，例如 `/expense`、`/bookings`、`/schedule`。
- 不通知事件發起者自己。
- 尊重使用者偏好：全域關閉、依旅程靜音、依類型關閉。

非目標：

- 不做 MagicBell / OneSignal 類的 dashboard、journey、A/B test、segmentation、email/SMS multi-channel。
- ~~不做完整通知中心 inbox。紅點仍是 App 內未讀狀態的唯一來源。~~ **此條已於 2026-07-01 由 P2「持久訊息匣」規劃取代**：鈴鐺新增獨立的已讀/未讀狀態，來源是 `users/{uid}/notifications`。既有的 tab 紅點（`lastActivityByFeature`）不受影響，維持原邏輯。
- P1 不推 wish vote / planning checklist，避免低價值通知疲勞。

## 2. 官方限制與前提

- Firebase Cloud Messaging Web 需要瀏覽器支援 Push API；前景訊息走 `onMessage`，背景 / 關閉狀態需要 service worker 處理背景訊息。
- FCM Web 可使用既有 service worker registration 取得 token；若不傳 registration，預設要求根目錄有 `firebase-messaging-sw.js`。
- iOS / iPadOS Web Push 只對「加入主畫面的 Web App」開放，不是一般 Safari 分頁都能收到。
- Notification permission 只能在使用者明確互動後請求；不能在頁面載入時自動跳 permission prompt。
- 目前 `npx firebase-tools firestore:databases:list` 失敗：本機 Firebase CLI 未登入，無法在此規劃階段確認 Firestore edition。實作 rules 前需重新登入後確認。

參考：

- Firebase FCM Web get started: https://firebase.google.com/docs/cloud-messaging/web/get-started
- Firebase FCM receive messages: https://firebase.google.com/docs/cloud-messaging/web/receive-messages
- Firebase FCM HTTP v1 send: https://firebase.google.com/docs/cloud-messaging/send/v1-api
- Firebase Cloud Functions Firestore events: https://firebase.google.com/docs/functions/firestore-events
- WebKit iOS Web Push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- MDN Push best practices: https://developer.mozilla.org/en-US/docs/Web/API/Push_API/Best_Practices
- MDN Notification.requestPermission: https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static

## 3. 推薦架構

推薦：Firebase Cloud Functions v2 Firestore triggers + FCM Web。

原因：

- 現有專案仍有不少 Firestore client SDK 直寫，例如 schedule / planning / 部分 booking / wish 流程。只靠現有 Cloudflare Worker 無法完整觀察這些寫入。
- 不能把「要通知誰、通知內容是什麼」交給 client 傳入；client 只能註冊自己的 token 與偏好。收件者、權限、事件內容必須由 server 從 Firestore re-derive。
- `trip.lastActivityByFeature` 目前是 client 可寫、且 `by` 欄位刻意未做強驗證。紅點可接受這種弱一致 UX 欄位；推播不可直接依賴它，否則會把低風險 UX 欄位升級成 spam surface。
- Firestore trigger 可以觀察 entity 寫入本身，使用 rules 已 pin 的 `createdBy` / `updatedBy` / `settledBy` 做 actor 判斷，安全性比 client 自報事件高。

備選：Cloudflare Worker `/notify-*` endpoint。

- 優點：沿用現有 Worker、service account、rate limit、logging。
- 缺點：client SDK 直寫不會自動被捕捉；若在每個 service mutation 後補呼叫 Worker，會變成多處散落的 best-effort side effect，而且仍需 Worker 重新讀 Firestore 驗證事件。P1 不建議。

## 4. 系統設計

### 4.1 Client

新增 lazy messaging bundle：

- `src/services/firebase.ts`
  - 新增 `getFirebaseMessaging()`。
  - 動態 import `firebase/messaging`，避免首屏載入 messaging SDK。
- `src/features/account/components/NotificationSettings.tsx`
  - 顯示目前 permission / subscription 狀態。
  - 按鈕點擊後才呼叫 `Notification.requestPermission()`。
  - 支援 enable、disable、send test notification。
- `src/features/account/hooks/usePushNotifications.ts`
  - feature detect：`Notification`、`navigator.serviceWorker`、`PushManager`、FCM support。
  - 使用既有 service worker registration 呼叫 `getToken({ vapidKey, serviceWorkerRegistration })`。
  - token 寫入 `users/{uid}/pushTokens/{tokenHash}`。
  - sign-out 前 best-effort disable current token。

### 4.2 Service Worker

目前 `vite.config.ts` 使用 `VitePWA({ workbox: ... })` 的 generateSW 模式。P1 需要改為 `injectManifest`，維護自訂 `src/sw.ts`：

- 保留 Workbox precache / runtimeCaching。
- 加入 FCM background handler。
- 避免額外建立根目錄 `firebase-messaging-sw.js`，因為同 scope 雙 service worker 會互相覆蓋。
- 保持 `registerType: 'prompt'`，避免通知 SW 改動造成使用者填表中被靜默更新。

### 4.3 Server

新增 Firebase Functions source，例如 `firebase-functions/`，不要放進現有 `functions/`，因為現有 `functions/` 是 Cloudflare Pages Functions，runtime / tsconfig 不同。

建議 trigger：

- `trips/{tripId}/expenses/{expenseId}`：create / update / soft-delete。
- `trips/{tripId}/settlements/{settlementId}`：create / delete。
- `trips/{tripId}/bookings/{bookingId}`：create / update / delete。
- `trips/{tripId}/schedules/{scheduleId}`：create / update / delete。
- `trips/{tripId}/members/{memberId}`：member joined / removed / role changed。P1 只推 member joined。

暫不 trigger：

- `wishes`：保留紅點，不推。
- `planning`：保留紅點，不推。
- `trip.lastActivityByFeature`：不可作為 push event source。

### 4.4 FCM 發送

流程：

1. Firestore trigger 收到 entity event。
2. 解析 actor：優先用 `updatedBy`，create 用 `createdBy`，settlement 用 `settledBy`。
3. 讀 trip doc / entity doc 的 `memberIds`。
4. 收件者 = `memberIds - actorUid`。
5. 讀每個收件者的 push prefs 與 tokens。
6. 過濾 disabled token、muted trip、disabled type。
7. 建立 dedupe record。
8. 發 FCM。
9. 針對 invalid / unregistered token，標記 `disabledAt`。

推播 payload 原則：

- 使用 data-only message；SW 先做 owner gate，再呼叫 `showNotification()`。
- `data.title`: `TripMate`
- `data.body`: 只放低敏感摘要，例如「費用が追加されました」「予約が更新されました」。
- `data`: `tripId`, `entityType`, `entityId`, `url`, `tag`, `eventId`, `targetUid`。
- 不放金額、完整店名、住宿地址、邀請 token、receipt URL。

## 5. Firestore 資料模型

```text
users/{uid}/pushTokens/{tokenHash}
  token: string
  platform: "web"
  provider: "fcm"
  permission: "granted"
  swScope: string
  appVersion?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  lastSeenAt: Timestamp
  disabledAt: Timestamp | null
  disabledReason?: "user-disabled" | "permission-revoked" | "fcm-unregistered" | "send-failed"

users/{uid}/notificationPrefs/default
  enabled: boolean
  types:
    invite: boolean
    expense: boolean
    settlement: boolean
    booking: boolean
    schedule: boolean
  updatedAt: Timestamp

users/{uid}/tripNotificationPrefs/{tripId}
  enabled: boolean
  mutedUntil: Timestamp | null
  types:
    expense?: boolean
    settlement?: boolean
    booking?: boolean
    schedule?: boolean
  updatedAt: Timestamp

_pushEvents/{eventId}
  tripId: string
  entityType: "expense" | "settlement" | "booking" | "schedule" | "member"
  entityId: string
  action: "created" | "updated" | "deleted" | "joined"
  actorUid: string
  recipientUids: string[]
  createdAt: Timestamp
  status: "pending" | "sent" | "partial" | "failed"
  sentCount: number
  failedCount: number
```

`tokenHash`：

- 用 SHA-256(token) 做 doc id。
- raw token 仍需存欄位，server 才能發送。
- client 只能讀寫自己的 token doc；其他使用者完全不可讀。

`_pushEvents`：

- client `read/write: false`。
- Functions admin SDK 專用。
- 用來處理 Firestore trigger retry / at-least-once delivery 的去重。

## 6. Firestore Rules 草案

正式實作前需在 rules test 補齊 allow/deny。

```js
match /users/{userId} {
  allow read, write: if false;

  match /pushTokens/{tokenId} {
    allow read, create, update, delete: if isSignedIn()
      && userId == uid()
      && request.resource.data.keys().hasOnly([
           'token','platform','provider','permission','swScope',
           'appVersion','createdAt','updatedAt',
           'lastSeenAt','disabledAt','disabledReason'
         ])
      && request.resource.data.platform == 'web'
      && request.resource.data.provider == 'fcm'
      && request.resource.data.permission == 'granted'
      && request.resource.data.token is string
      && request.resource.data.token.size() > 20
      && request.resource.data.token.size() <= 4096
      && request.resource.data.swScope is string
      && request.resource.data.swScope.size() <= 200
      && request.resource.data.disabledAt == null;
  }

  match /notificationPrefs/{prefId} {
    allow read, create, update, delete: if isSignedIn()
      && userId == uid()
      && prefId == 'default';
  }

  match /tripNotificationPrefs/{tripId} {
    allow read, create, update, delete: if isSignedIn()
      && userId == uid()
      && uid() in get(/databases/$(database)/documents/trips/$(tripId)).data.memberIds;
  }
}

match /_pushEvents/{eventId} {
  allow read, write: if false;
}
```

注意：

- `pushTokens` update/delete 規則實作時要拆路徑；上面只是方向草案。disable token 可能需要允許 client 將 `disabledAt` 從 null 改為 `request.time`，但不可讓 client 偽造 `disabledReason = 'fcm-unregistered'`。
- prefs 要補完整 enum / key allowlist / bool type gate，避免 raw SDK 寫入垃圾資料。
- 若 token doc 允許 update，需 pin `token`、`provider`、`platform` 不可被換成另一個人的 token。

## 7. 通知類型矩陣

| Type | Trigger | 收件者 | 預設 | 文案方向 | Route |
|---|---|---:|---|---|---|
| invite / member joined | `members` create | trip members except joiner | on | `メンバーが参加しました` | `/schedule` |
| expense created | `expenses` create | members except creator | on | `費用が追加されました` | `/expense` |
| expense updated / deleted | `expenses` update | members except updater | on | `費用が更新されました` | `/expense` |
| settlement created | `settlements` create | payer / receiver plus trip members? P1 建議只雙方 | on | `精算が記録されました` | `/expense` |
| booking updated | `bookings` create/update/delete | members except actor | on | `予約情報が更新されました` | `/bookings` |
| schedule updated | `schedules` create/update/delete | members except actor | on，但可關 | `行程が更新されました` | `/schedule` |
| wish vote | `wishes` vote | none | off | 紅點即可 | `/wish` |
| planning toggle | `planning` update | none | off | 紅點即可 | `/planning` |

## 8. 紅點與推播的責任邊界

紅點：

- App 內 unread signal。
- 使用 `trip.lastActivityByFeature` + `lastViewedStore`。
- 切到 tab 後 mark viewed。

推播：

- App 外 interrupt signal。
- 只推高價值事件。
- ~~不新增第二套 unread state。~~ **P2 起例外**：通知鈴鐺自己的已讀/未讀是刻意新增的第二套 unread state，範圍限定在鈴鐺 UI，不影響 tab 紅點的判斷邏輯。
- 點擊推播只是導回 tab，由現有 tab viewed 流程自然清紅點；點鈴鐺內單筆通知則額外 mark 該筆 `readAt`。

## 9. 競態與安全風險

### 9.1 重複通知

風險：Firestore triggers 可能重試，同一事件可能送兩次。

修法：

- eventId 使用 CloudEvent id 或穩定的 `entityType/entityId/action/updatedAt`。
- `_pushEvents/{eventId}` create-if-absent；已存在則 skip。

### 9.2 Client 偽造通知

風險：如果讓 client 傳 recipients / title / body，就能 spam 或洩漏資訊。

修法：

- client 只管理自己的 token / prefs。
- server 從 entity doc + trip/memberIds re-derive recipients。
- title/body 使用 server-side allowlist template。

### 9.3 `lastActivityByFeature` 被濫用

風險：目前 rules 刻意允許 member bump activity，`by` 不強驗證；若拿它做 push source，任何 member 可製造大量通知。

修法：

- P1 不用 `lastActivityByFeature` trigger 發 push。
- 若未來要共用，需把 activity bump 改 Worker-authoritative 或 rules 強 pin `by == uid()` + rate limit。

### 9.4 Service worker scope 衝突

風險：新增 `firebase-messaging-sw.js` 會跟 VitePWA 既有 SW 競爭 root scope。

修法：

- 改 `injectManifest`，單一自訂 SW 同時處理 Workbox precache + FCM background。

### 9.5 隱私洩漏

風險：鎖屏通知可能顯示旅費金額、住宿地址、邀請資訊。

修法：

- 通知 body 只放低敏感摘要。
- 詳細內容進 App 後依現有 Firestore rules 顯示。

### 9.6 Token lifecycle

風險：使用者關閉通知、換瀏覽器、FCM token rotation，舊 token 造成送達失敗與成本噪音。

修法：

- App 啟動 / Account 頁 refresh token 時更新 `lastSeenAt`。
- 發送失敗收到 invalid / unregistered 類錯誤後標記 `disabledAt`。
- sign-out best-effort disable current token。

## 10. 實作階段

### Phase 0：規格與基礎資料層

工時：0.5 天

- 確認 Firebase CLI 登入與 Firestore edition。
- 補 `users/{uid}/pushTokens`、prefs、`_pushEvents` rules。
- 補 rules tests。
- 產生 FCM Web Push certificate / VAPID public key。
- 新增 `VITE_FIREBASE_VAPID_KEY` prod/dev env。

### Phase 1：Client opt-in + token 管理

工時：1 天

- 新增 `getFirebaseMessaging()` lazy loader。
- Account 頁新增 Notification settings row / sheet。
- 實作 permission request、getToken、save token、disable token。
- App foreground `onMessage` 接 toast，不彈系統通知。
- rules tests + component tests。

### Phase 2：Custom service worker

工時：1 天

- VitePWA 從 generateSW 改 injectManifest。
- 建 `src/sw.ts`，保留既有 Workbox caching 行為。
- 加 FCM background handler。
- 驗證 install / update prompt / offline / Firebase chunk runtime cache 沒退化。

### Phase 3：Server delivery

工時：1.5 到 2 天

- 新增 Firebase Functions source，不混 Cloudflare Pages `functions/`。
- 加 Firestore triggers。
- 加 event normalization / recipient resolver / prefs resolver。
- 加 `_pushEvents` dedupe。
- 加 FCM send + invalid token cleanup。
- 加 emulator tests / unit tests。

### Phase 4：QA / rollout

工時：0.5 到 1 天

- Chrome desktop：foreground / background / closed。
- Android Chrome PWA：installed app push。
- iOS 16.4+ Home Screen PWA：permission / delivery / notification click。
- Permission denied / revoked。
- Token rotation / sign-out。
- Cloudflare Pages preview env：確保沒有 prod Worker fallback 風險。

總估：4 到 5.5 天。

## 11. 驗收標準

- 未登入使用者不載入 messaging bundle。
- 未點通知開關時不請求 permission。
- deny permission 後不重複騷擾 prompt。
- 開啟通知後，Firestore 有自己的 token doc，其他使用者不可讀。
- 自己新增 expense 不收到自己的 push；其他成員收到。
- 前景收到事件只顯示 in-app toast；背景收到系統通知。
- 點通知進正確 route。
- muted trip / disabled type 不收到。
- 同一 trigger retry 不重複發送。
- invalid token 會被 disabled。
- PWA install/update/offline 行為不因 SW 改造退化。

## 12. 待決策問題

1. P1 是否要包含 schedule push？建議預設 on，但在設定中可關；若擔心干擾，P1 可以只先開 expense / settlement / booking / member joined。
2. Settlement 通知要只給 payer / receiver，還是全 trip members？建議只給雙方，避免第三方噪音。
3. iOS 未安裝 Home Screen 時，要顯示「請加入主畫面」狀態，還是只顯示 unsupported？建議顯示狀態但不自動教學。
4. 是否要同時加 app icon badge？建議 P1 不做，等 push 主路徑穩定後再做。

## 13. 最終建議

先做「自建 P1」而不是買通知平台：

- 技術核心是 FCM + Firebase Functions，跟目前 Firebase Auth / Firestore 權限模型一致。
- 推播事件由 server 從 Firestore re-derive，不信任 client。
- 紅點繼續保留，不把推播做成另一套 unread。
- P1 範圍壓在 expense / settlement / booking / member joined，schedule 視決策加入；wish / planning 暫不推。
