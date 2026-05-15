# TripMate — 架構速查

> 旅遊行程協作 PWA(React 19 + Firebase + Cloudflare Worker)。日文 UI、繁中註解。
> 設計取向:**preview-first / optimistic / realtime**。

---

## Stack

| 層 | 技術 |
|---|---|
| Frontend | **React 19** + Vite 8 + TanStack Query v5 + Zustand v5 + Tailwind v4 + React Router v7 |
| Compiler | **babel-plugin-react-compiler v1**(自動 memoise,所以幾乎沒有手寫 useCallback/useMemo) |
| Backend | **Firebase v12**: Auth(Google)/ Firestore(+ IndexedDB persistence)/ Storage |
| 即時同步 | Firestore `onSnapshot` 包裝在 `createRealtimeListHook` factory |
| 收據 OCR | **Cloudflare Worker** + **Gemini 3 Flash Preview**(workers/ocr/) |
| Hosting | Firebase Hosting(prod URL: `tripplanner-80a4f.web.app`) |
| 觀測 | Sentry(lazy-loaded replayIntegration) |
| 測試 | Vitest + @cloudflare/vitest-pool-workers(Worker 測試) |
| CI | GitHub Actions(`.github/workflows/ci.yml`) |
| Pre-commit | Lefthook(typecheck/lint/test gating) |

## 資料模型(Firestore)

```
trips/{tripId}
  ├── members/{userId}           # role: owner | editor | viewer
  ├── schedules/{scheduleId}     # 行程項目(時間軸 card)
  ├── bookings/{bookingId}       # 訂單(機票/飯店/火車/巴士/其他)
  ├── expenses/{expenseId}       # 費用 + splits + 可選 items[](OCR)
  ├── wishes/{wishId}            # 願望清單 + votes[]
  ├── plannings/{planItemId}     # 行前準備 checklist
  └── (trip doc 本體:title/dest/dates/ownerId/icon/currency)

invites/{token}                  # token 在 URL fragment(不進 server log)
```

Storage:`trips/{tripId}/expenses/{expenseId}/receipt.webp` + `thumb.webp` 等(WebP 壓縮過,thumbnail variants)。

## 三層權限(Firestore + Storage rules 雙層 enforce)

- **owner**(`isTripOwner`): trip 編輯 / 邀請 / 成員管理 / 刪除
- **editor / owner**(`canWrite`): schedule/booking/expense/planning 的 CRUD,Storage 上傳
- **viewer**(`isMember`): 唯讀全部 + Wish 投票 / 提案(Wish 寬鬆)

UI gating 走 `useCanWrite` + `useIsTripOwner` hooks(`features/trips/hooks/useTripRole.ts`)。

## 路由(src/routes/index.tsx)

| Path | Component | Lazy? | 說明 |
|---|---|---|---|
| `/schedule` | SchedulePage | eager(start_url) | landing page,trip switcher 也在這 |
| `/expense` | ExpensePage | lazy | 費用 + 結算 |
| `/bookings` | BookingsPage | lazy | 訂單 |
| `/wish` | WishPage | lazy | 願望清單 |
| `/planning` | PlanningPage | lazy | 行前準備 |
| `/account` | AccountPage | lazy | 使用者 + 共遊圈 / 過往住宿入口 |
| `/invite/:tripId#token` | InvitePage | standalone | 加入邀請(token 在 fragment) |
| `/past-lodging` | PastLodgingPage | standalone | 跨 trip 住宿匯總 |
| `/social-circle` | SocialCirclePage | standalone | 共遊朋友圈 |

底部 BottomNav 寫在 `layouts/AppLayout.tsx`,使用 `env(safe-area-inset-bottom)` 處理 iOS Face-ID home indicator。

## 各頁面 CRUD + 主要觸發

### `/schedule` — SchedulePage
- **狀態管理 hook**: `useSchedulePageState`(集中所有 trip / schedule / modal state)
- **CRUD**: `useCreateSchedule` / `useUpdateSchedule` / `useDeleteSchedule`(`features/schedule/hooks/useSchedules.ts`)
- **Trip 操作**: `useCreateTrip` / `useUpdateTrip` / `useDeleteTrip` / `useCopyTrip`(`features/trips/hooks/useTrips.ts`)
- **觸發**:
  - 點 `+` → 開 ScheduleFormModal(create)
  - 點現有 schedule card → ScheduleFormModal(edit + delete inline)
  - TripHeaderCard 點 menu → 編輯/邀請/複製/成員/刪除 trip
  - 滑左 trip switcher row → 刪除 trip / 拖曳重排
  - 換 day chip → activeDate 切換 grouped 顯示

