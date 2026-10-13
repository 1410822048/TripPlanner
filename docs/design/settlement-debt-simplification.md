# 設計方案：跨人債務簡化（Routed Settlement）

> 狀態：已實作（2026-10-13），尚未部署
> 目標規模：單一旅程 10 人
> 分支：`feat/settlement-routing`（疊在 `fix/audit-2026-10` 上）

## 0. 已確認的產品決定

| # | 決定 |
|---|---|
| 1 | Route 的單段 leg 可以只清掉一條邊的一部分；同一條邊可被不同 route 分次消耗 |
| 2 | 中間人不需要確認；route 內每個中間人的收入總額 = 支出總額（淨額不變） |
| 3 | 建立、撤銷都以整個 route 為單位，原子完成；不能單獨刪除某一段 leg |
| 4 | 每段 leg 不超過權威剩餘量，並以 `expectedRemainingMinor` 做 CAS；過期即拒絕、重新規劃 |
| 5 | 循環抵銷是正式記帳（有 lineage、紀錄、通知、權限，可整筆撤銷） |
| 6 | 付款建議一律簡化，不提供逐對切換；只有系統限制時才退回直接付款 |
| 7 | 第一版就支援外幣與已離開成員 |
| 8 | 「記錄收款」：建議消失後，只要帳上仍能合法解釋這筆付款就能記錄 |
| 9 | 不為了理論最少筆數犧牲真實債務、lineage、權限、CAS 或可撤銷性 |

部分還款（同一人分次還）不支援：團體規則是一次付清。

## 1. 問題

舊的付款建議只做「同兩人之間互抵」，每條 normalized pair edge 一筆，不做 multi-hop。10 人旅程最壞會有 45 筆建議。

2026-05-27（`55a4cfe`）以前的 net-greedy 版本做過跨人簡化，但被換掉了：它產生的「A 付 C」在帳上找不到 A→C 的債務，Worker 無法驗證，也鎖不到對應費用。

本方案要同時做到：**轉帳筆數大幅減少**，而且**每一塊錢仍追溯到具體費用、仍由伺服器驗證**。

## 2. 資料模型：一筆清算 = 一個 route = 一份文件

A 欠 B 10、B 欠 C 10 → 建議「A 付 C 10（經 B）」。C 確認時，Worker 在一個 transaction 寫入**一份** settlement doc `trips/{tripId}/settlements/{routeId}`：

| 欄位 | 內容 |
|---|---|
| `kind` | `TRANSFER`／`OFFSET` |
| `legs[]` | 帳本：`{ fromUid, toUid, amountMinor }`，依規範順序（from、to）排列，每段都落在真實債務邊上。本例為 A→B 10、B→C 10 |
| `participantUids` | 所有 leg 涉及的人（排序） |
| `payerUid`、`receiverUid`、`amountMinor` | 只有 TRANSFER |
| `note`、`ownerRecorded` | 選填 |
| `sourceCurrency`、`sourceAmountMinor`、`settledOn`、`fxSnapshot` | 外幣四件組，只有 TRANSFER，全有或全無 |
| `appliedSources[]` | 顯示用 lineage，每筆帶 `legIndex`；整份文件最多 400 筆 |
| `lockedExpenses[]` | 完整的鎖定集合：`{ expenseId, legIndexes }`，每筆費用一次，記錄被哪幾段鎖住 |
| `settledBy`、`createdAt`、`deletedAt`、`deletedBy` | 同其他實體 |

- 帳本、orphan、時序重播、lineage 都以 **leg** 為單位運算：client 用 `settlementLegs()` 把文件攤平，Worker 用 `decodeSettlementLegs()`。「清算只能抵銷、不能創造反向債務」照舊成立。
- 一份文件 = listener 一次送達、撤銷一次寫入、一則通知、一個 overlay 操作；不可能只看到半個 route。
- 外幣與備註描述整筆付款；leg 一律是旅程幣別（B 沒有用外幣付給任何人）。
- 文件 id 就是 client 鑄造的 `routeId`，重試時冪等。

### 為什麼是一份文件
比較過三種做法：

