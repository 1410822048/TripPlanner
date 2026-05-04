// scripts/migrate-wish-categories.mjs
// One-shot migration: rewrite legacy `category: 'activity' | 'other'`
// wish docs to `'place'`. Required because the schema enum was tightened
// to two values (place / food); deploying the new code without this
// migration would make existing activity/other wishes throw on read.
//
// USAGE:
//   1. `firebase login` (if not already)
//   2. `firebase use <project-id>` (or set GCLOUD_PROJECT env)
//   3. `node scripts/migrate-wish-categories.mjs --dry-run`  ← preview first
//   4. `node scripts/migrate-wish-categories.mjs`            ← actually run
//
// Idempotent: re-running on already-migrated data is a no-op.
//
// Mapping:
//   - 'activity' → 'place'  (most activities happen at a place)
//   - 'other'    → 'place'  (default safe bucket)
//
// Service-account auth: this uses Firebase Admin SDK with application
// default credentials. On a personal machine after `firebase login`,
// the gcloud SDK's stored credentials should work. If not, set
// GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.

import { initializeApp, applicationDefault, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
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

async function main() {
  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (will update Firestore)'}`)
  console.log()

  // Collection-group query across every trip's wishes subcollection,
  // matching only the legacy categories.
  const legacyCats = ['activity', 'other']
  let total = 0
  const updates = []

  for (const cat of legacyCats) {
    const snap = await db.collectionGroup('wishes').where('category', '==', cat).get()
    console.log(`  Found ${snap.size} wish docs with category="${cat}"`)
    snap.forEach(doc => {
      updates.push({ ref: doc.ref, oldCat: cat })
      total++
    })
  }

  console.log()
  console.log(`Total to migrate: ${total}`)
  if (total === 0) { console.log('Nothing to do.'); return }

  if (dryRun) {
    console.log('\nDry-run preview (first 10):')
    updates.slice(0, 10).forEach(u => console.log(`  ${u.ref.path}  (${u.oldCat} → place)`))
    console.log('\nRe-run without --dry-run to apply.')
    return
  }

  // Batched writes (Firestore batch cap 500). Run in chunks.
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500)
    const batch = db.batch()
    chunk.forEach(u => batch.update(u.ref, { category: 'place' }))
    await batch.commit()
    console.log(`  Committed chunk ${i / 500 + 1} (${chunk.length} docs)`)
  }
  console.log(`\n✅ Migrated ${total} wish docs.`)
}

main().catch(e => { console.error(e); process.exit(1) })
