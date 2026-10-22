// Offline-write acceptance on a fully local stack:
//   Firebase Auth + Firestore emulators → a BUILT app (dev-mode build with the
//   emulator env baked in, served by `vite preview` so the real service
//   worker precaches the app shell), driven by Playwright as the DEV owner.
//
//   npm run e2e:offline
//
// Also hosts the notification-click case (same harness: real SW, signed-in
// owner): the SW's NOTIFICATION_OPEN message and the cold-start ?notify=<nonce>
// hand-off are exercised against the built app — see notificationOpenCase.
//
// Proves that a client Firestore SDK write (schedule / planning / text-only wish / planning toggle)
// made while OFFLINE is handed to the SDK's IndexedDB queue, survives a page
// reload while still offline, and reaches Firestore after reconnecting.
// Two cases, each in a fresh, storage-isolated browser context:
//   1. offline write → reconnect (no reload)       — isolates "sync works"
//   2. offline write → reload offline → reconnect  — the real acceptance
// If 1 passes and 2 fails, the queue is lost on reload (persistence); if
// both fail at the emulator step, the write never reached the SDK queue
// (e.g. TanStack `networkMode: 'online'` paused mutationFn while offline).
//
// Why a build and not the Vite dev server: the dev server has no SW
// precache, so an offline reload would get the browser's offline error page.
// The build is a DEVELOPMENT build (NODE_ENV=development) so the dev-only
// emulator flags stay live; VITE_FIREBASE_EMULATORS_PERSIST=true switches
// the emulator-mode memory cache to the production persistentLocalCache.
//
// Needs Java 21 (Firestore emulator) and Playwright's Chromium
// (`npx playwright install chromium` once). No Worker / Functions needed.
// Screenshots: e2e-results/offline/. Build output: e2e-results/offline-dist/.
// Ports: 8080, 9099, 5199 (same as e2e:settlement; never run both at once).
// Env: E2E_SKIP_BUILD=1 reuses the last build; E2E_NEGATIVE_CONTROL=1 builds
// without `networkMode: 'always'` and passes only if the reload case FAILS;
// E2E_VERBOSE=1 streams seed / preview output.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  APP, APP_ENV, APP_PORT, TRIP,
  collectProblems, launchChromium, listDocs, newMobileContext, runInsideEmulators,
  seed, signInAs, start, stopAll, waitFor,
} from './e2e-common.mjs'

const ROOT = process.cwd()
const OUT = join(ROOT, 'e2e-results', 'offline')
const OWNER = 'dev-owner'
const SYNC_TIMEOUT_MS = 30_000
const OFFLINE_HAND_OFF_MESSAGE = '目前離線，已先儲存在此裝置，恢復連線後會自動同步'
// E2E_NEGATIVE_CONTROL=1 proves the test can tell the difference: the build
// strips `networkMode: 'always'` from the schedule / planning / wish hooks (back to
// TanStack's default 'online', which pauses mutationFn offline and keeps the
// write in memory only). The reload case is then EXPECTED to fail.
const NEGATIVE_CONTROL = !!process.env.E2E_NEGATIVE_CONTROL
const DIST = join('e2e-results', NEGATIVE_CONTROL ? 'offline-dist-control' : 'offline-dist')

/** Build-time only (negative control): drop `networkMode: 'always'` from the
 *  modal-wait mutation hooks. Fails the build if nothing matched, so the
 *  control can never silently test the unmodified app. */
