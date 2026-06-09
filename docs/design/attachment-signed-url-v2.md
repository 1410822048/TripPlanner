# Attachment Signed URL V2 — 設計書(修訂版）

> 狀態:Phase 1(Worker signer)實作中,client 未啟用。
> 前身:目前線上是 **path-only + `getBlob` + Storage Rules** 讀取(commit `2897a418` / `d24330f8`)。
> 本文 supersede 對話中那份「V2 規劃書(4.7/5)」,差別在 **§2 fallback 策略**。

---

## 0. 目標 / 非目標

**目標**:在不破壞 path-only 安全模型的前提下,把附件讀取從 `getBlob`(下載 bytes → objectURL)升級成 **短效 GCS V4 signed URL**,換取:

- 瀏覽器原生快取 / range request(大圖、PDF 體驗)
- 降低 client 記憶體壓力(不再每張圖都 `createObjectURL` 一份 blob)
- 保留免費方案額度(Worker 只「簽 URL」不代理 bytes)

**非目標**:

- Worker 不下載 / 不代理 image / PDF bytes
- signed URL 不寫進 Firestore / localStorage / IndexedDB / Sentry
- 不新增 IAM 權限(用 service-account private key 做 **local** V4 簽章,不呼叫 `iam.signBlob`)
- 不改資料模型:Firestore 永遠只存 path

---

## 1. 不變的安全底線

```
Firestore 永遠只存 path(不存 ?alt=media&token= 的 bearer URL)
Storage object 永遠移除 firebaseStorageDownloadTokens(consume 時 strip,cron scrubber 兜底)
signed URL 只存在 memory,生命週期 = resolver cache TTL
signed URL 不持久化(Query cache / Zustand / localStorage / Sentry breadcrumb 都不行)
Worker 只簽 URL,不代理 bytes
```

`getBlob + Storage Rules` 程式碼**保留**(見 §2),作為 mode flag 的另一個值,不是 per-request fallback。

---

## 2. Fallback 策略(本次修訂重點)

原 V2 規劃寫「signed URL 失敗時 fallback getBlob」當常態行為。**改掉**,理由:per-request 自動降級會把 signed 路徑的系統性問題藏在 getBlob 後面,既看不到也測不準,還得永遠養兩條 hot path。

修訂後:

- **production 初版用 feature flag 二選一**:`VITE_ATTACHMENT_URL_MODE = getBlob | signed`
  - `getBlob`(預設):維持現狀,完全不碰 signer
  - `signed`:走 Worker signed URL resolver
- **不做** per-request「signed 失敗 → 自動改打 getBlob」當長期行為
- **只保留 emergency flag**:signed 模式若出系統性問題,ops 直接把 flag 切回 `getBlob`(全域快速回退),而非每張圖各自靜默降級
- Firestore 仍 **path-only**,signed URL 永不持久化

> Rollout 觀察期間(§7)可以容許一個**有界、會 log + Sentry 計數**的 signed→getBlob 降級,純粹為了不讓使用者在切換期看到破圖;但它是**過渡手段**,不是終態契約,穩定後移除。終態只有「mode flag 二選一」。

---

## 3. 讀取策略

### Thumb:batch path signer(client 直接給 path)

用途:expense list / booking cards / wish cards / account lodging preview。

- client 仍呼叫 `useAttachmentUrl(path, { kind: 'thumb' })`,底層改 resolver
- resolver:memory cache hit → 直接回;pending hit → 共用 promise;miss → microtask queue 合批 → `POST /attachment-thumb-urls`
- **安全論證**:thumb 端點吃 client 給的 path,但只簽 `trips/{tripId}/...` 底下的 `.thumb.*`,且 caller 必須是該 trip 成員 —— 這跟成員「本來就能 `getBlob` 同 trip 任何物件」(`allow read: if isMember`)等價,**沒有任何越權**。`.thumb.` 限制是 policy(逼 full/pdf 走 entity-ref 端點 + 較短 TTL),不是安全邊界。
- TTL:**30 min**;client 在 `expiresAt - 60s` 重簽