1. 另開 route collection，再每段一份 leg doc：兩個 listener 不同步送達，畫面會短暫不一致，還要多一組 rules、cascade 清單與 listener。
2. 每段一份 leg doc，每份都抄一份 route header：解決了同步，但同一筆付款散在多份文件，通知、overlay、撤銷都得把「一組文件」當成一筆處理（只由第一段發通知、撤銷時要隱藏所有段）。
3. 一份 route doc，legs 在裡面：唯一「一筆付款 = 一份資料」的模型。代價是 1 MiB 文件上限，以及帳本要先把 leg 攤平。

資料庫上線前會清空，沒有遷移成本，因此採用 3。它的兩個代價分別由下面的大小設計與 `settlementLegs()` 處理。

### 1 MiB 文件上限
- `appliedSources` 只供顯示，整份文件共用 400 筆預算（`MAX_ROUTE_APPLIED_SOURCES`），以 max-min 公平的方式分給各段（`capRouteSources`），每段保留最舊的來源。被截掉的部分在畫面顯示為「其他較新的費用 ¥X（未逐筆列出）」。client 預覽用同一個函式，所以預覽就是實際寫入的內容。
- `lockedExpenses` 永遠完整（最多 500 筆費用，受費用讀取上限約束），不受預算影響。
- Worker 依 Firestore 公布的計算方式（`firestore-size.ts`）算出文件的實際儲存大小，超過 1,000,000 bytes 就以 409 拒絕。最壞情況測試涵蓋：45 段、30 位 128 字元 uid、400 筆每字 4 bytes 的標題與品項名、500 筆每段都鎖的費用、外幣與備註。即使這樣也仍在上限之內。
- Worker 讀帳時只投影 `legs`、`createdAt`（`select`），不會把其他 route 的 lineage 一起讀進來。

## 3. 不變式（`validateRouteShape`，client 與 Worker 共用）

1. 1～45 段 leg、參與者 ≤ 30 人（Worker 用一個 `paidBy IN participants` 查詢，Firestore 的 IN 上限是 30）、金額為正整數、沒有自環。
2. 同一個**無序**人對最多一段（沒有 A→B 又 B→A）。
3. 流量守恆：TRANSFER 付款人 −M、收款人 +M、其他人 0；OFFSET 全員 0。
4. **TRANSFER 必須無環**（`CYCLIC`）。只檢查守恆的話，收款人可以夾帶一個無關的債務循環（循環本身也守恆），清掉別人之間的債。無環則保證每段 leg 都在付款人→收款人的路徑上。
5. **OFFSET 必須是單一連通分量**（`DISCONNECTED`）。不相連的循環若合併成一筆，某個循環的參與者就能確認另一個他沒參與的循環。

Worker 另外在 transaction 內逐段檢查：`expectedRemainingMinor` 必須**等於**權威剩餘量（CAS，不一致 → 409 `SETTLEMENT_STALE`），且 `amountMinor` ≤ 剩餘量。

## 4. 權限

| 種類 | 誰能記錄 |
|---|---|
| TRANSFER | 收款人本人；收款人已離開時，由 owner 代記（`ownerRecorded`） |
| OFFSET | 任何**參與者**；全部參與者都已離開時，由 owner 代記 |

- 付款人與中間人可以是已離開成員：債務不會因為離開而消失，中間人的淨額也不變。
- 「已離開」= 列在 `trip.formerMemberNames` **且**沒有 member doc。已離開成員只會以帳務當事人的身分出現，不會因此重新取得任何成員操作權。
- 撤銷：記錄者（`settledBy`）或 owner。付款人、中間人都不能撤銷。

## 5. 規劃演算法（`@tripmate/settlement-core` 的 `routes.ts`）

`planSettlementRoutes(pairwise)`：

