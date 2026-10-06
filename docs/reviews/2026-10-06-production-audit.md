# TripMate 深度審查與依賴升級 — 2026-10-06

## 綜合評分：4 / 5

已修正本次可重現的兩個問題，完成相容性篩選與 29 個直接套件升級。驗證範圍內沒有尚未修復的 Critical / High finding；這不構成零缺陷或正式資安認證。本報告記錄提交／部署前的驗證；後續 release 以 Git commit 與平台部署紀錄為準。

## 真正要修的致命／中度風險

### 啟動階段未處理 sessionStorage 拒絕存取（P2，已修正）

- 位置：`src/App.tsx` 模組頂層啟動程式。
- 時序：瀏覽器封鎖 storage → getItem / setItem 丟出 SecurityError → App 模組載入中斷 → React ErrorBoundary 尚未掛載 → 空白頁。
- 修法：僅包住 storage 存取；拒絕存取時保留原 URL 並繼續掛載。可使用 storage 時，仍保留首次導向 schedule、邀請 deep link 與重新整理行為。
- 驗證：4 項啟動回歸測試，涵蓋 getItem / setItem 拒絕、普通新工作階段與邀請網址。

### JSON body 限制只信任 Content-Length（P1，已修正）

- 位置：`workers/ocr/src/index.ts` JSON body 解析與新增 `request-body.ts`。
- 路徑：已驗證使用者 → 缺漏／偽造 Content-Length → 原 request.json() 完整緩衝輸入 → 繞過 9 MiB 上限，可能耗盡單次 Worker 記憶體。此問題不代表未登入即可越權。
- 修法：保留 header 的快速拒絕；實際串流逐塊累加 byteLength，超過 9 MiB 即中止並回 413。JWT、雙層 rate limit、CORS、各 route schema 與既有二進位附件限制均保留。
- 驗證：5 項 parser 邊界測試＋2 項實際 Worker fetch 測試；涵蓋 UTF-8 跨 chunk、恰好上限、超限 cancellation、缺漏／偽造 header、無效 JSON。

### 已知間接依賴漏洞（已修補）

初始 audit 發現 proxy-addr、@fastify/busboy、source-map-js 漏洞；乾淨重解依賴時另發現 gaxios 6 的 uuid 9 路徑。已使用相容更新與經驗證的 override 修補。套件 advisory 嚴重度不能直接當成應用程式可被利用的證據。