### Full / PDF:entity-ref signer(client 給 entity 座標,不給 path)

用途:點開 receipt 全圖 / booking PDF / wish 全圖。

- client 呼叫 `POST /attachment-url`,body 是 `{ tripId, entityType, entityId, variant }`,**不傳 path**
- Worker 讀 Firestore doc → derive path → 只簽該 path(BOLA 強度,跟 `/expense-receipt-ocr` 同 pattern)
- 多一次 Firestore read,但 full/pdf 是「點開才發生」低頻,值得
- TTL:**full image 10 min** / **PDF 5 min**

權限:thumb 與 entity-ref 都是**純讀取**,只要 **trip member** 即可(viewer 也能看附件,對齊 Storage Rules `allow read: if isMember`)。**不要求** owner/editor —— 這跟 `/expense-receipt-ocr` 不同(那個是「準備寫入」才鎖 owner/editor)。

---

## 4. Worker endpoints

### `POST /attachment-thumb-urls`(batch thumb)

> 命名用 kebab,與 codebase 既有 `/expense-create` 等一致;不用 AIP 的 `:batch` colon 風格。

Request:
```ts
{ tripId: string; paths: string[] }   // paths ≤ 20,server-side dedupe
```
Response:
```ts
{ urls: Array<{ path: string; url: string; expiresAt: string }> }
```
拒絕:
```
非 member               → 403
paths 為空 / > 20       → 400
path 不在 trips/{tripId}/ 底下 → 403
path 非 .thumb.* 用途    → 400
path 含 ../ // 控制字元等 → 400
trip 不存在 / deleting   → 404 / 410
```

### `POST /attachment-url`(entity-ref full/pdf)

Request:
```ts
{ tripId: string; entityType: 'expense'|'booking'|'wish'; entityId: string; variant: 'full'|'pdf' }
```
Response:
```ts
{ url: string; expiresAt: string }
```
derive path:
```
expense → receipt.path   (type: receipt.type)
booking → attachment.filePath (type: attachment.fileType)
wish    → image.path     (wish 無 type 欄位,只允許 variant=full)
```
拒絕:
```
非 member                       → 403
doc 不存在 / expense deletedAt   → 404
attachment 欄位缺 / 無 path       → 404
derive path 不在 trips/{tripId}/{collection}/{entityId}/ 底下 → 400 (BOLA)
variant 與 stored type 不符        → 415  (wish + variant=pdf → 400)
trip deleting                    → 410
```

### 共用 Worker pipeline(沿用現有,不另造)

`index.ts` 既有:CORS allowlist → body-size guard → `verifyFirebaseToken` → 兩層 rate-limit(per-PoP binding + DO global)→ `handleJsonRoute`(Zod safeParse → handler → `CascadeError` 映射 status → 500)。兩個新端點掛同一條 pipeline,handler 全程丟 `CascadeError(status, msg)`。

**Log redaction**:`formatLog` 與 handler **永不** log signed URL / signature。thumb 只 log `trip=… count=N`;entity 只 log `trip=… entity=…/… variant=…`。

---

## 5. GCS V4 local signing(已對官方文件確認)

來源:`cloud.google.com/storage/docs/access-control/signing-urls-manually`(V4, query-string, GET)。

- **host = path-style** `storage.googleapis.com`,canonical URI = `/{bucket}/{object}`。
  **為什麼不用 virtual-hosted**:bucket 名 `tripplanner-80a4f.firebasestorage.app` 含多個 dot,`{bucket}.storage.googleapis.com` 會撞 `*.storage.googleapis.com` 萬用憑證(只配一層 label)→ TLS 失敗。path-style 無此問題,也與既有 `storage.ts`(`storage.googleapis.com/storage/v1/...`)一致。
