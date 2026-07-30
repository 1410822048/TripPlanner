# Private R2 attachment proxy

> 狀態：實作完成，待 production rollout。

## 1. 決策

附件移至 private Cloudflare R2，bucket 不設 public/custom domain、不建立 S3 API token。
瀏覽器只與既有 Cloudflare Worker 溝通；Worker 透過 `ATTACHMENTS` binding 讀寫 R2。

使用 Worker proxy 而非 presigned URL：

- 每次讀取都重新驗 Firebase ID token 與 trip membership，撤權立即生效。
- 不需要 AWS SigV4、read-only S3 credentials、URL TTL cache 或 refresh skew。
- `useAttachmentUrl(path, { kind })` 公開介面不變，feature callers 不需知道儲存後端。
- 回應為 `private, no-store`，v1 僅使用 client module-level blob URL LRU。

## 2. Bucket 與環境

| 環境 | Worker | R2 bucket |
|---|---|---|
| production | `tripmate-ocr` | `tripmate-attachments-production` |

不建立獨立 preview Worker 或 preview R2。Pages preview 若使用，直接連 production
Worker / R2，因此其寫入會影響正式資料；這是目前僅有單一使用者時的刻意取捨。

## 3. API 與授權

### `POST /attachment-upload`

- request 只帶 `tripId`、`intentId` 與 raw body；canonical path 必須來自 Firestore intent。
- 驗證 intent caller、狀態、expiry、MIME、declared length、magic bytes、SHA-256。
- body 最多 5 MiB，使用 bounded stream；禁止無界 `arrayBuffer()`。
- R2 create 採 deterministic path。相同 digest replay 成功；不同 digest/path conflict 回 409。
- intent 狀態：`pending → uploaded → used`。entity transaction 只消費 `uploaded` intent。

### `GET /attachment-content`

- Client 只透過 `X-Attachment-Trip-Id` 與 `X-Attachment-Path` headers 傳遞 locator；
  不接受 query parameters，避免完整附件路徑進入 access log。資料庫已清空且沒有使用過
  `/attachment-content` 的舊版 client，因此不保留 rolling-deploy fallback。
- 維持既有 trip-level read authorization：任何 trip member 可讀該 trip prefix 下的附件。
- path 必須通過 canonical attachment path parser，禁止跨 trip prefix。
- Worker 直接串流 R2 body；回應 `Cache-Control: private, no-store`，不送 ETag。

### `POST /attachment-delete`

- expense／booking：owner 或 editor。
- wish：proposer 或 trip owner。
- 404 視為冪等成功；client 不取得 bucket credential 或 bulk-delete authority。

## 4. 維運

- trip cascade、receipt purge、orphan purge、storage scan、expired-intent cleanup、re-OCR
  全部直接使用 R2 binding。
- receipt 的 10 天 purge 依 Firestore 狀態決定，不可用純年齡 R2 lifecycle 取代。
- lifecycle 只適合清除沒有 Firestore 狀態可判斷的孤兒 prefix。
- thumb LRU 上限為 200；rate limit 尺寸需把長頁回捲造成的重新抓取計入。

## 5. Rollout 與 point of no return

> 2026-07-30：舊 Firebase Storage bucket 已在物件數為 0 時提前刪除；下列第 5 步改為驗證其仍不存在。

1. 部署 production Worker（R2 production binding）。
2. 部署 production Pages；接受 Worker 與 Pages 換版間的短暫功能中斷。
3. 驗證新上傳、讀取、刪除、re-OCR、cascade、purge、scan。
4. 確認 Firebase Storage production calls 與 GCS API calls 都為 0。
5. 依 `docs/runbooks/storage-iam-hardening.md` 驗證舊 Firebase Storage bucket 仍不存在；
   只刪 repo 內的 `storage.rules` 或 Firebase config 不會撤銷線上既有 Rules。
6. 最後才移除 GCP service account 殘留的 project-level Storage IAM 角色。

2026-07-30 刪除 Firebase Storage bucket 時，資料面的 point of no return 已經發生；
本專案選擇清空舊資料，不做 Firebase Storage 歷史搬遷、雙寫或回讀 fallback。
此後無論 rollout 進行到哪一步，回退版本都必須保留 R2 讀寫路徑，不能只回到
Firebase Storage client。production R2 出現第一個新物件後，回退時也必須保留既有 R2 資料。

## 6. 驗收門檻

- `useAttachmentUrl(path, { kind })` signature 不變。
- MIME／magic bytes／5 MiB／digest／BOLA／delete role 測試全綠。
- 同 digest replay、不同 digest 409、concurrent create winner 測試全綠。
- full image、thumb、PDF 新分頁、wish 多圖列表與重新 OCR 手動 E2E 通過。
- production Wrangler dry-run 通過。
- admin OAuth token 只要求 `datastore` scope；GCP service account 最終沒有 Storage IAM。
