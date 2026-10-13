// End-to-end settlement walkthrough on a fully local stack:
//   Firebase Auth + Firestore emulators → the real Worker in emulator mode
//   (workers/ocr/src/emulator.ts) → the real app (Vite dev, emulator mode),
//   driven by Playwright as three DEV accounts (owner / editor / viewer).
//
//   npm run e2e:settlement
//
// Needs Java 21 (Firestore emulator) and Playwright's Chromium
// (`npx playwright install chromium` once). The foreign-currency step asks
// the Worker for a real rate (Frankfurter), so it needs internet.
// Screenshots: e2e-results/settlement/. Ports: 8080, 9099, 8787, 5199.
//
// The outer run wraps everything in `firebase emulators:exec`; the inner run
// (E2E_INNER=1) starts the Worker and Vite, seeds, walks the scenarios with
// assertions against both the screen and the emulator's data, and stops
// what it started.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = process.cwd()
const PROJECT = 'demo-tripmate'
const APP = 'http://127.0.0.1:5199'
const WORKER = 'http://127.0.0.1:8787'
const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`
const TRIP = 'dev-route-trip'
const OUT = join(ROOT, 'e2e-results', 'settlement')
const isWin = process.platform === 'win32'

if (!process.env.E2E_INNER) {
  const result = spawnSync(
    'npx',
    ['firebase', 'emulators:exec', '--only', 'auth,firestore', `--project=${PROJECT}`, '"node scripts/e2e-settlement.mjs"'],
    { stdio: 'inherit', shell: true, env: { ...process.env, E2E_INNER: '1' } },
  )
  process.exit(result.status ?? 1)
}

// ─── Inner run: services ──────────────────────────────────────────

const APP_ENV = {
  VITE_USE_FIREBASE_EMULATORS: 'true',
  VITE_FIREBASE_EMULATOR_HOST: '127.0.0.1',
  VITE_FIREBASE_PROJECT_ID: PROJECT,
  VITE_FIREBASE_API_KEY: 'demo',
  VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:emulator',
  VITE_DEV_EMULATOR_PASSWORD: 'tripmate-dev-password',
  VITE_WORKER_BASE_URL: WORKER,
  VITE_SENTRY_DSN: '',
}

const children = []
function start(name, command, args, opts = {}) {
  const child = spawn(command, args, { shell: true, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  child.stdout.on('data', d => { if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${d}`) })
  child.stderr.on('data', d => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${d}`) })
  children.push(child)
  return child
}
function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}
async function waitFor(url, init = {}, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try { if ((await fetch(url, init)).status < 500) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

// ─── Emulator data (admin) ────────────────────────────────────────

const plain = v => v == null ? v
  : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'booleanValue' in v ? v.booleanValue
  : 'nullValue' in v ? null : 'timestampValue' in v ? v.timestampValue
  : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(plain)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, plain(x)])) : v
async function list(collection) {
  const res = await fetch(`${DOCS}/trips/${TRIP}/${collection}?pageSize=500`, { headers: { Authorization: 'Bearer owner' } })
  return ((await res.json()).documents ?? []).map(d => ({
    id: d.name.split('/').at(-1),
    ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, plain(v)])),
  }))
}
const activeSettlements = async () => (await list('settlements')).filter(s => s.deletedAt === null)
const locksOf = async title => (await list('expenses')).find(e => e.title === title)?.settlementLockIds ?? []

// ─── Browser helpers ──────────────────────────────────────────────

const ROLE_LABEL = { owner: 'DEV owner', editor: 'DEV editor', viewer: 'DEV viewer' }
const problems = []
const pages = []
let browser

async function as(role) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' })
  const page = await context.newPage()
  page.on('pageerror', e => problems.push(`[${role}] page error: ${e.message}`))
  page.on('console', m => {
    // The shared emulator seed writes schedules in an older shape; that is
    // the schedule page's concern, not this walkthrough's.
    if (m.type() === 'error' && !/scheduleFromDoc/.test(m.text())) problems.push(`[${role}] console: ${m.text().slice(0, 300)}`)
  })
  await page.goto(`${APP}/expense`)
  await page.getByRole('button', { name: '登入' }).first().click()
  await page.getByRole('button', { name: new RegExp(ROLE_LABEL[role]) }).click()
  await page.getByRole('button', { name: '費用', exact: true }).click()
  pages.push({ role, page })
  // Signed in once the demo banner is gone (a viewer has no 新增費用 button).
  await page.getByText('預覽模式').waitFor({ state: 'detached' })
  await page.getByText('費用紀錄').first().waitFor()
  await page.waitForTimeout(1500)
  return { page, close: () => context.close() }
}

async function shot(page, name, anchor = '精算') {
  await page.getByText(anchor).first().scrollIntoViewIfNeeded().catch(() => {})
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

const settle = page => page.waitForTimeout(3000)

async function addExpense(page, { title, amount, paidBy, splitAmong }) {
  await page.getByRole('button', { name: /新增費用/ }).first().click()
  const dialog = page.locator('[role="dialog"]')
  await dialog.getByPlaceholder('例：壽司大 築地').fill(title)
  await dialog.getByPlaceholder('0').fill(String(amount))
  await dialog.getByRole('button', { name: `代墊者：${ROLE_LABEL[paidBy]}` }).click()
  for (const role of ['editor', 'owner', 'viewer']) {
    const name = ROLE_LABEL[role]
    const box = dialog.locator(`xpath=.//*[normalize-space(text())='${name}']/ancestor::*[.//input[@type='checkbox']][1]//input[@type='checkbox']`)
    if (await box.count() === 0) continue
    if ((await box.isChecked()) !== splitAmong.includes(role)) await box.click()
  }
  await dialog.locator('button', { hasText: '新增費用' }).last().click()
  await settle(page)
}

