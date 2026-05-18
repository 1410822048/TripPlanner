// scripts/backfill-audit-fields.mjs
// One-shot migration: stamp missing audit fields (createdBy / updatedBy /
// updatedAt) on pre-migration docs across every trip's 5 feature
// subcollections. Required when:
//   - The Zod schema gains a required audit field
//   - Pre-existing docs predate that field
//   - The strict read path would otherwise reject them
//
// Stamping strategy:
//   - createdBy / updatedBy ← trip.ownerId (best-effort proxy; no way
//     to recover the real authoring uid from history)
//   - updatedAt             ← existing createdAt if present, else
//     serverTimestamp() (so realtime listeners that order by
//     updatedAt still produce a stable order)
//
// USAGE:
//   1. firebase login                                          (if needed)
//   2. firebase use <project-id>                               (or set GCLOUD_PROJECT)
//   3. node scripts/backfill-audit-fields.mjs --dry-run        (preview)
//   4. node scripts/backfill-audit-fields.mjs                  (apply)
//
// Idempotent: docs with all three fields already populated are skipped.
// Safe to re-run.
//
// Service-account auth: uses Firebase Admin SDK with application default
// credentials. On a personal machine after `firebase login` the gcloud
// SDK's stored creds work; otherwise set GOOGLE_APPLICATION_CREDENTIALS
// to a service-account JSON path.

import { initializeApp, applicationDefault, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { readFileSync, existsSync } from 'node:fs'

const dryRun = process.argv.includes('--dry-run')
const projectId = process.env.GCLOUD_PROJECT
  ?? (existsSync('.firebaserc')
    ? JSON.parse(readFileSync('.firebaserc', 'utf8'))?.projects?.default
    : undefined)

if (!projectId) {
  console.error('No project id. Set GCLOUD_PROJECT or run `firebase use <id>`.')
  process.exit(1)
}

const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
initializeApp({
  projectId,
  credential: credsPath ? cert(credsPath) : applicationDefault(),
})

const db = getFirestore()

// Subcollections that carry the audit-fields contract. Wishes are
// here but use `proposedBy` as the creator field, so they only need
// updatedBy stamped (not createdBy).
const FEATURE_COLLECTIONS = [
  { name: 'schedules', needsCreatedBy: true  },
  { name: 'expenses',  needsCreatedBy: true  },
  { name: 'bookings',  needsCreatedBy: true  },
  { name: 'plannings', needsCreatedBy: true  }, // collection name 'plannings' / 'planning' — see below
  { name: 'wishes',    needsCreatedBy: false }, // proposedBy is the creator field
]

// The codebase uses `planning` (singular) for the Firestore subcollection
// name (see src/services/paths.ts). Override here so the script doesn't
// scan an empty 'plannings' path.
FEATURE_COLLECTIONS.find(c => c.name === 'plannings').name = 'planning'

function needsBackfill(data, needsCreatedBy) {
  if (needsCreatedBy && !data.createdBy)     return true
  if (!data.updatedBy)                       return true
  if (!data.updatedAt)                       return true
  return false
}

function buildPatch(data, ownerId, needsCreatedBy) {
  const patch = {}
  if (needsCreatedBy && !data.createdBy) patch.createdBy = ownerId
  if (!data.updatedBy)                   patch.updatedBy = ownerId
  if (!data.updatedAt) {
    // Prefer createdAt — that's the closest "when this row's last
    // meaningful change happened". Falls back to now if neither exists.
    patch.updatedAt = data.createdAt ?? FieldValue.serverTimestamp()
  }
  return patch
}

async function main() {
  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (will update Firestore)'}`)
  console.log()

  // Snapshot every trip (and its ownerId, which we'll use as the
  // backfill uid). Subcollections are scanned per-trip rather than
  // via collectionGroup so we can attribute writes to the trip's
  // actual owner — collectionGroup doesn't expose the parent path
  // cleanly enough to map back without extra reads.
  const tripsSnap = await db.collection('trips').get()
  console.log(`Found ${tripsSnap.size} trips.\n`)

  let totalScanned = 0
  let totalToBackfill = 0
  const previews = []

  // Bucket updates so we can batch-commit (Firestore 500/batch cap).
  const updates = []

  for (const tripDoc of tripsSnap.docs) {
    const tripId = tripDoc.id
    const ownerId = tripDoc.get('ownerId')
    if (!ownerId) {
      console.warn(`  skip trip ${tripId}: no ownerId`)
      continue
    }

    for (const { name, needsCreatedBy } of FEATURE_COLLECTIONS) {
      const subSnap = await db.collection(`trips/${tripId}/${name}`).get()
      totalScanned += subSnap.size
      for (const d of subSnap.docs) {
        const data = d.data()
        if (!needsBackfill(data, needsCreatedBy)) continue
        const patch = buildPatch(data, ownerId, needsCreatedBy)
        totalToBackfill++
        updates.push({ ref: d.ref, patch })
        if (previews.length < 10) {
          previews.push(`  ${d.ref.path}  +${Object.keys(patch).join(',')}`)
        }
      }
    }
  }

  console.log(`Scanned:  ${totalScanned} feature docs`)
  console.log(`Backfill: ${totalToBackfill}`)
  console.log()
  if (totalToBackfill === 0) { console.log('Nothing to do.'); return }

  if (dryRun) {
    console.log('Preview (first 10):')
    previews.forEach(p => console.log(p))
    if (totalToBackfill > previews.length) {
      console.log(`  ... +${totalToBackfill - previews.length} more`)
    }
    console.log('\nRe-run without --dry-run to apply.')
    return
  }

  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500)
    const batch = db.batch()
    chunk.forEach(({ ref, patch }) => batch.update(ref, patch))
    await batch.commit()
    console.log(`  Committed chunk ${i / 500 + 1} (${chunk.length} docs)`)
  }
  console.log(`\nBackfilled ${totalToBackfill} docs.`)
}

main().catch(e => { console.error(e); process.exit(1) })
