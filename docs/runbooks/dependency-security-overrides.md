# 間接依賴安全更新

2026-10-02：根目錄 `package.json` 的 overrides 保留原有 Firebase、Vitest 4 與 Worker 測試介面，補上上游尚未放寬的依賴版本。

| 範圍 | 修補版本 | 原因 |
| --- | --- | --- |
| `@firebase/firestore` → `@grpc/grpc-js` | `^1.14.5` | Firebase 固定 `~1.9.0`；修補 GHSA-m9gg-hp2v-232j 與 GHSA-f596-whhp-79r4。瀏覽器仍使用 Web SDK。 |
| `miniflare` → `sharp` | 根目錄 `$sharp` (`^0.35.5`) | 修補 libheif 漏洞 GHSA-rgj7-g3m4-5g8c；與圖示產生工具共用已修補版本。 |
| `miniflare` / `jsdom` → `undici` | `^7.29.1` | 維持 v7 API，修補 TLS、WebSocket、retry / cache 路徑漏洞。 |

不要使用 `npm audit fix --force`：目前其建議包含 Firebase 9 與 Worker pool 0.8 的降級，會破壞現有架構。相容範圍內的其餘更新已記入 lockfile。

上游更新後可逐個移除 override；每次需重跑 `npm audit`、前端與 Worker / Functions 測試、Firestore Rules emulator、typecheck、lint 和 production build。不得直接修改 `node_modules`。
