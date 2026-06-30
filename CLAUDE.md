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
| 收據 OCR | **Cloudflare Worker** + **Qwen primary / Claude fallback**(workers/ocr/) |
| Hosting | **Cloudflare Pages**(`tripmate-2wg.pages.dev`) |
| 觀測 | Sentry(@sentry/react,init 同步;拆獨立 `vendor-sentry` chunk + modulepreload 平行下載) |
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
  ├── settlements/{id}           # 「X 給 Y 還了 ¥Z」雙邊任一可記錄,balance 當 reverse expense 計入
  └── (trip doc 本體:title/dest/dates/ownerId/icon/currency)

invites/{token}                  # token 在 URL fragment(不進 server log)
```

**所有 5 個 feature entity(schedules/expenses/bookings/wishes/plannings)都帶有 `createdBy` + `updatedBy` + `createdAt` + `updatedAt`。`updatedBy` 在每次 create / update / toggle / vote 都會被服務層寫入當前 uid,rules 用 `request.resource.data.updatedBy == uid()` 鎖死,client 偽造會被 Firestore 拒。底部 tab 紅點過濾自己的寫入就是靠這個欄位(`useFeatureBadges`)。Booking 在加 updatedBy 同時補了 createdBy / updatedAt(過去只有 createdAt)。**

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
  - 點卡片附件區 → AttachmentPreviewModal(全螢幕看圖 / PDF 走 lazy `PdfPreview`(pdf.js+react-pdf)全平台 app 內 inline 預覽)

### `/expense` — ExpensePage
- **CRUD**: `useCreateExpense` / `useUpdateExpense` / `useDeleteExpense`(`features/expense/hooks/useExpenses.ts`)
- **特色 1 — OCR**: 拍照 → 自動觸發 `useOcrFlow` → Cloudflare Worker → OCR provider 解析收據 → 填入 items[] + 標題 + 金額
- **特色 2 — Items 模式**: items.length > 0 時,均等 / カスタム split 收起,改用 chip-per-row 多選分擔者,splits 反算
- **特色 3 — Settlement (debt-edge model)**: 演算法在 `services/settlement.ts`,**pairwise gross → applied(cap)→ remaining → normalize → net** 五步純函式。核心不變式: **settlement 只能 reduce 既存 debt,不能 create 反向 debt** — 刪 expense 後不會冒出反方向應付款,超出天然債務的部分變 `orphan` 顯式 surface。`paid` / `owed` 顯示**只看 expenses**(不被 settlement 污染);`net` 來自 normalize 後的剩餘 debt。**受取人(toUid)唯一可按「済み」**(firestore.rules 鎖死;付款人視覺上不是按鈕,是 Clock + 「受取待ち」status pill)。Settlement 歷史:預設展開最近 2 筆,行內兩段刪除(`settledBy` 才能刪)。詳見「複雜流程詳解 / Settlement debt-edge model」
- **特色 4 — 列表日期 fold**: `ExpenseDateGroups` 預設展開最近 2 天(`DEFAULT_EXPANDED_DAYS`);user override 用 `useState<Map<date,bool>>` 記,加新費用造成日期 reorder 時 toggle 選擇不被覆蓋
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
- **投票 + voter stack**: 任何成員可 toggle 自己的 vote(rules 限定只能改自己 uid 進出 votes 陣列);卡片底部 stacked avatar 顯示誰投了(最多 3 + 「+N」,使用 `MemberAvatar` primitive)+ heart pop 動畫 + haptic
- **iOS GPU fix**: VoterStack 用 `isolation: isolate` + `translateZ(0)` 解決 iOS Safari swipe 父層下子層 mount/unmount 殘影
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
| `useFormModal<T>` | open / openEdit / close + 自動 key(`editTarget?.id ?? 'new'`)觸發 modal re-mount + **`saveError` state**(setError / clearError,modal banner 用) |
| `useFormReducer<T>` | form state 統一 reducer,所有 modal 用 |
| `useTripContext` | 統一回傳 `demo` / `cloud` / `loading` / `no-trip` 4 狀態 |
| `useAttachment` | 單一附件(file + existing url)的 tri-state lifecycle |
| `useBlobUrl` | 唯一一個合理用 useEffect+useState 的 blob URL 生命週期 hook |
| `useSwipeRow` / `useSwipeOpen` | 滑刪 row 手勢 + list-level 「目前打開的 row」狀態(haptic light/medium/success 觸發) |
| `useOcrFlow` | OCR pipeline(compressImage → worker → onSuccess);loading 顯示 elapsed seconds + 8s 慢路徑切換文案。被 `useReceiptOcr` 包覆 |
| `useReceiptOcr` | ExpenseFormModal 的 OCR 編排層:組合 `useOcrFlow` + receipt source machine(`sourceKey`/`analyzedSourceKey` 驅動「明細を読み取る↔もう一度読み取る」CTA)+ compare 子功能 + camera/upload pick handlers + `pendingSourceKey` 記帳。回傳分層 `{ status, caps, compare, handlers }`。form-apply(`applyOcrResultToForm`)與 sibling clear(att/items/adjustments)留在 component |
| `useExpenseItems` | items state machine + chip 分擔者 |
| `useSettlements` / `useCreateSettlement` / `useDeleteSettlement` | Settlement 記錄 CRUD + realtime listener。**受取人(toUid)唯一可建立**(rule + UI 雙層 gate);delete 由 `settledBy` 或 trip owner 觸發。算法層在 `services/settlement.ts` 的 `computeBalancesFull` 回 `{ balances, orphans }` |
| `useFeatureBadges` | **AppLayout 內 5 個 always-on Firestore listener**,對比 `lastViewedStore` 算 unread,驅動 BottomNav 紅點 |
| `useOnlineStatus` | 訂閱 `online`/`offline` event,搭配 `OfflineBanner` 顯示離線提示 |
| `createRealtimeListHook` | Generic factory:onSnapshot → TanStack Query cache 同步;**module-level refcount listener dedup**(AppLayout + page 共用 1 個 onSnapshot,降 50% reads) |
| `subscribeToCollection` | 統一 Firestore listener 工廠(throws → captureError) |
| `firestoreDocFromSchema` | doc snapshot → Zod parse(失敗送 Sentry) |
| `tempId()` | 樂觀更新的 client ID,prefix `temp-`,UI 端用來偵測 pending row |
| `patchListCache` / `rollbackListCache` | TanStack Query cache 樂觀 patch / 回滾 |
| `haptic('light'/'medium'/'success')` | `navigator.vibrate` 包裝,iOS Safari noop 降級 |
| `MutationCache.onError`(`src/services/queryClient.ts`)| **全 mutation 失敗的 single source**,讀 `meta: { action, silent }` 自動 Sentry capture + toast。Hook 不再各自 toast |

### 共用 UI primitives

| 元件 | 作用 |
|---|---|
| `BottomSheet` + `FormModalShell` | 5 個 form modal(Schedule/Booking/Expense/Wish/Planning)共用 wrapper。FormModalShell 內建 `saveError` 紅色 banner(AlertCircle + danger-pale) |
| `MemberAvatar` | 純圓 avatar(read-only)— SettlementSummary、voter stack、ExpenseFormModal 的 paidBy / split picker 都用這個。內建 Google photo `<img>` + onError 退回 label fallback |
| `CurrencyInput` | 帶幣值前綴的 number input。**Flex layout 而非 absolute span**,任意 symbol 寬度都不會跟 placeholder「0」重疊(NT$ / CN¥ / HK$ 等多字元 symbol 用這個解)。`size='default'`(42px 主欄)/ `'compact'`(36px row 用)兩種變體 |
| `SkeletonBar` / `SkeletonContainer` / `PageHeaderSkeleton` / `PageSkeletonShell` | Skeleton primitives;Container 支援 `embedded` prop 避免 nested animate-pulse |
| `OfflineBanner` | 離線時頂部 amber 細條,回線後 2s「同期しました」綠條 |
| `Toaster` 加 action button | `toast.error(msg, { action: { label, onClick } })`;timerId tracked → manual dismiss 清 timer |

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

### Save error 處理(modal-driven flow)
- **Modal save 失敗**:Wish / Schedule / Booking / Planning 4 個 modal-driven flow 用 inline banner(`FormModalShell` 內建 + `useFormModal.saveError`)取代 toast,**避免雙通知**
- Hook 配 `useCreateXxx(tripId, { silent: true })`,跳過全域 toast
- Page handleSave 內 `try { ... } catch (err) { modal.setError(err.message) }`,modal 不關;banner stay until next 嘗試 / 關 modal
- **ExpenseFormModal 例外**:optimistic close 流程,modal 在 mutate 之前就關 → 沒 banner,改靠全域 toast + rollback patch

### Hybrid shell loading
- AppLayout `Suspense fallback` 用 generic `PageLoadingSkeleton`(切 tab 第一次 chunk 下載期)
- 各 page 在 `ctx.status === 'loading'` 走自己的 `XxxPageSkeleton`,layout pixel-aligned 真實 page → transition 是「灰塊變內容」不是整塊 swap
- List query 還在 loading 時用 `XxxListSkeleton`(embedded mode,不重複 pulse / aria)
- `prefers-reduced-motion` 全域支援(`index.css` 縮 animation duration 到 1ms)

### Tab unread badge
- **`AppLayout` 內 `useFeatureBadges()`** 開 5 個 always-on Firestore listener(schedules/expenses/bookings/wishes/planning)
- 對比 `lastViewedStore`(Zustand + persist localStorage)算 max(item.updatedAt ?? createdAt) > lastViewed
- BottomNav 對應 tab 渲染紅色圓點(`active` tab 不顯示)
- 切到該 tab → `useEffect` 觸發 `markViewed(currentTripId, feature)`,圓點清除
- `useDeleteTrip onSuccess` 呼叫 `clearTrip(tripId)`,避免 localStorage 累積

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
                → OCR provider (Qwen primary / Claude fallback)
                → return { items[], total, storeName? }
  ↓ onSuccess:
items.reset(result.items.map(i => ({ name, amount, allocations: [] })))  ← 預設無人指派
setField('amount', String(result.total))                                  ← 自動填總額
if (result.storeName && !title) setField('title', result.storeName)       ← 標題空才填

使用者:點每個 item 的 chip 指派分擔者,用 +/- 設定份數(必填)→ 按存
  ↓
validate(): items.every(i => i.allocations.length > 0) && sum(items) === total
  ↓ pass
materializeExpenseSplits(items, adjustments, members) → ExpenseSplit[] → 進 Firestore
```

