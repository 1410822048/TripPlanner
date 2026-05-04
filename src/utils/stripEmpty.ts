// src/utils/stripEmpty.ts
// Drop empty-string and undefined values from a record so Firestore
// doesn't store noise (Firestore's null vs missing distinction matters
// for queries; storing `''` for an unfilled optional bloats indexes
// and forces every reader to "or empty" check).
//
// Used by booking / wish / planning service update paths. Originally
// duplicated in three files; consolidated here.
//
// `null` is intentionally PRESERVED — it has semantic meaning ("user
// explicitly cleared this field") that callers may rely on. Use
// Firestore's `deleteField()` if you actually want to remove a field.

export function stripEmpty<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '') continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}
