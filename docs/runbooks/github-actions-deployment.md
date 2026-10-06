# GitHub Actions 正式部署

## 流程與啟用

`.github/workflows/ci.yml` 保留完整 CI；`main` 通過檢查後才允許 production job。
PR 與其他分支不取得 production 憑證。所有 Actions 固定完整 commit SHA。

- 自動部署開關：repository variable `PRODUCTION_DEPLOY_ENABLED=true`。
- 初始設定為 `false`，完成 Cloudflare token 與首次實際部署驗證後才啟用。
- 手動部署：Actions → CI → Run workflow → branch `main`，`verify_only=false`。
- 僅驗證 Google 登入：同一入口，`verify_only=true`；仍跑完整 CI，但不發布或清理雲端資源。
- production Environment 只接受 `main` 分支。

production job 會 checkout `main` 並比對本次通過 CI 的 `github.sha`。
若等待期間 main 已前進，舊 run 中止，禁止把尚未驗證的新提交發布。
部署共用 concurrency group，`cancel-in-progress=false`，不會中途切斷發版。

## Cloudflare 設定

在 [production Environment](https://github.com/1410822048/TripPlanner/settings/environments)
直接新增 secret `CLOUDFLARE_API_TOKEN`，不要貼入聊天、workflow 或 repository。

Token 限定正式帳號：

- Cloudflare Pages Edit，供既有 `tripmate` 專案上傳與列出 deployments。
- 既有 `tripmate-ocr` Worker Editor，使用 Cloudflare granular authorization 的個別 Worker scope。
- 不授予 DNS、其他 Worker、R2 物件資料或帳號管理權限。

部署 token 能修改使用 runtime secrets 的程式碼，仍屬高敏感憑證；限縮 API 權限
不代表修改 Worker 後不能間接使用既有 bindings。僅由可信 main workflow 使用。

## Google WIF

無 JSON key；`google-github-actions/auth` 建立短效 ADC，Firebase CLI 與 gcloud 共用。
`gha-creds-*.json` 已加入 `.gitignore`，不得上傳成 CI artifact。

| 項目 | 設定 |
| --- | --- |
| Project | `tripplanner-80a4f`（number `388031713949`） |
| Pool / provider | `github-actions` / `tripplanner-production` |
| Deploy service account | `github-deploy@tripplanner-80a4f.iam.gserviceaccount.com` |
| Repository / owner ID | `1219822851` / `71370330` |
| Ref / environment | `refs/heads/main` / `production` |
| Workflow | `1410822048/TripPlanner/.github/workflows/ci.yml@refs/heads/main` |
| Events | `push` / `workflow_dispatch` |

Provider condition 同時比對上述 repo ID、owner ID、ref、environment subject、workflow_ref
與 event；service account 的 `roles/iam.workloadIdentityUser` 只綁該 repo ID。

部署帳號不授予 Owner／Editor，也不授予 Firestore entity 資料讀寫權限。
Project roles 為 Cloud Functions Developer、Firebase Rules Admin、Datastore Index Admin、
Service Usage Consumer，以及自訂 `tripmateDeploymentHygiene`／`tripmateDeploymentMetadata`。
Metadata role 僅含 firebase.projects.get、firebase.clients.get 與 firebaseextensions.configs.list；
不使用含 Firestore entity 讀取權限的 Firebase Viewer。
自訂 role 僅含 Cloud Run services get/list、revisions get/list/delete 與 operations get。
Artifact Registry Repo Admin 僅授予 `asia-east1/gcf-artifacts` repository；
Service Account User 僅授予目前 Functions build/runtime 使用的 compute service account。

若 Firebase CLI 報缺少權限，依錯誤補必要 permission／resource scope，
不要直接提升為 Editor／Owner。此帳號仍可部署 Functions 及 Rules；能控制這些程式碼
即能改變線上服務行為，必須保護 repo 的寫入權限。

## production variables

`CLOUDFLARE_ACCOUNT_ID`、`GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`
存於 production Environment variables。前端公開 build-time 設定同樣放 variables：
`VITE_FIREBASE_API_KEY`、`VITE_FIREBASE_AUTH_DOMAIN`、`VITE_FIREBASE_PROJECT_ID`、
`VITE_FIREBASE_MESSAGING_SENDER_ID`、`VITE_FIREBASE_VAPID_KEY`、`VITE_FIREBASE_APP_ID`、
`VITE_SENTRY_DSN`、`VITE_MAPBOX_TOKEN`。

公開設定由前端 bundle 使用，不能取代 Rules／Worker 權限驗證；地圖 token 應有來源限制。
不要使用 CI job 的 placeholder build 作為 production 產物。

## 原有部署防線

執行 `npm run deploy:prod`，保留 env preflight、main/origin HEAD 比對、乾淨工作區、
索引 READY polling、Functions ACTIVE polling、Rules 編譯與 Pages 存取檢查。
發布後比對正式網域的 index.html、sw.js、compatibility.json 與本次 dist，
允許 CDN 傳播短暫延遲；不一致則 run 失敗。

腳本成功發布後會清理退役 Functions、不再使用的 Cloud Run revisions 與舊 runtime
images；這是既有行為，不是新的備份機制。Firestore／R2 使用者資料不清空。

**Schema Epoch 仍須人工分階段安排提交。** 自動化不會替你決定 cutoff 或更新窗口。
增加必填 wire 欄位時，先發布相容 client，再提高 manifest minimum 並等 active-client
refresh 窗口，最後才發布 strict Worker；不得把四階段壓成一次 main push。

## 金鑰與失敗復原

WIF 僅移除 CI 的長效 Google key；Worker 的 `FIREBASE_SERVICE_ACCOUNT` runtime secret
仍依賴既有私鑰。撤銷根目錄 key 前需核對 key ID 與所有使用者，必要時先輪替 Worker。
本次遷移不撤銷任何 runtime key。

若須停止自動發版，把 `PRODUCTION_DEPLOY_ENABLED` 設為 `false`，已開始的 run 應等它
完成，避免中斷多服務發布。仍可用原本本機安全腳本部署。
修改較早已通過 CI 的提交時需重新跑 CI；回滾亦應以新的 main commit 發布。