**「📎 ファイルから追加」差別**: 同樣的 compressImage → pickFile,但**不**自動跑 OCR,改顯示「✨ 明細を読み取る」按鈕,使用者點才 ocr.run。

**錯誤路徑**: `OcrError.kind` 分 `auth / rate-limit / parse / network / config / unknown`,在 `ocrErrorCopy()` 轉成日文 toast 文案。

### Trip switcher(SchedulePage 內)

- **長按 trip row**(400ms hold) → 進入拖曳模式,可上下拖排序 → 釋放更新 `tripStore.tripOrder`(zustand persist localStorage)+ haptic light
- **滑左 trip row**(short swipe) → 露出刪除(owner only),兩段確認;edit mode 下 swipe 自動 disabled
- **編集 / 完了 toggle**(dropdown header):`trips.length > 1` 時顯示,edit mode 下每個 row 右側 inline 顯示 grip + trash icon(取代 swipe 隱藏手勢)
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

### Settlement debt-edge model

`features/expense/services/settlement.ts` 的 `computeBalancesFull(expenses, members, settlements)` 是純函式,5 步算出 `{ balances, orphans }`:

1. **gross[from][to]** ← 從 expenses 累積:每筆 split.amount 加到 `gross[split.memberId][paidBy]`(skip self)
2. **applied[from][to]** ← 套 settlements,**cap 在 gross**:`applied += min(amount, gross - already_applied)`;超出的 leftover 進 orphan
3. **remaining = max(0, gross - applied)** ← 剩餘 debt
4. **normalize**: 對每組無序 pair (a, b),`remaining[a][b]` 跟 `remaining[b][a]` 對抵 → 只留淨額方向。對 transfer suggestion 沒影響(走 net),但 pairwise UI / debug 用得乾淨
5. **net[i] = Σ normalized[j][i] − Σ normalized[i][j]** ← 應收 − 應付

