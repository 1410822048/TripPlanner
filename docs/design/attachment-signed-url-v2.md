# Attachment Signed URL V2 — 設計書(修訂版）

> 狀態:**SHIPPED**(2026-06-10)。終態 = **full/PDF 走 signed、thumb 維持 getBlob**;mode flag 長存,可一鍵回退。
> 前身:目前線上是 **path-only + `getBlob` + Storage Rules** 讀取(commit `2897a418` / `d24330f8`)。
> 本文 supersede 對話中那份「V2 規劃書(4.7/5)」,差別在 **§2 fallback 策略**。

---

## 0. 目標 / 非目標

**目標**:在不破壞 path-only 安全模型的前提下,把附件讀取從 `getBlob`(下載 bytes → objectURL)升級成 **短效 GCS V4 signed URL**,換取:

- 瀏覽器原生快取 / range request(大圖、PDF 體驗)
- 降低 client 記憶體壓力(不再每張圖都 `createObjectURL` 一份 blob)
- 保留免費方案額度(Worker 只「簽 URL」不代理 bytes)

> **實際落地(2026-06-10)**:只有 **full/PDF** 走 signed;**thumb 維持 getBlob**。上面「降低記憶體壓力」對縮圖收益其實邊際(thumb LRU 已 cap 200 + 圖小),而 signed 給縮圖加的 per-image Worker round-trip 量到單張 ~1.35s,不划算 → thumb 不走 signed。詳見 §7。

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

### Thumb:~~batch path signer~~ → **getBlob(signed thumb 已移除)**

> **REMOVED 2026-06-10**:thumb 維持 `getBlob`,不走 signed。原本的 `POST /attachment-thumb-urls` batch signer + client microtask 合批佇列(`enqueueThumb` / `flushThumbs` / `thumbQueue`)**整套刪除**。原因:signed thumb 在 bytes 下載前插一段 Worker round-trip(verify + `requireTripMember` 2 個 Firestore 讀 + RSA 簽),getBlob 是 browser 直連 Storage、**零 Worker hop**,單張量到 ~1.35s。縮圖小、LRU 已 cap 記憶體,不值得。`useAttachmentUrl(path, { kind: 'thumb' })` 仍是同一個 hook,但 `attachmentUrlMode('thumb')` 硬回 `getBlob`(忽略 env)。詳見 §7。

### Full / PDF:entity-ref signer(client 給 entity 座標,不給 path)

用途:點開 receipt 全圖 / booking PDF / wish 全圖。

- client 呼叫 `POST /attachment-url`,body 是 `{ tripId, entityType, entityId, variant }`,**不傳 path**
- Worker 讀 Firestore doc → derive path → 只簽該 path(BOLA 強度,跟 `/expense-receipt-ocr` 同 pattern)
- 多一次 Firestore read,但 full/pdf 是「點開才發生」低頻,值得
- TTL:**full image 10 min** / **PDF 5 min**

> **Phase 2 簡化(實作後修訂)**:原規劃要為 full/pdf 新增一個 `useAttachmentUrlFromEntity` hook,因為 entity 端點吃座標而非 path。但所有 stored path 都是結構化的 `trips/{tripId}/{collection}/{entityId}/{file}` —— 座標(tripId / entityType / entityId / variant)**全都能從 path parse 出來**(`attachmentUrlResolver.parseEntityRef`,`.pdf` 副檔名 → variant=pdf)。所以 **沿用既有 `useAttachmentUrl(path, { kind })`,API 不變、零 UI 遷移**,只在 hook 內依 mode 切底層。client 傳的座標仍只是 locator,Worker 照舊從 doc 重新 derive(BOLA 不變)。

權限:thumb 與 entity-ref 都是**純讀取**,只要 **trip member** 即可(viewer 也能看附件,對齊 Storage Rules `allow read: if isMember`)。**不要求** owner/editor —— 這跟 `/expense-receipt-ocr` 不同(那個是「準備寫入」才鎖 owner/editor)。

---

## 4. Worker endpoints

### ~~`POST /attachment-thumb-urls`(batch thumb)~~ — **REMOVED 2026-06-10**

thumb 改回 getBlob,此端點與其 schema / 路徑驗證(`isValidThumbPath`)/ 測試**整套刪除**。`requireTripMember` 原本只有它在用,也一併移除(`signEntityUrl` 自己 inline 讀 trip+member+entity)。Worker 現在只有下面這一個 signed-URL 端點。

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

scope `attachment-url`(thumb 端點移除後只剩 entity full/pdf 端點用):

```
L1 (per-PoP binding ATTACHMENT_URL_RATE_LIMITER): 120 / min / uid
L2 (DO global,scope='attachment-url'):           300 / min / uid
```

理由:full/pdf 點開才簽,低頻。(thumb batch 端點已移除,故無 batch max。)

---

