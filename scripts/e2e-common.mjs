// Shared pieces of the local-stack e2e harnesses (scripts/e2e-*.mjs):
// child-process lifecycle, readiness polling, the emulator app env, the
// Firestore emulator REST reader and the DEV-account sign-in flow.
//
// The emulators run under `firebase emulators:exec`; each harness re-invokes
// itself inside it with E2E_INNER=1 (see runInsideEmulators).
import { spawn, spawnSync } from 'node:child_process'

export const PROJECT = 'demo-tripmate'
export const TRIP = 'dev-route-trip'
export const APP_PORT = 5199
export const APP = `http://127.0.0.1:${APP_PORT}`
export const WORKER = 'http://127.0.0.1:8787'
export const AUTH_EMULATOR = 'http://127.0.0.1:9099'
export const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`
export const DEV_PASSWORD = 'tripmate-dev-password'
export const isWin = process.platform === 'win32'

/** Build-time env for the app in emulator mode (dev-only flags). */
export const APP_ENV = {
  VITE_USE_FIREBASE_EMULATORS: 'true',
  VITE_FIREBASE_EMULATOR_HOST: '127.0.0.1',
  VITE_FIREBASE_PROJECT_ID: PROJECT,
  VITE_FIREBASE_API_KEY: 'demo',
  VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:emulator',
  VITE_DEV_EMULATOR_PASSWORD: DEV_PASSWORD,
  VITE_WORKER_BASE_URL: WORKER,
  VITE_SENTRY_DSN: '',
}

/** Outer run: re-run `script` inside `firebase emulators:exec`, exit with its status. */
export function runInsideEmulators(script, only) {
  const result = spawnSync(
    'npx',
    ['firebase', 'emulators:exec', '--only', only, `--project=${PROJECT}`, `"node ${script}"`],
    { stdio: 'inherit', shell: true, env: { ...process.env, E2E_INNER: '1' } },
  )
  process.exit(result.status ?? 1)
}

// ─── Child processes ──────────────────────────────────────────────

const children = []
export function start(name, command, args, opts = {}) {
  const child = spawn(command, args, { shell: true, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  child.stdout.on('data', d => { if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${d}`) })
  child.stderr.on('data', d => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${d}`) })
  children.push(child)
  return child
}
export function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}
export function exited(child) {
  return new Promise((resolve, reject) => child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${child.spawnargs.join(' ')} exited ${code}`)))))
}
/** Seeds the DEV accounts + the dev-route-trip into the running emulators. */
export async function seed() {
  await exited(start('seed', 'npm', ['run', 'emulator:seed'], { env: { ...process.env, VITE_FIREBASE_PROJECT_ID: PROJECT } }))
}
export async function waitFor(url, init = {}, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try { if ((await fetch(url, init)).status < 500) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

// ─── Emulator data (admin REST) ───────────────────────────────────

export const plain = v => v == null ? v
  : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'booleanValue' in v ? v.booleanValue
  : 'nullValue' in v ? null : 'timestampValue' in v ? v.timestampValue
  : 'doubleValue' in v ? v.doubleValue
  : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(plain)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, plain(x)])) : v

/** Lists `trips/{tripId}/{collection}` straight from the emulator, bypassing rules. */
export async function listDocs(collection, tripId = TRIP) {
  const res = await fetch(`${DOCS}/trips/${tripId}/${collection}?pageSize=500`, { headers: { Authorization: 'Bearer owner' } })
  return ((await res.json()).documents ?? []).map(d => ({
    id: d.name.split('/').at(-1),
    ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, plain(v)])),
  }))
}

// ─── Browser ──────────────────────────────────────────────────────

export const ROLE_LABEL = { owner: 'DEV owner', editor: 'DEV editor', viewer: 'DEV viewer' }

export async function launchChromium() {
  const { chromium } = await import('playwright')
  return chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})
}

/** A fresh, storage-isolated mobile-sized context. */
export function newMobileContext(browser) {
  // hasTouch: row buttons inside SwipeableShell must be driven with tap(). The
  // row captures the pointer on pointerdown, and Chromium then retargets a MOUSE
  // click to the capturing element, so a mouse click never reaches the button
  // (touch taps do). The app is touch-first; drive it the way users do.
  return browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei', hasTouch: true })
}

/** Records page errors and console errors into `problems`, tagged with `tag`. */
export function collectProblems(page, tag, problems) {
  page.on('pageerror', e => problems.push(`[${tag}] page error: ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') problems.push(`[${tag}] console: ${m.text().slice(0, 300)}`)
  })
}

/** Demo → SignInPromptModal → emulator role button. Waits for the demo banner to go. */
export async function signInAs(page, role) {
  await page.getByRole('button', { name: '登入' }).first().click()
  await page.getByRole('button', { name: new RegExp(ROLE_LABEL[role]) }).click()
  await page.getByText('預覽模式').waitFor({ state: 'detached' })
}
