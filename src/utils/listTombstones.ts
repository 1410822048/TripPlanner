// src/utils/listTombstones.ts
// Query-scoped optimistic-delete overlay for realtime list caches.
//
// 問題:createRealtimeListHook 撐起來的 list,有「兩個 writer」同時寫同一
// 份 TanStack cache slot —— 樂觀 mutation 與 Firestore onSnapshot listener
// (後者直接 setQueryData(queryKey, rawServerArray))。listener 是
// authoritative,但對 Worker-authoritative 的刪除會短暫落後:admin-SDK 的
// 寫入繞過 client SDK,所以 Firestore 的 latency-compensation 不會在本地先
// 把該 row 藏掉。於是一個「還帶著剛被刪 doc」的舊 snapshot 會覆蓋掉樂觀移
// 除 → row 閃回來,直到 post-delete snapshot 落地才真的消失。
//
// 解法:刪除「不要」去 mutate raw cache。raw cache 永遠保持 server truth,
// 刪除改成 READ-TIME overlay —— 一個 per-query-key 的「tombstone id 集合」,
// 由 list hook 在 return 前 filter 掉。正因為 raw cache 從不被樂觀縮小,某
// 個 id「離開 raw cache」就「唯一地」代表 server 已確認刪除,於是
// pruneTombstones() 可以安全清掉 tombstone。Worker 拒絕時 removeTombstones()
// 拿掉 tombstone,row 立刻回來。
//
// 這個 module 同時是一個極小的 observable store:每次集合變動都 bump 一個
// per-key version + 通知 subscriber,讓 list hook 透過 useSyncExternalStore
// 在「mutation 樂觀刪除 / 失敗回滾 / server 確認後 prune」三種轉換上都「確定」
// re-render,不依賴 react-query 的 select 記憶化 / structural-sharing 內部
// 行為(後者會把內容相同的新陣列折回同一個 ref,讓 select 不重跑)。
//
// 生命週期(由 useTripListMutation + createRealtimeListHook 串接):
//   onMutate(delete) → addTombstones() : 讀取時藏起來,raw 不動
//   onError          → removeTombstones(): row 回來(拒絕 / 確定失敗)
//   server snapshot   → pruneTombstones() : id 已不在 server truth ⇒ 清 tombstone
//   read(hook return) → filterTombstoned(): 對 consumer 隱藏 tombstoned id
import type { QueryKey } from '@tanstack/react-query'

// Module-level registry — one entry per active queryKey, keyed by the
// stringified queryKey(queryKey 依本 codebase 慣例是 primitive array,
// stringify 為穩定字串 identity)。
const registry  = new Map<string, Set<string>>()
const listeners = new Map<string, Set<() => void>>()
// Per-key snapshot version for useSyncExternalStore — a stable primitive
// that only changes identity when that key's set changes.
const versions  = new Map<string, number>()

const keyId = (queryKey: QueryKey) => JSON.stringify(queryKey)

function bump(id: string): void {
  versions.set(id, (versions.get(id) ?? 0) + 1)
  listeners.get(id)?.forEach(fn => fn())
}

/** Subscribe to set changes for a key (useSyncExternalStore). */
export function subscribeTombstones(queryKey: QueryKey, cb: () => void): () => void {
  const id = keyId(queryKey)
  let set = listeners.get(id)
  if (!set) {
    set = new Set()
    listeners.set(id, set)
  }
  set.add(cb)
  return () => { set.delete(cb) }
}

/** Stable snapshot value for a key — bumps on every set change. */
export function tombstoneVersion(queryKey: QueryKey): number {
  return versions.get(keyId(queryKey)) ?? 0
}

/** 把 ids 標記為「樂觀已刪除」(讀取時隱藏)。 */
export function addTombstones(queryKey: QueryKey, ids: string[]): void {
  if (ids.length === 0) return
  const id  = keyId(queryKey)
  const set = registry.get(id) ?? new Set<string>()
  let changed = false
  for (const docId of ids) if (!set.has(docId)) { set.add(docId); changed = true }
  if (!changed) return
  registry.set(id, set)
  bump(id)
}

/** 拿掉 tombstone(Worker 拒絕刪除 → row 必須回來)。 */
export function removeTombstones(queryKey: QueryKey, ids: string[]): void {
  if (ids.length === 0) return
  const id  = keyId(queryKey)
  const set = registry.get(id)
  if (!set) return
  let changed = false
  for (const docId of ids) if (set.delete(docId)) changed = true
  if (!changed) return
  if (set.size === 0) registry.delete(id)
  bump(id)
}

/** 用 server truth 確認刪除:任何 tombstoned id 已不在 raw server list 中,
 *  代表真的被刪了 → 清掉它的 tombstone。「只」因為刪除從不縮小 raw cache
 *  (overlay 模型)才安全。 */
export function pruneTombstones<T>(queryKey: QueryKey, serverList: T[], getId: (item: T) => string): void {
  const id  = keyId(queryKey)
  const set = registry.get(id)
  if (!set || set.size === 0) return
  const present = new Set(serverList.map(getId))
  let changed = false
  for (const docId of set) if (!present.has(docId)) { set.delete(docId); changed = true }
  if (!changed) return
  if (set.size === 0) registry.delete(id)
  bump(id)
}

/** 讀取時 overlay:回傳 `list` 去掉 tombstoned id 後的結果。該 key 沒有任何
 *  tombstone 時回傳「同一個 reference」,讓非刪除路徑維持 referential
 *  stability(不觸發多餘 re-render)。 */
export function filterTombstoned<T>(queryKey: QueryKey, list: T[], getId: (item: T) => string): T[] {
  const set = registry.get(keyId(queryKey))
  if (!set || set.size === 0) return list
  return list.filter(item => !set.has(getId(item)))
}

/** Test-only:清空所有 module-level 狀態,避免測試間外溢。 */
export function __resetTombstonesForTest(): void {
  registry.clear()
  listeners.clear()
  versions.clear()
}
