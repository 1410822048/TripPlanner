# TripMate — 架構速查

> 旅遊行程協作 PWA(React 19 + Firebase + Cloudflare Worker)。繁體中文 UI、繁中註解。
> 設計取向:**preview-first / optimistic / realtime**。

---

## Stack

| 層 | 技術 |
|---|---|
| Frontend | **React 19** + Vite 8 + TanStack Query v5 + Zustand v5 + Tailwind v4 + React Router v7 |
| Compiler | **babel-plugin-react-compiler v1**(自動 memoise,所以幾乎沒有手寫 useCallback/useMemo) |
| Backend | **Firebase v12**: Auth(Google)/ Firestore(+ IndexedDB persistence) + **Cloudflare R2** private attachments |
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

R2:`trips/{tripId}/expenses/{expenseId}/receipt.webp` + `thumb.webp` 等(private bucket,WebP thumbnail variants)。

## 三層權限(Firestore rules + Worker R2 authorization)

- **owner**(`isTripOwner`): trip 編輯 / 邀請 / 成員管理 / 刪除
- **editor / owner**(`canWrite`): schedule/booking/expense/planning 的 CRUD,R2 附件上傳
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
- **特色 2 — Items 模式**: items.length > 0 時,平均分攤 / 自訂 split 收起,改用 chip-per-row 多選分擔者,splits 反算
- **特色 3 — Settlement (debt-edge model)**: 演算法在 `services/settlement.ts`,**pairwise gross → applied(cap)→ remaining → normalize → net** 五步純函式。核心不變式: **settlement 只能 reduce 既存 debt,不能 create 反向 debt** — 刪 expense 後不會冒出反方向應付款,超出天然債務的部分變 `orphan` 顯式 surface。`paid` / `owed` 顯示**只看 expenses**(不被 settlement 污染);`net` 來自 normalize 後的剩餘 debt。**受取人(toUid)唯一可按「済み」**(firestore.rules 鎖死;付款人視覺上不是按鈕,是 Clock + 「受取待ち」status pill)。Settlement 歷史:預設展開最近 2 筆,行內兩段刪除(`settledBy` 才能刪)。詳見「複雜流程詳解 / Settlement debt-edge model」
- **特色 4 — 列表日期 fold**: `ExpenseDateGroups` 預設展開最近 2 天(`DEFAULT_EXPANDED_DAYS`);user override 用 `useState<Map<date,bool>>` 記,加新費用造成日期 reorder 時 toggle 選擇不被覆蓋
- **Optimistic close**: 按存 → modal 立刻收 → list 顯示半透明 row + 旋轉「保存中…」(overlay pending 偵測)→ server truth 一致時撤下 overlay
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
| `useReceiptOcr` | ExpenseFormModal 的 OCR 編排層:組合 `useOcrFlow` + receipt source machine(`sourceKey`/`analyzedSourceKey` 驅動 OCR CTA)+ camera/upload pick handlers + `pendingSourceKey` 記帳。回傳分層 `{ status, caps, handlers }`。form-apply(`applyOcrResultToForm`)與 sibling clear(att/items/adjustments)留在 component |
| `useExpenseItems` | items state machine + chip 分擔者 |
| `useSettlements` / `useCreateSettlement` / `useDeleteSettlement` | Settlement 記錄 CRUD + realtime listener。**受取人(toUid)唯一可建立**(rule + UI 雙層 gate);delete 由 `settledBy` 或 trip owner 觸發。算法層在 `services/settlement.ts` 的 `computeBalancesFull` 回 `{ balances, orphans }` |
| `useFeatureBadges` | 讀 trip doc 的 `lastActivityByFeature`(**0 個額外 listener**,搭現有 trip-doc listener 便車),對比 `lastViewedStore` 算 unread,驅動 BottomNav 紅點 |
| `useOnlineStatus` | 訂閱 `online`/`offline` event,搭配 `OfflineBanner` 顯示離線提示 |
| `createRealtimeListHook` | Generic factory:onSnapshot → TanStack Query cache 同步;**module-level refcount listener dedup**(AppLayout + page 共用 1 個 onSnapshot,降 50% reads) |
| `subscribeToCollection` | 統一 Firestore listener 工廠(throws → captureError) |
| `firestoreDocFromSchema` | doc snapshot → Zod parse(失敗送 Sentry) |
| `createListOverlay` / `applyOverlays` | **樂觀狀態的唯一機制**:query cache 只放 server truth,op(create/patch/remove)在讀取時重播。`confirms` 決定何時撤下,`authoritativeFetch` 走 `getDocsFromServer` 定奪 ambiguous 寫入 |
| `useOverlayPendingRowIds` | 從 overlay 推導「寫入仍在飛行中」的 row id,驅動 pending 視覺與 tap/swipe 鎖定 |
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
- **scope 捕捉(跨 trip 防護)**: mutation hooks 綁的是**即時** trip id,被踢 / 旅程被他人刪除會讓 `useCurrentTripSync` 背景改選,開著的 modal 若照存會把 trip A 的內容無聲寫進 trip B;demo → 登入轉換同理。兩種策略,依「有沒有草稿」選:
  - **有草稿(5 個 entity form + SettlementRecordSheet + WishDeadlineSheet)**: open 時 snapshot `{ tripId, uid }`(`useFormModal` scope 參數 / sheet 自帶),save/delete 時 mismatch → `FORM_SCOPE_CHANGED_MESSAGE` **保留內容拒絕寫入**,絕不用 effect 自動關(會吃草稿)。SettlementRecordSheet **必須**有 client guard —— Worker 的 `expectedRemainingMinor` 只是數值 CAS,同 pair 同餘額的另一個 trip 會通過。scope 比對必須**先於**任何會清內容的分支:wish 的 `votingClosed` 會 `modal.close()`、settlement 的 `isDemo` 會 `setRecordTarget(null)` —— cloud→demo 登出轉換要先被 scope 攔下(demo 開的 sheet 捕捉 `{undefined,undefined}`,live demo 仍匹配,照常走 sign-in prompt)。live trip/uid **消失**(cloud→demo / no-trip)併入同一個 fail-closed 分支,不可 `if (!cloudTripId) return` 靜默吞掉
  - **無草稿的管理 modal(MembersModal / InviteModal)**: open state 蓋 `{ tripId, uid }` 章,trip / 帳號一變即 **derive 成關閉**(`useScheduleModals`),並以 `key={currentTrip.id}` remount 清掉 pending confirm(remove / transfer / leave)—— 否則重開會復活上一個 trip 的確認面板。mismatch 是 **transition 不是可重推導的狀態**:首次 mismatch 必須把 stamp 永久清除(render-phase adjust,同步關閉),否則 A→B→A 折返會重新匹配舊 stamp,modal 自己重開
  - `useFormModal.scopeChanged` 對「captured 存在但 live scope 是 undefined」fail-closed
