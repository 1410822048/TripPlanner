#!/usr/bin/env node
// One-off production audit for the "trip edit resets currency to TWD" bug
// (UpdateTripSchema inherited `currency.default('TWD')` through Zod 4's
// `.partial()`, live from 2026-05-15 until the fix in this branch).
//
// READ-ONLY by default. Lists every trip whose expenses / settlements are
// recorded in a currency different from trip.currency, with per-currency
// counts and the first/last createdAt of each, so the owner can decide what
// the trip currency should be.
//
// Usage (needs Google credentials with Firestore read on the project, e.g.
// `gcloud auth application-default login`):
//   node scripts/audit-trip-currency.mjs
//   node scripts/audit-trip-currency.mjs --json > report.json
// Restore ONE trip's currency after reviewing the report (writes only
// trips/{id}.currency; expenses and settlements are never modified):
//   node scripts/audit-trip-currency.mjs --set <tripId>=JPY --apply
// Without --apply, --set only prints what it would change.
//
// Backfill trip.ledgerStartedAt (the marker firestore.rules uses to pin the
// currency once a trip has expenses) on trips created before the marker
// existed. Run AFTER restoring any mismatched trips above:
//   node scripts/audit-trip-currency.mjs --backfill-ledger            (dry run)
//   node scripts/audit-trip-currency.mjs --backfill-ledger --apply
//
// Expenses/settlements created AFTER a trip was flipped were recorded as the
// wrong currency by the app itself; they are listed (mismatch counts are per
// currency) but deliberately NOT rewritten here — their amounts may have
// gone through FX conversion and need a human decision per row.
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'tripplanner-80a4f'
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const apply  = args.includes('--apply')
const setArg = args[args.indexOf('--set') + 1]
const setPair = args.includes('--set') ? /^([A-Za-z0-9_-]{1,60})=([A-Z]{3})$/.exec(setArg ?? '') : null
if (args.includes('--set') && !setPair) {
  console.error('--set expects <tripId>=<CUR>, e.g. --set abc123=JPY')
  process.exit(2)
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
const db = getFirestore()

function iso(ts) {
  return ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : null
}

function tally(docs) {
  const byCurrency = {}
  for (const d of docs) {
    const data = d.data()
    const cur = typeof data.currency === 'string' ? data.currency : '(missing)'
    const row = byCurrency[cur] ??= { count: 0, firstCreatedAt: null, lastCreatedAt: null }
    row.count += 1
    const at = iso(data.createdAt)
    if (at && (!row.firstCreatedAt || at < row.firstCreatedAt)) row.firstCreatedAt = at
    if (at && (!row.lastCreatedAt  || at > row.lastCreatedAt))  row.lastCreatedAt  = at
  }
  return byCurrency
}

if (args.includes('--backfill-ledger')) {
  const all = await db.collection('trips').get()
  let pending = 0
  for (const trip of all.docs) {
    if (trip.get('ledgerStartedAt')) continue
    const first = await trip.ref.collection('expenses').orderBy('createdAt').limit(1).get()
    if (first.empty) continue
    pending += 1
    const at = first.docs[0].get('createdAt')
    console.log(`trips/${trip.id}  ledgerStartedAt <- ${iso(at)}${apply ? '' : '  (dry run)'}`)
    if (apply) await trip.ref.update({ ledgerStartedAt: at })
  }
  console.log(`${pending} trip(s) ${apply ? 'backfilled' : 'would be backfilled; add --apply'}`)
  process.exit(0)
}

if (setPair) {
  const [, tripId, currency] = setPair
  const ref  = db.doc(`trips/${tripId}`)
  const snap = await ref.get()
  if (!snap.exists) { console.error(`trip ${tripId} not found`); process.exit(1) }
  const from = snap.get('currency')
  console.log(`trips/${tripId}.currency: ${from} -> ${currency}${apply ? '' : '  (dry run; add --apply to write)'}`)
  if (apply) {
    await ref.update({ currency })
    console.log('written.')
  }
  process.exit(0)
}

const trips = await db.collection('trips').get()
const report = []
for (const trip of trips.docs) {
  const tripCurrency = trip.get('currency')
  const [expenses, settlements] = await Promise.all([
    trip.ref.collection('expenses').get(),
    trip.ref.collection('settlements').get(),
  ])
  const exp = tally(expenses.docs)
  const set = tally(settlements.docs)
  const mismatched = [...Object.keys(exp), ...Object.keys(set)].some(c => c !== tripCurrency)
  if (!mismatched) continue
  report.push({
    tripId: trip.id,
    title: trip.get('title'),
    ownerId: trip.get('ownerId'),
    tripCurrency,
    tripUpdatedAt: iso(trip.get('updatedAt')),
    expensesByCurrency: exp,
    settlementsByCurrency: set,
  })
}

if (asJson) {
  console.log(JSON.stringify({ scannedTrips: trips.size, mismatched: report }, null, 2))
} else {
  console.log(`scanned ${trips.size} trips; ${report.length} with currency mismatches\n`)
  for (const r of report) {
    console.log(`- ${r.tripId}  "${r.title}"  trip.currency=${r.tripCurrency}  (trip updatedAt ${r.tripUpdatedAt})`)
    for (const [cur, v] of Object.entries(r.expensesByCurrency)) {
      console.log(`    expenses    ${cur}: ${v.count}  (${v.firstCreatedAt} … ${v.lastCreatedAt})`)
    }
    for (const [cur, v] of Object.entries(r.settlementsByCurrency)) {
      console.log(`    settlements ${cur}: ${v.count}  (${v.firstCreatedAt} … ${v.lastCreatedAt})`)
    }
  }
  if (report.length) console.log('\nReview, then restore with: node scripts/audit-trip-currency.mjs --set <tripId>=<CUR> --apply')
}
