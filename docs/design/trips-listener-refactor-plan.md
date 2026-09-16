# Trips listener 重構計畫

日期：2026-09-15。狀態：已實作並通過自動化驗證，尚未提交／部署。
核對基準：`e08524a23f56048ac4a2aaad1a0036a9f9e57ea6`；核對開始時工作樹乾淨。
本項是原 5 項 backlog 之外的獨立新增範圍。

## 1. 結論與目標

以 `trips` collection 的 `where('memberIds', 'array-contains', uid)` 取代 membership collection-group listener 與 N 條 trip doc listener。
同一 QueryClient、同一 uid 的所有 useMyTrips consumers 共用一條 trips listener；保留一次性 initial fetch／invalidate refetch，故「單一 listener」不等於「只有一次讀取」。
保留 useMyTrips 的回傳介面與 tripKeys.mine(uid)，避免頁面全面改寫。

## 2. 重構前核對的現況

| 位置 | 現況與處置 |
| --- | --- |
| src/features/trips/hooks/useTrips.ts:46 | useMyTripIds 取得 IDs；useMyTrips 再 getTripsByIds＋shared controller。替換為共用 list factory。 |
| src/features/trips/hooks/sharedTripSubscriptions.ts | 具備 QueryClient 隔離、ref-count、延遲 release、late callback 防護；遷移這些行為後才刪檔。 |
| src/hooks/createRealtimeListHook.ts:72 | registry 目前只依 query key；onData 無 entry 存活檢查。直接套用會弱化 trips 既有防護。 |
| src/features/members/hooks/useAllTripMembers.ts:47 | 另外訂閱 useMyTripIds；改成 trips?.map(t => t.id)，保留 undefined/loading 與空陣列的差異。 |
| src/features/trips/hooks/useTrips.ts | create/copy/delete/leave 維護 mine 與 myIds 兩個快取；收斂到 mine，保留 rollback 與 onSettled reconcile。 |
| src/features/trips/invites/useInvites.ts:132 | invite redeem 寫入 myIds；移除冗餘寫入。 |
| src/features/members/hooks/useMembers.ts:119 | owner transfer invalidate myIds；移除該 key 的 invalidation，保留其他刷新。 |
| src/features/trips/hooks/useCurrentTrip.ts:32 | cold boot 走 server-only detail read；保留，list 一旦已解析仍是唯一權威來源。 |
| src/features/trips/invites/inviteService.ts:261 | getTripsByIds(..., 'server') 用於接受邀請；因此不能隨列表重構刪掉 getTripsByIds。 |
| firestore.rules:299 | trips list 現在全面禁止；必須搭配 query 開放同文件 membership 判斷。 |
| workers/ocr/src/member-lifecycle-write.ts:128、203 | remove/leave 均在 authz transaction 使用 buildMemberStripWrites。 |
| workers/ocr/src/membership-shared.ts:181 | removingAt 與 trip.memberIds 移除是同一 transaction 的 writes；後續 cascade 失敗不會讓 trip 重新符合新 query。 |

GitNexus：useMyTrips 為 CRITICAL，5 個直接相依、20 個受影響符號、10 條流程；包含 AppLayout、Schedule、Expense、Bookings、Wish、Planning、Account、SocialCircle。createRealtimeListHook 為 MEDIUM，9 個直接相依、39 個受影響符號。工具先前對 useMyTripIds 回傳零影響，但原始碼有實際 consumers；影響圖不是完整性保證。實作前仍須逐符號重新 impact，提交前 detect_changes。

## 3. 決策與實作範圍

### A. Rules 與查詢契約

- trips 的 `allow list: if memberOfDoc();`；既有 helper 已包含登入判斷。
- 不更動 get 權限、ownerId 限制、create 的 memberIds == [uid()]、update 的 unchanged(memberIds)，也不放寬其他寫入限制。
- 新增 getMyTrips(uid) 與 subscribeToMyTrips(uid, onData, onError)，共用相同 query shape、parser、排序規則。
- 本次採 `where(memberIds, array-contains, uid) + limit(50)`，讀取後依 createdAt 降序排列。保留上限觸發的 Sentry 提示與壞文件逐筆略過；pending serverTimestamp 使用 estimate。
- 不加入 server orderBy；本次無需新增 memberIds＋createdAt composite index。現有上限不是「最近 50 筆」保證，新 query 超過上限時的取樣集合也可能與舊 membership query 不同；不把排序後的結果宣稱為全域最新 50 筆。50 筆以上的分頁是另案。
- 已透過 Firebase CLI list/get 確認專案 tripplanner-80a4f 的 (default) 為 STANDARD edition；索引設定檔未排除 trips.memberIds 的單欄 array 索引。本輪未對正式資料庫執行使用者資料查詢。若另案加入 orderBy，必須同時處理索引及 Rules/read schema 的排序欄位存在與型別約束。

