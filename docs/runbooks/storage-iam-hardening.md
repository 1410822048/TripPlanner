# Runbook — Storage Admin 權限收斂（IAM hardening）

> 對象:部署 / IAM 操作者。這份是「把 Worker 的 admin service account 從寬角色收斂到
> bucket-level 最小權限」的操作手冊與防呆筆記。**純 Console / gcloud 操作,程式碼不需改動。**

最後驗證:2026-06-08。狀態:**規劃完成,尚未在 Console 執行**(等本 runbook 跑過一輪)。

---

## 0. 背景 / 為什麼做

- 收據 / booking 附件 / wish 圖已改成 **path-only**:Firestore 只存 Storage object PATH,
  讀取走 `getBlob(ref(path))` + Storage Rules,**不再存長效 `?alt=media&token=` bearer URL**。
- 上傳完成時,Worker 在 `consumeIntentInTx()` 用 **GCS `objects.patch`** 把
  `firebaseStorageDownloadTokens` metadata 設 `null`(strip token,fail-closed),
  讓 bearer URL 根本組不出來。實作:`workers/ocr/src/storage.ts:updateObjectMetadata`。
- **2026-06 事故教訓**:`objects.patch` 用 OAuth scope `devstorage.read_write` 會回
  **403 "Provided scope(s) are not authorized"**(read_write 涵蓋 get/list/delete,但
  **不授權 patch 方法**)。已修成 `devstorage.full_control`(`workers/ocr/src/admin.ts`,
  commit `d24330f8`,已部署)。

這份 runbook 處理的是**下一步**:scope 修好之後,把 SA 在 **IAM** 層的 Storage 權限
從專案層寬角色收斂到 bucket 層最小集合。

---

## 1. 核心防呆:scope ≠ IAM(兩者是 AND）

```txt
OAuth scope  = token 的能力上限(這顆 token「最多」能做什麼方法)
IAM 權限     = SA 對「某個資源」實際被授予什麼
有效權限     = scope ∩ IAM   (兩者都通過才放行)
```

- `devstorage.full_control` **不代表**真的放大到全專案。它只是讓 token 能「通過 patch 這個
  方法」的 scope 門檻;**真正的資源邊界要靠 IAM 綁在指定 bucket**。
- 所以:**`full_control` scope 保留、不 rollback**(`objects.patch` 需要它);收斂在 IAM 那一側做。

