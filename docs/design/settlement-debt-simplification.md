# 設計方案：跨人債務簡化（Routed Settlement）

> 狀態：已確認，實作中（2026-10-13）
> 目標規模：單一旅程 10 人
> 分支：`feat/settlement-routing`（疊在 `fix/audit-2026-10` 上）

## 0. 已確認的決定

| # | 決定 |
|---|---|
| 1 | Route 的單段 leg 可以只清掉一條邊的一部分；從「人」的角度仍是付一次就全清 |
| 2 | 中間人不需要確認，只由最終收款人確認 |
| 3 | 循環抵銷：任一參與者可記錄，全員通知，`settledBy` 本人或 owner 可撤銷 |
| 4 | 付款建議**一律簡化**，不提供逐對檢視切換 |
| 5 | 第一版就支援**外幣**與**已離開成員** |

## 1. 問題

目前的付款建議只做「同兩人之間互抵」（`settlementSuggestions.ts` 的 `computeSettlements`：每條 normalized pair edge 一筆，**不做 multi-hop**）。10 人旅程最壞會出現 45 對（C(10,2)）各自的建議。

2026-05-27（`55a4cfe`）以前的 net-greedy 版本會做跨人簡化，但被換掉：它產生的「A 付 C」在帳上找不到 A→C 的債務，Worker 無法驗證、`computePairwiseRemaining` 會把它整筆丟掉、也鎖不到對應的費用。

本方案要同時達成：**轉帳筆數大幅減少**，且**每一塊錢仍追溯到具體費用、仍由伺服器驗證**。

## 2. 核心想法：一筆簡化轉帳 = 一組普通的兩人清算

A 欠 B 10、B 欠 C 10 → 建議「A 付 C 10（經 B）」。C 按「已收款」時，Worker 在**同一個 transaction** 寫入：

- 一個 **route doc**（`settlementRoutes/{routeId}`）：付款人、收款人、金額、外幣資訊、備註、leg 清單。這是畫面、通知、刪除的單位。
- 兩筆**完全普通**的 settlement doc（leg），帶 `routeId`：

| leg | fromUid → toUid | amountMinor | 對應費用（lineage / 鎖） |
|---|---|---|---|
| 0 | A → B | 10 | A、B 之間的費用 |
| 1 | B → C | 10 | B、C 之間的費用 |

因為每一筆 leg 都是現行格式的 pair settlement，`computePairwiseRemaining`、orphan 時序重播、lineage、費用 `settlementLockIds`、`(fromUid,toUid,deletedAt)` 查詢**全部原封不動可用**；每筆 leg 都落在真實的債務邊上，「清算只能抵銷、不能創造反向債務」自然成立。

### 為什麼另開 route doc，而不是把 route 資訊抄在每筆 leg 上
- 外幣資訊（實際付款幣別、匯率快照）屬於「A 實際付給 C 的那筆錢」，不屬於任何一條邊。放在 leg 上會讓 B 看起來也用外幣付了錢。
- 通知、紀錄、刪除都以 route 為單位；有獨立 doc 就不需要在多筆 leg 之間去重。
- leg 只多帶一個 `routeId`，其餘欄位語意不變。

## 3. Route 的形狀與不變式

Route 是一組 leg，每段是 `(fromUid, toUid, amountMinor)`，同一條邊在一個 route 內最多一段（多條路徑共用一條邊時合併金額）。分兩種：

- **TRANSFER**：有付款人 P、收款人 R、金額 M（旅程幣別，> 0）。
- **OFFSET**（循環抵銷）：沒有人付錢，所有參與者淨額為 0。

不變式：

1. **流量守恆**：對每個人計算「這個 route 裡收到的 leg 總額 − 付出的 leg 總額」：
   - TRANSFER：P 為 −M、R 為 +M，**其他人都必須是 0**（中間人淨額不變 → 不需要中間人確認）。
   - OFFSET：所有人都是 0。