- **autofocus**: 第一個 input 用 `useAutoFocus(ref, isOpen)` 自動 focus
- **bottom sheet**: `BottomSheet` 元件 + `FormModalShell` 包一層 SaveButton,所有 form modal(Schedule/Booking/Expense/Wish/Planning/EditTrip)共用

### Save error 處理(modal-driven flow)
- **Schedule / Planning**:modal-wait flow。Hook 配 `{ silent: true }`,Page 在 `await mutateAsync` 失敗時用 `modal.setError(err.message)` 顯示 inline banner；modal 不關,避免與全域 toast 雙通知。
- **Expense / Booking / Wish**:optimistic-close flow。一般情況在 `mutate` 前關閉 modal；明確失敗由 overlay 撤回該 operation,並由全域 `MutationCache.onError` 顯示 toast。Schema Epoch preflight 是例外：不相容時在關閉前同步擋下,保留表單並顯示 inline banner。

### Hybrid shell loading
- AppLayout `Suspense fallback` 用 generic `PageLoadingSkeleton`(切 tab 第一次 chunk 下載期)
- 各 page 在 `ctx.status === 'loading'` 走自己的 `XxxPageSkeleton`,layout pixel-aligned 真實 page → transition 是「灰塊變內容」不是整塊 swap
- List query 還在 loading 時用 `XxxListSkeleton`(embedded mode,不重複 pulse / aria)
- `prefers-reduced-motion` 全域支援(`index.css` 縮 animation duration 到 1ms)

