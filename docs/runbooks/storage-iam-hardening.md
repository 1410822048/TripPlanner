# Runbook — Firebase Storage 完整退役

> 狀態：R2 遷移的最後一道人工基礎設施步驟。程式碼已不再要求 GCS OAuth scope，
> 但線上 Storage Rules、bucket 與 GCP IAM 授權都不會隨程式刪除而自動消失。
>
> 執行紀錄：2026-07-30 已確認 bucket 內物件數為 0，並刪除
> `gs://tripplanner-80a4f.firebasestorage.app`；刪除後 `buckets describe` 回傳 404。

## 前置門檻

舊 bucket 已提前刪除；只有在下列條件全部成立後才移除殘留 Storage IAM：

- production Worker 與 Pages 已切至 private R2。
- 新上傳、縮圖／全圖／PDF 讀取、刪除、re-OCR、trip cascade、receipt/orphan purge、storage scan 全部通過。
- `workers/ocr/src/storage.ts`、`gcs-sign.ts`、Firebase Storage Web SDK production call 均為 0。
- Worker admin token scope 只剩 `https://www.googleapis.com/auth/datastore`。
- 已依產品決策清空舊資料，不需要 Firebase Storage migration 或 rollback。

## 執行

### 1. 盤點 IAM

先找出 `FIREBASE_SERVICE_ACCOUNT` 的 `client_email`，不要輸出 private key：

```bash
gcloud projects get-iam-policy tripplanner-80a4f \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:<SA_EMAIL>" \
  --format="table(bindings.role)"
```

bucket-level binding 已隨 bucket 刪除，不再查詢 bucket IAM；此步只盤點仍可能存在的
project-level Storage 角色。

### 2. 驗證舊 Firebase Storage bucket 不存在

刪除 repo 內的 `storage.rules` 或 `firebase.json` Storage block **不會**刪除線上既有 Rules；
移除 Worker service account IAM 也不影響持 Firebase Auth token 的舊 PWA／raw SDK。
本專案已於 2026-07-30 刪除舊 bucket。現行流程只驗證它沒有被重新建立：

```bash
# 預期結果：404 / NOT_FOUND。此失敗代表 bucket 仍維持刪除狀態。
gcloud storage buckets describe gs://tripplanner-80a4f.firebasestorage.app
```

若指令意外成功，立即停止 IAM 收斂並確認 bucket 建立來源、物件數與線上流量；不得在
runbook 中自動執行不可逆刪除。若產品決策改成保留 bucket，必須先重新加入最小
`storage.rules` 並部署 `allow read, write: if false;`。

### 3. 移除殘留 Storage IAM

移除該 service account 的 project-level Storage 角色；實際 role 以盤點結果為準。
bucket-level binding 會隨 bucket 刪除消失；若第 2 步改採 deny-all 保留 bucket，才需另外移除它：

```bash
gcloud projects remove-iam-policy-binding tripplanner-80a4f \
  --member=serviceAccount:<SA_EMAIL> --role=<STORAGE_ROLE>

# 僅限保留 bucket 的 deny-all 方案：
gcloud storage buckets remove-iam-policy-binding \
  gs://tripplanner-80a4f.firebasestorage.app \
  --member=serviceAccount:<SA_EMAIL> --role=<STORAGE_ROLE>
```

若 service account 仍靠 `roles/editor` 同時取得 Firestore 權限，先補
`roles/datastore.user`，驗證 Firestore Worker writes 正常後才移除 `roles/editor`。

## 驗證

```bash
gcloud projects get-iam-policy tripplanner-80a4f \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:<SA_EMAIL>" \
  --format="table(bindings.role)"
```

- Worker 的 Firestore writes／cron 正常，沒有 403。
- R2 upload/read/delete/re-OCR/cascade/purge 正常。
- service account 沒有任何 `roles/storage.*`、自訂 Storage role 或 inherited Storage grant。
- Firebase Storage bucket 已不存在；若改採保留方案，線上 Rules 必須是 deny-all 且不再有應用流量。

## Rollback

若誤拔的是 Firestore 必需角色，回加 `roles/datastore.user`。R2 本身不需要 GCP Storage IAM，
因此附件故障時不要回加 Storage role；應先檢查 Worker deployment、R2 binding 與 Cloudflare secrets。