核心不變式: **settlement cannot create debt**。任何刪除 expense 後 settlement 仍在的場景,orphan 補 surface,balance 不會冒出反向應付款。

`paid` / `owed` 顯示**只看 active expenses**(soft-deleted 排除,跟 UI 顯示一致)。`net` 才反映 settlement 後的當下狀態。

UI(`SettlementSummary`)結構: 成員淨額 → 支払い提案(只 receiver 看到 green「済み」 button,其他人 Clock + 「受取待ち」status)→ 清算済み記録(預設展開 2 筆 + 兩段刪除)→ orphan 警告 banner(amber, **reason-aware**)。

### Settlement phase-2: chronological replay + orphan reason 分類

每個 orphan 帶 `reason: 'OVERPAYMENT' | 'EXPENSE_DELETED' | 'MIXED' | 'UNKNOWN'`,透過 `buildOrphanReasonMap` 對 (expense_create / expense_delete / settlement) 事件做時序回放,**先記錄 settlement recording 時的狀態 `{ atRecording, overpayment }`**,最終由 `classifyOrphan(info, leftover)` 依「recording 時的狀態 + 當下殘餘 leftover」推導 reason:

- **OVERPAYMENT** — settlement 在 recording 時 amount 已超過 available debt(`atRecording = 'OVER'`),且最終 leftover 全部都是 recording 時就已超付的部分。代表使用者當下就多付了,跟後續刪不刪 expense 無關。
- **EXPENSE_DELETED** — settlement 在 recording 時完全 fit available debt(`atRecording = 'WITHIN'`);orphan 是後續 expense 被 soft-delete 縮小 gross 才出現。需要 `deletedAt` tombstone 才能正確判斷,phase-2 deploy 後新發生的這類情況都分類得到。
- **MIXED** — settlement 在 recording 時 amount 部分超付(`atRecording = 'OVER'`,有 `overpayment > 0`),且後續又有 expense 被刪除進一步擴大 leftover(`leftover − overpayment > EPS`)。代表兩種成因同時存在,需要使用者逐筆檢視。
- **UNKNOWN** — defensive guard:`atRecording = 'NO_EXPENSE'`(settlement 找不到對應 pair 的 expense gross)。`allow delete: if false` + Worker trip-cascade 一次刪 expense+settlement 後,data-at-rest 不會再產生這狀態;留著當 catch-all,讓未來異常 admin 寫入或資料毀損可見化,不會 silently 被歸到其他 reason。