### Tab unread badge
- **`AppLayout` 內 `useFeatureBadges()`** 讀 trip doc 的 `lastActivityByFeature` map,**不開任何額外 listener**(早期版本開 5 個 always-on collection listener,已改成由各 service mutation 呼叫 `bumpTripActivity` 反正規化進 trip doc)
- 對比 `lastViewedStore`(Zustand + persist localStorage)算 lastActivity > lastViewed
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

| 觸發行為 | 所在 page | List 是否 optimistic | Modal 行為 | Pending UI |
|---|---|---|---|---|
| 新增 / 編輯 expense | `/expense` | ✅ Overlay + **optimistic close** | 按存後立即關閉 | ✅ row 半透明 + 「儲存中…」,block tap/swipe |
| 新增 / 編輯 schedule | `/schedule` | ✅ Overlay(modal-wait) | `await mutateAsync`;成功才關,失敗留在 modal 顯示 banner | Modal 儲存中狀態 |
| 新增 / 編輯 booking(含批次 PDF) | `/bookings` | ✅ Overlay + **optimistic close** | 按存後立即關閉 | ✅ row 半透明 + 「儲存中…」,block tap/swipe |
| 新增 / 編輯 wish | `/wish` | ✅ Overlay + **optimistic close** | 按存後立即關閉 | ✅ card 半透明 + pending pill,block edit/vote |
| 新增 / 編輯 planning | `/planning` | ✅ Overlay(modal-wait) | `await mutateAsync`;成功才關,失敗留在 modal 顯示 banner | Modal 儲存中狀態 |
| Toggle planning row done | `/planning` | ✅ Optimistic | 沒 modal | 無(checkbox 立即翻) |
| Wish vote toggle | `/wish` | ✅ Optimistic | 沒 modal | 無 |
| Swipe delete(支援滑刪的 list row) | 各 list page | ✅ Optimistic | 沒 modal | row 立刻消失 |

**Optimistic-close 的選擇**:
- Expense receipt、Booking 附件 / 批次 PDF、Wish 圖片都可能包含較慢的 Worker / R2 路徑,因此三者按存後立即收 modal,由 list overlay 顯示進度。
- Schedule / Planning 同樣使用 operation-scoped overlay 保護並行寫入,但保留 `await mutateAsync` 的 modal-wait UX；失敗時使用者仍在原表單內,可直接修正或重試。

## Pending state 規範

```
Expense / Booking / Wish:
按存 → validate() pass → modal.close() → mutate(...) 背景跑

Schedule / Planning:
按存 → validate() pass → await mutateAsync(...) → 成功才 modal.close()
                                           └→ 失敗保留 modal + inline banner

兩條路徑共用 list mutation pipeline:
global MutationCache.onMutate:同步檢查 Schema Epoch(只讀 memory snapshot,不碰網路)
→ local onMutate: overlay.add(op)(id 由呼叫端 crypto.randomUUID() 鑄造)
→ mutationFn: setDoc / Worker 寫入
→ 明確失敗: drop(該 operation)；optimistic-close flow 另由全域 toast 提示
→ ambiguous: markAmbiguous → 等 settle window → 讀 server truth 定奪
→ 成功: markSucceeded → reconcile 在 server truth 一致時撤下
```

**Pending row 視覺 / 互動規範**(`SwipeableExpenseItem` / `SwipeableBookingItem` / `WishCard`):
- 偵測: `useOverlayPendingRowIds(controller, queryKey).has(row.id)` — **不再用 id 形狀判斷**;id 從一開始就是最終 id
- 視覺: `opacity-55` 半透明,meta 行用 `<Loader2 className="animate-spin" />` + 「**儲存中…**」
- 互動: `onClick = undefined`(完全不接 tap)+ `swipeable = false`(`useSwipeRow` 整個禁用)
- 解除: op 被 drop 時自動解除;已 `succeeded` 但還在等 snapshot 的 op **不鎖 UI**(寫入已完成,只差確認)

