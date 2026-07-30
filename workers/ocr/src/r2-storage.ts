// Typed, deliberately thin R2 binding helpers. Authorization and canonical
// path derivation stay in endpoint/domain modules; this file only normalizes
// object metadata and keeps R2-specific calls out of business logic.

export interface R2StoredObject {
  key:            string
  version:        string
  size:           number
  uploaded:       Date
  contentType:    string
  customMetadata: Record<string, string>
}

function storedObject(object: R2Object): R2StoredObject {
  return {
    key:            object.key,
    version:        object.version,
    size:           object.size,
    uploaded:       object.uploaded,
    contentType:    object.httpMetadata?.contentType ?? 'application/octet-stream',
    customMetadata: object.customMetadata ?? {},
  }
}

export async function headR2Object(
  bucket: R2Bucket,
  key:    string,
): Promise<R2StoredObject | null> {
  const object = await bucket.head(key)
  return object ? storedObject(object) : null
}

export async function getR2Object(
  bucket: R2Bucket,
  key:    string,
): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}

/**
 * Create-only write. R2's strong consistency + If-None-Match semantic makes
 * the canonical key immutable: concurrent retries cannot overwrite a winner.
 * Returns null when the key already exists.
 */
export async function createR2Object(
  bucket:         R2Bucket,
  key:            string,
  value:          ReadableStream | ArrayBuffer | ArrayBufferView | Blob,
  contentType:    string,
  customMetadata: Record<string, string>,
): Promise<R2StoredObject | null> {
  const object = await bucket.put(key, value, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType },
    customMetadata,
  })
  return object ? storedObject(object) : null
}

/** Idempotent: deleting an absent R2 key is successful. */
export async function deleteR2Object(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

export interface R2ObjectPage {
  objects:   R2StoredObject[]
  truncated: boolean
  cursor?:   string
}

export async function listR2Objects(
  bucket: R2Bucket,
  prefix: string,
  cursor: string | undefined,
  limit: number,
): Promise<R2ObjectPage> {
  const page = await bucket.list({ prefix, cursor, limit, include: ['httpMetadata', 'customMetadata'] })
  return {
    objects:   page.objects.map(storedObject),
    truncated: page.truncated,
    cursor:    page.truncated ? page.cursor : undefined,
  }
}

export async function purgeR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0
  let cursor: string | undefined
  do {
    const page = await listR2Objects(bucket, prefix, cursor, 500)
    const keys = page.objects.map(object => object.key)
    if (keys.length > 0) {
      // R2 supports up to 1,000 keys per batch delete; list is capped at 500.
      await bucket.delete(keys)
      deleted += keys.length
    }
    cursor = page.cursor
  } while (cursor)
  return deleted
}
