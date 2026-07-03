// scripts/deploy-pages-preview.mjs
//
// Deploy a Cloudflare Pages preview from a non-main branch. Production deploys
// stay in deploy-pages-prod.mjs, which requires main == origin/main and a clean
// worktree.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { loadEnv } from 'vite'

const PROJECT_NAME = 'tripmate'
const PAGES_DEV_DOMAIN = 'tripmate-2wg.pages.dev'
const PRODUCTION_BRANCH = 'main'
const WORKER_URL = 'https://tripmate-ocr.tripmate.workers.dev'
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

const abort = (message) => {
  console.error(message)
  process.exit(1)
}

const rawArgs = process.argv.slice(2)
const ALLOWED_FLAGS = new Set(['--help', '--preflight-only', '--build-only', '--deploy-only'])
const branchArgs = rawArgs.filter((arg) => arg.startsWith('--branch='))
const unknownArgs = rawArgs.filter(
  (arg) => !ALLOWED_FLAGS.has(arg) && !arg.startsWith('--branch='),
)
if (unknownArgs.length > 0) {
  abort(
    `[deploy:pages:preview] ABORT: unknown argument(s): ${unknownArgs.join(', ')}\n` +
      'Supported flags: --preflight-only / --build-only / --deploy-only / --branch=<branch>.',
  )
}
if (branchArgs.length > 1) {
  abort('[deploy:pages:preview] ABORT: pass --branch=<branch> at most once.')
}

if (rawArgs.includes('--help')) {
  console.log(`
Usage:
  npm run deploy:pages:preview
  npm run deploy:pages:preview -- --preflight-only
  npm run deploy:pages:preview -- --build-only
  npm run deploy:pages:preview -- --deploy-only
  npm run deploy:pages:preview -- --branch=feat/example

Options:
  --preflight-only    Validate env, branch, and Cloudflare Pages access only.
  --build-only        Build the preview bundle without uploading it.
  --deploy-only       Upload the existing dist/ without rebuilding.
  --branch=<branch>   Override the Cloudflare Pages preview branch label.

Set TRIPMATE_PAGES_AUTH_DOMAIN to override the derived preview auth domain.
`)
  process.exit(0)
}

const preflightOnly = rawArgs.includes('--preflight-only')
const buildOnly = rawArgs.includes('--build-only')
const deployOnly = rawArgs.includes('--deploy-only')
const modeCount = [preflightOnly, buildOnly, deployOnly].filter(Boolean).length
if (modeCount > 1) {
  abort('[deploy:pages:preview] ABORT: use only one of --preflight-only / --build-only / --deploy-only.')
}

process.env.VITE_WORKER_BASE_URL = WORKER_URL

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim()
const currentBranch = git('branch --show-current')
const explicitBranch = branchArgs[0]?.slice('--branch='.length).trim()
const deploymentBranch = explicitBranch || currentBranch

if (branchArgs.length === 1 && !explicitBranch) {
  abort('[deploy:pages:preview] ABORT: --branch requires a non-empty value.')
}
if (!deploymentBranch) {
  abort('[deploy:pages:preview] ABORT: cannot infer preview branch; pass --branch=<branch>.')
}
if (currentBranch === PRODUCTION_BRANCH || deploymentBranch === PRODUCTION_BRANCH) {
  abort(
    `[deploy:pages:preview] ABORT: preview deploy cannot target \`${PRODUCTION_BRANCH}\`; ` +
      'use `npm run deploy:pages` for production.',
  )
}
if (!/^[A-Za-z0-9._/-]+$/.test(deploymentBranch) || deploymentBranch.length > 100) {
  abort(`[deploy:pages:preview] ABORT: invalid preview branch: ${JSON.stringify(deploymentBranch)}.`)
}

const previewBranchAlias = deploymentBranch.toLowerCase().replace(/[^a-z0-9]/g, '-')
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(previewBranchAlias)) {
  abort(
    `[deploy:pages:preview] ABORT: derived preview branch alias is not a valid DNS label: ` +
      `${JSON.stringify(previewBranchAlias)}. Set TRIPMATE_PAGES_AUTH_DOMAIN explicitly.`,
  )
}

const resolved = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }
const PAGES_AUTH_DOMAIN =
  process.env.TRIPMATE_PAGES_AUTH_DOMAIN?.trim()
  || `${previewBranchAlias}.${PAGES_DEV_DOMAIN}`
if (!/^[a-z0-9.-]+$/i.test(PAGES_AUTH_DOMAIN)) {
  abort(
    `[deploy:pages:preview] ABORT: VITE_FIREBASE_AUTH_DOMAIN must be host-only, got ` +
      `${JSON.stringify(PAGES_AUTH_DOMAIN)}.`,
  )
}
process.env.VITE_FIREBASE_AUTH_DOMAIN = PAGES_AUTH_DOMAIN
resolved.VITE_FIREBASE_AUTH_DOMAIN = PAGES_AUTH_DOMAIN

const missing = REQUIRED_CLIENT_ENV.filter((key) => !resolved[key]?.trim())
if (missing.length > 0) {
  abort(
    `[deploy:pages:preview] ABORT: preview build is missing client env:\n` +
      missing.map((key) => `    - ${key}`).join('\n'),
  )
}

const worktreeStatus = git('status --porcelain')
if (worktreeStatus.length > 0) {
  console.warn('[deploy:pages:preview] WARN: worktree is dirty; preview deploy will include local files.')
}

const assertWranglerPagesAccess = () => {
  try {
    execSync(`npx wrangler pages deployment list --project-name=${PROJECT_NAME} --json`, {
      stdio: 'pipe',
      env: process.env,
    })
  } catch {
    abort(
      `[deploy:pages:preview] ABORT: cannot access Cloudflare Pages project \`${PROJECT_NAME}\`. ` +
        'Run `npx wrangler login` or check Pages project permissions.',
    )
  }
}

const run = (cmd, extraEnv) =>
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...extraEnv } })

assertWranglerPagesAccess()

if (preflightOnly) {
  console.log(
    `[deploy:pages:preview] preflight OK (${REQUIRED_CLIENT_ENV.length} env keys, ` +
      `branch=${deploymentBranch}, authDomain=${PAGES_AUTH_DOMAIN}).`,
  )
  process.exit(0)
}

if (!deployOnly) {
  console.log(
    `[deploy:pages:preview] building preview branch=${deploymentBranch} with ` +
      `VITE_WORKER_BASE_URL=${WORKER_URL}, VITE_FIREBASE_AUTH_DOMAIN=${PAGES_AUTH_DOMAIN}`,
  )
  run('npm run build', {
    VITE_WORKER_BASE_URL: WORKER_URL,
    VITE_FIREBASE_AUTH_DOMAIN: PAGES_AUTH_DOMAIN,
  })

  if (buildOnly) {
    console.log('[deploy:pages:preview] build-only OK; dist is ready for preview deploy.')
    process.exit(0)
  }
}

if (!fs.existsSync('dist/index.html')) {
  abort('[deploy:pages:preview] ABORT: dist/index.html not found; run without --deploy-only first.')
}

run(
  `npx wrangler pages deploy dist --project-name=${PROJECT_NAME} --branch=${deploymentBranch} ` +
    `--commit-message="Pages preview deploy: ${deploymentBranch}" --commit-dirty=true`,
)