### PWA Schema Epoch(write compatibility gate)

- `public/compatibility.json` 是同源、`Cache-Control: no-store` 的 operational manifest：`{ revision, minimumWriteEpoch }`；不進 Workbox precache / runtime cache。
- `CLIENT_SCHEMA_EPOCH` 編進 bundle。`revision` 必須單調增加；較新的 revision 可降低 `minimumWriteEpoch`,供緊急 rollback。
- boot / visibility / online / bfcache pageshow / 3 分鐘 visible timer 背景 refresh；single-flight,成功結果存 memory + localStorage 並用 storage event 跨 tab 同步。被動 check 的 30s floor 用 `performance.now()`(單調)—— `Date.now()` 遇時鐘回撥會讓 elapsed 持續為負,把所有被動更新凍結到牆上時間追回為止。CTA(force)撞上 in-flight 被動檢查時**先等它 settle 再發全新 fetch** —— 服務層 single-flight 會把「點擊前就發出」的 request 交回來,它失敗或載到 rollback 前的 manifest 都會讓第一次點擊白按。
- mutation path **只同步讀 memory snapshot**,禁止 fetch。唯一 fail-closed 狀態是「曾確認 client epoch 低於 minimum」；無成功紀錄、fetch/parse 暫時失敗一律 fail-open,由 Rules / Worker 維持最終安全邊界。
- global `MutationCache.onMutate` 在任何 local optimistic `onMutate` 前擋下舊 bundle；`UpdateRequiredError` 不進 Sentry / toast,由 root `AppCompatibilityGate` 顯示不可 dismiss 的更新 CTA。
- optimistic-close page 必須在清空 draft / 關 modal 前呼叫同步 preflight；不相容時保留表單。已經開始的 mutation 不會被中途取消,避免切斷 cascade / upload cleanup。
- **三個值分開,不要互相折疊**:`isOwner`(純身分)/ `writeCompatible`(純 epoch,`isDemo || !updateRequired`)/ `canOwnerWrite = isOwner && writeCompatible`。`isOwner` **絕不可**折進 epoch —— 它同時驅動結算鎖覆寫與 `ExpensePage` 的 readonly redirect,一旦 manifest 在使用者編輯途中更新就會讓 owner「不再是 owner」,把開著的表單連同草稿一起卸載。`canWrite` 可以折(它沒有身分語義)。
- `MembersModal` 自己從 `uid === trip.ownerId` 推 `isOwner`,同樣**不可**折 —— 會經由 `!isOwner` 反轉,讓被擋的 owner 冒出「退出旅程」。
- 訊息順序:`canWrite` 已折入 epoch,所以任何會講「你沒有編輯權限」的分支都要**先**檢查 epoch,否則版本過舊會被說成權限不足。
- **隱藏 affordance 擋不住 stale-open sheet** —— 隱藏只影響 flip 之後的 render。因此 `saveTrip` / `onLeaveTrip` / MembersModal 三個 confirm / wish 選單刪除 / 結算刪除 / InviteModal 產生與撤銷 / schedule modal 刪除 / expense 與 booking 的 swipe 刪除都各自有同步 preflight(swipe 類是已 dispatch 的手勢仍可能在 flip 後落地)。isMember-class(wish 投票、planning 勾選)沒有任何角色 gate,同理。這些一律 `toast.error(reason)`,沿用該處既有 toast 慣例而非新增 disabled 狀態。
- 空狀態文案用 `roleCanWrite`(未折 epoch 的角色半邊)分因,且**角色優先**:`canWrite=false` 時先看 `roleCanWrite` —— false 講檢視者文案,true 才講「更新後即可繼續新增」。反過來會對 viewer 承諾更新後可寫(更新完仍是 viewer),對過舊的 editor 謊稱是權限問題。`writeCompatible` 留給無角色概念的入口(建立旅程)。
- **`activeDate` 以 trip 為鍵**(`{ tripId, date }`)。只做 `dateRange.includes()` 不夠 —— 兩個旅程日期重疊(或複製出來的旅程)時,舊日期仍然合法,刪除 / 退出後會被下一個旅程繼承。改成 keyed 後,任何切換都自動失效,刪除 / 退出因此完全不需要碰 `activeDate`(事前 reset 會在失敗時吃掉選日,放 `onSuccess` 則會被晚到的回呼清掉之後才選的日期)。
- **`/route-apply` 是唯一不經 useMutation 的 Worker 寫入**,epoch preflight 放在 `applyRoutePreview` service choke point(涵蓋所有 stale-open caller);`routeErrorMessage` 對 `UpdateRequiredError` 回原文案,避免 fallback 成「請重新預覽後再試」這種兌現不了的建議。其他 Worker write 端點全部包在 mutation hooks 內,由全域 guard 涵蓋 —— 新增直接 `workerFetch` 寫入時必須比照。
- **不走 TanStack 的直接寫入**(`features/account`)採分類豁免,不要一律擋:只有 `usePushNotifications.enable()`(建立完整 token entity)在 `Notification.requestPermission()` 前 preflight;`disable()` / 登出 `revokeStoredPushToken` / 權限撤銷後的清理屬 cleanup,**永遠放行**,否則舊 client 會被困在無法關閉通知的狀態;通知已讀 / 忽略只寫 timestamp 欄位,一併放行。
- 發版採兩段式：先部署新 epoch client（minimum 仍容許舊版）→ 更新窗口後,提高 manifest minimum 再部署 Pages。Firestore 清空不會清掉裝置上的舊 PWA bundle,**部署 Pages 也不會** —— 已安裝的 SW 會一直跑到使用者更新為止,所以「讓舊 bundle 停止寫入」只有提高 manifest minimum 這一條路。
- 當這一版的 Worker 會**拒絕舊 bundle 送得出來的請求**(新必填欄位 / 改掉的 wire 契約)時,epoch 兩段式要再接第三段:cutoff 生效後才部署 strict Worker,否則兩者之間的窗口全是 400。範例見「附件 stale-replace 契約」。

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
  - `delete` → DeleteConfirm inline → 刪 trip + cascade R2
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