1. **轉帳**：每一輪在所有（欠款人, 收款人）組合中，用 max-flow（Edmonds–Karp）計算沿真實債務邊最多能轉多少，優先選「能讓某人結清」的組合，其次選金額最大的。flow 若含環，消掉環（不扣帳），扣掉其餘部分後重複。
2. **不需合併轉帳**：同一組（付款人, 收款人）不可能被選兩次。有人被結清就退出候選；沒人結清的那次已經是該組的最大流量，最小割飽和，之後只會更小。有性質測試釘住這一點。
3. **抵銷**：剩下的只會是純循環；**每個連通分量一筆 OFFSET**。
4. **上限**：超過 45 段或 30 人的 route 會拆開（TRANSFER 拆成路徑再打包，OFFSET 拆成循環後依「共用參與者」打包）。單一路徑或循環本身就超過上限時，才退回直接付款。10 人規模不會發生。

**實測**（隨機 10 人旅程各 200 組）：

| 情境 | 逐對列出 | 簡化後轉帳 | 抵銷確認 |
|---|---|---|---|
| 10 筆費用 | 32.2 | 12.4 | 0.4 |
| 40 筆費用 | 44.7 | 10.8 | 0.6 |
| 40 筆、每筆全員分攤 | 45.0 | 15.1 | 0 |
| 80 筆、小群分攤 | 44.9 | 9.7 | 0.9 |

不受「要對到真實費用」限制的理論值是 9 筆（人數 − 1）；差距就是可追溯性的代價。規劃時間：10 人約 4ms，20 人約 50ms。

### 記錄收款與過期建議
- `maxPayable(pairwise, P, R)`：付款人到收款人之間所有真實債務路徑的 max-flow 總和，也就是帳上最多能解釋的金額。
- `routeForPayment(pairwise, P, R, X)`：把一筆真實付款映射成合法路徑（可拆成多條路徑），超過 `maxPayable` 就回傳 null。
- 「任意順序」的意思是：挑一筆目前合法的建議 → 記錄 → 重新規劃 → 再挑下一筆。不是說第一次產生的整份建議永遠有效。記錄 sheet 會在**送出當下**用最新帳本重新計算：原本的 legs 還有效就沿用，否則重算同一筆付款；帳上已解釋不了這麼多時，就顯示目前的上限。抵銷不是一筆付款，無法重算，帳變了就請使用者重新確認。

## 6. Worker：`/settlement-route-create`

Request（`.strict()`）：`{ tripId, routeId, kind, legs[{fromUid,toUid,amountMinor,expectedRemainingMinor}], note?, …TRANSFER: payerUid, receiverUid, amountMinor, sourceCurrency?/settledOn?/expectedFxRate?（三者全有或全無）}`。OFFSET 不接受任何外幣欄位。

同一個 transaction 內依序：

1. `validateRouteShape`（純函式，不讀資料）
2. `authorizeMemberTx` ＋ route 權限（第 4 節）
3. 冪等：route doc 已存在 → payload（含每段 leg）相同就回成功（不碰 FX、不讀帳），不同就是撞 id；已撤銷的 routeId 不能重用
4. 外幣：`resolveForeignRate` ＋ `expectedFxRate` CAS，**在讀帳本之前**（網路等待不進衝突視窗）
5. 讀帳本（全部 fail-closed）：`paidBy IN participants` 的費用（≤500）、全旅程 active settlements（≤500 份，只投影 `legs`、`createdAt`；任何一份讀不出 legs 就 500）、每條邊的 pair lock（**依 key 排序逐一讀取**）
6. 逐段（依規範順序）在「已套用本 route 前面各段」的帳本上做 CAS、容量檢查、lineage
7. 組出 route doc，檢查儲存大小，然後寫入：route doc（`exists:false`）＋每個 pair lock ＋**每筆被鎖的費用一次**（`settlementLockIds` 加上 routeId；同一筆費用被兩段鎖住也只寫一次、只記一次）。總寫入超過 500 → 409 `PAIR_LEDGER_TOO_LARGE`

外幣：route 的 `amountMinor` 以旅程幣別入帳；`sourceAmountMinor` 由它以 at-most 反推（只用於顯示與稽核），換算後為 0 時拒絕。

## 7. 撤銷：`/settlement-delete`

收到 settlement id（即 routeId），軟刪除這份文件，一次寫入就撤銷整個 route。接著依排序碰觸每段的 pair lock，並把 routeId 從 `lockedExpenses` 裡每筆費用的 `settlementLockIds` 移除。已撤銷的再撤一次不做任何事；讀不出 legs 的文件視為損毀（500），不會在不知道碰了哪些對的情況下撤銷。