- canonical request = `join('\n', [GET, canonicalUri, canonicalQuery, 'host:storage.googleapis.com\n', 'host', 'UNSIGNED-PAYLOAD'])`
- query params(sorted,key+value 各自 `strictEncode` = RFC3986 unreserved 之外全 percent-encode):
  `X-Goog-Algorithm=GOOG4-RSA-SHA256` / `X-Goog-Credential={email}/{YYYYMMDD}/auto/storage/goog4_request` / `X-Goog-Date={YYYYMMDD'T'HHMMSS'Z'}` / `X-Goog-Expires={sec}` / `X-Goog-SignedHeaders=host`
- **region 用 `auto`**(官方 Python sample 即用 `auto`,multi-region / 未知 region bucket 皆可)
- canonical URI:object 各 segment `strictEncode`、`/` 保留
- stringToSign = `join('\n', ['GOOG4-RSA-SHA256', xGoogDate, '{YYYYMMDD}/auto/storage/goog4_request', sha256Hex(canonicalRequest)])`
- signature = **hex**( RSASSA-PKCS1-v1_5 / SHA-256 over UTF-8(stringToSign) ),用 SA `private_key`(WebCrypto `importKey('pkcs8', …)`,key 物件 module 快取)
- final = `https://storage.googleapis.com{canonicalUri}?{canonicalQuery}&X-Goog-Signature={sigHex}`

簽章時間注入:helper 收 `nowMs` 參數(handler 傳 `Date.now()`,測試傳固定值 → deterministic)。

---

## 6. Rate limit / quota

新增 scope `attachment-url`,thumb 與 entity 共用:

```
L1 (per-PoP binding ATTACHMENT_URL_RATE_LIMITER): 120 / min / uid
L2 (DO global,scope='attachment-url'):           300 / min / uid
batch max:                                         20 paths / request
```

理由:一個列表畫面約 1~3 次 batch(不是每張圖一次);full/pdf 點開才簽。實測 Worker CPU 簽 20 張太高再降到 10,很低再升。

---

## 7. Rollout 順序

```
Phase 1 ← 本次:Worker signing helper + 兩端點 + 完整 Worker 測試;client 不改,不切流量
Phase 2:client signedUrlResolver(memory cache / in-flight dedup / thumb microtask batch),mode flag 預設 getBlob
Phase 3:thumb 先開 signed,觀察 Worker request / 403 / 5xx / CPU
Phase 4:再開 full/pdf entity-ref signed
終態:mode flag 二選一;移除過渡期的 signed→getBlob 降級
```

---

## 8. 已知 tradeoff

```
signed URL 在 TTL 內是 bearer URL(成員被移除後,舊 URL 最多 TTL 內仍可用:thumb 30m / full 10m / pdf 5m)
Worker request 增加,但 batch + memory cache 壓低
full/pdf 多一次 Firestore read
系統複雜度高於 getBlob —— 所以才用 mode flag 守住「能一鍵回退」
```

---

## 9. Phase 1 測試清單(本次必須綠)

Signing(`gcs-sign.spec.ts`):
```
canonical request / stringToSign 對固定輸入 = golden 字串
query 參數排序 + strictEncode(/ @ 等)正確
auto region / path-style host / hex 簽章格式
用 ephemeral RSA key 簽出來的 URL,signature 能被同 key verify
nowMs 注入 → X-Goog-Date / expiresAt deterministic
```

Endpoints(`attachment-url.spec.ts`):
```
thumb: member + 合法 .thumb path → 200,回 N 個 url+expiresAt
thumb: 非 member → 403 / cross-trip path → 403 / 非 thumb path → 400 / traversal → 400 / >20 → 400 / 重複 path → dedupe
thumb: trip 不存在 → 404 / deleting → 410
entity: expense full derive receipt.path → 200 / booking full derive attachment.filePath → 200 / wish full derive image.path → 200
entity: 非 member → 403 / doc 不存在 → 404 / 缺 attachment → 404 / deletedAt expense → 404
entity: derive path 跨 trip → 400 (BOLA) / variant 與 type 不符 → 415 / wish+pdf → 400
schema strict:thumb 端點塞 entityId、entity 端點塞 path → 400
回傳的 body 不被 log;handler 不 console.log url
```