### Worker 錯誤分類(precommit / ambiguous / post-commit)

client 對 Worker 失敗只有兩種處置:**definitive → 回滾樂觀列**,**ambiguous → 保留並等 listener 對帳**。分錯的代價是不對稱的 —— 把確定沒寫入的錯誤講成 ambiguous 會留下永遠不會被 server 取代的 phantom row;把已經寫入的講成 definitive 會回滾掉線上真實存在的資料。

- **precommit 標記由 `runFirestoreTransaction` 自己蓋**(`isPrecommitError`):body 拋錯時 commit 尚未執行,而且先前的 attempt 不可能已 commit(成功會 return、ABORTED 沒寫入、ambiguous 直接拋不重試)。**derived 而非宣告**,所以不會像手維護的 route flag 那樣,在有人於 tx 之後加工作時默默說謊
- `cascadePrecommit` route flag 保留給**開 tx 之前**就拋出的 CascadeError(plain-GET precheck),那些 wrapper 看不到
- **`PostCommitError`**:已經 commit、後續階段才失敗。**它不是 `CascadeError`,所以碰不到蓋 precommit 的分支**,自然落到 ambiguous 的 generic 500 —— 機制就在包裝本身,dispatcher 不需要額外分支(加了反而讓 Sentry 少一層 wrapper frame)
- `/invite-redeem` 是目前唯一需要它的地方:membership 已 commit,而 post-tx 的 `cascadeMemberAdd` 自批次 1 起會跑自己的 transaction,**它的 CascadeError 會帶著 precommit 標記** —— 那對它自己的 tx 為真、對這個 request 為假。不包就會回滾一個真的加入了的成員
- 同一處的 cascade **暫時性失敗會自動重試一次**(`cascadeWithRepairRetry`)。使用者沒有理由自己重新 redeem —— 在他眼中已經加入了 —— 所以被 blip 撕裂的 ACL projection 會一直留著,讓他成為一個讀不到子集合的成員。重試安全是因為 cascade 的寫入全是冪等 arrayUnion + `exists` precondition;順帶讓「doc 在 cascade 途中被刪」自我收斂(第一次撞 404,第二次重新 list 就沒有它了)。**`CascadeError` 不重試** —— 那是政策拒絕(被踢 / trip 刪除中),狀態穩定,再試一次只是白跑並埋掉原因。無論哪種,最終仍包成 `PostCommitError`
- **`withTokenRetry` 對 `PostCommitError` 直接 rethrow**。它靠 message 比對 `→ 401`,而 `PostCommitError` 會把 cause 的訊息嵌進自己的 message —— 少了這個 early return,一個包著 401 的 post-commit 失敗會讓最外層把**整個 redeem(含已 commit 的 membership tx)**重跑一次,再與 `cascadeMemberAdd` 內層、`cascadeWithRepairRetry` 相乘成 8 次。原則:**已 commit 的請求永遠不整包 replay**,那個 wrapper 的職責是在任何寫入之前換掉過期 token
- tx mock(`test/helpers/tx-mock.ts`)取代整個模組,所以會構造 / instanceof 這些 class 的 spec 必須先 spread `importActual`,否則 `new PostCommitError` 拿到 undefined,TypeError 讀起來像通過