const suggestionText = async page => (await page.getByText(/付款建議/).first().locator('..').innerText()).replace(/\s+/g, ' ')
const recordButtons = page => page.getByRole('button', { name: /記錄已收到/ })
const sheet = page => page.locator('[role="dialog"]').last()

function step(name) { console.log(`\n▶ ${name}`) }
function ok(what) { console.log(`  ✓ ${what}`) }

// ─── Scenarios ────────────────────────────────────────────────────

async function run() {
  mkdirSync(OUT, { recursive: true })
  const { chromium } = await import('playwright')
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {})

  step('A → C via B: suggestion as seen by payer, intermediate and receiver')
  const owner = await as('owner')
  await addExpense(owner.page, { title: '晚餐', amount: 3000, paidBy: 'editor', splitAmong: ['owner'] })
  await addExpense(owner.page, { title: '計程車', amount: 3000, paidBy: 'viewer', splitAmong: ['editor'] })
  await owner.page.reload()
  await owner.page.getByRole('button', { name: '費用', exact: true }).click()
  await owner.page.getByText('付款建議').first().waitFor()
  assert.match(await suggestionText(owner.page), /¥3,000 經 DEV editor/)
  assert.equal(await recordButtons(owner.page).count(), 0)
  await shot(owner.page, '01-payer')
  ok('payer: one payment of ¥3,000 via DEV editor, waiting for the receiver')

  const editor = await as('editor')
  assert.match(await suggestionText(editor.page), /你不用付款：這筆會同時清掉 DEV owner 欠你的與你欠 DEV viewer 的各 ¥3,000，你的淨額不變/)
  assert.equal(await recordButtons(editor.page).count(), 0)
  await shot(editor.page, '02-intermediate')
  ok('intermediate: told they pay nothing and their net does not move')

  const viewer = await as('viewer')
  await viewer.page.getByRole('button', { name: /明細（2 段）/ }).first().click()
  assert.match(await suggestionText(viewer.page), /來源：計程車 ¥3,000.*來源：晚餐 ¥3,000/)
  await shot(viewer.page, '03-receiver-preview')
  ok('receiver: legs previewed with their source expenses')

  step('Receiver records it')
  await recordButtons(viewer.page).first().click()
  assert.match((await sheet(viewer.page).innerText()).replace(/\s+/g, ' '), /經 DEV editor 轉交，將清掉以下欠款/)
  await shot(viewer.page, '04-record-sheet', '記錄清算')
  await sheet(viewer.page).getByPlaceholder(/燒肉/).fill('晚餐和車資')
  await sheet(viewer.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(viewer.page)
  let active = await activeSettlements()
  assert.equal(active.length, 1, 'one doc for the whole route')
  assert.equal(active[0].legs.length, 2)
  assert.equal(active[0].note, '晚餐和車資')
  // Each expense locked by exactly its own leg (entries are ordered by expense id).
  assert.deepEqual(active[0].lockedExpenses.map(l => l.legIndexes.length), [1, 1])
  assert.deepEqual(active[0].lockedExpenses.flatMap(l => l.legIndexes).sort(), [0, 1])
  assert.deepEqual(await locksOf('晚餐'), [active[0].id])
  await viewer.page.getByText('所有成員的帳務已平衡').waitFor()
  await viewer.page.getByRole('button', { name: /明細（2 段）/ }).last().click()
  await shot(viewer.page, '05-recorded', '已清算紀錄')
  ok('one settlement doc, two legs, per-leg locks; everyone is square')

  step('A locked expense is read-only for a non-owner')
  await editor.page.getByText('晚餐', { exact: true }).first().click()
  await editor.page.getByText('費用詳情').waitFor()
  await editor.page.screenshot({ path: join(OUT, '06-locked-expense.png') })
  await editor.page.keyboard.press('Escape')
  ok('the intermediate sees 費用詳情 (read-only), not the edit form')

  step('Cancel restores the debt and releases the locks')
  await viewer.page.getByRole('button', { name: '刪除清算紀錄' }).click()
  await viewer.page.getByRole('button', { name: /確認刪除整筆清算紀錄/ }).click()
  await settle(viewer.page)
  assert.equal((await activeSettlements()).length, 0)
  assert.deepEqual(await locksOf('晚餐'), [])
  assert.match(await suggestionText(viewer.page), /¥3,000 經 DEV editor/)
  ok('cancelled as a whole; suggestion back')

  step('記錄收款: a partial payment routes the same way')
  await viewer.page.getByRole('button', { name: /記錄收款/ }).click()
  await sheet(viewer.page).locator('button', { hasText: 'DEV owner' }).click()
  await sheet(viewer.page).locator('input[aria-label="清算金額"]').fill('1000')
  await shot(viewer.page, '07-record-payment', '記錄收款')
  await sheet(viewer.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(viewer.page)
  active = await activeSettlements()
  assert.deepEqual(active.map(s => s.legs.map(l => l.amountMinor)), [[1000, 1000]])
  assert.match(await suggestionText(viewer.page), /¥2,000 經 DEV editor/)
  ok('¥1,000 recorded via DEV editor; ¥2,000 still suggested')
  await recordButtons(viewer.page).first().click()
  await sheet(viewer.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(viewer.page)

  step('A debt cycle is cleared as one offset')
  await addExpense(owner.page, { title: '咖啡', amount: 500, paidBy: 'owner', splitAmong: ['editor'] })
  await addExpense(owner.page, { title: '甜點', amount: 500, paidBy: 'editor', splitAmong: ['viewer'] })
  await addExpense(owner.page, { title: '飲料', amount: 500, paidBy: 'viewer', splitAmong: ['owner'] })
  await editor.page.reload()
  await editor.page.getByRole('button', { name: '費用', exact: true }).click()
  await editor.page.getByText('付款建議').first().waitFor()
  assert.match(await suggestionText(editor.page), /互相抵銷 · 不需付款/)
  await shot(editor.page, '08-offset')
  await editor.page.getByRole('button', { name: /記錄 .*互相抵銷/ }).click()
  await sheet(editor.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(editor.page)
  const offset = (await activeSettlements()).find(s => s.kind === 'OFFSET')
  assert.equal(offset?.legs.length, 3)
  assert.equal(offset?.settledBy, 'dev-editor')
  ok('one OFFSET doc with three legs, recorded by a participant')

  step('Foreign currency: the receiver got US dollars')
  await addExpense(owner.page, { title: '門票', amount: 15000, paidBy: 'viewer', splitAmong: ['owner'] })
  await viewer.page.reload()
  await viewer.page.getByRole('button', { name: '費用', exact: true }).click()
  await recordButtons(viewer.page).first().click()
  await sheet(viewer.page).locator('button', { hasText: '日圓 (JPY)' }).click()
  await viewer.page.locator('button, [role="option"]', { hasText: '美元 (USD)' }).last().click()
  await sheet(viewer.page).getByText(/匯率 [\d.]+/).waitFor({ timeout: 20_000 })
  await shot(viewer.page, '09-foreign-sheet', '記錄清算')
  await sheet(viewer.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(viewer.page)
  const foreign = (await activeSettlements()).find(s => s.sourceCurrency === 'USD')
  assert.ok(foreign, 'foreign settlement stored')
  assert.equal(foreign.amountMinor, 15000)
  assert.deepEqual(foreign.legs, [{ fromUid: 'dev-owner', toUid: 'dev-viewer', amountMinor: 15000 }])
  assert.ok(foreign.sourceAmountMinor > 0 && foreign.fxSnapshot?.rateDecimal)
  ok(`¥15,000 cleared, received as $${(foreign.sourceAmountMinor / 100).toFixed(2)} at ${foreign.fxSnapshot.rateDecimal}`)

  step('A departed receiver: only the owner may record — even as the payer')
  await addExpense(owner.page, { title: '早餐', amount: 2000, paidBy: 'viewer', splitAmong: ['owner'] })
  const auth = await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dev-owner@localhost.test', password: APP_ENV.VITE_DEV_EMULATOR_PASSWORD, returnSecureToken: true }),
  })).json()
  const removed = await fetch(`${WORKER}/member-remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.idToken}`, Origin: APP },
    body: JSON.stringify({ tripId: TRIP, memberUid: 'dev-viewer' }),
  })
  assert.equal(removed.status, 200, await removed.text())
  await editor.page.reload()
  await editor.page.getByRole('button', { name: '費用', exact: true }).click()
  await editor.page.getByText('付款建議').first().waitFor()
  assert.equal(await recordButtons(editor.page).count(), 0)
  await owner.page.reload()
  await owner.page.getByRole('button', { name: '費用', exact: true }).click()
  await owner.page.getByRole('button', { name: /代 .*（已退出）記錄已收到/ }).click()
  await sheet(owner.page).locator('button', { hasText: '儲存紀錄' }).click()
  await settle(owner.page)
  const byOwner = (await activeSettlements()).find(s => s.ownerRecorded)
  assert.equal(byOwner?.settledBy, 'dev-owner')
  assert.equal(byOwner?.receiverUid, 'dev-viewer')
  await owner.page.getByText('所有成員的帳務已平衡').waitFor()
  await owner.page.getByText('由旅程擁有者代為記錄').first().waitFor()
  await shot(owner.page, '10-departed', '已清算紀錄')
  ok('the owner recorded it on the departed receiver\'s behalf; everyone is square')

  for (const s of [owner, editor, viewer]) await s.close()
  assert.deepEqual(problems, [], 'no page errors or console errors')
  console.log(`\nAll settlement scenarios passed. Screenshots: ${OUT}`)
}

let failed = false
try {
  start('seed', 'npm', ['run', 'emulator:seed'], { env: { ...process.env, VITE_FIREBASE_PROJECT_ID: PROJECT } })
  await new Promise((resolve, reject) => children.at(-1).on('exit', code => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`)))))
  start('worker', 'npm', ['run', 'dev:emulator'], { cwd: join(ROOT, 'workers/ocr') })
  start('vite', 'npx', ['vite', '--host', '127.0.0.1', '--port', '5199', '--strictPort', '--mode', 'emulator'], { env: { ...process.env, ...APP_ENV } })
  await waitFor(`${WORKER}/settlement-route-create`, { method: 'OPTIONS', headers: { Origin: APP } })
  await waitFor(APP)
  await run()
} catch (e) {
  failed = true
  console.error('\n✗', e?.message ?? e)
  for (const { role, page } of pages) {
    await page.screenshot({ path: join(OUT, `failure-${role}.png`), fullPage: true }).catch(() => {})
  }
  if (problems.length) console.error(problems.join('\n'))
} finally {
  await browser?.close().catch(() => {})
  stopAll()
}
process.exit(failed ? 1 : 0)