function stripNetworkModeAlways() {
  const target = /[\\/]src[\\/]features[\\/](?:schedule|planning|wish)[\\/]hooks[\\/][^\\/]+(?<!\.test)\.ts$/
  // Per build: vite-plugin-pwa runs a second build for src/sw.ts with the
  // same plugins, which never sees these hooks.
  let seen = 0
  let stripped = 0
  return {
    name: 'e2e-strip-network-mode-always',
    enforce: 'pre',
    buildStart() { seen = 0; stripped = 0 },
    transform(code, id) {
      if (!target.test(id.split('?')[0])) return null
      seen++
      // Either quote style: the React Compiler babel pass may run first and
      // reprint the module.
      const out = code.replace(/networkMode:\s*(['"])always\1,?/g, () => { stripped++; return '' })
      return out === code ? null : { code: out, map: null }
    },
    buildEnd() {
      if (seen === 0) return
      if (stripped === 0) this.error("negative control: no `networkMode: 'always'` found in schedule / planning / wish hooks")
      console.log(`[negative control] stripped networkMode: 'always' from ${stripped} mutation(s) in ${seen} hook file(s)`)
    },
  }
}

if (!process.env.E2E_INNER) {
  if (!process.env.E2E_SKIP_BUILD) {
    console.log(`Building the app (development build, emulator env, IndexedDB persistence${NEGATIVE_CONTROL ? ', NEGATIVE CONTROL' : ''}) …`)
    // NODE_ENV=development keeps import.meta.env.DEV true in the build, so the
    // dev-only emulator wiring and DEV role login stay live. Must be set
    // before Vite loads.
    Object.assign(process.env, APP_ENV, { VITE_FIREBASE_EMULATORS_PERSIST: 'true', NODE_ENV: 'development' })
    const { build } = await import('vite')
    try {
      await build({
        configFile: join(ROOT, 'vite.config.ts'),
        mode: 'emulator',
        logLevel: 'warn',
        build: { outDir: DIST, emptyOutDir: true },
        plugins: NEGATIVE_CONTROL ? [stripNetworkModeAlways()] : [],
      })
    } catch (e) {
      console.error(e?.message ?? e)
      process.exit(1)
    }
  }
  runInsideEmulators('scripts/e2e-offline.mjs', 'auth,firestore')
}

// ─── Helpers ──────────────────────────────────────────────────────

const problems = []
let browser

function step(name) { console.log(`\n▶ ${name}`) }
function ok(what) { console.log(`  ✓ ${what}`) }

/** A failure whose message names the stage it happened in. */
class StageError extends Error {
  constructor(stage, detail) {
    super(`[${stage}] ${detail}`)
    this.stage = stage
  }
}
async function stage(name, fn) {
  try { return await fn() } catch (e) {
    if (e instanceof StageError) throw e
    throw new StageError(name, e?.message ?? String(e))
  }
}

/** Deletes every IndexedDB database, Cache Storage entry and SW registration
 *  for the app origin; returns the database names found before and after.
 *  It runs on /favicon.svg, never on an app route: the SW's navigation route
 *  would answer any app URL with index.html, the app would open Firestore,
 *  and a delete blocked by that open connection never settles. favicon.svg
 *  is precached, so the precache route (registered first) serves the SVG. */
async function wipeOriginStorage(page) {
  await page.goto(`${APP}/favicon.svg`)
  return page.evaluate(async () => {
    const names = async () => (await indexedDB.databases()).map(d => d.name).filter(Boolean)
    const before = await names()
    await Promise.all(before.map(name => new Promise(done => {
      const r = indexedDB.deleteDatabase(name)
      r.onsuccess = r.onerror = r.onblocked = () => done()
    })))
    for (const key of await caches.keys()) await caches.delete(key)
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister()
    localStorage.clear()
    sessionStorage.clear()
    return { before, after: await names() }
  })
}

/** First load registers + activates the SW (precache installed); the reload
 *  makes it control the page so the runtime-cached chunks (vendor-firebase-*
 *  are excluded from precache on purpose) land in Cache Storage too. */
async function ensureServiceWorkerControls(page) {
  const active = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return reg.active?.state ?? null
  })
  assert.equal(active, 'activated', 'service worker activated')
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 })
  }
  // The signed-in app pulled the Firestore + Auth chunks through the SW.
  await page.waitForFunction(async () => {
    if (!(await caches.has('vendor-firebase-cache'))) return false
    const keys = await (await caches.open('vendor-firebase-cache')).keys()
    const names = keys.map(k => k.url)
    return names.some(u => /vendor-firebase-firestore/.test(u)) && names.some(u => /vendor-firebase-auth/.test(u))
  }, null, { timeout: 30_000, polling: 500 })
}

