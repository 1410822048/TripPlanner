import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type FirestoreIndex = {
  collectionGroup: string
  queryScope: string
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>
}

async function loadIndexes(): Promise<FirestoreIndex[]> {
  const path = resolve(process.cwd(), 'firestore.indexes.json')
  const raw = await readFile(path, 'utf8')
  return (JSON.parse(raw) as { indexes: FirestoreIndex[] }).indexes
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
    // workers/ocr/src/settlement-write.ts: in-tx pair reads (fromUid == a AND toUid == b AND deletedAt IS NULL).
    dependsOn: 'settlement create/delete pairwise tx reads',
    index: {
      collectionGroup: 'settlements', queryScope: 'COLLECTION',
      fields: [asc('fromUid'), asc('toUid'), asc('deletedAt')],
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
