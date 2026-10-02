// src/services/parseListSnapshot.ts
// Per-row resilience for list-from-snapshot parsing. One bad doc must
// not poison the entire list payload — otherwise schema drift, stale
// IndexedDB cache, or pre-migration leftovers would crash whichever
// tab is unlucky enough to land on the row first.
//
// 預設列表略過壞資料；帳務讀取必須提供 completeness，禁止用殘缺列表
// 推導權威餘額。fromDoc 的 schema 錯誤仍由 firestoreDocFromSchema 回報。
// 有上限時查詢須多取一筆，讓「剛好滿」與「被截斷」可以區分。
//
// Used by realtimeQuery.subscribeToCollection AND every service's
// getXxxByTrip one-shot read — both paths must apply the same completeness policy.
import type { QuerySnapshot, QueryDocumentSnapshot } from 'firebase/firestore'

export function parseListSnapshot<T>(
  snap:    QuerySnapshot,
  fromDoc: (d: QueryDocumentSnapshot) => T,
  completeness?: { limit?: number },
): T[] {
  if (completeness?.limit !== undefined && snap.size > completeness.limit) {
    throw new Error('帳務資料超過讀取上限，無法計算完整餘額。')
  }
  const out: T[] = []
  for (const d of snap.docs) {
    try {
      out.push(fromDoc(d))
    } catch (error) {
      if (completeness) {
        throw new Error('帳務資料格式異常，無法計算完整餘額。', { cause: error })
      }
      // fromDoc already called captureError with the ZodError + docId
      // before throwing — no need to re-report. Silently skip the row.
    }
  }
  return out
}
