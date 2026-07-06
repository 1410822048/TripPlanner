// src/features/expense/hooks/settlementTombstones.ts
// Feature-local optimistic-delete overlay for settlement cancellation.
//
// Settlement delete is Worker-authoritative. The raw React Query cache must
// stay server-shaped because a lagging Firestore snapshot can still contain
// the just-cancelled row. The UI hides pending ids at read time and prunes
// them only after server truth no longer contains the id.
import type { SettlementRecord } from '@/types/settlement'

export const SETTLEMENT_DELETE_RETRY_DELAY_MS = 700

const registry  = new Map<string, Set<string>>()
const listeners = new Map<string, Set<() => void>>()
const versions  = new Map<string, number>()

function bump(tripId: string): void {
  versions.set(tripId, (versions.get(tripId) ?? 0) + 1)
  listeners.get(tripId)?.forEach(fn => fn())
}

export function subscribeSettlementTombstones(tripId: string, cb: () => void): () => void {
  let set = listeners.get(tripId)
  if (!set) {
    set = new Set()
    listeners.set(tripId, set)
  }
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0) listeners.delete(tripId)
  }
}

export function settlementTombstoneVersion(tripId: string): number {
  return versions.get(tripId) ?? 0
}

export function addSettlementTombstone(tripId: string, settlementId: string): void {
  const set = registry.get(tripId) ?? new Set<string>()
  if (set.has(settlementId)) return
  set.add(settlementId)
  registry.set(tripId, set)
  bump(tripId)
}

export function removeSettlementTombstone(tripId: string, settlementId: string): void {
  const set = registry.get(tripId)
  if (!set?.delete(settlementId)) return
  if (set.size === 0) registry.delete(tripId)
  bump(tripId)
}

export function pruneSettlementTombstones(tripId: string, serverList: SettlementRecord[]): void {
  const set = registry.get(tripId)
  if (!set || set.size === 0) return
  const present = new Set(serverList.map(s => s.id))
  let changed = false
  for (const settlementId of set) {
    if (!present.has(settlementId)) {
      set.delete(settlementId)
      changed = true
    }
  }
  if (!changed) return
  if (set.size === 0) registry.delete(tripId)
  bump(tripId)
}

export function filterSettlementTombstones(
  tripId: string,
  list:   SettlementRecord[],
  // Load-bearing render dependency: useSettlements passes the
  // useSyncExternalStore snapshot here so React Compiler cannot treat the
  // filtered result as depending only on tripId + list identity.
  _version = settlementTombstoneVersion(tripId),
): SettlementRecord[] {
  if (_version < 0) return list
  const set = registry.get(tripId)
  if (!set || set.size === 0) return list
  return list.filter(settlement => !set.has(settlement.id))
}

export function __resetSettlementTombstonesForTest(): void {
  registry.clear()
  listeners.clear()
  versions.clear()
}
