// scripts/deploy-pages-prod.mjs
//
// 正式環境 Pages 部署的固定入口。把正式 Worker URL 注入 build,並在 build
// 前對 production bundle 必備的 client env 做 preflight,讓 prod 部署不再
// 依賴 ambient env / 本機 .env 是否存在。
//
// 為什麼需要這支 wrapper:
//   `deploy:pages` 是「本地 `npm run build` → 上傳 dist」,不是 Cloudflare
//   遠端 build。client env 是 Vite build-time bake-in(凍進 JS bundle,不是
//   runtime 讀取),而 `.env` 是 gitignored —— 換機器 / CI / 新 clone 沒有
//   它時,`npm run build` 仍會「成功」,卻 ship 出壞站:
//     - VITE_WORKER_BASE_URL 缺  → 每個 mutating Worker call 在
//       requireWorkerWriteBase() runtime throw(寫入全掛)。
//     - VITE_FIREBASE_* 缺       → firebase.ts 在 import.meta.env.PROD 下
//       module-load 時 throw → 一開站白屏。
//   這兩種偵測原本都在 runtime(瀏覽器)才發生。這支 wrapper 把它們左移到
//   build 之前:URL 直接注入成確定值,其餘必備 env 缺一就中止,壞 bundle
//   根本 ship 不出去。
//
// 為什麼用 Vite 的 loadEnv 而不是查 process.env:
//   node 的 process.env 不會自動含 .env 的值(只有 Vite build 時才讀),
//   所以「查 process.env」會在有 .env 的機器上誤判缺值。loadEnv 解析的正是
//   build 實際會看到的 merged env(.env* 檔 + process.env,後者優先),檢查
//   與實際 bake 一致。
//
// 為什麼不靠「grep dist 是否含某 URL」當驗證:workerBase.ts 的 FALLBACK
//   常數無條件把 Worker URL 放進 bundle,grep 無法區分 baked vs 空。可靠性
//   來自控制輸入(這裡注入 + preflight),不是事後掃輸出。

import { execSync } from 'node:child_process'
import { loadEnv } from 'vite'

// 正式 Worker URL。canonical 來源三處必須一致:
//   1. workers/ocr/wrangler.jsonc  name=tripmate-ocr (workers_dev:true)
//   2. src/services/workerBase.ts  FALLBACK 常數
//   3. 本檔
const WORKER_URL = 'https://tripmate-ocr.tripmate.workers.dev'

// 防呆:有人把上面清空 / 改壞時直接中止,別 build 出壞 bundle。
if (!/^https:\/\/\S+$/.test(WORKER_URL)) {
  console.error(`[deploy:pages:prod] ABORT: WORKER_URL 不合法: ${JSON.stringify(WORKER_URL)}`)
  process.exit(1)
}

// Worker URL 直接注入(確定值,不靠 .env)。先設進 process.env,讓底下的
// loadEnv 與隨後的 build 都看得到。
process.env.VITE_WORKER_BASE_URL = WORKER_URL

// build 前 env preflight。清單需與 src/services/firebase.ts 的
// REQUIRED_FIREBASE_ENV 對齊(那邊缺值會在 PROD module-load throw),外加
// VITE_WORKER_BASE_URL。這些值由 gitignored .env 或 CI/部署環境的 env var
// 提供 —— 公開的 Firebase web config 刻意不進版控,所以這裡只「檢查存在」
// 而非硬寫死(與 Worker URL 不同;後者本就已是 source 內的常數)。
const REQUIRED_CLIENT_ENV = [
  'VITE_WORKER_BASE_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]

const resolved = loadEnv('production', process.cwd(), 'VITE_')
const missing = REQUIRED_CLIENT_ENV.filter((k) => !resolved[k]?.trim())
if (missing.length > 0) {
  console.error(
    `[deploy:pages:prod] ABORT: production build 缺少必備 client env:\n` +
      missing.map((k) => `    - ${k}`).join('\n') +
      `\n  這些值來自 gitignored .env 或部署環境的 env var。缺它們時 build 會\n` +
      `  「成功」卻 ship 出壞站(firebase.ts 一開站 throw / workerBase 寫入全掛)。\n` +
      `  在本機 .env 或部署環境設好後再跑。`,
  )
  process.exit(1)
}

const run = (cmd, extraEnv) =>
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...extraEnv } })

// 1. build —— 透過 process.env 注入。Vite 會把 VITE_ 前綴的 process.env
//    併入 import.meta.env 並 bake 進 bundle,不依賴本機 .env。
console.log(
  `[deploy:pages:prod] env preflight OK (${REQUIRED_CLIENT_ENV.length} keys); ` +
    `building with VITE_WORKER_BASE_URL=${WORKER_URL}`,
)
run('npm run build', { VITE_WORKER_BASE_URL: WORKER_URL })

// 2. deploy —— --commit-dirty=false 強制乾淨 worktree。
run(
  'npx wrangler pages deploy dist --project-name=tripmate --branch=main ' +
    '--commit-message="Pages deploy" --commit-dirty=false',
)