async function goTab(page, label) {
  await page.getByRole('link', { name: label, exact: true }).or(page.getByRole('button', { name: label, exact: true })).first().click()
}

const dialog = page => page.locator('[role="dialog"]').last()

async function addScheduleViaUi(page, title) {
  await page.getByRole('button', { name: '新增行程' }).first().click()
  const d = dialog(page)
  await d.getByPlaceholder('例如：參觀淺草雷門').fill(title)
  await d.locator('button', { hasText: '新增行程' }).last().click()
}

// Empty list: the 新增項目 CTA; otherwise each category section has 新增.
const planAddButton = page => page.getByRole('button', { name: /^新增(項目)?$/ }).first()

async function addPlanItemViaUi(page, title) {
  await planAddButton(page).click()
  const d = dialog(page)
  await d.getByPlaceholder('例如：護照、充電器、換匯').fill(title)
  await d.getByRole('button', { name: '新增', exact: true }).click()
}

// Text-only wish: client setDoc (no image → no Worker), optimistic-close.
async function addWishViaUi(page, title) {
  await page.getByRole('button', { name: /^新增.*候選項目$/ }).first().click()
  const d = dialog(page)
  await d.getByPlaceholder('例：築地市場、壽司大、淺草寺').fill(title)
  await d.getByRole('button', { name: '新增', exact: true }).click()
}

// Planning self-completion toggle on the row that carries `title`.
// `done` is the state to reach; the aria-label flips with the overlay patch.
const DONE_LABEL = { true: '將自己改為未完成', false: '標示自己已完成' }
async function togglePlanItemViaUi(page, title, done = true) {
  const row = page.getByText(title).first().locator('xpath=ancestor::*[.//button[@aria-label="標示自己已完成" or @aria-label="將自己改為未完成"]][1]')
  // A MOUSE click on purpose (the context also has touch): useSwipeRow used
  // to capture the pointer on pointerdown, which made Chromium retarget the
  // click to the row so the button never got it. This step is the
  // regression check for that fix; tap() would hide it.
  await row.getByRole('button', { name: DONE_LABEL[!done] }).click()
  try {
    await row.getByRole('button', { name: DONE_LABEL[done] }).waitFor({ timeout: 10_000 })
  } catch (e) {
    // Diagnostics: what the page shows instead of the ticked checkbox.
    const pressed = await row.getByRole('button').first().getAttribute('aria-pressed').catch(() => '?')
    const toasts = await page.locator('[role="status"], [role="alert"]').allTextContents().catch(() => [])
    const sheet = await page.locator('[role="dialog"]').count().catch(() => -1)
    throw new Error(`planning toggle did not apply: aria-pressed=${pressed} toasts=${JSON.stringify(toasts)} dialogs=${sheet}: ${e.message.split(String.fromCharCode(10))[0]}`)
  }
}

async function expectFormHandedOff(page, what) {
  await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {
    throw new Error(`${what} form is still open while offline (the write was not handed off — still 「儲存中…」?)`)
  })
}