- proxy-addr：2.0.7 → 2.0.8；[advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)。
- @fastify/busboy：3.2.0 → 3.2.2；[advisory](https://github.com/advisories/GHSA-xjh9-v7x6-24jw)。
- source-map-js：1.2.1 → 1.2.2；[advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。
- uuid：9.0.1 → 11.1.1；gaxios 6 僅使用 v4()，已實測 Node 22 載入與 UTF-8 multipart boundary；[advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq)、[gaxios 原始碼](https://raw.githubusercontent.com/googleapis/gaxios/v6.7.1/src/gaxios.ts)。
- 根 workspace 與 Functions 獨立 lockfile 的 npm audit：各 0 個已知漏洞。

## 技術迭代與現代化最優解

先核對 registry engine／peer dependency、官方 release／migration 文件，再安裝、回歸。未使用 audit fix --force 或手改 node_modules。

| 套件 | 原解析版本 → 新版本 | 決策 |
| --- | --- | --- |
| React / React DOM | 19.2.8 → 19.3.0 | 同步升級 runtime 與 types；[官方發布](https://react.dev/blog/2026/09/09/react-19-3) |
| Vite | 8.2.1 → 8.3.3 | 同一 major |
| vite-plugin-pwa | 1.3.0 → 2.0.0 | peer 已支援 Vite 8；未使用的 asset-generator peer 變更不影響本專案；[release](https://github.com/vite-pwa/vite-plugin-pwa/releases/tag/v2.0.0) |
| react-easy-crop | 5.5.7 → 6.2.4 | v6 主要 breaking change 為 build tooling；既有 API 通過編譯與測試；[releases](https://github.com/ValentinH/react-easy-crop/releases) |
| Worker Vitest pool | 0.20.3 → 0.22.0 | 保留相容 Vitest 4.1.11；925 項 Worker 測試通過 |
| Firebase Functions | 7.3.2 → 7.4.0 | Admin 14.5.0、Node 22 相容；獨立正式安裝、62 項測試與編譯通過 |
| Sentry browser | 10.69.0 → 10.76.0 | 保留既有資料收集行為 |
| TanStack Query | 5.101.4 → 5.104.1 | 同一 major |
| Router | 7.18.2 → 7.18.4 | 同一 major |
| Zod | 4.4.3 → 4.6.5 | 同一 major；保留 Rules／schema 驗證 |
| Zustand | 5.0.14 → 5.0.15 | 同一 major |
| Mapbox GL | 3.27.0 → 3.32.0 | 保留條件 lazy load 與預快取排除 |
| Wrangler | 4.120.0 → 4.147.0 | root 與 Worker 同步 |
| lint-staged | 16.4.0 → 17.6.0 | engine ≥22.22.1；實測 Node 22.23.3 |
| npm | 11.17.0 → 11.21.0 | 固定 CI、packageManager 與 Functions engine；乾淨 ci 與 ls 全樹通過 |

另外升級 jose、Lucide、ESLint、typescript-eslint、Testing Library、React types、Node types、Vite React plugin、Rolldown Babel plugin、globals、react-refresh、bundle visualizer。29 個直接套件數量不含 npm、Actions 或新增明示依賴。

Workbox 六個直接使用的套件改為明示 dependency，避免依賴 PWA 插件的偶然 hoisting。CI 移除 legacy-peer-deps，加入 audit gate、唯讀 GitHub token permission，Actions 固定官方 release 的完整 commit SHA。

| 暫緩項目 | 已確認原因／驗證邊界 |
| --- | --- |
| TypeScript 7 | typescript-eslint 8.71.1 peer 為 ≥4.8.4、<6.1.0，保留 TypeScript 6.0.3 |
| Vitest 5 | Worker pool 0.22.0 peer 為 ^4.1.0，保留 4.1.11 |
| JSDOM 30 | 實測引發 5 項 ExpenseFormModal 測試失敗，涉及 Vitest 4 Blob 相容層與 JSDOM 30 的內部表示；退回 29.1.1 後全數通過 |
| Sentry 11 | dataCollection 預設改變，需先制定個資政策；[官方 migration](https://raw.githubusercontent.com/getsentry/sentry-javascript/11.4.0/MIGRATION.md) |
| react-pdf 11 / PDF.js 6 | 必須同步 renderer、worker 與瀏覽器支援矩陣；本次未完成 major migration 驗證，保留現有精確版本配對 |
| Babel 8 | 非已證實不相容；React Compiler 與轉換鏈 major migration 尚未獨立驗證，保留 Babel 7 |
| npm 12.2.0 | npm 12 預設封鎖第三方 lifecycle scripts；目前 Workerd、esbuild、Firebase util、protobufjs 需要先建立跨平台 allowScripts 政策，再驗證 CI／Functions builder，保留本次已通過的 11.21.0；[官方 breaking changes](https://github.com/npm/cli/releases/tag/v12.0.0) |

## Simplify 減法重構

本次僅集中 JSON byte 上限與串流解析，避免 handler 堆疊 reader loop。調整前為 header 常數＋request.json()；調整後為共用 MAX_JSON_BODY_BYTES＋readBoundedJson()。未新增表單狀態、泛型架構或額外 listener。

安全與防禦等價性：既有 JWT、權限、rate limit、schema、附件限制與 AbortController 均保留；新 parser 補足 header 不可信的防線。JSON 邊界維持 unknown，待 route schema 驗證，不將已驗證實體降級為 any。

## 順手可以加強的輕微缺失

- PWA 2 上游仍傳入 deprecated inlineDynamicImports；建置成功，等待相容的上游修正，不直接 patch 已安裝套件。
- Mapbox lazy chunk 約 517 KiB gzip，仍有 chunk size 提示；未納入 87 筆預快取，不阻塞一般初始入口。本次未做行動網路地圖性能基準。
- glob 10／11 的棄用訊息已消除：Workbox build 與 rimraf 的 library 呼叫經驗證後使用 scoped glob 13.0.6 override；Functions 獨立 manifest 同步。node-domexception 仍由 node-fetch／fetch-blob 引入，最新上游也未移除；保留受支援介面，不以自製 fork 掩蓋棄用。
- npm 11.21 出現第三方 install script 尚未配置 allowScripts 的提醒；本次安裝、Husky、Workerd 測試及建置均成功，未隨意核准供應鏈腳本。
- 架構速查已同步：badge 使用 trip activity metadata、不新增五個 listener；Sentry browser 延遲初始化；Husky + lint-staged；R2 私有附件、mutation overlay 與目前的開發指令。同步 CLAUDE.md、local AGENTS.md 與依賴安全 override runbook；AGENTS.md 為既有 ignored 本機文件，不強制加入版本控制。

## 寫得對／值得保留

- accountScope、listener generation／refcount、URL epoch 清理與 mutation overlay 防止帳號切換及樂觀更新競態。
- Firestore ledger parse fail-closed、sortDate 型別不變式、receiver-only settlement、transaction revision、冪等紀錄與 hard-delete gate。
- OCR sequence／AbortController、modal cleanup 與附件大小／型別驗證。
- PWA redirected response 的既有 copyResponse 修補與回歸測試；升級後保留 87 筆預快取。
- FCM dispatch lease 與可恢復 progress；沒有為了縮短程式碼移除防禦。

## 驗證證據與範圍

| 項目 | 結果 |
| --- | --- |
| 前端／共用 packages | 1,326 tests、126 files 通過 |
| Worker | 925 tests、48 files 通過 |
| Functions | 62 tests、5 files 通過 |
| Firestore Rules emulator | 266 tests、2 files 通過 |
| 合計 | 2,579 tests 通過；新增 11 項回歸 |
| typecheck / lint | 完整 workspace 通過；npm 11.21 乾淨 ci 後再次通過 |
| production build | 通過；Vite 8.3.3、PWA 2.0.0、87 precache entries |
| Functions build | 通過 |
| 嚴格安裝 | root npm ci 不使用 legacy-peer-deps；Functions 在乾淨隔離目錄 ci --omit=dev 通過 |
| npm ls / audit | root 全樹、Functions 正式依賴樹通過；兩份 lockfile audit 各 0 |
| 瀏覽器 smoke | 正式建置本機預覽的行程、訂單、費用、心願、規劃、帳戶均載入；帳戶重載仍留在 /account；console error 0 |

GitNexus 已重建 PDG 索引，審查 callers、依賴流程與變更。既有頂層啟動 IIFE、Worker 外部 fetch 入口不會完整反映於 indexed caller 數，因此另以人工路徑審查與實際入口測試補足。無 taint finding 不代表安全性已獲證明；列出的三組 cycle 經查為 type-only／符號名稱碰撞，未據此進行破壞性重構。

提交前重新執行 detect_changes，回報 10 個已追蹤變更檔、19 個 indexed symbols（主要為文件章節與 Worker fetch）、risk LOW、0 indexed flows；未追蹤的新檔另行逐檔 review。新 parser 的 context 確認 1 個正式直接呼叫者（Worker fetch）與測試呼叫者，並非所有 route 都沒有影響。頂層啟動與外部 fetch 入口的索引限制，以實際入口回歸測試補足。每筆拆分提交另檢查 staged 範圍。

本次未重演實體 iOS PWA／Android 瀏覽器、真實多人併發、正式第三方 OCR／地圖 API 與完整登入後操作。Rules 在 demo emulator 執行，未重設或改寫正式 Firestore／R2 資料。

## 修補順序與工時

兩個可重現問題 → 依賴安全修補 → peer／engine 相容升級 → CI 強化 → 完整測試與建置 → 瀏覽器 smoke 均已完成。建議可提交此批變更；保留本報告所列驗證邊界。後續 PDF.js／Sentry major migration 應各自成批驗證，不混入安全補丁；實機 PWA 與登入後協作驗收約 30–60 分鐘，視裝置與帳號準備而定。

## 補充：本機 Service Worker 更新失敗

使用者提供的 Sentry 截圖時間為 2026-10-06 08:50:54 UTC；實際 scope 是 `http://127.0.0.1:4173/`、script 是 `/sw.js`，並同時記錄 `/compatibility.json` fetch 失敗。先前 smoke 結束後已關閉 4173 預覽伺服器；本次重查也確認該 port 沒有 listener。更新檢查在頁面持續開啟、定時／重新顯示時仍會執行，因此會遇到本機來源不可用。

重新啟動相同正式建置後，以瀏覽器實際確認 `/sw.js` 為 200、text/javascript，`/compatibility.json` 為 200、application/json；Service Worker 為 activated、script 與 scope 正確，直接重試 registration.update() 成功，console error 0。未修改 PWA 程式碼或移除快取；預覽伺服器保持運行。這筆本機事件沒有顯示應用損壞，不能據此把正式站或伺服器仍在線時的同類錯誤一律忽略。

## 補充：上游警告與文件同步

- inlineDynamicImports：PWA 2.0.0 的獨立 SW build 在 output 硬寫舊選項（[上游原始碼](https://raw.githubusercontent.com/vite-pwa/vite-plugin-pwa/v2.0.0/src/vite-build.ts)）。Rolldown 已有 codeSplitting: false 替代（[官方文件](https://rolldown.rs/reference/OutputOptions.codeSplitting)）；等插件相容修正。建置通過，與本機預覽停止後的 SW fetch 失敗無因果關係。
- Mapbox：既有 lazy／預快取排除保留。「新體積優化」指尚未執行的評估：降低第一次開啟地圖時實際下載與解析的 SDK bytes，並以行動網路基準比較；單純切更多 chunk 不等於總量變小。本次沒有宣稱已減少 517 KiB gzip 的 SDK。
- glob：已排除 deprecated 10／11，根依賴樹與 Functions 獨立正式安裝均使用 13.0.6。[v13 變更](https://raw.githubusercontent.com/isaacs/node-glob/v13.0.6/changelog.md)主要移出 CLI；實際 caller 只用 library API。
- node-domexception：最新 fetch-blob 4.0.0 仍依賴它，node-domexception 最新 2.0.2 也 deprecated；因此沒有可直接升級消除的版本。本專案 Node 22 使用原生 DOMException，仍等待父套件遷移。
- allowScripts：已補政策說明，未啟用 allowlist。它控制第三方套件安裝 lifecycle scripts；建立政策需讀取腳本、核准必要精確版本、測試 Windows／Linux／Functions builder。npm 11.21 未列管時提示但仍執行，npm 12 改成預設封鎖；不可把全部套件直接核准。
- 文件：上述架構與工具事實已同步；保留 AGENTS.md 原有 user feedback 與 GitNexus 規範。

此次追加驗證：Node 22.23.3／npm 11.21.0；root 乾淨 npm ci、Functions 隔離 ci --omit=dev、root npm ls --all、兩份 lockfile audit 各 0、完整 typecheck／lint／production build 通過；87 筆預快取。乾淨安裝後重新執行 frontend／packages 1,326 tests、Worker 925 tests、Functions 62 tests、Rules 266 tests，共 2,579 tests 通過。PWA／相容性 26 tests 另先行通過（為全測試的子集，不重複計數）；Workbox manifest、rimraf async／sync、原生 DOMException、Blob UTF-8、multipart UTF-8 共 6 個實際依賴相容性檢查也通過。安裝中已無 glob 棄用訊息，node-domexception 與未列管 scripts 提示仍保留。
