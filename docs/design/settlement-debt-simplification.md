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

## 2. 資料模型：route = 一組普通的 pair settlement

A 欠 B 10、B 欠 C 10 → 建議「A 付 C 10（經 B）」。C 確認時，Worker 在**同一個 transaction** 寫入兩筆**普通**的 settlement doc（leg）：

| leg id | fromUid → toUid | amountMinor | lineage／鎖 |
|---|---|---|---|
| `{routeId}-00` | A → B | 10 | A、B 之間的費用 |
| `{routeId}-01` | B → C | 10 | B、C 之間的費用 |

每段 leg 都帶相同的 `route` header（map）：`id`、`legIndex`、`legCount`、`kind`（TRANSFER／OFFSET）、`participantUids`；TRANSFER 另有 `payerUid`、`receiverUid`、`amountMinor`；可選 `note`、`ownerRecorded`，以及外幣四件組（`sourceCurrency`、`sourceAmountMinor`、`settledOn`、`fxSnapshot`）。

- `computePairwiseRemaining`、orphan 時序重播、lineage、費用 `settlementLockIds`、`(fromUid,toUid,deletedAt)` 查詢**全部照舊可用**。每段 leg 都落在真實債務邊上，「清算只能抵銷、不能創造反向債務」自然成立。
- leg id 由 `routeLegId(routeId, i)` 依規範順序（from、to 排序）**推導**，不由 client 指定：避免與既有 settlement 撞 id，刪除時也能直接逐一讀到每段 leg。
- 外幣與備註只放在 header：B 沒有用外幣付給任何人。leg 一律是旅程幣別，頂層不帶 FX 欄位。

### 為什麼不另開 `settlementRoutes` collection（原設計的修正）
原設計是另開 route doc。實作前發現：route doc 與 legs 會被**兩個 listener 分別送達**，畫面會短暫看到「有 legs 沒 route」或反過來，overlay 也得跨兩個 collection 對帳；另外還要多一組 rules、一份 cascade 清單、一個 listener。把 header 冗餘寫在每段 leg 上之後，一次 commit、一個 listener 就能看到完整的 route；冪等改用 leg 0 判斷，通知只由 leg 0 發送。

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
3. 冪等：leg 0 已存在 → payload 相同就回成功（不碰 FX、不讀帳），不同就是撞 id；已撤銷的 routeId 不能重用
4. 外幣：`resolveForeignRate` ＋ `expectedFxRate` CAS，**在讀帳本之前**（網路等待不進衝突視窗）
5. 讀帳本（全部 fail-closed）：`paidBy IN participants` 的費用（≤500）、全旅程 active settlements（≤500）、每條邊的 pair lock（**依 key 排序逐一讀取**）
6. 逐段（依規範順序）在「已套用本 route 前面各段」的帳本上做 CAS、容量檢查、lineage
7. 寫入：每段 leg（`exists:false`）＋每個 pair lock ＋**每筆費用一次**合併後的鎖寫入（兩段 leg 鎖同一筆費用時，分兩次寫同一欄位，後寫會蓋掉前寫的鎖 id）。總寫入超過 500 → 409 `PAIR_LEDGER_TOO_LARGE`

外幣：route 的 `amountMinor` 以旅程幣別入帳；`sourceAmountMinor` 由它以 at-most 反推（只用於顯示與稽核），換算後為 0 時拒絕。

## 7. 撤銷：`/settlement-delete`

收到任一 leg id，就撤銷**整個 route**：讀出所有 leg，全部軟刪除，依排序碰觸每個 pair lock，每筆被鎖的費用一次移除本 route 所有 leg id。已撤銷的再撤一次不做任何事。沒有 route header 的舊單筆清算照舊處理。

## 8. 畫面

- **付款建議**：顯示簡化後的 TRANSFER（「A → C ¥X　經 B」）與 OFFSET（「A、B、C 互相抵銷 · 不需付款」）。展開可看每段 leg，以及每段會清掉哪些費用與明細項目（用與 Worker 相同的 lineage 程式預覽）。
- **中間人**：說明「你不用付款：會同時清掉 A 欠你的與你欠 C 的各 ¥X，你的淨額不變」。
- **記錄收款**：選付款人（只列帳上能解釋的人），輸入金額（預設並限制為 `maxPayable`）。
- **清算紀錄**：同一個 route 合併成一列，可展開看各段、來源與 orphan 說明；刪除會明確標示是「整筆刪除」。

