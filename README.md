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
- Firebase Hosting

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

```bash
npm run build                          # tsc + vite build → dist/
firebase deploy --only hosting         # 部署到 Firebase Hosting
```

完整部署（含 rules / indexes）：

```bash
firebase deploy
```

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
├── services/           App-level：firebase, paths, sentry, memberSync
├── shared/             toast, categoryMeta
├── store/              Zustand stores（trip, demoTrip）
├── types/              依 entity 切分（trip / schedule / expense / booking / wish / planning）
└── utils/              date / image / retry helpers
```

### 約定

- **Feature 標準層次**：`{services, hooks, components, types?, utils?, mocks?}`。新增 feature 時請對齊這個骨架。
- **Sub-domain folder（如 `trips/invites/`）**：當一個 sub-flow 有 ≥4 個檔案（service + hook + 2+ UI components）且這些檔案彼此緊耦合，但與 feature 主幹（trips 本體）只有「使用」關係時，才開 sub-folder 平鋪所有檔案。否則拆回標準層次。
- **跨 feature 共享的 service**：放在 `src/services/`（如 `memberSync.ts`），不放在任何 feature 裡。把它放在 feature 內會讓另一個 feature 的 import 線變成「橫向依賴某 feature 的內部結構」。
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
firebase deploy --only firestore,storage           # rules / indexes 同步
firebase deploy --only hosting                     # 上線
gcloud firestore export gs://<bucket>/backups/$(date +%F)  # 手動備份基準
```

## Contributing

這是個人 / 朋友圈專案。如果你不知道為什麼 clone 了它，你可能拿錯倉庫了。

## License

私人專案，無 license。