2. **每段不超過該邊剩餘**：`leg.amountMinor <= remaining(from,to)`；每條邊仍以 `expectedRemainingMinor` 做 CAS（不一致 → 409 `SETTLEMENT_STALE`，畫面重算建議）。
3. **確認權限**（沿用 receiver-only 並推廣）：
   - TRANSFER：caller 必須是 R；或 caller 是 owner 且 R 是已離開成員（寫入 `recordedOnBehalfOf`），與現行代記規則相同。
   - OFFSET：caller 必須是循環參與者之一；若參與者全部已離開，owner 可代記。
   - 所有 leg 與 route 的 `settledBy` = caller。
4. **原子性**：建立、刪除都以 route 為單位全部成功或全部失敗。**不能單獨刪除帶 `routeId` 的 leg**（否則中間人淨額會被打破）；舊的 `/settlement-delete` 收到 leg id 時，改為刪除整個 route。

## 4. 簡化演算法（`@tripmate/settlement-core` 新增純函式）

`planSettlementRoutes(pairwise)`：

1. **輸入**：現在的 normalized pairwise remaining（已含兩人互抵）。
2. **消去循環**：反覆找出有向循環，沿循環扣掉最小邊，每個被消去的循環累積成 OFFSET route（同一組參與者的循環合併）。
3. **路徑分解**：剩下的無循環圖中，從淨欠款人沿邊走到淨收款人，每次取「瓶頸最大」的路徑（減少筆數），扣除後重複，直到圖清空。
4. **合併**：起點、終點相同的路徑合併成一筆 TRANSFER；共用的邊合併金額。
5. **輸出**：`{ kind, payerUid?, receiverUid?, amountMinor, legs: { fromUid, toUid, amountMinor, expectedRemainingMinor }[] }[]`，排序穩定。

**Worker 不信任演算法**，只驗證第 3 節的不變式；之後換更好的演算法不影響伺服器契約。

預期效果：理論最少筆數一般情況下是 NP-hard，本法不保證最少，但**保證不比逐對多**且消掉所有循環；10 人常見情況約從 15～30 筆降到 10 筆左右。

## 5. Worker：`/settlement-route-create`

Request（`.strict()`）：
```
{ tripId, routeId, kind: 'TRANSFER' | 'OFFSET',
  payerUid?, receiverUid?, amountMinor?,          // TRANSFER 必填，OFFSET 禁止
  legs: [{ settlementId, fromUid, toUid, amountMinor, expectedRemainingMinor }],
  note?,
  // 外幣（僅 TRANSFER）：與現行 FOREIGN 清算相同的三件
  sourceCurrency?, settledOn?, expectedFxRate? }
```

Transaction 內流程（沿用 `doCreate` 的骨架）：
1. 結構驗證（純檢查，不讀資料）：守恆、無自環、同邊不重複、leg 數 ≤ 45。
2. `authorizeMemberTx`、確認權限（第 3 節第 3 點）。
3. 冪等：route doc 已存在 → 比對內容一致就回成功，不一致 → collision。
4. 外幣：`resolveForeignRate` + `expectedFxRate` CAS，**在讀 pair 資料之前**（與現行相同，網路呼叫不進衝突視窗）；用 `amountMinor = M` 推導 `sourceAmountMinor`（現行 at-most inverse）。
5. 讀取：一次讀整個旅程的 active expenses（≤500）與 settlements；`tx.get` 每條邊的 `settlementPairLocks`（依 key 排序）。
6. 每條邊算 remaining，做 CAS 與 `amount <= remaining`；依序套用 leg 算 lineage（同 transaction 內前一段已扣的量要算進去）。
7. 寫入：route doc＋每段 leg doc＋每條邊 pair lock＋費用鎖。**同一筆費用被多段鎖住時合併成一個寫入**（把所有 leg id 一次 union）。總寫入超過 500 → 409 `PAIR_LEDGER_TOO_LARGE`。