Soft-delete + Receipt-purge 設計:
- `deleteExpense` 改成 `updateDoc({ deletedAt: serverTimestamp() })`,**保留 receipt**(reversible at data layer 10 天內)
- `Expense.deletedAt?: Timestamp | null` 必要 schema field;`receiptPurgedAt?: Timestamp | null` 也是必要(create 階段 rule 鎖死 present + null)
- `useExpenses` 回傳 ALL(含 soft-deleted);ExpensePage 拆兩路:`displayExpenses = expenses.filter(!deletedAt)` for 列表/總額/件數,`expenses`(unfiltered)for `SettlementSummary` 做 chronological replay
- 樂觀 delete 的 patch 用 `mockTimestampNow()` 而非 `MOCK_TIMESTAMP`(epoch 0),否則 chronological replay 把 delete event 排到所有 expense_create 之前
- firestore.rules:create 鎖 `deletedAt == null` + `receiptPurgedAt == null`;update 的 deletedAt 可 null↔Timestamp 但有 10 天 restore window;receiptPurgedAt 強制 `unchanged`(只有 Worker admin 寫得到)
- 沒做 restore UI(B1 決定);資料層保留 10 天

**P1 closed 2026-05-20** — 之前的 `tripDeletionActive` cascade-window 是 KNOWN BROKEN(owner 可 raw SDK 開窗繞過 tombstone)。透過把 tripCascade 搬到 Worker `/cascade-trip-delete`(admin SDK bypass rules)+ `trips/{id}` 根 doc 與 `expenses/{id}` 子集合 doc 各上 `allow delete: if false` 封死兩條 integrity-critical hard-delete 路徑。**只有這兩種 doc 必走 Worker**;其他 subcollections(schedules / bookings / wishes / planning / settlements / invites / members)維持原本的 `canWrite` / `isTripOwner` / `memberOfDoc` client-side delete rules — 正常編輯 UX,沒有 replay-style invariant 要保護。`deletionStartedAt` 欄位 + helper 全數移除。10-day receipt-purge cron 同批 ship,跑 daily UTC 03:00。

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
- **AI**: `/ocr` 走 `OCR_PRIMARY_PROVIDER`(預設 `qwen`),`/ocr-fallback` 走 `OCR_FALLBACK_PROVIDER`(預設 `claude`),`/ocr-compare` 需 `OCR_COMPARE_ENABLED=true` 才開。Qwen 用 OpenAI-compatible Chat Completions(`QWEN_BASE_URL` / `QWEN_MODEL`);Claude 用 Microsoft Foundry 原生 Anthropic Messages API(`ANTHROPIC_FOUNDRY_RESOURCE` / `CLAUDE_DEPLOYMENT`)。兩者共用 OCR JSON schema + prompt。
- **Wrangler**: `npx wrangler tail` 看即時 log(找 `[qwen]` / `[claude]` 前綴);`npx wrangler deploy` 部署
- **secrets**: `QWEN_API_KEY`(primary 為 qwen 時必填)、`ANTHROPIC_FOUNDRY_API_KEY`(fallback/compare 用 Claude 時必填)

