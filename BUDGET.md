# Firebase 用量與成本評估（20 人規模）

最後更新：2026-05

本文件記錄 TripMate 在 **20 名活躍使用者** 規模下，預期的 Firebase 各服務用量與費用。
目的：監控用、debug 時參考、決定何時該升 Blaze plan。

---

## 使用者行為假設

| 維度 | 假設值 |
|---|---|
| 活躍使用者 | 20 人 |
| 平均每人 trip 數 | 3 個（含被邀請加入的） |
| 唯一 trip 總數（去重） | ~15 個 |
| 平均每 trip 成員數 | 4 人 |
| 平均每 trip 資料量 | 40 schedules / 25 expenses / 10 wishes / 5 bookings / 15 planning items |
| 每人每日 app 開啟次數 | 5 次（早/中/晚 + 規劃時頻繁開） |
| 每次 session 走訪 tab 數 | 平均 3 個 |
| 寫入動作 | 每人每天 ~10 次（加 schedule、投票、勾 todo 等） |

---

## 各服務逐項試算

### 1. Firestore reads（**最容易超額的指標**）

| 路徑 | 單次 reads | 備註 |
|---|---|---|
| 進 SchedulePage 首屏 | ~50 | useMyTrips + useSchedules + useMembers + prefetch bookings |
| 切到 ExpensePage | ~25 | 新 expense query |
| 切到 BookingsPage | ~10 | bookings query（small） |
| 切到 WishPage | ~12 | wishes query |
| 切到 PlanningPage | ~17 | planning query |
| 切到 AccountPage | ~25 | 跨 trip member fan-out |

**每 session 平均**：~80 reads（走訪 3 個 tab + 共用快取）

**每人每天**：
```
5 sessions × 80 reads × 0.5（TanStack staleTime 命中率） = 200 reads
```

**全體每天**：
```
20 人 × 200 reads = 4,000 reads/天
```

**免費額度**：50,000 reads/天 → **使用率 8%** ✅

> 留 92% 餘裕給：cascade delete 偶發、新加入者初載入、bug 多打查詢等。

---

### 2. Firestore writes

| 動作 | 寫入次數 |
|---|---|
| 加一筆 schedule | 1 |
| 加一筆 expense | 1 |
| 投票 wish | 1 |
| 勾 todo done | 1 |
| 邀請接受（新增 member + booking memberIds 同步） | 1 + N（N = trip 既有 booking 數） |
| 刪 trip cascade | 100-200（含 storage + subcollection 全清） |

**每人每天**：~10 寫入

**全體每天**：
```
20 人 × 10 = 200 writes/天（不含偶發大事件）
```

**免費額度**：20,000 writes/天 → **使用率 1%** ✅

> 偶發 cascade delete trip 會一次燒 ~150 writes，無傷大雅。

---

### 3. Firestore 儲存

| 文件類型 | 平均大小 | 數量 | 小計 |
|---|---|---|---|
| Trip | 0.5 KB | 15 | 7.5 KB |
| Schedule | 1 KB | 600 | 600 KB |
| Expense | 0.8 KB | 375 | 300 KB |
| Wish | 1 KB | 150 | 150 KB |
| Booking | 1 KB | 75 | 75 KB |
| Planning | 0.5 KB | 225 | 113 KB |
| Member | 0.3 KB | 60 | 18 KB |
| Invite（活著的） | 0.3 KB | ~10 | 3 KB |

**總計**：~1.3 MB

**免費額度**：1 GB → **使用率 0.13%** ✅（500 倍以上餘裕）

---

### 4. Cloud Storage（圖片附檔）

| 來源 | 平均大小 | 數量 | 小計 |
|---|---|---|---|
| Booking 附檔（PDF / 圖） | 500 KB | 75 | 37.5 MB |
| Booking 縮圖 | 30 KB | 75 | 2.3 MB |
| Wish 封面圖 | 250 KB | 150 | 37.5 MB |
| Wish 封面縮圖 | 20 KB | 150 | 3 MB |

**總計**：~80 MB

**免費額度**：5 GB 儲存 → **使用率 1.6%** ✅

---

### 5. Cloud Storage egress（下載量）

每次列表頁進入會載縮圖：
- 進 BookingsPage：載 ~5 個縮圖 × 30 KB = 150 KB
- 進 WishPage：載 ~10 個縮圖 × 20 KB = 200 KB
- 點縮圖看大圖：偶發

**每人每天**：~1 MB（含 PWA cache 後幾乎為 0）

**全體每天**：
```
20 × 1 MB = 20 MB/天
```

**免費額度**：1 GB/天（30 GB/月）→ **使用率 2%** ✅

---

### 6. Hosting

| 項目 | 規模 | 說明 |
|---|---|---|
| 部署檔案大小 | ~2 MB | dist/ 全部 |
| 首訪傳輸（gzip） | ~700 KB | main + critical css + icons |
| 重訪（PWA cache） | <50 KB | 只更新 SW + 少量檔案 |