### 附件 stale-replace 契約(expense / booking / wish)

三個 Worker file-write 端點共用一個不變式:**寫附件前必須證明自己看到的是最新狀態**。否則 Tab A 會蓋掉 Tab B 剛 commit 的替換,並讓 B 的 blob 變孤兒(空殼上 `referencedPaths()` 讀不到東西,blob 會被 storage-scan 當 orphan 清掉)。

- `wish`:`expectedCurrentPath`(單一 image,schema 必填)
- `expense`:`expectedCurrentReceiptPath` —— schema 可選,但**在 doUpdate 依「是否碰到 receipt」強制**:`intentIds` 存在或 `patch.receipt === null` 時**必填**,否則**禁止**。schema 不設必填是因為 text-only 更新共用這個端點,無條件必填等於白白擋掉它們
- `booking`:`expectedCurrentPaths` per-role map。**覆蓋率由 Worker 自行推導的 touched set 檢查**(`requireExactExpectedPathCoverage`):touched = `attachments` 的 role ∪ `clearAttachments`,snapshot 的 key 集合必須**完全相等**。entries 光是 optional 而沒有覆蓋率檢查,`expectedCurrentPaths: {}` 就能繞過全部比對 —— 這是實際存在過的洞。touched set **絕不可**由呼叫端宣告,否則等於把繞過方式還回去

比對一律 `readNestedString(...) ?? null`,讓「map 不存在」與「明確 null」collapse 成同一件事(對應 client 的 `existing?.path ?? null`)。不符 → 409。

**部署順序必須走 Schema Epoch 四階段**,單純「先 Pages 再 Worker」**不夠** —— 部署 Pages 不會清掉裝置上已安裝的 SW / bundle,舊 bundle 會繼續跑到使用者自己更新為止,strict Worker 一上線它的收據替換 / 刪除就吃 400:

1. `CLIENT_SCHEMA_EPOCH = 2`、manifest 仍留 `minimumWriteEpoch: 1` → 部署 Pages
2. 等更新窗口(讓裝置換到 epoch-2 bundle)
3. manifest 提到 `{ revision: 2, minimumWriteEpoch: 2 }` → 再部署一次 Pages(manifest 由 Pages 提供)。**已成功取得 revision 2 manifest 的** epoch-1 bundle 從此停寫,由 `AppCompatibilityGate` 顯示更新 CTA
4. 確認 production `/compatibility.json` 真的是 revision 2、並等過 active-client 的 refresh 窗口後,才部署 strict Worker

