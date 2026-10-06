# 間接依賴安全更新

2026-10-06：根目錄 `package.json` 的 overrides 保留原有 Firebase、Vitest 4 與 Worker 測試介面，補上上游尚未放寬的依賴版本。CI 與 Functions 固定 npm 11.21.0；本次實測 npm 11.17.0 對 override 的 `npm ls` 出現 invalid 誤報，11.21.0 的相同依賴樹檢查通過。

| 範圍 | 修補版本 | 原因 |
| --- | --- | --- |
| `@firebase/firestore` → `@grpc/grpc-js` | `^1.14.5` | Firebase 固定 `~1.9.0`；修補 GHSA-m9gg-hp2v-232j 與 GHSA-f596-whhp-79r4。瀏覽器仍使用 Web SDK。 |
| `sharp` | 根目錄 `$sharp` (`^0.35.5`) | 修補 libheif 漏洞 GHSA-rgj7-g3m4-5g8c；與圖示產生工具共用已修補版本。全域約束避免 Worker pool 引入較舊的 Miniflare 時重新解析出漏洞版本。 |
| `undici` | `^7.30.0` | 維持 v7 API，修補 TLS、WebSocket、retry / cache 路徑漏洞。 |
| `uuid` | `^11.1.1` | 修補 GHSA-w5hq-g745-h8pq。gaxios 6 僅使用 `v4()`；已驗證 Node 22 的 CJS/ESM 載入與 multipart boundary。Functions 獨立部署不繼承根 override，因此其 manifest 也保留此約束。 |
| `workbox-build` / `rimraf` → `glob` | `^13.0.6` | 移除 deprecated glob 10／11。兩個 caller 使用的是 `globSync`／promise `glob`，不依賴 v13 移走的 CLI；以實際 Workbox manifest 與 rimraf async/sync 路徑驗證。Functions 獨立 manifest 也保留 rimraf 範圍的 override。 |

glob 跨 major 的範圍依 [官方 changelog](https://raw.githubusercontent.com/isaacs/node-glob/v13.0.6/changelog.md) 核對，未 override Firebase Admin、Google SDK 或 Workbox 的父套件 major。Node 22.23.3／npm 11.21.0 乾淨安裝、Functions 獨立正式安裝、完整 typecheck／lint／建置與實際 caller 測試通過；兩份 lockfile audit 各 0。升級 glob 後仍需保留此相容性驗證，不能由 audit 0 推導跨 major API 相容。

不要使用 `npm audit fix --force`：目前其建議包含 Firebase 9 與 Worker pool 0.8 的降級，會破壞現有架構。相容範圍內的其餘更新已記入 lockfile。

上游更新後可逐個移除 override；每次需重跑 `npm audit`、前端與 Worker / Functions 測試、Firestore Rules emulator、typecheck、lint 和 production build。不得直接修改 `node_modules`。

## 仍由上游帶入的 DOMException 套件

`firebase-admin`／Google SDK → `node-fetch@3.3.2` → `fetch-blob@3.2.0` → `node-domexception@1.0.0`。本次查核最新 node-fetch 仍為 3.3.2；fetch-blob 4.0.0 仍依賴 node-domexception，node-domexception 最新 2.0.2 本身也被標示 deprecated。因此單純升級無法消除此訊息。

在本專案 Node 22 下，現有 node-domexception 直接回傳原生 `globalThis.DOMException`，不啟動舊版 fallback。保留父套件的受支援依賴介面，等待它們移除該依賴；不以移除必要 SDK、隱藏 npm 訊息或自製相容 fork 當成修正。

## allowScripts 是什麼

第三方依賴的 preinstall／install／postinstall 可以執行本機程式，例如 Workerd、esbuild 準備對應平台 binary。`allowScripts` 在 package.json 記錄經審查的套件與版本是否允許執行這些 lifecycle scripts；不是 PWA 或應用使用者的權限。

建置完整政策需列舉所有腳本、讀取腳本來源、只核准必要的精確版本，再以乾淨安裝驗證 Windows、Linux CI 與 Functions builder。固定版本升級後需要重新審查。npm 11.21 的未列管腳本目前會提醒；其實作只阻止明確 denied 的套件，strict-allow-scripts 可作為 CI 的未審查 gate。npm 12 則改成預設阻止未核准腳本；目前未啟用這份政策，也沒有宣稱此提醒已消除。