### B. 共用訂閱的必要防護

先以測試補強 createRealtimeListHook，再接入 trips：

- registry 改成以 QueryClient 分區的 WeakMap，再依 query key 定位 entry。
- data/error callback 必須檢查 entry 仍屬目前 generation 且尚未 disposed，避免卸載後重建被清掉的快取。
- 保留 ref-count、async init 完成後釋放、舊 init rejection 不得刪除新 generation。
- 移植 microtask 延後最後 release／generation 檢查，讓 StrictMode cleanup/reacquire 共用尚存訂閱；真正最後 release 必須完整 unsubscribe。
- 補 initial fetch/refetch 晚於新 snapshot 回來的競態測試。若 listener 已收到新資料，較舊 fetch 不得覆蓋它；以 TanStack Query 的取消機制與必要的 generation 判斷解決，避免另建一套資料儲存。
- 維持既有 hooks 型別與 overlay 行為；不導入新 state library，也不改寫整個 realtime API。

### C. Client 與刪除清單

- useMyTrips 改接已補強的 createRealtimeListHook，initial fetch 和 invalidation 都使用同一 membership query。
- useAllTripMembers 由 trips 推導 IDs；既有 per-trip members listeners 不在本次合併範圍。固定 IDs 的 identity 不應因單純 metadata 更新反覆重訂閱。
- 只維護 mine(uid) 快取；create/copy/redeem 保留立即呈現，leave/delete 保留 optimistic removal、失敗回復與 server reconcile、lastViewed cleanup。
- 移除 useMyTripIds、getMyTripIds、subscribeToMyTripIds、只供舊路徑使用的 memberDocsToTripIds、tripKeys.myIds。
- 確認全 repo 引用後移除 subscribeToTrip 與 sharedTripSubscriptions.ts；將後者 6 個測試的必要行為遷移到新 service/hook/factory 測試後再刪舊測試檔。
- 保留 getTripsByIds、getTripByIdFromServer 及其邀請／cold-boot 用途。
- 保留既有 mytrips-first-publish 效能量測意義，避免刪 controller 時一併失去觀測；每次有效共用訂閱生命週期僅記錄首個非空結果。
- 清除註解中 owner-only LIST、兩階段讀取、IDs 先於 trips 可用的過時描述。

### D. 明確保留的範圍

- Worker membership transaction、removingAt、cascade 與 invite 授權流程不重寫。
- 保留 members collection-group Rules／索引，避免舊 PWA 在切換期間立即失效；此項不做跨版本支援清理。
- current-trip server-only fast path 與 persisted selection 不刪除。瀏覽器快取不是服務端授權證明，保留帳號隔離回歸測試。
- 不升級依賴、不改 UI、不加入分頁、不改 members fan-out，也不引入另一套 trips controller。

## 4. 驗收矩陣

| 層級 | 必須通過 |
| --- | --- |
| Rules emulator | owner/editor/viewer 使用本人 array-contains 均可讀；匿名、查他人 uid、無條件 list、ownerId-only 查詢均拒絕；有限 documentId 查詢逐文件授權，混入無權限文件整批拒絕；create/update 不可注入 memberIds。 |
| Rules listener | 成員被從 trip.memberIds 移除後 query 移除該 trip；其他合法 trips 仍持續更新；沒有因單筆離開終止全部訂閱。 |
| Service | initial/listener query shape 一致；0/1/50 筆；排序、截斷提示、壞文件略過、pending timestamp；刪除與加入更新。 |
| Shared factory | 多 consumer 一條 listener；QueryClient/uid 隔離；StrictMode；最後卸載；late callback/init/rejection；舊 fetch 不覆蓋新 snapshot；現有 overlay 回歸。 |
| Trips mutations | create/copy/redeem 即時加入；leave/delete 樂觀移除；真正失敗 rollback；server 成功但 HTTP 回應遺失後 reconcile 不留下 ghost。 |
| Consumers | Account/SocialCircle 的 trips/IDs/memberResults 對齊；metadata 更新不重訂閱 members；selected trip 被移除時 fallback；登入登出、A→B、cold boot、離線再連線。 |

Emulator 修正了原計畫的假設：有限 documentId 查詢可以驗證各文件 membership，因此全數授權時允許，混入任何無權限 trip 則整批拒絕。ownerId-only 和無條件 list 仍拒絕。Client 仍採 array-contains query，不使用 ID fan-out。

## 5. 步驟、驗證與交付