## 8. 畫面

- **付款建議**：顯示簡化後的 TRANSFER（「A → C ¥X　經 B」）與 OFFSET（「A、B、C 互相抵銷 · 不需付款」）。展開可看每段 leg，以及每段會清掉哪些費用與明細項目（用與 Worker 相同的 lineage 程式預覽）。
- **中間人**：說明「你不用付款：會同時清掉 A 欠你的與你欠 C 的各 ¥X，你的淨額不變」。
- **記錄收款**：選付款人（只列帳上能解釋的人），輸入金額（預設並限制為 `maxPayable`）。
- **清算紀錄**：一份文件一列，可展開看各段、來源（含未逐筆列出的金額）與 orphan 說明；刪除會明確標示是「整筆刪除」。

## 9. 通知（Functions）

一份文件一則通知，對象是所有參與者（中間人的債務也變了）。內容是「付款人 → 收款人 ¥X（經 …）」，或「A、B、C 之間的互相抵銷（不需付款）」。已離開成員的名字從 `formerMemberNames` 取得。

## 10. 相容性與部署

- `SettlementDocSchema` 就是 route 的形狀：`legs` 必填，lineage 的 `legIndex` 與 `lockedExpenses` 的 `legIndexes` 必須指向存在的 leg，外幣群組維持原本的不變式。未知欄位會被略過，上限比 Worker 寬鬆，避免一份稍大的文件讓整個 listener 失效。
- `SETTLEMENT_LIST_LIMIT` = 500 份文件，也就是 500 筆付款或抵銷，不再以 leg 計算。Worker 的讀取上限相同。
- **只有一種資料形狀**：資料庫上線前會清空，沒有舊資料要共存。舊的 `/settlement-create`、單筆清算，以及「每段一份文件」的形狀都已移除。
- **Schema Epoch 4**，manifest `{ revision: 3, minimumWriteEpoch: 4 }`。這不是為了舊資料，而是為了**已安裝在手機上的舊版 PWA**：它只會呼叫已移除的端點，升版後它會顯示「請更新」，而不是送出必定失敗的請求。
- Firestore rules 的行為不變（只更新註解）。indexes 有兩項變更：
  - 移除舊的 `(fromUid, toUid, deletedAt)` 複合索引，它只服務已刪除的逐對讀取。
  - `appliedSources`、`lockedExpenses` 不建單欄索引：它們從不被查詢，不建索引可省掉大型陣列的索引寫入。

部署順序：Worker → Functions → Firestore indexes → Pages（含 manifest）。rules 行為不變，可以之後順帶部署。

## 11. 設計稽核：找到並修正的反例

| # | 反例 | 被破壞的不變式 | 修正 |
|---|---|---|---|
| 1 | 兩個不相連的循環合併成一筆 OFFSET，A 可以確認 D、E、F 之間的循環 | 只有參與者能確認抵銷 | 每個連通分量一筆；Worker 驗證 `DISCONNECTED` |
| 2 | TRANSFER 夾帶一個守恆的無關循環 | 收款人只能清掉經過自己這筆付款的債 | Worker 驗證 `CYCLIC` |
| 3 | max-flow 的結果可能含環 | 同上 | 規劃時消掉環並留在帳上，並直接測試這個守門邏輯 |
| 4 | 兩段 leg 鎖同一筆費用、各寫一次 | 鎖集合（後寫蓋掉前寫） | 每筆費用一次寫入、只記一次 routeId |
| 5 | 只撤銷其中一段 leg | 中間人淨額不變（決定 2） | 一份文件，撤銷就是整份；結構上做不到只撤一段 |
| 6 | 一筆付款散在多份文件，listener 先送到一部分 | 畫面與 overlay 一次看到完整的付款 | 一份文件 |
| 7 | 長行程的 lineage 讓文件超過 1 MiB，commit 被 Firestore 拒絕 | 記錄一定寫得進去，或乾淨地被拒絕 | 400 筆來源預算、鎖定集合不截斷、依 Firestore 規則精確計算大小、最壞情況測試 |
| 8 | Worker 讀帳時把每份 route 的 lineage 一起讀進來 | 讀取成本只跟帳本有關 | `select` 只投影 `legs`、`createdAt` |
| 9 | 鎖定集合只存整份聯集：一段的 orphan 原因被別段的費用改動誤判；若改用「費用目前是否涉及這一對」來篩，又會漏掉「被改到不涉及這一對」的費用（這正是 lineage 要解釋的情況） | orphan 原因只由這一段實際動用的費用決定 | `lockedExpenses` 記錄每筆費用被哪幾段鎖住，逐段精確 |
| 10 | 文件裡有一段 leg 是壞的 | 一筆付款整筆套用，或整筆不套用 | client 整份排除並警告；Worker 讀帳與撤銷都 500 fail-closed |
| 11 | owner 自己欠已離開成員錢時，畫面不給 owner「代記」按鈕（E2E 抓到） | 收款人離開後由 owner 代記（Worker 允許），否則這筆永遠無法記錄 | 付款建議卡移除「owner 不是付款人」的限制，與 Worker 一致 |