**每月新訪**：20 人 × 平均 3 裝置 × 1 月 = ~60 首訪 = ~50 MB

**已快取重訪**：忽略不計

**免費額度**：10 GB/月 → **使用率 0.5%** ✅

---

### 7. Authentication

只用 Google 登入 → **永久免費，無上限**。

---

## 總結

| 服務 | 預估每日用量 | 免費上限 | 使用率 |
|---|---|---|---|
| Firestore reads | 4,000 | 50,000 | **8%** |
| Firestore writes | 200 | 20,000 | 1% |
| Firestore 儲存 | 1.3 MB | 1 GB | 0.13% |
| Storage 儲存 | 80 MB | 5 GB | 1.6% |
| Storage egress | 20 MB | 1 GB | 2% |
| Hosting egress | 1.6 MB（每月 50 MB） | 360 MB（每月 10 GB） | 0.5% |
| Auth | - | 無限 | - |

**結論**：20 人規模在 **Spark plan（免費）下 0 元成本，所有指標都有 10 倍以上餘裕**。

---

## 何時該升 Blaze

下列任一觸發 → 必須升 Blaze（pay-as-you-go）：

- [ ] **要用 Cloud Functions**（收據掃描、自動備份）
- [ ] **Firestore reads 持續超 40K/天**（80% 警戒線）
- [ ] **使用者數 > 100**
- [ ] **每 trip 平均資料量 > 200 docs**

---

## 升 Blaze 後的成本估算（仍然是 20 人規模）

升上去之後，**免費額度依然存在**，超過才付費。

| 服務 | 免費額度 / 月 | 超額單價 |
|---|---|---|
| Firestore reads | 1.5M | $0.06 / 100K |
| Firestore writes | 600K | $0.18 / 100K |
| Firestore 儲存 | 1 GB | $0.18 / GB / 月 |
| Storage 儲存 | 5 GB | $0.026 / GB / 月 |
| Storage egress | 30 GB | $0.12 / GB |
| Cloud Functions invocations | 2M | $0.40 / 1M |
| Cloud Functions egress | 5 GB | $0.12 / GB |

**20 人規模升 Blaze 但不開新服務**：用量仍在免費內 → **每月 $0**。

**20 人規模 + 加收據掃描（200 張/月，用 Gemini Flash）**：
- Cloud Functions invocations：200 次 → 0% of free tier → $0
- Outbound network 到 Gemini：~50 MB → 0% of 5 GB → $0
- Gemini API：free tier 內 → $0
- → **總成本仍 $0/月**

---

## 監控 checklist

### 每週一次
- [ ] [Firebase Console → Usage and billing](https://console.firebase.google.com)
  - 看 Firestore reads/writes 趨勢圖
  - 確認沒突發尖峰
- [ ] 若有：[Sentry](https://sentry.io) 看是否有大量 schema validation 失敗（reads 燒爆的常見前兆）

### 每月一次
- [ ] 看 Storage 儲存增長率（多少 GB / 月）
- [ ] Hosting → 看 traffic 是否異常

### 設定告警
- [ ] **GCP Console → Billing → Budgets & alerts**
  - 設月度 budget = $5
  - 50% / 90% / 100% 三段 email 通知
- [ ] **Firestore Console → Capacity**：可設「reads/day 超過 X 通知」（Blaze 才有）

---

## 觸發異常用量的常見原因

當你看到指標突然飆高，先檢查這幾項：

1. **某個 useEffect 缺 dep** → 無限重新訂閱資料 → reads 暴漲
2. **TanStack Query staleTime 被改成 0** → 每次 render 都打 query
3. **新加的 collection-group query 沒有 LIST_LIMIT** → 全 scan 整個 collection
4. **使用者帳號被盜爆刷 cascade delete** → 寫入暴漲
5. **批次匯入 / migration 腳本忘了關**

---

## 過去發生的事故記錄

> 留給未來自己 / 接手者參考。發生新事故記得補上來。

### 2026-04-30：Storage cascade delete 規則漏洞
- **症狀**：刪除 trip 時 listAll 被擋（403）
- **原因**：`storage.rules` 只覆蓋葉子檔案路徑，沒覆蓋 `/trips/{tripId}/**` 的 list 權限
- **影響**：無金錢損失，但使用者無法刪除有附檔的 trip
- **修補**：加 wildcard read rule on `match /trips/{tripId}/{allPaths=**}`
- **保險**：rules integration test（`tests/rules/storage.test.ts`）已加固，後不會再復發

### 2026-04-30：Firestore LIST 規則 vs `where(documentId, 'in')`
- **症狀**：刪除完任一 trip 後，整個 trip list 變空白並 403
- **原因**：`getTripsByIds` 改用 batched query → 走 LIST rule（owner-only）→ 非 owner 成員的 trip 讓整個 query 被拒
- **影響**：無金錢損失，使用者頁面壞掉
- **修補**：回退到 `Promise.all(getDoc)`（走 GET rule，accept any member）
- **保險**：rules integration test 已加 LIST vs GET 差異的回歸測試
