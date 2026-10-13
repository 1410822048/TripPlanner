// workers/ocr/src/firestore-size.ts
// Stored size of a Firestore document, computed by Firestore's documented
// rules (https://firebase.google.com/docs/firestore/storage-size), so a
// writer that builds large documents can refuse cleanly before a commit
// Firestore would reject (1 MiB per document):
//   string   UTF-8 bytes + 1          integer / double / timestamp   8
//   boolean / null   1                array   Σ element sizes
//   map      Σ (key string size + value size)
//   document name   Σ path segment string sizes + 16
//   document        name + Σ fields + 32
import type { FsValue } from './firestore'

const encoder = new TextEncoder()

function stringSize(s: string): number {
  return encoder.encode(s).length + 1
}

export function valueSize(v: FsValue): number {
  if (v.stringValue !== undefined) return stringSize(v.stringValue)
  if (v.integerValue !== undefined || v.doubleValue !== undefined || v.timestampValue !== undefined) return 8
  if (v.booleanValue !== undefined || 'nullValue' in v) return 1
  if (v.arrayValue) return (v.arrayValue.values ?? []).reduce((sum, x) => sum + valueSize(x), 0)
  if (v.mapValue) return fieldsSize(v.mapValue.fields ?? {})
  throw new Error('valueSize: unsupported Firestore value')
}

export function fieldsSize(fields: Record<string, FsValue>): number {
  return Object.entries(fields).reduce((sum, [key, value]) => sum + stringSize(key) + valueSize(value), 0)
}

/** Size of the document at `path` (e.g. `trips/t/settlements/s`) holding
 *  `fields`, plus a timestamp at each server-transform field path (written
 *  at commit, so absent from `fields`). */
export function documentSize(path: string, fields: Record<string, FsValue>, serverTimestampPaths: readonly string[] = []): number {
  const name = path.split('/').reduce((sum, segment) => sum + stringSize(segment), 0) + 16
  const transforms = serverTimestampPaths.reduce((sum, fieldPath) => sum + stringSize(fieldPath.split('.').at(-1)!) + 8, 0)
  return name + fieldsSize(fields) + transforms + 32
}
