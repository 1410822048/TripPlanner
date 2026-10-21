import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type FirestoreIndex = {
  collectionGroup: string
  queryScope: string
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>
}

type FieldOverride = {
  collectionGroup: string
  fieldPath: string
  ttl?: boolean
  indexes: Array<{ order?: string; arrayConfig?: string; queryScope: string }>
}

type IndexesFile = { indexes: FirestoreIndex[]; fieldOverrides?: FieldOverride[] }

async function loadIndexesFile(): Promise<IndexesFile> {
  const path = resolve(process.cwd(), 'firestore.indexes.json')
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as IndexesFile
}

async function loadIndexes(): Promise<FirestoreIndex[]> {
  return (await loadIndexesFile()).indexes
}

const asc = (fieldPath: string) => ({ fieldPath, order: 'ASCENDING' })
const desc = (fieldPath: string) => ({ fieldPath, order: 'DESCENDING' })

// Composite indexes that server-side code (Worker crons / tx reads, Cloud
// Functions) depends on. A missing index there fails at runtime with
// FAILED_PRECONDITION, far from any client test, so pin them here.
const SERVER_INDEXES: Array<{ dependsOn: string; index: FirestoreIndex }> = [
  {
    // workers/ocr/src/route-preview.ts + route-apply.ts: one day's schedules ordered by `order`.
    dependsOn: 'Worker route preview / apply (date == X ORDER BY order)',
    index: { collectionGroup: 'schedules', queryScope: 'COLLECTION', fields: [asc('date'), asc('order')] },
  },
  {
    // workers/ocr/src/firestore.ts queryReceiptPurgeCandidates (allDescendants), via receipt-purge.ts cron.
    dependsOn: 'receipt-purge cron (receiptPurgedAt == null AND deletedAt < cutoff)',
    index: {
      collectionGroup: 'expenses', queryScope: 'COLLECTION_GROUP',
      fields: [asc('receiptPurgedAt'), asc('deletedAt')],
    },
  },
  {
    // workers/ocr/src/firestore.ts queryWishDeadlineSweepCandidates, via wish-deadline-sweep.ts cron.
    dependsOn: 'wish-deadline sweep (NotifiedAt == null AND deadlineAt <= now ORDER BY deadlineAt)',
    index: {
      collectionGroup: 'trips', queryScope: 'COLLECTION',
      fields: [asc('wishVotingDeadlineNotifiedAt'), asc('wishVotingDeadlineAt')],
    },
  },
  {
    // workers/ocr/src/firestore.ts queryUploadIntents, upload-intent-purge.ts passes 1-2 (pending / uploaded).
    dependsOn: 'upload-intent purge (status == X AND expiresAt < cutoff)',
    index: {
      collectionGroup: 'uploadIntents', queryScope: 'COLLECTION_GROUP',
      fields: [asc('status'), asc('expiresAt')],
    },
  },
  {
    // workers/ocr/src/firestore.ts queryUploadIntents, upload-intent-purge.ts pass 3 (used retention).
    dependsOn: 'upload-intent purge (status == used AND usedAt < cutoff)',
    index: {
      collectionGroup: 'uploadIntents', queryScope: 'COLLECTION_GROUP',
      fields: [asc('status'), asc('usedAt')],
    },
  },
  {
    // firebase-functions/src/dispatch.ts loadEnabledTokens: users/{uid}/pushTokens.
    dependsOn: 'push dispatch (disabledAt == null ORDER BY lastSeenAt DESC)',
    index: {
      collectionGroup: 'pushTokens', queryScope: 'COLLECTION',
      fields: [asc('disabledAt'), desc('lastSeenAt')],
    },
  },
]

describe('Firestore indexes required by server code', () => {
  it.each(SERVER_INDEXES)('keeps the index for $dependsOn', async ({ index }) => {
    await expect(loadIndexes()).resolves.toContainEqual(index)
  })
})

// TTL policies live as fieldOverrides in firestore.indexes.json. The release
// ends with `firebase deploy --only firestore:indexes --force`, which deletes
// every remote field override (ttlConfig included) that this file does not
// list — so a TTL enabled only via gcloud is silently turned off on the next
// deploy. Pin each one here. `indexes: []` exempts the field from single-field
// indexing; none of these collections query or order by expiresAt.
const TTL_OVERRIDES: Array<{ dependsOn: string; override: FieldOverride }> = [
  {
    // workers/ocr/src/route-apply.ts: route-apply idempotency receipts (30 days).
    dependsOn: 'routeApplications.expiresAt',
    override: { collectionGroup: 'routeApplications', fieldPath: 'expiresAt', ttl: true, indexes: [] },
  },
  {
    // firebase-functions/src/notifications.ts writeNotificationDocs: users/{uid}/notifications (30 days).
    dependsOn: 'notifications.expiresAt',
    override: { collectionGroup: 'notifications', fieldPath: 'expiresAt', ttl: true, indexes: [] },
  },
  {
    // firebase-functions/src/dispatch.ts reservePushEvent: _pushEvents dedupe / lease records (30 days).
    dependsOn: '_pushEvents.expiresAt',
    override: { collectionGroup: '_pushEvents', fieldPath: 'expiresAt', ttl: true, indexes: [] },
  },
]

describe('Firestore TTL policies kept in the indexes file', () => {
  it.each(TTL_OVERRIDES)('keeps the TTL override for $dependsOn', async ({ override }) => {
    const { fieldOverrides = [] } = await loadIndexesFile()
    expect(fieldOverrides).toContainEqual(override)
  })

  it('declares each TTL field override exactly once', async () => {
    const { fieldOverrides = [] } = await loadIndexesFile()
    const keys = fieldOverrides.map(o => `${o.collectionGroup}.${o.fieldPath}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