參考:
- [Objects: patch — 需要 `storage.objects.update`](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/patch)
- [IAM permissions for JSON methods](https://docs.cloud.google.com/storage/docs/access-control/iam-json)
- [Cloud Storage OAuth scopes](https://docs.cloud.google.com/storage/docs/oauth-scopes)

---

## 2. Worker 實際用到的 GCS 操作面（最小集合）

全部 GCS 呼叫只經 `workers/ocr/src/storage.ts`(`BASE = storage.googleapis.com/storage/v1`)。
實際 object 操作只有四種:

| 程式 (`storage.ts`)                       | GCS method   | 需要的 IAM permission     |
|-------------------------------------------|--------------|---------------------------|
| `listObjects` / `purgeObjectsByPrefix`    | objects.list | `storage.objects.list`    |
| `getObjectMetadata` / `downloadObject`    | objects.get  | `storage.objects.get`     |
| `deleteObject`                            | objects.delete | `storage.objects.delete`|
| `updateObjectMetadata`(strip token)      | objects.patch | `storage.objects.update` |

- **沒有** bucket 操作、**沒有** `objects.create`(上傳由 client 用 Firebase ID token 走
  Storage Rules,admin token 從不建檔)、**沒有** ACL / IAM 操作。
- `objects.patch` 的額外權限(`setRetention` / ACL / object-context)我們都沒用 —— patch body
  只有 `{ metadata: { firebaseStorageDownloadTokens: null } }`。
- 結論:Storage 最小角色 = **`{ get, list, delete, update }`**,一個不多。

> ⚠️ 若未來導入 Firebase Resize Images extension 或其他 server 端寫圖,需要 `objects.create`
> 時,記得回來補這份角色 + Part H scrubber 涵蓋產出的縮圖。

---

## 3. ⚠️ 最大雷點:同一個 SA 同時服務 Firestore + Storage

`workers/ocr/src/admin.ts` 的 admin token **同時帶兩個 scope**:

```txt
https://www.googleapis.com/auth/datastore             ← Firestore REST admin
https://www.googleapis.com/auth/devstorage.full_control ← GCS objects.* + patch
```

→ 同一顆 token、同一個 SA。Worker 的 **trip-cascade / settlement-write / expense-write**
全靠它打 Firestore admin。

**因此:不能直接把 project-level `Editor`(或其他寬角色)整個拔掉去收斂 Storage**,
否則會**連 Firestore 寫入一起斷**。正確順序是「先補 Firestore 的最小角色,再拔寬角色」。

---

## 4. 鎖定結論

```txt
OAuth scope:
  devstorage.full_control   → 保留,不 rollback(objects.patch 需要)

Storage IAM(bucket-level,綁在 gs://tripplanner-80a4f.firebasestorage.app):
  storage.objects.get
  storage.objects.list
  storage.objects.delete
  storage.objects.update

Firestore IAM:
  若目前靠 Editor 才有 Firestore → 先補 roles/datastore.user,再拔 Editor
```

---

## 5. 執行步驟（先加後拔,驗證為閘）

專案 = `tripplanner-80a4f`,bucket = `gs://tripplanner-80a4f.firebasestorage.app`。

### Step 0 — 取得 SA email
從 `FIREBASE_SERVICE_ACCOUNT` wrangler secret 的 `client_email`(**不必印 private key**)。
通常形如 `firebase-adminsdk-xxxxx@tripplanner-80a4f.iam.gserviceaccount.com`。

### Step 1 — 盤點目前 IAM（先看它靠什麼角色拿到 Firestore + Storage）
```bash
gcloud projects get-iam-policy tripplanner-80a4f \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:<SA_EMAIL>" \
  --format="table(bindings.role)"
```
記下它現有的寬角色(`roles/editor`、`roles/firebase.sdkAdminServiceAgent`、
專案層 `roles/storage.admin` 等)。

### Step 2 — 先加 bucket-level Storage 最小權限（尚未拔任何東西）

**中期方案:自訂角色(最小)**
```bash
gcloud iam roles create tripmateStorageObjectMaintainer --project=tripplanner-80a4f \
  --title="Tripmate Storage Object Maintainer" \
  --permissions=storage.objects.get,storage.objects.list,storage.objects.delete,storage.objects.update

gcloud storage buckets add-iam-policy-binding gs://tripplanner-80a4f.firebasestorage.app \
  --member=serviceAccount:<SA_EMAIL> \
  --role=projects/tripplanner-80a4f/roles/tripmateStorageObjectMaintainer
```

**短期方案(更快、稍寬):bucket-level objectAdmin**
```bash
gcloud storage buckets add-iam-policy-binding gs://tripplanner-80a4f.firebasestorage.app \
  --member=serviceAccount:<SA_EMAIL> \
  --role=roles/storage.objectAdmin
```

### Step 3 — 先補 Firestore 最小角色（若 Step 1 顯示 Firestore 靠 Editor）
```bash
gcloud projects add-iam-policy-binding tripplanner-80a4f \
  --member=serviceAccount:<SA_EMAIL> --role=roles/datastore.user
```

### Step 4 — 全功能驗證（拔寬角色前必須全綠）
見 [§6 驗證清單]。**確認無 403 / `ATTACHMENT_HARDENING_FAILED`、Firestore 寫入正常**後才往下。

### Step 5 — 才移除過寬的 project-level 角色
```bash
# 例:拔 Editor(視 Step 1 結果而定,逐一拔)
gcloud projects remove-iam-policy-binding tripplanner-80a4f \
  --member=serviceAccount:<SA_EMAIL> --role=roles/editor
```
拔完**再跑一次 §6 驗證**。

### Step 6 — 觀察 24h cron
確認每日 03:00 UTC 的 `runStorageMaintenance`(token scrubber + orphan scan)正常,
log `[cron] storage-maintenance scrub={...} orphan={...}` 無 403。

---

## 6. 驗證清單

跑過以下全部,確認**無** `403` / `Provided scope(s) are not authorized` / `ATTACHMENT_HARDENING_FAILED`:

- [ ] 含圖片 expense 建立(receipt 上傳 → strip token → doc 寫入成功)
- [ ] 含 PDF / 圖片 booking 建立
- [ ] wish 封面圖建立
- [ ] receipt / 附件 `getBlob` 預覽顯示(列表縮圖 + 全尺寸 modal)
- [ ] 刪除 expense / booking / wish 附件(`objects.delete`)
- [ ] Firestore 寫入正常(settlement「済み」記錄、trip 編輯、cascade)
- [ ] 手動或等 cron 跑一次 storage maintenance,scrubber 有清 token、無 403
- [ ] `gsutil stat gs://.../<新上傳的 object>` → metadata **無** `firebaseStorageDownloadTokens`
- [ ] 直接組 `?alt=media&token=` → 應 **403**(token 已被 strip)

---

## 7. Rollback

若 IAM 收太緊導致 production 403 / 寫入失敗:

```txt
Storage 斷    → 先回加 bucket-level roles/storage.objectAdmin
Firestore 斷  → 先回加 roles/datastore.user(或暫時回 roles/editor)
```

**不要動程式碼**。`devstorage.full_control` scope(`admin.ts`)是 `objects.patch` 的必要條件,
**不可** rollback 成 `read_write` —— 那會直接讓 token-strip 回到 403 事故狀態。

---

## 8. 備忘

- 收斂只動 IAM,scope 與程式碼都已就位(scope = full_control、操作面已最小)。
- signed URL 讀取(免 CORS)是後續 backlog,等這層 IAM 穩定再評估。
- 相關:path-only 遷移計畫見 plan `mossy-exploring-llama`;FX / settlement 等其他遷移見 memory index。