/** Poll a predicate against the emulator (admin REST). */
async function until(pred, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

async function findDoc(collection, title) {
  return (await listDocs(collection)).find(d => d.title === title)
}

/** Polls the emulator (admin REST, bypasses rules) until both docs exist. */
async function waitForServerDocs(titles) {
  const until = Date.now() + SYNC_TIMEOUT_MS
  let found = {}
  while (Date.now() < until) {
    found = {
      schedule:     await findDoc('schedules', titles.schedule),
      planning:     await findDoc('planning', titles.planning),
      planningSeed: await findDoc('planning', titles.planningSeed),
      wish:         await findDoc('wishes', titles.wish),
    }
    // The online-created item must carry the OFFLINE toggle (completedBy[owner]).
    if (found.schedule && found.planning && found.planningSeed?.completedBy?.[OWNER] && found.wish) return found
    await new Promise(r => setTimeout(r, 500))
  }
  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => `${k} "${titles[k]}"`)
  throw new Error(
    `after reconnecting, ${missing.join(' and ')} did not reach the Firestore emulator within ${SYNC_TIMEOUT_MS / 1000}s. `
    + 'The offline write never left the device: either it was never handed to the Firestore SDK queue '
    + '(TanStack paused mutationFn offline — needs networkMode: \'always\'), or the queue was lost on reload.',
  )
}

// ─── Case ─────────────────────────────────────────────────────────