### Firebase
- **Auth**: Google sign-in(popup → redirect fallback iOS PWA)
- **Firestore**: persistentLocalCache 開啟(離線可讀 + cross-tab)
- **Storage**: bucket `tripplanner-80a4f.firebasestorage.app`
- **rules**: `firestore.rules` 三層分權 + `storage.rules` 角色 gate + 5MB cap + mime 白名單

## 開發指令速查

```bash
npm run dev                                # vite dev server
npm run build                              # tsc -b + vite build(含 React Compiler)
npm run deploy:pages                       # build + Cloudflare Pages deploy
npx vitest run                             # 全測試
npx tsc --noEmit                           # typecheck only
npx eslint src                             # lint
firebase deploy --only firestore           # firestore rules + indexes
firebase deploy --only storage             # storage rules
cd workers/ocr && npx wrangler deploy      # Worker 上線
cd workers/ocr && npx wrangler tail        # Worker 即時 log
```

## Dev tools

- **`window.dev.failNextSave(msg?)`** — DevTools console 跑一行,觸發下一次 modal save 失敗,測試 saveError banner / 全域 toast 路徑。Single-shot(用完自動 clear)。Production 不可用(`import.meta.env.DEV` 為 false → Vite tree-shake)。詳見 `src/utils/devFailures.ts`
- **`window.dev.clearFailNextSave()`** — 取消 pending fail flag

## 慣例 / 風格

- **註解語言**: TypeScript 程式碼內註解用**繁體中文 / 英文**,UI 文案用**日文**(這個 app 主要服務日本旅遊情境)
- **emoji 用法**: 禁止寫進程式碼,除非使用者明確要求(現有 emoji 是 UI 內容如 ✈️🏨 等,屬功能性)
- **型別 vs interface**: 表單 state 用 `type`(才能塞進 `Record<string, unknown>` 約束);entity / props 用 `interface`
- **錯誤處理**:
  - 服務層 throws → mutation hook `onError` 做 rollback / cache patch(**不再各自 toast**)
  - 全 mutation 失敗統一走 `src/services/queryClient.ts` 的 `MutationCache.onError`:讀 `meta: { action, silent }` → Sentry capture + 全域 toast
  - Modal-driven hook(useCreateXxx / useUpdateXxx for wish/booking/planning/schedule)配 `{ silent: true }` → 跳過全域 toast,改在 modal 內 banner(`useFormModal.saveError` + FormModalShell)
  - 不要靜默 swallow
- **PWA**: vite-plugin-pwa,`registerType: 'prompt'` 不自動更新,PwaUpdatePrompt 由使用者觸發
- **iOS input zoom**: 所有 input 強制 `text-[16px]`(`inputClass` helper),否則 iOS Safari focus 會 zoom
- **手動 memoize**: 已交給 React Compiler,**新程式碼不要寫 useCallback / useMemo / React.memo**。唯一例外:`useBlobUrl`(外部資源生命週期)

## 已記憶的 user feedback(`.claude/projects/.../memory/`)

存於 `~/.claude/projects/C--Users-PC-C-Desktop-travel-app/memory/MEMORY.md` index 內。可用查詢時自動載入。重要的有:
- 回覆用**繁體中文**,程式碼 / 註解保留原語言
- Deploy 不需問,直接 `firebase deploy`
- **三思再講** —— 涉及版本 / 套件 / API 用法時,先 fetch 官方文件再說,不靠記憶
- 每個 feature 完成後做**架構簡化**(extract hooks / components when 2+ callers)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **TripPlanner** (4714 symbols, 11672 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/TripPlanner/context` | Codebase overview, check index freshness |
| `gitnexus://repo/TripPlanner/clusters` | All functional areas |
| `gitnexus://repo/TripPlanner/processes` | All execution flows |
| `gitnexus://repo/TripPlanner/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