### `/bookings` — BookingsPage
- **CRUD**: `useCreateBooking` / `useUpdateBooking` / `useDeleteBooking`(`features/bookings/hooks/useBookings.ts`)
- **特色**: 三種卡片 dispatcher(`FlightCard` / `HotelCard` / `TrainCard`) + GenericCard,各自有品牌色 + airline/hotel 元資料
- **附件**: `useAttachment`(共用) + `bookingStorage` 上傳圖/PDF,thumbnail variants
- **觸發**:
  - 點 `+` 或卡片 → BookingFormModal(類型決定欄位:flight 用 origin→destination,hotel 用 check-in/out)
  - 滑左 row → 刪除
  - 點卡片附件區 → AttachmentPreviewModal(全螢幕看圖 / PDF 跳新分頁)

### `/expense` — ExpensePage
- **CRUD**: `useCreateExpense` / `useUpdateExpense` / `useDeleteExpense`(`features/expense/hooks/useExpenses.ts`)
- **特色 1 — OCR**: 拍照 → 自動觸發 `useOcrFlow` → Cloudflare Worker → Gemini 解析收據 → 填入 items[] + 標題 + 金額
- **特色 2 — Items 模式**: items.length > 0 時,均等 / カスタム split 收起,改用 chip-per-row 多選分擔者,splits 反算
- **特色 3 — Settlement**: `computeBalances` + `computeSettlements`,自動建議「誰轉錢給誰最少筆」
- **Optimistic close**: 按存 → modal 立刻收 → list 顯示半透明 row + 旋轉「保存中…」(tempId 偵測)→ 完成後 realtime 替換
- **觸發**:
  - 點 `+` → ExpenseFormModal
  - 拍照按鈕 → capture=environment + auto-OCR
  - 上傳按鈕 → 純上傳,手動點「✨ 明細を読み取る」才 OCR
  - 滑左 row → 刪除
  - 點 row(非 pending)→ edit

### `/wish` — WishPage
- **CRUD**: `useCreateWish` / `useUpdateWish` / `useDeleteWish`(`features/wish/hooks/useWishes.ts`)
- **特色**: Pinterest-style 卡片 + 可選 cover image(blob URL via `useBlobUrl`,需要時走 `useImageCropFlow` 16:9 裁切)
- **投票**: 任何成員可 toggle 自己的 vote(rules 限定只能改自己 uid 進出 votes 陣列)
- **觸發**:
  - 點 `+` → WishFormModal
  - 卡片 like 按鈕 → vote toggle
  - 卡片內容 → 編輯(只有 proposer 可改文字)

### `/planning` — PlanningPage
- **CRUD**: `useCreatePlanItem` / `useUpdatePlanItem` / `useDeletePlanItem`(`features/planning/hooks/usePlanning.ts`)
- **特色**: 5 個 category(essentials / documents / packing / todo / other),按 category bucket
- **觸發**:
  - 點 `+` → PlanFormModal
  - row checkbox → toggleDone(立刻 optimistic)
  - 滑左 row → 刪除

### `/account` — AccountPage
- **CRUD**: 無(純導覽 + 統計)
- **顯示**: 旅程總日數 / 過往住宿 thumbnails / 共遊圈 chips
- **觸發**:
  - 點「新規旅程」→ navigate to `/schedule` with `state.openCreateTrip = true`
  - 點「過往住宿」→ `/past-lodging`
  - 點「共遊圈」→ `/social-circle`
  - 登入 / 登出 → useAuth

## 跨 feature 抽象

| Hook / Helper | 作用 |
|---|---|
| `useFeatureListPage<T>` | 集中 list page 的 ctx / uid / modal / signIn / canWrite / isOwner,4 個 page 共用 |
| `useFormModal<T>` | open / openEdit / close + 自動 key(`editTarget?.id ?? 'new'`)觸發 modal re-mount |
| `useFormReducer<T>` | form state 統一 reducer,所有 modal 用 |
| `useTripContext` | 統一回傳 `demo` / `cloud` / `loading` / `no-trip` 4 狀態 |
| `useAttachment` | 單一附件(file + existing url)的 tri-state lifecycle |
| `useBlobUrl` | 唯一一個合理用 useEffect+useState 的 blob URL 生命週期 hook |
| `useSwipeRow` / `useSwipeOpen` | 滑刪 row 手勢 + list-level 「目前打開的 row」狀態 |
| `useOcrFlow` | OCR pipeline(compressImage → worker → onSuccess) |
| `useExpenseItems` | items state machine + chip 分擔者 |
| `createRealtimeListHook` | Generic factory:onSnapshot → TanStack Query cache 同步 |
| `subscribeToCollection` | 統一 Firestore listener 工廠(throws → captureError) |
| `firestoreDocFromSchema` | doc snapshot → Zod parse(失敗送 Sentry) |
| `tempId()` | 樂觀更新的 client ID,prefix `temp-`,UI 端用來偵測 pending row |
| `patchListCache` / `rollbackListCache` | TanStack Query cache 樂觀 patch / 回滾 |
| `toast.mutationError` | 統一 mutation 失敗 toast |