async function offlineWriteCase({ name, reloadWhileOffline }) {
  const tag = name
  const context = await newMobileContext(browser)
  const page = await context.newPage()
  collectProblems(page, tag, problems)
  const stamp = Date.now().toString(36)
  const titles = {
    schedule: `離線行程 ${stamp}`, planning: `離線準備 ${stamp}`, wish: `離線心願 ${stamp}`,
    planningSeed: `線上準備 ${stamp}`,
  }
  const shot = file => page.screenshot({ path: join(OUT, `${name}-${file}.png`) })

  try {
    await stage('isolate storage', async () => {
      const { before, after } = await wipeOriginStorage(page)
      assert.deepEqual(before, [], 'a fresh context starts with no IndexedDB databases')
      assert.deepEqual(after, [])
    })

    await stage('sign in online', async () => {
      await page.goto(`${APP}/schedule`)
      await signInAs(page, 'owner')
      await page.getByText('Arrive at Narita').first().waitFor({ timeout: 30_000 })
      ok('signed in as DEV owner; seeded schedule visible')
    })

    await stage('service worker ready', async () => {
      await ensureServiceWorkerControls(page)
      await page.getByText('Arrive at Narita').first().waitFor({ timeout: 30_000 })
      // Visit planning and wish online once so their (empty) queries are cached too.
      await goTab(page, '規劃')
      await planAddButton(page).waitFor({ timeout: 30_000 })
      // An item created ONLINE (acked by the emulator) is what the offline
      // toggle below acts on — the toggle is an update, not a create.
      await addPlanItemViaUi(page, titles.planningSeed)
      await until(async () => !!(await findDoc('planning', titles.planningSeed)), 'online planning item reaches the emulator')
      await togglePlanItemViaUi(page, titles.planningSeed, true)
      await until(async () => !!(await findDoc('planning', titles.planningSeed))?.completedBy?.[OWNER], 'online toggle reaches the emulator')
      await togglePlanItemViaUi(page, titles.planningSeed, false)
      await until(async () => !(await findDoc('planning', titles.planningSeed))?.completedBy?.[OWNER], 'online untoggle reaches the emulator')
      await goTab(page, '心願')
      await page.getByRole('button', { name: /^新增.*候選項目$/ }).first().waitFor({ timeout: 30_000 })
      await goTab(page, '行程')
      await page.getByText('Arrive at Narita').first().waitFor()
      const dbs = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name))
      assert.ok(dbs.some(n => n?.startsWith('firestore')), `Firestore uses IndexedDB persistence (found: ${dbs.join(', ') || 'none'})`)
      ok('SW activated and controlling; Firebase chunks runtime-cached; Firestore persisted in IndexedDB')
    })

    await stage('go offline', async () => {
      await context.setOffline(true)
      assert.equal(await page.evaluate(() => navigator.onLine), false)
      ok('context offline (navigator.onLine === false)')
    })

    await stage('offline schedule write', async () => {
      await addScheduleViaUi(page, titles.schedule)
      await expectFormHandedOff(page, 'schedule')
      await page.getByText(OFFLINE_HAND_OFF_MESSAGE).first().waitFor({ timeout: 5_000 })
      await page.getByText(titles.schedule).first().waitFor({ timeout: 10_000 })
      await shot('01-schedule-offline')
      ok('schedule form closed with the offline hand-off toast; optimistic row visible')
    })

    await stage('offline planning write', async () => {
      await goTab(page, '規劃')
      await addPlanItemViaUi(page, titles.planning)
      await expectFormHandedOff(page, 'planning')
      await page.getByText(titles.planning).first().waitFor({ timeout: 10_000 })
      await togglePlanItemViaUi(page, titles.planningSeed, true)
      await shot('02-planning-offline')
      ok('planning form closed; optimistic row visible; the online-created item ticked offline')
    })

    await stage('offline wish write (text-only)', async () => {
      await goTab(page, '心願')
      await addWishViaUi(page, titles.wish)
      await expectFormHandedOff(page, 'wish')
      await page.getByText(titles.wish).first().waitFor({ timeout: 10_000 })
      await shot('02b-wish-offline')
      ok('text-only wish form closed; optimistic card visible')
    })

    await stage('offline is real', async () => {
      await page.waitForTimeout(2000)
      assert.equal(await findDoc('schedules', titles.schedule), undefined, 'schedule must not reach the emulator while offline')
      assert.equal(await findDoc('planning', titles.planning), undefined, 'planning must not reach the emulator while offline')
      assert.equal(await findDoc('wishes', titles.wish), undefined, 'wish must not reach the emulator while offline')
      assert.ok(!(await findDoc('planning', titles.planningSeed))?.completedBy?.[OWNER], 'the offline toggle must not reach the emulator while offline')
      ok('no write reached the emulator while offline')
    })

    if (reloadWhileOffline) {
      await stage('reload while offline', async () => {
        const res = await page.reload()
        assert.ok(res?.fromServiceWorker(), 'the offline navigation was answered by the service worker')
        await page.getByRole('button', { name: '規劃', exact: true }).or(page.getByRole('link', { name: '規劃', exact: true })).first().waitFor({ timeout: 20_000 })
        assert.equal(await page.getByText('預覽模式').count(), 0, 'still signed in (not demo mode) after the offline reload')
        ok('app shell loaded from the SW precache while offline; still signed in')
      })

      await stage('rows survive the offline reload', async () => {
        // The reload landed on the last tab visited offline (心願); check it
        // first, then walk the other tabs.
        await page.getByText(titles.wish).first().waitFor({ timeout: 20_000 }).catch(() => {
          throw new Error(`wish card "${titles.wish}" is gone after the offline reload (the pending write was not persisted in IndexedDB)`)
        })
        await shot('03b-wish-after-reload')
        await goTab(page, '規劃')
        await page.getByText(titles.planning).first().waitFor({ timeout: 20_000 }).catch(() => {
          throw new Error(`planning row "${titles.planning}" is gone after the offline reload (the pending write was not persisted in IndexedDB)`)
        })
        const seedRow = page.getByText(titles.planningSeed).first().locator('xpath=ancestor::*[.//button[@aria-label="標示自己已完成" or @aria-label="將自己改為未完成"]][1]')
        await seedRow.getByRole('button', { name: '將自己改為未完成' }).waitFor({ timeout: 20_000 }).catch(() => {
          throw new Error('the offline planning toggle is gone after the offline reload (the pending write was not persisted in IndexedDB)')
        })
        await shot('03-planning-after-reload')
        await goTab(page, '行程')
        await page.getByText(titles.schedule).first().waitFor({ timeout: 20_000 }).catch(() => {
          throw new Error(`schedule row "${titles.schedule}" is gone after the offline reload (the pending write was not persisted in IndexedDB)`)
        })
        await shot('04-schedule-after-reload')
        ok('all rows (and the planning toggle) rendered from the IndexedDB cache after the reload')
      })
    }

    await stage('reconnect and sync', async () => {
      await context.setOffline(false)
      const docs = await waitForServerDocs(titles)
      for (const [kind, doc] of Object.entries(docs)) {
        assert.equal(doc.tripId, TRIP, `${kind}.tripId`)
        if (kind !== 'wish') assert.equal(doc.createdBy, OWNER, `${kind}.createdBy`)
        assert.equal(doc.updatedBy, OWNER, `${kind}.updatedBy`)
        assert.ok(doc.memberIds?.includes(OWNER), `${kind}.memberIds includes the owner`)
        assert.ok(typeof doc.createdAt === 'string' && typeof doc.updatedAt === 'string', `${kind} has server timestamps`)
      }
      assert.equal(docs.schedule.date, '2026-07-15', 'schedule.date is the active trip day')
      assert.equal(docs.planning.category, 'essentials', 'planning.category')
      assert.deepEqual(docs.planning.completedBy, {}, 'planning.completedBy starts empty')
      assert.ok(typeof docs.planningSeed.completedBy?.[OWNER] === 'string', 'the online-created item carries the offline toggle (server timestamp)')
      assert.equal(docs.wish.proposedBy, OWNER, 'wish.proposedBy')
      assert.deepEqual(docs.wish.votes, [OWNER], 'wish.votes starts with the proposer')
      ok(`all docs in Firestore: schedules/${docs.schedule.id}, planning/${docs.planning.id} (+ toggle on ${docs.planningSeed.id}), wishes/${docs.wish.id}`)
    })

    await stage('ui after sync', async () => {
      await goTab(page, '行程')
      await page.getByText(titles.schedule).first().waitFor({ timeout: 15_000 })
      await page.getByText(OFFLINE_HAND_OFF_MESSAGE).first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      await shot('05-schedule-synced')
      ok('row still shown after the server confirmed it')
    })
  } catch (e) {
    // Before cleanup navigates away: capture the screen the failure left.
    await page.screenshot({ path: join(OUT, `${name}-failure.png`), fullPage: true }).catch(() => {})
    throw e
  } finally {
    // Belt and braces on top of the per-case context: leave nothing behind.
    await context.setOffline(false).catch(() => {})
    const wiped = await wipeOriginStorage(page).catch(e => ({ error: e?.message }))
    // The still-running SW keeps its own databases (workbox-expiration,
    // firebase-heartbeat-database) open until the context closes; only a
    // surviving Firestore database would matter.
    const firestoreLeft = (wiped.after ?? []).filter(n => n.startsWith('firestore'))
    if (wiped.error || firestoreLeft.length) console.log(`  ! cleanup: ${wiped.error ?? `Firestore IndexedDB left: ${firestoreLeft.join(', ')}`}`)
    await context.close()
  }
}

