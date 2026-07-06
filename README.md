# TripMate

朋友圈專用的旅遊行程規劃 PWA。一群人出遊時用來協作管理行程、訂單、費用、心願清單。

> 這是個 side project，給朋友間用,不是商業產品。

## 功能

| 分頁 | 用途 |
|---|---|
| 🗓 行程 | 每天的活動時間軸 |
| 🎫 訂單 | 機票 / 飯店 / 電車 / 巴士 / 其他確認單（含附件上傳）|
| 🧾 費用 | 共同支出記帳 + 自動結算分攤 |
| ❤️ Wish | 大家投票決定想去的地方 / 想吃的東西 |
| 🗺 規劃 | 預留（尚未實作）|
| 👤 我的 | 個人資料 + 過往住宿 + 朋友圈 |

支援多 trip 切換、邀請連結（5 小時 expiry，含 QR code）、角色權限（owner / editor / viewer）、PWA 離線。

## Tech Stack

**前端**
- React 19 + Vite 8 + TypeScript（strict）
- React Router 7
- TanStack Query 5（server state）
- Zustand 5（UI state）
- Zod 4（schema 驗證）
- Tailwind CSS 4

**後端 / 服務**
- Firebase Auth（Google OAuth）
- Cloud Firestore（`(default)` database，asia-east1）
- Cloud Storage（asia-east1，含 cross-service rules）
- Cloudflare Pages（`tripmate-2wg.pages.dev`，主 host）
- Cloudflare Worker（`workers/ocr/`，OCR + Worker-authoritative writes）

**工具**
- vite-plugin-pwa（service worker + manifest）
- Sentry（error tracking，optional）
- Husky + lint-staged（pre-commit hooks）
- Vitest（unit tests）

## Quickstart

### 1. Clone + 安裝

```bash
git clone <this-repo>
cd travel-app
npm install
```

### 2. Firebase 設定

複製 env 範本：

```bash
cp .env.example .env
```