## UI 互動模式(每個 list page 通用)

### 滑左刪除(swipe-to-delete)
- **手勢**: row 上左滑(`useSwipeRow` 偵測 pointer move),露出 80px 紅色刪除按鈕
- **兩段確認**: 點刪除 → 變「**確認削除**」紅字 → 再點才真的刪
- **取消**: 點其他地方(別的 row / page 空白)或反方向滑 → 自動收起
- **跨 row 互斥**: `useSwipeOpen` 確保同時只有一個 row 處於 open(換 row 滑會關掉前一個)
- **權限 gate**: 沒 delete 權限(viewer)時,`useSwipeRow` 接收 `enabled: false`,手勢被吃掉,改成純 tap-to-edit row
- **tap 行為**: row 在 open 狀態 → 任何點擊**先收起**而非觸發 onSelect(避免「我看到刪除鈕但點 row 結果開了 edit」)

### Modal 生命週期
- **key-based remount**: 所有 form modal 用 `<Modal key={editTarget?.id ?? 'new'}>` —— 切換 edit target 自動 unmount + remount,每次都用全新的 useState init,不靠 setState-in-effect 同步 props
- **autofocus**: 第一個 input 用 `useAutoFocus(ref, isOpen)` 自動 focus
- **bottom sheet**: `BottomSheet` 元件 + `FormModalShell` 包一層 SaveButton,所有 form modal(Schedule/Booking/Expense/Wish/Planning/EditTrip)共用

### Demo vs Cloud mode
- `useTripContext` 回傳 4 狀態:`loading` / `no-trip` / `demo` / `cloud`
- **Demo**: 未登入訪客看 mock data(東京五日間 trip)。**任何寫入動作 → 開 SignInModal 而非 mutate**
- **Cloud**: 已登入 + 有 trip → 走真正的 Firestore mutate
- 切換 detection 在 `useFeatureListPage.isDemo` boolean

### Role-based UI gating
- `useCanWrite(tripId, isDemo)` → 沒 write 權限時隱藏 `+`(add) 按鈕、隱藏 swipe-to-delete affordance
- `useIsTripOwner(tripId, isDemo)` → 隱藏邀請、編輯 trip、刪除 trip 等 owner-only action
- Demo mode 預設 `canWrite = true`、`isOwner = true`(讓訪客玩,真正按了才 prompt sign-in)

## CRUD 觸發時序表

| 觸發行為 | 所在 page | 是否 optimistic | Modal 行為 | Pending UI |
|---|---|---|---|---|
| **新增費用 / 編輯費用** | `/expense` | ✅ **Optimistic close** | 按存 modal 立即關閉 | ✅ 半透明 + 「保存中…」spinner,block tap/swipe |
| 新增 / 編輯 schedule | `/schedule` | ❌ `await mutateAsync` | 等 mutation 完成才關 modal | 無 |
| 新增 / 編輯 booking | `/bookings` | ❌ `await mutateAsync` | 等 mutation 完成才關 modal | 無 |
| 新增 / 編輯 wish | `/wish` | ❌ `await mutateAsync` | 等 mutation 完成才關 modal | 無 |
| 新增 / 編輯 planning | `/planning` | ❌ `await mutateAsync` | 等 mutation 完成才關 modal | 無 |
| Toggle planning row done | `/planning` | ✅ Optimistic | 沒 modal | 無(checkbox 立即翻) |
| Wish vote toggle | `/wish` | ✅ Optimistic | 沒 modal | 無 |
| Swipe delete(任何 row) | 全部 | ✅ Optimistic | 沒 modal | row 立刻消失 |

**為何只有費用走 optimistic close**:
- 費用流程含 receipt 上傳(可能 2-4 秒),體感最差 → 收益最高
- 其他流程都是純 Firestore write,< 500ms,await 體感 OK
- 未來若 Booking 也加 attachment 上傳常態,可考慮一併改