// ─── Notification click (SW → client) ─────────────────────────────

const NOTIFY_COPY = {
  unknownRecipient: '無法確認這則通知的收件帳號，請從通知收件匣查看',
  otherAccount:     '這則通知屬於其他帳號，請切換帳號後再查看',
  draftOpen:        '有尚未儲存的表單，已保留目前畫面；儲存或關閉後再從通知收件匣查看',
}
const NOTIFY_CACHE = 'tripmate-notification-open'

/** The SW's notificationclick posts this to an open window; dispatching the
 *  same MessageEvent on navigator.serviceWorker reaches the client handler
 *  exactly as a real post would (the SW itself cannot be clicked from here). */
async function notificationOpenCase({ name }) {
  const context = await newMobileContext(browser)
  const page = await context.newPage()
  collectProblems(page, name, problems)
  const shot = file => page.screenshot({ path: join(OUT, `${name}-${file}.png`) })
  const send = data => page.evaluate(d => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: d }))
  }, data)
  const notice = (scope, route, targetUid) =>
    ({ type: 'NOTIFICATION_OPEN', scope, route, tripId: TRIP, ...(targetUid ? { targetUid } : {}) })
  const where = () => page.evaluate(() => location.pathname + location.search)
  const atPath = pathname => page.waitForURL(u => new URL(u).pathname === pathname && !new URL(u).searchParams.has('notify'), { timeout: 20_000 })
  /** Plants a nonce record the way the SW's nonce store writes it. */
  const plantNonce = (payload, expiresAt) => page.evaluate(async ({ payload, expiresAt, cacheName }) => {
    const nonce = crypto.randomUUID()
    const record = { payload, expiresAt }
    const cache = await caches.open(cacheName)
    await cache.put(`/__notification-open/${nonce}`, new Response(JSON.stringify(record), {
      headers: { 'content-type': 'application/json', 'x-tripmate-expires-at': String(expiresAt) },
    }))
    return nonce
  }, { payload, expiresAt, cacheName: NOTIFY_CACHE })
  const nonceLeft = nonce => page.evaluate(async ({ nonce, cacheName }) =>
    !!(await (await caches.open(cacheName)).match(`/__notification-open/${nonce}`)), { nonce, cacheName: NOTIFY_CACHE })

  try {
    await stage('isolate storage', async () => { await wipeOriginStorage(page) })

    await stage('sign in online', async () => {
      await page.goto(`${APP}/schedule`)
      await signInAs(page, 'owner')
      await page.getByText('Arrive at Narita').first().waitFor({ timeout: 30_000 })
      await ensureServiceWorkerControls(page)
      await page.getByText('Arrive at Narita').first().waitFor({ timeout: 30_000 })
      ok('signed in as DEV owner; SW controlling')
    })

    await stage('open window: own trip notification navigates in place', async () => {
      await page.evaluate(() => { window.__e2eAlive = true })
      await send(notice('trip', '/expense', OWNER))
      await atPath('/expense')
      assert.equal(await page.evaluate(() => window.__e2eAlive === true), true, 'SPA navigation — the page was not reloaded')
      await page.getByText('費用紀錄').first().waitFor({ timeout: 15_000 })
      await shot('01-trip-notification')
      ok('landed on /expense without a page reload')
    })

    await stage('open window: not for this account → no navigation', async () => {
      await goTab(page, '行程')
      await page.getByText('Arrive at Narita').first().waitFor()
      await send(notice('trip', '/expense', 'dev-editor'))
      await page.getByText(NOTIFY_COPY.otherAccount).first().waitFor({ timeout: 10_000 })
      assert.equal(await where(), '/schedule')
      await send(notice('trip', '/expense'))
      await page.getByText(NOTIFY_COPY.unknownRecipient).first().waitFor({ timeout: 10_000 })
      assert.equal(await where(), '/schedule')
      ok("another account's notification and a targetUid-less one both stay put")
    })

    await stage('open window: an open draft is protected', async () => {
      await page.getByRole('button', { name: '新增行程' }).first().click()
      await dialog(page).waitFor()
      await dialog(page).getByPlaceholder('例如：參觀淺草雷門').fill('草稿中')
      await send(notice('trip', '/expense', OWNER))
      await page.getByText(NOTIFY_COPY.draftOpen).first().waitFor({ timeout: 10_000 })
      assert.equal(await where(), '/schedule')
      assert.equal(await dialog(page).getByPlaceholder('例如：參觀淺草雷門').inputValue(), '草稿中', 'the draft is untouched')
      await shot('02-draft-protected')
      await dialog(page).getByRole('button', { name: '關閉' }).click()
      await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 10_000 })
      ok('stayed on the form with the draft intact')
    })

    await stage('open window: account scope goes to /account', async () => {
      await send(notice('account', '/account', OWNER))
      await atPath('/account')
      ok('account-scope notification landed on /account')
    })

    await stage('cold start: ?notify=<nonce> is resolved through the SW', async () => {
      const nonce = await plantNonce({ scope: 'trip', route: '/wish', tripId: TRIP, targetUid: OWNER }, Date.now() + 5 * 60_000)
      await page.goto(`${APP}/schedule?notify=${nonce}`)
      await atPath('/wish')
      assert.equal(await nonceLeft(nonce), false, 'the nonce record is one-shot')
      await shot('03-cold-start')
      ok('cold start landed on /wish with the query cleared; nonce consumed')
    })

    await stage('cold start: an expired nonce stays on the default page', async () => {
      const nonce = await plantNonce({ scope: 'trip', route: '/wish', tripId: TRIP, targetUid: OWNER }, Date.now() - 1_000)
      await page.goto(`${APP}/schedule?notify=${nonce}`)
      await atPath('/schedule')
      await page.getByText('Arrive at Narita').first().waitFor({ timeout: 30_000 })
      ok('expired nonce: default page, query cleared')
    })
  } catch (e) {
    await page.screenshot({ path: join(OUT, `${name}-failure.png`), fullPage: true }).catch(() => {})
    throw e
  } finally {
    await wipeOriginStorage(page).catch(() => {})
    await context.close()
  }
}