## 9. 通知（Functions）

只有 leg 0 會發通知：每個 route 一則，對象是所有參與者（中間人的債務也變了）。內容是「付款人 → 收款人 ¥X（經 …）」，或「A、B、C 之間的互相抵銷（不需付款）」。已離開成員的名字從 `formerMemberNames` 取得。

## 10. 相容性與部署

- `SettlementDocSchema` 新增選填的 `route` header（header 自身也有 FX 群組不變式）；未知欄位仍會被略過。沒有 route 的舊資料照常解析。
- `SETTLEMENT_LIST_LIMIT` 200 → 500（一段 leg 一筆 doc），Worker 讀取上限同步。
- **Schema Epoch 4**，manifest `{ revision: 3, minimumWriteEpoch: 4 }`。epoch-3 的舊版不會破壞帳本（它會略過 `route`，舊的 `/settlement-create` 也受 pair lock 與 CAS 保護，有測試），但它把每段 leg 當成獨立紀錄顯示，刪一段就會在沒有任何說明的情況下撤銷整個 route（包括別人的段），所以要停止它寫入。
- 舊的 `/settlement-create` 保留給還沒拿到新 manifest 的舊版（Worker 是最終邊界）；新版一律走 route 端點。
- 不需要改 Firestore rules：legs 就是 settlements（client 不可寫、只能讀 active 的），trip cascade 本來就涵蓋 settlements。

部署順序：Worker → Functions → Pages（含 manifest）。rules 不變。

## 11. 設計稽核：找到並修正的反例

| # | 反例 | 被破壞的不變式 | 修正 |
|---|---|---|---|
| 1 | 兩個不相連的循環合併成一筆 OFFSET，A 可以確認 D、E、F 之間的循環 | 只有參與者能確認抵銷 | 每個連通分量一筆；Worker 驗證 `DISCONNECTED` |
| 2 | TRANSFER 夾帶一個守恆的無關循環 | 收款人只能清掉經過自己這筆付款的債 | Worker 驗證 `CYCLIC` |
| 3 | max-flow 的結果可能含環 | 同上 | 規劃時消掉環並留在帳上，並直接測試這個守門邏輯 |
| 4 | 兩段 leg 鎖同一筆費用、各寫一次 | 鎖 id 集合（後寫蓋掉前寫） | 每筆費用合併成一次寫入 |
| 5 | client 指定 leg id | id 唯一、可依 route 找回所有 leg | 由 routeId 推導 |
| 6 | 舊版刪除一段 leg | 中間人淨額不變（決定 2） | 任一 leg 撤銷整個 route；epoch 4 停止舊版寫入 |
| 7 | 每段 leg 各發一則通知 | 通知以 route 為單位 | 只有 leg 0 發送 |
| 8 | route doc 與 legs 分屬兩個 listener | 畫面與 overlay 要一次看到完整的 route | header 冗餘寫在每段 leg 上 |

## 12. 測試

- settlement-core：200 組固定 seed 的性質測試，涵蓋只走真實債務、整份計畫剛好清空帳本、中間人淨額為 0、經濟淨額正確、「挑一筆 → 記錄 → 重新規劃」最後一定清完、過期建議會被 CAS 拒絕、同一對不會被選兩次；另有上限拆分、多路徑、記錄收款、lineage 等測試。
- Worker：用記憶體版 Firestore（原子提交、前置條件、REQUEST_TIME），在建立／撤銷之後讀回帳本驗證。涵蓋 multi-hop、multi-path、部分與重疊的邊、CAS 過期、競爭、冪等、形狀攻擊、循環權限、已離開成員（付款人／收款人／中間人／循環）、外幣（CAS、取整、過小金額）、合併鎖、整筆撤銷，以及固定 seed 的端到端性質測試（鎖集合與 lineage 一致、不重複扣同一份額）；還有舊 `/settlement-create` 與 route 並存的相容性測試。
- Functions：每個 route 只發一則通知、取消通知、抵銷內容、經手人與已離開成員的名字。
- Client：schema（header、外幣群組、向前相容）、service 傳輸格式、overlay（多段一起成功或失敗、撤銷時隱藏所有 leg）、record sheet（過期重算、記錄收款上限、抵銷過期、外幣）、付款建議卡與紀錄分組、ExpensePage 依 leg 數檢查上限。