1. 補共享 factory 防護與測試（約 2–3 小時）。逐符號 impact 後修改。
2. Rules＋trips services＋service/Rules 測試（約 1–2 小時）。
3. hook／快取 consumers 遷移，移植測試後刪舊實作（約 2–3 小時）。
4. consumer 整合回歸與全套 gates（約 2–4 小時）。

總估 1–2 個工作天；共用 factory 的競態若暴露更多既有問題，先單獨定位，再更新估時。

最終執行 npm test、npm run test:rules、npm run typecheck、npm run lint、npm run build、git diff --check；報告確切成功／失敗數與剩餘限制。提交前執行 GitNexus detect_changes，確認只有上述預期範圍。

部署順序：先部署相容 Rules，再發新 client；新 client 不可先於 Rules。必要索引必須 ready 後才切換。回滾 client 時保留相容 Rules，不能在新 client 仍使用時改回 list:false。
依既有「上線前清空 Firestore」的歷史部署約定，不把 backfill／正式資料盤點列為此案前置；這項約定本輪未重新確認，也不代表瀏覽器 IndexedDB 或 PWA 會一併清空。R2 無資料格式變更。

## 6. 規劃階段的基線

執行：npx vitest run src/hooks/createRealtimeListHook.test.ts src/features/trips/hooks/sharedTripSubscriptions.test.ts src/features/trips/hooks/useCurrentTrip.test.tsx src/features/trips/services/tripService.test.ts

結果：4 個測試檔、16 個測試全部通過（15.11 秒）。這是現況基線，不代表上述新增契約已驗證。
以上是改碼前的基線；最終結果見下一節。

## 7. 實作結果與驗證

- 已新增 getMyTrips／subscribeToMyTrips，useMyTrips 改接通用 factory；IDs 從 trips 推導。
- 已移除 sharedTripSubscriptions.ts 與舊測試，移除 useMyTripIds／memberDocsToTripIds／subscribeToMyTripIds／getMyTripIds／subscribeToTrip／tripKeys.myIds。
- 共用 factory 加入 QueryClient 分區、callback generation guard、microtask release、AbortSignal 與 snapshot 前取消舊 fetch。取消使用 TanStack 預設 revert 行為，確保 fetchStatus 回到 idle；測試驗證 snapshot 後 status 為 success。
- 保留 server-only detail read、所有既有寫入限制、mutation rollback／reconcile 及 lastViewed cleanup。
- npm test：116 檔、1273 測試通過（含審查後補上的 11 個回歸案例）。
- npm run test:rules：1 檔、259 測試通過，包含離線期間權限移除後 reconnect 收斂、合法 query 持續更新及 membership 注入拒絕。
- npm run typecheck／npm run lint：通過（含 workspace scripts）。
- npm run build：通過，含 client compatibility source/dist 檢查。仍有 chunk size／上游 deprecation 警告，本次不修改套件。
- git diff --check：通過。GitNexus detect_changes 已執行；以實際 diff 補足索引對新檔／已刪符號的映射限制，變更集中在本計畫範圍。
- 未部署／未提交；未執行真實瀏覽器或 iOS PWA 端到端測試。離線重連的證據來自 Firestore emulator，帳號／頁面資料相依的證據來自 hook 整合測試。

### 審查後追加修補

- Terminal listener error 現在會使本次訂閱 generation 失效、釋放 handle、取消在途 fetch，並將 query 設為 error／idle。保留 consumer ref-count，避免新 consumer 重建後，舊 consumer 還活著卻被誤斷線。
- 新 consumer acquire 或明確 refetch 可啟動新 attempt；不自動循環重試權限錯誤。遲到的 callback、錯誤與 init handle 都受 generation 防護。
- selection grace 改為依剩餘時間排一次 timer，沒有新 snapshot 也會執行 fallback；新列表、改選、登入狀態或 unmount 都會取消舊 timer。已過期的 persisted selection 立即同步，已回補的有效 selection 不觸發切換。
- 針對性驗證：3 檔、28 測試通過；完整測試／typecheck／lint 通過。此追加修補沒有更動 Rules，沿用前一輪 259 個 emulator 測試結果。

參考：

- [Firestore query 授權](https://firebase.google.com/docs/firestore/security/rules-query)
- [Firestore 排序與上限](https://firebase.google.com/docs/firestore/query-data/order-limit-data)
- [React effect cleanup](https://react.dev/reference/react/useEffect)

上述官方文件核對 query/Rules 契約、排序欄位存在性與 effect cleanup；modern-web-guidance 搜尋未提供與此 Firebase 訂閱重構直接匹配的指南，不據此加入無關 Web API。