// ─── Inner run ────────────────────────────────────────────────────

const CASES = [
  { name: 'no-reload', reloadWhileOffline: false, run: offlineWriteCase, title: 'offline write survives reconnect (no reload)' },
  { name: 'reload', reloadWhileOffline: true, run: offlineWriteCase, title: 'offline write survives an offline reload' },
  { name: 'notify', run: notificationOpenCase, title: 'notification click is handled by the client, not a page navigation' },
]

const results = []
try {
  mkdirSync(OUT, { recursive: true })
  await seed()
  start('preview', 'npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort', '--outDir', DIST])
  await waitFor(APP)
  browser = await launchChromium()
  for (const c of CASES) {
    step(`${c.title} [${c.name}]`)
    try {
      await c.run(c)
      results.push({ name: c.name, ok: true })
    } catch (e) {
      console.error(`  ✗ ${e?.message ?? e}`)
      results.push({ name: c.name, ok: false, stage: e?.stage ?? 'unknown', message: e?.message ?? String(e) })
    }
  }
} catch (e) {
  results.push({ name: 'harness', ok: false, stage: 'harness', message: e?.message ?? String(e) })
  console.error('\n✗ harness:', e?.message ?? e)
} finally {
  await browser?.close().catch(() => {})
  stopAll()
}