**cutoff 不是全域同步生效,別這樣宣稱。** `clientCompatibility.ts` 在 module load 時**同步** hydrate localStorage 裡的舊 manifest,refresh 是非同步 effect,而未知狀態一律 fail-open(這是刻意的:寧可放行也不要因為 manifest 抓不到就鎖死全 app)。所以休眠很久的裝置醒來時,會先帶著 `{revision:1, minimumWriteEpoch:1}` 的 cached snapshot 放行寫入,直到 refresh 落地為止 —— 這段窗口內的請求仍會打到 strict Worker 並吃 400。epoch gate 的作用是把這類 400 的範圍**縮小到還沒成功取得 cutoff manifest 的 late client**;對那些 client 這不是一次性的 —— 只要 fetch 持續失敗,cached revision 1 就持續 fail-open,使用者每次重試都可能再撞一次,直到某次 refresh 成功為止。**Worker 才是最終邊界**。要做到零 400 只能讓 Worker 保留 backward-compatible grace 或版本化端點,這裡不值得。

方向與 rules tighten 相反(那邊是 Worker→Pages→rules);差別在於這裡的舊寫入者是**使用者裝置上的 bundle**,只有 epoch gate 能讓它停手。順帶一提 top-level request schema 沒有 `.strict()`(Zod 預設 strip),所以第 1 階段新欄位送到舊 Worker 會被無害丟棄。

booking 的覆蓋率收緊不需要 epoch —— client 一直就送精確的 touched set,舊 bundle 本來就合規;需要 epoch 的是 expense 的新必填欄位。

### 成員 ACL cascade(add 側的 roster guard)

`cascadeMemberAdd`(`workers/ocr/src/cascade.ts`)把 uid arrayUnion 到 trip doc 與每個子集合 doc 的 `memberIds[]`。**每個 ≤500 writes 的 chunk 都跑在自己的 transaction 內,並在 tx 中重讀 trip roster**;plain-GET 的前置檢查只是 fail-fast,單靠它是 TOCTOU:

```
T0 cascade 讀 roster(含 M)   T1 /member-remove commit removingAt + roster strip
T2 kick 的 strip cascade 清空各 doc   T3 cascade 的 arrayUnion 落地 → M 回到所有 ACL,踢人被倒轉
```

roster strip 寫的就是每個 chunk tx 讀的那份 trip doc,所以:strip 前開始的 chunk 會在 commit 時 ABORT(wrapper 重試 → 重讀 → 拒絕),strip 後開始的 chunk 直接讀到已剝離的 roster 而拒絕。strip 之前就 commit 的 chunk 由 kick 自己的 strip cascade 收乾淨。**不可改成單一大 transaction**(Firestore commit 上限 500 writes);chunk 之間不需要原子性 —— arrayUnion 冪等,部分套用可重跑。

member doc 的 roster seed 走同一個 guard,且 roster 取自**該 tx 自己的讀**而非另一次 GET(否則 kick 落在中間時,會拿已經過期的 roster 去 seed 一個即將被刪的 doc)。

`TxWrite` 為此新增 `op: 'transform'`(top-level `transform`,對應 SDK 的 arrayUnion)。**每一筆都必須帶 `currentDocument: { exists: true }`** —— transform 打在不存在的 doc 上**不會失敗**:Firestore 回 200 並建立一個只帶該欄位的空殼(已對 emulator 實測;SDK `updateDoc` 的 not-found 來自 precondition,不是 transform 本身)。少了它,`listDocNames` 與 commit 之間被刪掉的 doc 會復活成只帶 `memberIds` 的空殼 —— 因為帶著 `memberIds`,它會**命中成員的 array-contains listener**,client 拿到一個沒有任何欄位可 parse 的 entity;附件也救不回來,`referencedPaths()` 在空殼上讀不到 receipt / image / document,blob 反而被判成 orphan 清掉。帶了它,commit 失敗碼是 **404 NOT_FOUND(不是 412)**,所以 tx wrapper 視為確定性失敗、不會空燒重試預算;呼叫端靠重跑 cascade 收斂(`/invite-redeem` 的 already-member 分支會重新 list,那時已不含被刪的 doc)。