## 12. 測試

- settlement-core：200 組固定 seed 的性質測試。涵蓋：只走真實債務、整份計畫剛好清空帳本、中間人淨額為 0、經濟淨額正確、「挑一筆 → 記錄 → 重新規劃」最後一定清完、過期建議被 CAS 拒絕、同一對不會被選兩次。另有上限拆分、多路徑、記錄收款、lineage、來源預算（公平分配與 prefix 的性質測試）。
- Worker：用記憶體版 Firestore（原子提交、前置條件、REQUEST_TIME、`select` 投影），在建立／撤銷之後讀回帳本驗證。涵蓋：
  - 文件形狀與規範順序、multi-hop、multi-path、部分與重疊的邊、CAS 過期、競爭、冪等（含外幣）
  - 形狀攻擊、循環權限、已離開成員（付款人／收款人／中間人／循環）、外幣（CAS、取整、過小金額）
  - 同一筆費用被兩段鎖住、來源預算與完整鎖定、最壞情況的文件大小、Firestore 大小計算、讀帳投影、壞文件 fail-closed
  - 整筆撤銷，以及固定 seed 的端到端性質測試（鎖定集合與 lineage 一致、每段來源加總等於金額、不重複扣同一份額）
  - 撤銷的邊界情況（不存在、非成員、旅程刪除中、讀不出 legs、費用已不持有鎖）
- Firestore 模擬器（`npm run test:emulator`，CI 也會跑）：Worker 的寫入程式直接對真的 Firestore 模擬器。確認 transaction 內的 `select` 只回傳 `legs`、`createdAt`；建立、冪等重試、撤銷後帳本復原；兩筆同時寫同一筆債只有一筆成功；`firestore-size.ts` 與模擬器的 1 MiB 限制完全一致（剛好 1,048,576 bytes 被接受，多 1 byte 被拒絕）。
- Functions：一份文件一則通知、取消通知、抵銷內容、經手人、參與者退回由 legs 推導。
- 端到端（`npm run e2e:settlement`）：Firebase 模擬器 + Worker 模擬器模式 + 真的 App，Playwright 以 owner／editor／viewer 三個帳號操作。涵蓋：付款人／中間人／收款人各自看到的建議、明細預覽、記錄（一份文件、逐段鎖定）、非 owner 看到唯讀費用、整筆撤銷、記錄收款（部分金額）、循環抵銷、外幣收款（真實匯率）、收款人離開後 owner 代記；並檢查沒有頁面錯誤。
- Client：
  - schema（形狀、legIndex 範圍、外幣群組、向前相容）、service 傳輸格式、overlay（一份文件一個操作）
  - 帳本（多段 route 套用、orphan 指名文件與段、壞 leg 整份排除、逐段精確的 lineage、被改離這一對的費用、已離開成員）
  - record sheet、付款建議卡、紀錄列（各段來源與未列出金額）、ExpensePage（一份文件佔一個名額、鎖定）