console.log('\nSummary')
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  — failed at "${r.stage}"`}`)
// Console errors are diagnostics here, not assertions: offline Firestore /
// compatibility fetches are expected to log network errors.
const networkNoise = problems.filter(p => /ERR_INTERNET_DISCONNECTED/.test(p)).length
const otherProblems = problems.filter(p => !/ERR_INTERNET_DISCONNECTED/.test(p))
if (problems.length) {
  console.log(`\nPage / console errors (informational): ${networkNoise} expected offline ERR_INTERNET_DISCONNECTED`)
  if (otherProblems.length) console.log(`  ${otherProblems.slice(0, 20).join('\n  ')}`)
}
console.log(`Screenshots: ${OUT}`)

if (NEGATIVE_CONTROL) {
  // Without networkMode 'always' the paused write lives in memory only: the
  // no-reload case may still sync (TanStack resumes it on reconnect), but the
  // reload case must lose it.
  const reload = results.find(r => r.name === 'reload')
  const detected = reload && !reload.ok && ['rows survive the offline reload', 'reconnect and sync'].includes(reload.stage)
  console.log(detected
    ? '\nNegative control OK: without networkMode \'always\' the offline write is lost on reload, and the test caught it.'
    : '\nNegative control FAILED: the test did not detect the missing networkMode \'always\'.')
  process.exit(detected ? 0 : 1)
}
process.exit(results.every(r => r.ok) ? 0 : 1)