**Trip cascade 的子集合清單必須涵蓋全部** —— `trip-cascade.ts` 的 `TRIP_SUBCOLLECTIONS` 是 Worker-local 硬編清單(bundle 保持獨立、不 import client types),所以新增任何寫在 `trips/{tripId}/` 底下的子集合時**一定要同步加進去**,`members` 維持在最後。`uploadIntents` 曾經漏掉:purge cron 只用 `expiresAt` / `usedAt` 比對,used intent 會在 trip 消失後再留 7 天,而欄位缺失 / 格式異常的 doc **任何 purge query 都比不到,等於永久殘留**;firestore.rules 的註解也一直宣稱 trip purge 會順帶回收它們。測試用「完整名單 + 順序」斷言而非只檢查單一項,因為真正的失效模式是「有人加了子集合卻忘了這個陣列」。

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
- **端點**: `POST /ocr`；附件走 `POST /attachment-upload`、`GET /attachment-content`、`POST /attachment-delete`
- **驗證**: `jose` + `createRemoteJWKSet` 驗 Firebase JWT
- **附件**: private R2 `ATTACHMENTS` binding；production=`tripmate-attachments-production`；無 public domain / S3 credentials。Pages preview 直接共用 production Worker / R2
- **AI**: 收據 `/ocr` 與 Booking PDF extraction 使用 Alibaba Model Studio 的 Qwen3.7-Flash(`QWEN_BASE_URL` / `QWEN_MODEL`);收據 `/ocr-fallback` 使用 Microsoft Foundry Claude 原生 Anthropic Messages API(`ANTHROPIC_FOUNDRY_RESOURCE` / `CLAUDE_DEPLOYMENT`)。兩者皆以嚴格 JSON schema 驗證輸出。
- **Wrangler**: `npx wrangler tail` 看即時 log(找 `[qwen]` / `[claude]` 前綴);`npx wrangler deploy` 部署
- **secrets**: `QWEN_API_KEY`(primary 為 qwen 時必填)、`ANTHROPIC_FOUNDRY_API_KEY`(fallback 用 Claude 時必填)

### Firebase
- **Auth**: Google sign-in(popup → redirect fallback iOS PWA)
- **Firestore**: persistentLocalCache 開啟(離線可讀 + cross-tab)
- **rules**: `firestore.rules` 三層分權；附件的 5MB/MIME/path/BOLA 驗證由 Worker enforce

## 開發指令速查

```bash
npm run dev                                # vite dev server
npm run build                              # tsc -b + vite build(含 React Compiler)
npm run deploy:pages                       # build + Cloudflare Pages deploy
npx vitest run                             # 全測試
npx tsc --noEmit                           # typecheck only
npx eslint src                             # lint
firebase deploy --only firestore           # firestore rules + indexes
cd workers/ocr && npm run deploy            # production Worker + production R2 binding
cd workers/ocr && npx wrangler tail        # Worker 即時 log
```

## Dev tools

- **`window.dev.failNextSave(msg?)`** — DevTools console 跑一行,觸發下一次 modal save 失敗,測試 saveError banner / 全域 toast 路徑。Single-shot(用完自動 clear)。Production 不可用(`import.meta.env.DEV` 為 false → Vite tree-shake)。詳見 `src/utils/devFailures.ts`
- **`window.dev.clearFailNextSave()`** — 取消 pending fail flag

## 慣例 / 風格

- **語言規範**: TypeScript 程式碼內註解用**繁體中文 / 英文**；所有使用者可見的 UI 文案、錯誤訊息與無障礙名稱一律使用**繁體中文**。日本旅遊情境中的正式地名、品牌名與使用者輸入內容保留原文。
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

This project is indexed by GitNexus as **TripPlanner** (6133 symbols, 14889 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
