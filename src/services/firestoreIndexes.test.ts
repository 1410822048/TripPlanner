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

describe('Firestore indexes', () => {
  it('supports Worker route previews ordered within one schedule day', async () => {
    await expect(loadIndexes()).resolves.toContainEqual({
      collectionGroup: 'schedules',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'date', order: 'ASCENDING' },
        { fieldPath: 'order', order: 'ASCENDING' },
      ],
    })
  })
})