刪除：`/settlement-route-delete { tripId, routeId }`（權限：`settledBy` 或 owner），軟刪除 route 與所有 leg、解開所有費用鎖、碰觸所有 pair lock。

## 6. 外幣

現行外幣清算：帳仍以旅程幣別記 `amountMinor`，另存實際收款的 `sourceCurrency`、`sourceAmountMinor`、`fxSnapshot`、`settledOn`。Route 沿用同一套，但**只存在 route doc 上**：
- leg 一律是旅程幣別、不帶外幣欄位（中間人沒有用外幣付錢）。
- route 的 `sourceAmountMinor` 由 M 推導，`fxSnapshot` 與 `expectedFxRate` CAS 完全沿用 `resolveForeignRate` / `deriveForeignArtifacts`。
- 匯率暫定時同樣走 modal-wait（`useAwaitedSave`），409 時在 sheet 內採用新匯率。

## 7. 已離開成員

- 在帳上照常參與路徑分解：可以是付款人、收款人或中間人（中間人淨額不變，不需要他確認）。
- 收款人已離開：owner 代記（`recordedOnBehalfOf`），與現行規則一致。
- 付款人已離開：仍由收款人確認（現行也不檢查付款人是否在籍）。
- 畫面沿用現有 ghost 顯示（`formerMemberNames`）。

## 8. 畫面

- **付款建議**：只顯示簡化結果。每張卡「A → C　¥10　經 B」，展開可看每段對應的費用。
- **中間人視角**：B 看到「A 已代你付給 C ¥10，你對 A 的應收與對 C 的應付各減少 ¥10」。
- **循環抵銷卡**：「A、B、C 互相抵銷 ¥10（不需付款）」，參與者看得到「記錄抵銷」按鈕。
- **清算紀錄**：以 route doc 為單位一列，可展開看 legs；舊的單筆清算照舊顯示。
- **記錄 sheet**：沿用 `SettlementRecordSheet`（幣別、日期、備註），提交改走 route 端點。

## 9. 其他影響

| 面向 | 調整 |
|---|---|
| Firestore rules | 新增 `settlementRoutes`：成員可讀（`deletedAt == null`），`create/update/delete: if false`（只有 Worker 寫） |
| Trip cascade | `TRIP_SUBCOLLECTIONS` 加入 `settlementRoutes`（`members` 維持最後） |
| 讀取上限 | legs 讓 active settlement 數變多；`SETTLEMENT_LIST_LIMIT` 由 200 提高到 500，Worker 讀取上限同步 |
| 通知 | Functions 改為監聽 `settlementRoutes` 建立／刪除；帶 `routeId` 的 leg 不再個別通知 |
| 舊 `/settlement-create` | 保留給舊 bundle；新 bundle 一律走 route 端點（單段 route 就是現在的兩人清算） |
| Schema Epoch | 新 bundle 依賴新端點，舊 Worker 不認得 → 部署順序 Worker 先；`SettlementDocSchema` 不是 strict，舊 bundle 能 parse 帶 `routeId` 的 leg，不需提高 epoch |

## 10. 實作順序（每步一個 commit）

1. `settlement-core`：`planSettlementRoutes`（循環消去、路徑分解、合併）＋測試。
2. Worker：route 驗證純函式＋`/settlement-route-create`＋`/settlement-route-delete`（含外幣、代記）＋測試；`/settlement-delete` 遇到 leg 改刪整個 route。
3. Rules／cascade／索引：`settlementRoutes` 規則與測試、cascade 清單。
4. Client：型別與 schema、service、hooks（overlay 以 route 為單位）、上限調整。
5. UI：建議卡片、循環抵銷、中間人說明、紀錄合併、記錄 sheet 改走 route。
6. Functions：通知改監聽 route。
7. 文件：CLAUDE.md「Settlement debt-edge model」補上 route 一節。

部署順序：Worker → rules → Functions → Pages。