## Pending state 規範(目前只 Expense 用)

```
按存 → validate() pass → modal.close() 立刻收
                       → createMut.mutate(...) 背景跑
                       → onMutate: patchListCache 插 temp row(id = tempId() = "temp-...")
                       → mutationFn: addDoc → uploadReceipt → updateDoc
                       → 失敗 onError: rollbackListCache + toast.mutationError
                       → 成功 + realtime listener fire: temp row 被 real row 替換
```

**Pending row 視覺 / 互動規範**(`SwipeableExpenseItem.tsx`):
- 偵測: `const isPending = expense.id.startsWith('temp-')`
- 視覺: `opacity-55` 半透明,meta 行用 `<Loader2 className="animate-spin" />` + 「**保存中…**」取代原本的 `[A] 立替 · 4人均等`
- 互動: `onClick = undefined`(完全不接 tap)+ `swipeable = false`(`useSwipeRow` 整個禁用)
- 解除: realtime listener 把 cache 內 tempId row 換成 server-issued ID 的 row,**單一 boolean 由資料推導**,不需手動 cleanup

**邊角狀況**: 若使用者在 1 秒內點剛新增的 temp row 想編輯,因為 tap 被 block,modal 不會開 → 沒 race condition。realtime 同步後變正常 row,點擊即進 edit。

## 複雜流程詳解

### Expense receipt OCR pipeline

```
使用者點「📷 撮影」(<input capture="environment">)
  ↓ iOS 自動轉 JPEG
onCameraPicked:
  → compressImage(file)            ← canvas → 1920px WebP ~200KB
  → att.pickFile(compressed)       ← 存進 useAttachment newFile slot
  → ocr.run(compressed)            ← useOcrFlow.run
                ↓
              ocrService.ocrReceipt():
                → 拿 Firebase ID token (currentUser.getIdToken())
                → fileToBase64 (FileReader)
                → POST https://tripmate-ocr.tripmate.workers.dev/ocr
                   Authorization: Bearer <token>
                   body: { image, mimeType, currency }
                   signal: AbortSignal.timeout(60_000)
                ↓
              Worker (workers/ocr/):
                → verifyFirebaseToken (jose JWKS)
                → extractReceiptItems (Gemini API responseJsonSchema)
                → return { items[], total, storeName? }
  ↓ onSuccess:
items.reset(result.items.map(i => ({ name, amount, assignees: [] })))  ← 預設無人指派
setField('amount', String(result.total))                                  ← 自動填總額
if (result.storeName && !title) setField('title', result.storeName)       ← 標題空才填

使用者:點每個 item 的 chip 指派分擔者(必填)→ 按存
  ↓
validate(): items.every(i => i.assignees.length > 0) && sum(items) === total
  ↓ pass
splitsFromItems(items) → ExpenseSplit[] → 進 Firestore
```

**「📎 ファイルから追加」差別**: 同樣的 compressImage → pickFile,但**不**自動跑 OCR,改顯示「✨ 明細を読み取る」按鈕,使用者點才 ocr.run。

**錯誤路徑**: `OcrError.kind` 分 `auth / rate-limit / parse / network / config / unknown`,在 `ocrErrorCopy()` 轉成日文 toast 文案。

### Trip switcher(SchedulePage 內)

- **長按 trip row**(400ms hold) → 進入拖曳模式,可上下拖排序 → 釋放更新 `tripStore.tripOrder`(zustand persist localStorage)
- **滑左 trip row**(short swipe) → 露出刪除(owner only),兩段確認
- **單點 trip row** → 切換 currentTrip(`setCurrentTrip` zustand,schedule 重新 query)
- **trip switcher 頂部 `+` 按鈕** → CreateTripModal
- **TripHeaderCard 三點 menu** → 5 個選項:`edit / copy / share(邀請) / members / delete`
  - `edit` → EditTripModal
  - `copy` → CopyTripModal(可勾「複製 schedules / planning」+ 改日期)
  - `share` → InviteModal(產生 invite link with token in URL fragment)
  - `members` → MembersModal(查看 + 移除成員,owner only)
  - `delete` → DeleteConfirm inline → 刪 trip + cascade Storage
- **AccountPage 點「新規旅程」** → navigate to `/schedule` with `state.openCreateTrip = true` → SchedulePage 偵測 location state 自動開 CreateTripModal

### Schedule day timeline

