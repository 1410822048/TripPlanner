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
import fs from 'node:fs'
import { loadEnv } from 'vite'

const abort = (message) => {
  console.error(message)
  process.exit(1)
}

const rawArgs = process.argv.slice(2)
const ALLOWED_FLAGS = new Set(['--preflight-only', '--build-only', '--deploy-only'])
const unknownArgs = rawArgs.filter((arg) => !ALLOWED_FLAGS.has(arg))
if (unknownArgs.length > 0) {
  abort(
    `[deploy:pages:prod] ABORT: unknown argument(s): ${unknownArgs.join(', ')}\n` +
      'Supported flags: --preflight-only / --build-only / --deploy-only.',
  )
}

const preflightOnly = process.argv.includes('--preflight-only')
const buildOnly = process.argv.includes('--build-only')
const deployOnly = process.argv.includes('--deploy-only')
const modeCount = [preflightOnly, buildOnly, deployOnly].filter(Boolean).length
if (modeCount > 1) {
  abort('[deploy:pages:prod] ABORT: use only one of --preflight-only / --build-only / --deploy-only.')
}

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

// loadEnv = build 實際會看到的 merged env(.env* + process.env,後者優先)。
// authDomain を決める前に読むことで、.env.production / CI が設定した
// VITE_FIREBASE_AUTH_DOMAIN を尊重する。
const resolved = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }

// Firebase Auth redirect helper is proxied by /functions/__/auth/[[path]].ts.
// Production must bake the Pages/custom domain into authDomain so the helper
// iframe is same-origin instead of tripplanner-80a4f.firebaseapp.com.
// 優先序:明示 override(TRIPMATE_PAGES_AUTH_DOMAIN)→ 設定済みの
// VITE_FIREBASE_AUTH_DOMAIN(.env.production / CI)→ 既定の Pages host。
// 以前は既定で無条件に上書きしていたため、custom domain への切替で authDomain
// が壊れていた(P2 修正)。
const PAGES_AUTH_DOMAIN =
  process.env.TRIPMATE_PAGES_AUTH_DOMAIN?.trim()
  || resolved.VITE_FIREBASE_AUTH_DOMAIN?.trim()
  || 'tripmate-2wg.pages.dev'
// host-only でなければ中止。scheme(https://)/ path / port を含むと、same-origin
// auth helper iframe や OAuth redirect URI が不一致になり OAuth が壊れる。
if (!/^[a-z0-9.-]+$/i.test(PAGES_AUTH_DOMAIN)) {
  console.error(
    `[deploy:pages:prod] ABORT: VITE_FIREBASE_AUTH_DOMAIN は host-only である必要が` +
      `あります(https:// や /path / :port を含めない): ${JSON.stringify(PAGES_AUTH_DOMAIN)}`,
  )
  process.exit(1)
}
process.env.VITE_FIREBASE_AUTH_DOMAIN = PAGES_AUTH_DOMAIN
resolved.VITE_FIREBASE_AUTH_DOMAIN = PAGES_AUTH_DOMAIN

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
  'VITE_FIREBASE_VAPID_KEY',
  'VITE_FIREBASE_APP_ID',
]

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

const PRODUCTION_BRANCH = 'main'

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim()

const assertProductionGitRef = () => {
  const currentBranch = git('branch --show-current')
  if (currentBranch !== PRODUCTION_BRANCH) {
    abort(
      `[deploy:pages:prod] ABORT: production Pages deploy must run from ` +
        `\`${PRODUCTION_BRANCH}\`, current branch is \`${currentBranch || '(detached)'}\`.`,
    )
  }

  try {
    execSync(`git fetch --quiet origin ${PRODUCTION_BRANCH}`, { stdio: 'ignore' })
  } catch {
    abort(`[deploy:pages:prod] ABORT: cannot fetch origin/${PRODUCTION_BRANCH}.`)
  }

  const head = git('rev-parse HEAD')
  const originHead = git(`rev-parse origin/${PRODUCTION_BRANCH}`)
  if (head !== originHead) {
    abort(
      `[deploy:pages:prod] ABORT: local HEAD must equal origin/${PRODUCTION_BRANCH} before production deploy.\n` +
        `    HEAD: ${head}\n` +
        `    origin/${PRODUCTION_BRANCH}: ${originHead}`,
    )
  }
}

const assertCleanWorktree = () => {
  const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
  if (status.length === 0) {
    return
  }

  abort(
    `[deploy:pages:prod] ABORT: worktree must be clean before Pages deploy.\n` +
      status
        .split('\n')
        .slice(0, 20)
        .map((line) => `    ${line}`)
        .join('\n'),
  )
}

const assertWranglerPagesAccess = () => {
  try {
    execSync(
      'npx wrangler pages deployment list --project-name=tripmate --environment=production --json',
      { stdio: 'pipe', env: process.env },
    )
  } catch {
    console.error(
      '[deploy:pages:prod] ABORT: cannot access Cloudflare Pages project `tripmate`. ' +
        'Run `npx wrangler login` or check Pages project permissions.',
    )
    process.exit(1)
  }
}

assertProductionGitRef()
assertCleanWorktree()
assertWranglerPagesAccess()

if (preflightOnly) {
  console.log(
    `[deploy:pages:prod] preflight OK (${REQUIRED_CLIENT_ENV.length} env keys, clean worktree, Pages access).`,
  )
  process.exit(0)
}

if (!deployOnly) {
  // 1. build —— 透過 process.env 注入。Vite 會把 VITE_ 前綴的 process.env
  //    併入 import.meta.env 並 bake 進 bundle,不依賴本機 .env。
  console.log(
    `[deploy:pages:prod] env preflight OK (${REQUIRED_CLIENT_ENV.length} keys); ` +
      `building with VITE_WORKER_BASE_URL=${WORKER_URL}, ` +
      `VITE_FIREBASE_AUTH_DOMAIN=${PAGES_AUTH_DOMAIN}`,
  )
  run('npm run build', {
    VITE_WORKER_BASE_URL: WORKER_URL,
    VITE_FIREBASE_AUTH_DOMAIN: PAGES_AUTH_DOMAIN,
  })

  if (buildOnly) {
    console.log('[deploy:pages:prod] build-only OK; dist is ready for deploy.')
    process.exit(0)
  }
}

// 2. deploy —— --commit-dirty=false 強制乾淨 worktree。deploy-only 用於
//    deploy:prod:production build 已在任何遠端變更前完成,這裡只上傳同一份 dist。
if (!fs.existsSync('dist/index.html')) {
  abort('[deploy:pages:prod] ABORT: dist/index.html not found; run without --deploy-only first.')
}

run(
  'npx wrangler pages deploy dist --project-name=tripmate --branch=main ' +
    '--commit-message="Pages deploy" --commit-dirty=false',
)