從 [Firebase Console](https://console.firebase.google.com) 拿到 web app config，填進 `.env`：

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project-id>
VITE_FIREBASE_STORAGE_BUCKET=<project-id>.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_USE_EMULATOR=false
VITE_SENTRY_DSN=                 # 可選，留空則停用錯誤回報
```

Firebase 端需要：
- Firestore：建立 **`(default)` database**（**不要**用 named database，Storage 跨服務 rules 只支援 `(default)`），region 選 asia-east1
- Storage：啟用，region 跟 Firestore 一致
- Auth：啟用 Google provider

### 3. Deploy rules / indexes

```bash
firebase deploy --only firestore,storage
```

第一次部署時會被問是否授予 IAM 角色給 cross-service rules——**選 Y**。

### 4. 開發

```bash
npm run dev          # vite dev server (含 host 暴露給區網)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest run（單元測試，無 emulator 依賴）
npm run test:watch   # vitest watch mode
npm run test:rules   # firestore + storage rules 整合測試（需 JDK + emulator）
```

### Rules tests 環境

`npm run test:rules` 會自動啟動 Firebase emulator → 跑 `tests/rules/*.test.ts` →
關掉 emulator。測試直接讀 `firestore.rules` / `storage.rules` 作為輸入，所以
通過代表**部署到 production 的規則就是被測過的那份**。

需要：
- **JDK 11 / 17 / 21**（任一 LTS）。
  Windows 推薦 `winget install Microsoft.OpenJDK.21`（需 admin）。
- Firebase CLI（已在 devDependencies）。

CI 不跑 rules tests（emulator 啟動時間 + 額外服務），只在本地 + 改 rules 時
手動跑一次。

## Build & Deploy

目前部署策略是 **production fail-closed / preview-first**：

- **production 只允許 `main`**：`npm run deploy:prod`、`npm run deploy:pages`、`npm run worker:deploy`、`npm run functions:deploy`、artifact/revision prune、`notifications:clear` 都走 production guard。真執行時必須在 `main`，且 local `HEAD == origin/main`、worktree clean。
- **feature branch 只跑 Pages preview**：在 `feat/*` 或其他非 main branch 測前端時，用 `npm run deploy:pages:preview`。它會部署到 Cloudflare Pages preview branch，不會更新 production。
- **dry-run 是唯一可繞過 production git gate 的模式**：`--dry-run` 只列出會跑的 production 流程，不改遠端狀態。
- **未知參數直接 abort**：例如 `--dryrun`、`--preflightonly` 這類 typo 不會被忽略。
- **互斥 mode 只能擇一**：`--worker-only`、`--functions-only`、`--artifacts-only`、`--revisions-only`、`--clear-notifications-only` 不能混用。

```bash
npm run build                          # tsc + vite build → dist/
npm run deploy:pages                   # production Pages only：要求 main == origin/main + clean worktree
npm run deploy:pages:preview           # feature branch Pages preview deploy
npm run deploy:pages:preview -- --preflight-only
npm run deploy:pages:preview -- --build-only
npm run deploy:pages:preview -- --branch=feat/example
```

Cloudflare Pages 上的 Firebase Auth redirect flow 走 same-origin helper：
`functions/__/auth/[[path]].ts` 會代理 `/__/auth/*` 到 Firebase Hosting auth helper。
production build 的 `VITE_FIREBASE_AUTH_DOMAIN` 必須是 Pages/custom domain（目前 `tripmate-2wg.pages.dev`），OAuth redirect URI 需允許 `https://<domain>/__/auth/handler`。

Pages preview build 會依 branch 推導 preview auth domain，例如 `feat/push-notifications` 會使用 `feat-push-notifications.tripmate-2wg.pages.dev`。若 Cloudflare preview host 不是這個格式，可用 `TRIPMATE_PAGES_AUTH_DOMAIN` 明確覆蓋。

Rules / indexes（Firebase 那邊還在管 Firestore + Storage）：

```bash
firebase deploy --only firestore       # firestore rules + indexes
firebase deploy --only storage         # storage rules
```

Push notifications（Firestore rules/indexes 必須先於 Pages client 上線，否則 token opt-in / inbox query 會被擋）：

```bash
npm run deploy:prod                    # pages build -> indexes -> worker -> functions -> rules -> pages upload -> prune
npm run deploy:prod -- --dry-run        # 檢查 production 流程，不改遠端
npm run worker:deploy                   # production guard 後 deploy Cloudflare Worker only
npm run functions:deploy               # production guard 後 push functions only + prune Cloud Run revisions/runtime images
npm run functions:deploy -- --dry-run   # 檢查 functions-only 流程，不改遠端
npm run functions:artifacts:keep-one   # 手動修剪 Artifact Registry runtime images（需 gcloud CLI）
npm run functions:revisions:keep-one   # 手動修剪 Cloud Run revisions（需 gcloud CLI）
npm run notifications:clear -- --confirm-clear-notifications=tripplanner-80a4f  # 破壞性：清空所有通知匣 docs
```

`npm run deploy:prod` 會把 Cloudflare Worker 納入正式流程，且 Worker 會早於 Functions / Pages 上線，避免 Functions 或 client 依賴 Worker 新行為時靠人腦記部署順序。

`npm run functions:deploy` **不會部署 Cloudflare Worker / Firestore rules / indexes**。如果只改了 notification 相關 rules 或 index，單跑 `functions:deploy` 不會生效；請改跑 `npm run deploy:prod`，或手動執行 `firebase deploy --only firestore`。如果 Worker 和 Functions/Pages 需要同批相容，請跑 `npm run deploy:prod`，不要拆成 `functions:deploy`。

## 專案結構

Feature-first folder layout。每個 feature 有自己的 `components / hooks / services`：

```
src/
├── features/
│   ├── account/        個人資料頁
│   ├── auth/           登入相關
│   ├── bookings/       訂單管理 + 過往住宿
│   ├── expense/        共同支出 + 結算
│   ├── members/        成員管理 + 朋友圈
│   ├── planning/       行前計畫（checklist）
│   ├── schedule/       行程時間軸
│   ├── trips/          trip 本體 + 邀請（cross-cutting，被多個 feature 引用）
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/
│   │   └── invites/    邀請連結 sub-domain（service + hook + modal + page）
│   └── wish/           協作心願清單 + 投票
├── components/         共用 UI（BottomSheet / FormField / pickers / ...）
├── hooks/              跨 feature hook（useAuth, useTripContext, useFormReducer,
│                        useFormModal, useFeatureListPage, useSwipeOpen, ...）
├── layouts/            AppLayout（含 nav）
├── routes/             React Router 設定
├── services/           App-level：firebase, paths, sentry, workerBase
├── shared/             toast, categoryMeta
├── store/              Zustand stores（trip, demoTrip）
├── types/              依 entity 切分（trip / schedule / expense / booking / wish / planning）
└── utils/              date / image / retry helpers
```

### 約定

- **Feature 標準層次**：`{services, hooks, components, types?, utils?, mocks?}`。新增 feature 時請對齊這個骨架。
- **Sub-domain folder（如 `trips/invites/`）**：當一個 sub-flow 有 ≥4 個檔案（service + hook + 2+ UI components）且這些檔案彼此緊耦合，但與 feature 主幹（trips 本體）只有「使用」關係時，才開 sub-folder 平鋪所有檔案。否則拆回標準層次。
- **跨 feature 共享的 service**：放在 `src/services/`（如 `workerBase.ts` / `tripMemberIds.ts`），不放在任何 feature 裡。把它放在 feature 內會讓另一個 feature 的 import 線變成「橫向依賴某 feature 的內部結構」。
- **跨 feature 共享的 hook**：放在 `src/hooks/`，feature 內保留只在該 feature 用得到的 hook。

## 安全模型

- 全部資料 scoped 在 `/trips/{tripId}/...` 下
- Firestore rules：每個 collection 各自驗證 isMember / canWrite / isTripOwner
- Storage rules：透過 cross-service `firestore.exists()` 對 `(default)` 資料庫做角色驗證
- 邀請 token 放在 URL fragment（`#`），不會進 server / CDN log

`firestore.rules` + `storage.rules` 是真實守門員，UI 端的權限檢查只是 UX 防呆。

## 已知限制

- Wish 排序在 client 端做（票數 desc），對應限制：**單 trip 最多 100 個 wish**
- Bookings 列表 100 筆上限、Schedules 200 上限——資料超過上限會 Sentry 警報
- HEIC 上傳走原檔（canvas 無法 decode），其他圖片自動轉 WebP（full 1920px + thumb 192px）
- PWA 離線寫入靠 Firestore 內建 IndexedDB cache；Storage 上傳沒離線 queue

## 部署檢查清單（第一次 / 重大改動後）

```bash
npm run typecheck && npm run lint && npm run test  # 本地驗證
npm run build                                       # 確認 build 通
firebase deploy --only storage                      # storage rules
npm run deploy:prod                                 # Pages build gate + indexes/functions/rules + Pages upload
gcloud firestore export gs://<bucket>/backups/$(date +%F)  # 手動備份基準
```

### 部署順序判斷

`npm run deploy:prod` 適合一般 additive deploy：新增 index、放寬 rules、新 client 需要的新 backend/functions 先就緒，最後才上 Pages client。

`deploy:prod` 會在任何遠端變更前先檢查 production git ref（`main == origin/main` + clean worktree）、Pages production env、Cloudflare Pages project access，並實際完成 production build；接著檢查 gcloud auth / Firestore / Cloud Run / Artifact Registry read 權限。任一項不通就 fail-fast，避免 backend 已部署但 Pages build / Pages access / cleanup 最後才失敗。

若要在 feature branch 驗證前端，使用 `npm run deploy:pages:preview`。不要用 `deploy:pages` 或 `deploy:prod` 測 feature branch，因為這兩個是 production path。

`npm run functions:deploy` 也是 production path，會套用同一個 git gate。若只是想看會跑什麼，使用 `npm run functions:deploy -- --dry-run`。

`npm run functions:deploy` 只處理 Functions + Cloud Run / Artifact Registry prune，不會碰 Firestore rules / indexes。若變更內容只有 notification rules 或 Firestore index，請跑 `npm run deploy:prod` 或手動 `firebase deploy --only firestore`。

若是 rules tightening、移除舊欄位、改 schema contract、或任何舊 client 可能被新 rules / backend 擋住的變更，不要直接套固定順序；先做 two-phase deploy（先讓 client/backend 同時相容舊新資料，再收緊 rules / 移除舊路徑）。

### 通知匣資料清理

`npm run notifications:clear` 是破壞性維護指令，不屬於日常 deploy，也不會被 `deploy:prod` 自動執行。只有在明確要清空資料庫、推播測試產生大量假通知、通知 schema 不相容且決定不做 migration，或誤寫入錯誤收件者 / tripId 的通知時才使用。

為避免誤清正式訊息匣，實際執行必須帶 project id 確認：

```bash
npm run notifications:clear -- --confirm-clear-notifications=tripplanner-80a4f
```

## Contributing

這是個人 / 朋友圈專案。如果你不知道為什麼 clone 了它，你可能拿錯倉庫了。

## License

私人專案，無 license。
