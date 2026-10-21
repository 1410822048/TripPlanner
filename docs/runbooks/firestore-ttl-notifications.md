# Runbook — Firestore TTL Policies(通知收件匣 / 推播去重 / route-apply 收據)

> 對象:部署操作者。**`firestore.indexes.json` 是 TTL 設定的唯一來源**;gcloud 只用來驗證,
> 不要拿來啟用或停用。

## 0. 背景

下列集合每筆文件都帶 `expiresAt`(Firestore `Timestamp`),由 Firestore 原生 TTL policy
在到期後自動刪除。清理**不**走 Cloudflare Worker cron(那是 receipt-purge 刪 R2 blob 的機制,
R2 沒有等效的原生 TTL)。

| collection group | 寫入處 | 保留期 |
|---|---|---|
| `notifications`(`users/{uid}/notifications/{eventId}`) | `firebase-functions/src/notifications.ts` `writeNotificationDocs` | 建立後 30 天 |
| `_pushEvents`(`_pushEvents/{eventId}`,推播去重 / lease 紀錄) | `firebase-functions/src/dispatch.ts` `reservePushEvent` | 建立後 30 天 |
| `routeApplications`(`trips/{tripId}/routeApplications/{revision}`) | `workers/ocr/src/route-apply.ts` | 30 天 |

TTL 是 collection-group 層級設定:`users/*/notifications` 底下每個 uid 的子集合自動套用。

## 1. 為什麼一定要寫在 `firestore.indexes.json`

`npm run deploy:prod`(`scripts/deploy-prod-safe.mjs`)每次發版最後都會跑
`firebase deploy --only firestore:indexes --force`。firebase-tools(15.34.0,
`lib/firestore/api.js` `deploy()`)會列出遠端所有 field override —— 查詢條件是
`indexConfig.usesAncestorConfig=false OR ttlConfig:*`,**包含只有 TTL 的欄位** —— 凡是檔案
`fieldOverrides` 沒列出的,在 `--force` 下一律 `deleteField()`:對該欄位送一個空的 PATCH,
連同 `ttlConfig` 一起清掉。

所以用 `gcloud firestore fields ttls update --enable-ttl` 手動開的 TTL,**下一次部署就會被無聲
關掉**。正確做法是在 `firestore.indexes.json` 的 `fieldOverrides` 放:

```json
{ "collectionGroup": "notifications", "fieldPath": "expiresAt", "ttl": true, "indexes": [] }
```

- `"ttl": true` → firebase-tools 的 `patchField()` 送出 `{ indexConfig: { indexes: [] }, ttlConfig: {} }`
  (沒有 `updateMask`,整個 field 設定一起寫),建立 / 保留 TTL policy。之後的部署
  `fieldMatchesSpec()` 判定一致就跳過,不會重送。
- `"indexes": []` → 把 `expiresAt` 排除在自動 single-field index 之外(遞增時間戳的 TTL 欄位
  官方建議豁免,避免寫入熱點)。目前**沒有任何查詢**以 `expiresAt` 篩選或排序這三個集合
  (client `notificationService.ts`、Worker `queryUserTripNotificationDocNames`、Functions
  皆已確認);若日後新增這類查詢,要改成列出對應的 `indexes`,不能留 `[]`。
- `src/services/firestoreIndexes.test.ts` 釘住這三筆 override,誤刪會讓測試失敗。

**刪除檔案中的條目 = 在下一次 `--force` 部署時停用該 TTL。** 這是唯一的 rollback 路徑(見第 4 節)。

## 2. 啟用 / 更新

1. 修改 `firestore.indexes.json` 的 `fieldOverrides`。
2. 正常發版(`npm run deploy:prod`,GitHub Actions 推 main 自動執行),或單獨跑
   `firebase deploy --only firestore:indexes --project tripplanner-80a4f`。
   沒帶 `--force` 時只會新增 / 更新,不會刪除遠端多出來的 override。

## 3. 驗證(gcloud 只讀)

```bash
gcloud firestore fields describe expiresAt \
  --collection-group=notifications \
  --project=tripplanner-80a4f

gcloud firestore fields describe expiresAt \
  --collection-group=_pushEvents \
  --project=tripplanner-80a4f
```

`ttlConfig.state` 剛建立是 `CREATING`,通常幾分鐘後轉 `ACTIVE`。Google 文件標註實際刪除在到期後
**72 小時內**執行(非到期當下秒刪),對 30 天保留期無感。

- [ ] 兩者 `ttlConfig.state == ACTIVE`
- [ ] `indexConfig.indexes` 為空(已豁免 single-field index)
- [ ] 手動塞一筆 `expiresAt` 設在過去的測試 doc,24-72 小時後確認被刪除
- [ ] 未過期的 notification 沒被誤刪

## 4. Rollback

從 `firestore.indexes.json` 移除對應條目,然後部署(`deploy:prod` 的最後一步帶 `--force`,
或手動 `firebase deploy --only firestore:indexes --force --project tripplanner-80a4f`)。
停用後既有文件不受影響,只是不再自動過期 —— 不會有資料被意外清空的風險。

**不要**用 `gcloud firestore fields ttls update --disable-ttl`:檔案仍列著 `"ttl": true`,
下一次部署會把它重新開回來。

## 5. 舊資料

`_pushEvents` 在加入 `expiresAt` 之前建立的舊文件沒有這個欄位,TTL 不會刪除它們;如需清理,
可另行以 Admin SDK 刪除 `createdAt` 早於 30 天的文件。