## 7. Rollout 順序

```
Phase 1 ✅ Worker signing helper + 兩端點 + 完整 Worker 測試;client 不改,不切流量
         (deployed + 真 GCS 端到端驗證過,2026-06-09)
Phase 2 ✅ client signedUrlResolver(memory cache / in-flight dedup / thumb microtask batch),
         mode flag VITE_ATTACHMENT_URL_MODE 預設 getBlob → prod 行為不變;沿用既有 hook,零 UI 遷移
Phase 3 ✅ prod 切 signed(全域 VITE_ATTACHMENT_URL_MODE=signed,2026-06-09,gate 兩層綠)
強化   ✅ per-kind flag(VITE_ATTACHMENT_{THUMB,FULL}_URL_MODE 覆寫全域)+ strict signed base
dial   ✅ full/PDF first → thumb second(2026-06-10);但 thumb 切 signed 後單張量到 ~1.35s,同日 revert
移除   ✅ signed thumb 整套刪除(2026-06-10):Worker /attachment-thumb-urls route + signThumbUrls + client thumb 佇列 + THUMB env flag 全拔;thumb 在 code 硬寫 getBlob
終態   ✅ full/PDF signed、thumb getBlob(永久);getBlob 不刪、full/pdf mode flag 長存
```

> **thumb 已從 signed 移除(2026-06-10,終態)**:`attachmentUrlMode('thumb')` 在 code 硬回 `getBlob`(忽略 env);只有 full/pdf 讀 `VITE_ATTACHMENT_FULL_URL_MODE` 覆寫全域 `VITE_ATTACHMENT_URL_MODE`(`'signed'` 才 signed)。原本的 per-kind THUMB flag 已拿掉(留著只會是個性能誤用開關)。**為何 thumb 不走 signed**:signed thumb 在 bytes 下載前先插一段 Worker round-trip(verify + 2 個 Firestore 讀 + RSA 簽),getBlob 是 browser 直連 Storage、**零 Worker hop**;單張 thumb 量到 ~1.35s(冷 isolate + 跨區 Firestore 兩讀;admin token / JWKS 其實有 in-process cache,不是主因)。縮圖小、LRU 已 cap 記憶體,每張多一個 hop + 冷啟動稅不划算 → **signed 只對 full/PDF 合理**(刻意單開、bytes 大、PDF range,延遲被使用者等待吸收)。member cache(`uid:tripId` 60-120s)能砍暖狀態的 Firestore 兩讀,但救不了冷啟動、也拿不掉 hop → 不為撐 signed thumb 而做(直接移除)。
>
> **Strict signed base(已實作)**:signed mode 鑄造 bearer URL,比 OCR read 敏感,resolver signed 分支用 `requireWorkerWriteBase()`(嚴格讀 `VITE_WORKER_BASE_URL`,不 fallback prod)。沒設 → fail-closed(resolve 回 null → placeholder + DEV 警告一次),而非默默打 prod Worker。單一 Firebase 專案下當下風險低,屬 hardening + 防未來拆 staging/prod 專案。

> **Phase 3 切旗前必做(rollout gate,兩層都要綠才設 prod `VITE_ATTACHMENT_URL_MODE=signed`)**:
> 1. **Worker→GCS 簽名**(re-runnable):`node workers/ocr/scripts/smoke-attachment-url.mjs entity <trip> <exp>`,GCS 須回 200。切旗前重跑一次確認 token / SA / bucket 沒漂。(thumb smoke 已隨 thumb 端點移除。)
> 2. **端到端 client render**(單元測試蓋不到):用 `VITE_ATTACHMENT_URL_MODE=signed` build(staging 或本機 `npm run dev`),開 expense / booking / wish 全圖 / PDF 預覽,確認 — Network 看到 `/attachment-url` 回 200、GCS 圖片 200、全圖實際渲染、sign-out 後舊 URL 不再出現。(縮圖走 getBlob,不打 Worker。)

---

## 8. 已知 tradeoff

```
signed URL 在 TTL 內是 bearer URL(成員被移除後,舊 URL 最多 TTL 內仍可用:full 10m / pdf 5m)
full/pdf 點開才多一次 Worker round-trip + Firestore read(thumb 走 getBlob,零 Worker hop)
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

Endpoints(`attachment-url.spec.ts`,entity full/pdf only — thumb 端點已移除):
```
entity: expense full derive receipt.path → 200 / booking full derive attachment.filePath → 200 / wish full derive image.path → 200
entity: 非 member → 403 / doc 不存在 → 404 / 缺 attachment → 404 / deletedAt expense → 404
entity: derive path 跨 trip → 400 (BOLA) / variant 與 type 不符 → 415 / wish+pdf → 400
schema strict:entity 端點塞 path / 壞 variant → 400
回傳的 body 不被 log;handler 不 console.log url
```