- **頂部 day chips**: 從 `selectedTrip.startDate ~ endDate` 產生,點切換 `activeDate`
- **每日 timeline**: `groupByDate(schedules)[activeDate]` 渲染卡片
- **TimelineCard**: 顯示時間 + emoji + title + 估價,**點卡片** → 編輯
- **空狀態**: 沒項目時顯示一個大 CTA 按鈕「行程を追加」
- **DayTotal**: 該日估價總額(右上角)
- **TripTotal**: 全程總額(TripHeaderCard 內)

### Wish 投票機制

- Wish 卡片**任何成員可看 / 可投票**,但**只 proposer 可改文字**
- 投票 = toggle 自己 uid 進出 `votes[]` array(`useToggleWishVote`)
- firestore.rules **嚴格**:update 路徑分兩條 —— proposer 改任何欄位(除了 immutable 的 tripId/proposedBy/createdAt),非 proposer 只能改 `votes` 且改動只能是「自己 uid 進出 ±1」

### Sign-in prompt 時機

Demo / not-signed-in 使用者點任何「寫入」action 都會跳 SignInModal。各 page 走 `useFeatureListPage().signIn.open()`。
觸發點:
- 點 `+` 新增(任何 entity)
- 點 row 編輯 → 提交
- TripHeaderCard menu 內任何 action
- 拖曳重排


## 外部服務

### Cloudflare Worker(收據 OCR)
- **URL**: `https://tripmate-ocr.tripmate.workers.dev`
- **目錄**: `workers/ocr/`
- **端點**: `POST /ocr` — Bearer Firebase ID token,body `{ image: base64, mimeType, currency? }`
- **驗證**: `jose` + `createRemoteJWKSet` 驗 Firebase JWT
- **AI**: Gemini 3 Flash Preview(`generativelanguage.googleapis.com/v1beta`),`responseJsonSchema` 強制結構化輸出
- **Wrangler**: `npx wrangler tail` 看即時 log;`npx wrangler deploy` 部署
- **secrets**: `GEMINI_API_KEY`(`npx wrangler secret put`)

### Firebase
- **Auth**: Google sign-in(popup → redirect fallback iOS PWA)
- **Firestore**: persistentLocalCache 開啟(離線可讀 + cross-tab)
- **Storage**: bucket `tripplanner-80a4f.firebasestorage.app`
- **rules**: `firestore.rules` 三層分權 + `storage.rules` 角色 gate + 5MB cap + mime 白名單

## 開發指令速查

```bash
npm run dev               # vite dev server
npm run build             # tsc -b + vite build(含 React Compiler)
npx vitest run            # 全測試
npx tsc --noEmit          # typecheck only
npx eslint src            # lint
firebase deploy --only hosting             # 前端上線
firebase deploy --only firestore           # firestore rules + indexes
firebase deploy --only storage             # storage rules
cd workers/ocr && npx wrangler deploy      # Worker 上線
cd workers/ocr && npx wrangler tail        # Worker 即時 log
```

## 慣例 / 風格

- **註解語言**: TypeScript 程式碼內註解用**繁體中文 / 英文**,UI 文案用**日文**(這個 app 主要服務日本旅遊情境)
- **emoji 用法**: 禁止寫進程式碼,除非使用者明確要求(現有 emoji 是 UI 內容如 ✈️🏨 等,屬功能性)
- **型別 vs interface**: 表單 state 用 `type`(才能塞進 `Record<string, unknown>` 約束);entity / props 用 `interface`
- **錯誤處理**: 服務層 throws → mutation onError → toast + Sentry captureError;**不要**靜默 swallow
- **PWA**: vite-plugin-pwa,`registerType: 'prompt'` 不自動更新,PwaUpdatePrompt 由使用者觸發
- **iOS input zoom**: 所有 input 強制 `text-[16px]`(`inputClass` helper),否則 iOS Safari focus 會 zoom
- **手動 memoize**: 已交給 React Compiler,**新程式碼不要寫 useCallback / useMemo / React.memo**。唯一例外:`useBlobUrl`(外部資源生命週期)

## 已記憶的 user feedback(`.claude/projects/.../memory/`)

存於 `~/.claude/projects/C--Users-PC-C-Desktop-travel-app/memory/MEMORY.md` index 內。可用查詢時自動載入。重要的有:
- 回覆用**繁體中文**,程式碼 / 註解保留原語言
- Deploy 不需問,直接 `firebase deploy`
- **三思再講** —— 涉及版本 / 套件 / API 用法時,先 fetch 官方文件再說,不靠記憶
- 每個 feature 完成後做**架構簡化**(extract hooks / components when 2+ callers)
