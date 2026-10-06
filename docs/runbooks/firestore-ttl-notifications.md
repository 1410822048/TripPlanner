# Runbook — Notification Inbox TTL Policy

> 對象:部署操作者。**純 gcloud / Console 操作,程式碼不需改動、也不用 Worker cron。**

## 0. 背景

`users/{uid}/notifications/{eventId}` 每筆都帶 `expiresAt`(createdAt + 30 天,見
`firebase-functions/src/notifications.ts`)。清理**不**走 Cloudflare Worker cron(那是
receipt-purge 用來刪 Storage blob 的機制,Storage 沒有等效的原生 TTL)——這個集合完全活在
Firestore 裡,直接用 Firestore 原生 TTL policy:設定一次,Firestore 背景每天掃描並刪除
`expiresAt` 已過期的文件,零程式碼、零額外 index、零 cron job。

## 1. 設定(一次性,對所有 trip 的 notifications sub-collection 生效)

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=notifications \
  --enable-ttl \
  --project=tripplanner-80a4f
```

TTL 是 collection-group 層級設定,`users/*/notifications` 底下每個 uid 的 sub-collection
自動套用,不用逐 uid 設定。

## 2. 驗證

```bash
gcloud firestore fields describe expiresAt \
  --collection-group=notifications \
  --project=tripplanner-80a4f
```

`ttlConfig.state` 剛設完是 `CREATING`,幾分鐘後轉 `ACTIVE`。變 `ACTIVE`後代表已生效——
Google 文件標註實際刪除動作在到期後 **72 小時內**執行(非到期當下秒刪),對 30 天保留期
來說這個延遲無感。

- [ ] `ttlConfig.state == ACTIVE`
- [ ] 手動塞一筆 `expiresAt` 設在過去的測試 doc,24-72 小時後確認被刪除
- [ ] 未過期的 notification 沒被誤刪

## 3. Rollback

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=notifications \
  --disable-ttl \
  --project=tripplanner-80a4f
```

停用後既有文件不受影響,只是不再自動過期——不會有資料被意外清空的風險。

## 4. `_pushEvents` TTL(推播去重紀錄)

`_pushEvents/{eventId}` 是 Functions 的去重 / lease 紀錄，每個通知事件一筆。新建立的文件帶
`expiresAt`(建立時間 + 30 天，見 `firebase-functions/src/dispatch.ts`)，遠超過平台事件重送的
時間窗。設定一次 TTL 後即自動清理，否則會隨使用量線性成長：

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=_pushEvents \
  --enable-ttl \
  --project=tripplanner-80a4f
```

驗證方式同第 2 節(`--collection-group=_pushEvents`)。加入此欄位之前建立的舊文件沒有
`expiresAt`,TTL 不會刪除它們;如需清理，可另行以 Admin SDK 刪除 `createdAt` 早於 30 天的文件。
