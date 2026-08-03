// src/hooks/listOverlay.ts
// Read-time optimistic overlay for realtime list queries.
//
// The query cache holds server truth only. Optimistic state lives here as
// operations that are replayed over the base at read time, which is what
// makes two failure modes of cache-patching impossible by construction:
//
//   - two edits to one row: each op is undone independently, so a failing
//     op can no longer strand its value on top of a surviving one
//   - a delete that fails while the server deleted the row too: there is
//     nothing to "restore", so the row cannot be resurrected
//
// Generalised from the settlement tombstone store, which proved the shape
// for deletes only.
//
// This module must stay Firebase-free: each op carries its own
// `authoritativeFetch`, captured with the tripId/uid it belongs to.
import { useSyncExternalStore } from 'react'
import { hashKey, type QueryKey } from '@tanstack/react-query'
import { captureError } from '@/services/sentry'

export type OverlayStatus = 'pending' | 'succeeded' | 'ambiguous'

interface OverlayOpBase<T> {
  opId:   string
  seq:    number
  status: OverlayStatus
  /** Has server truth caught up with this op? Read against the raw base.
   *  MUST cover every field the op writes — a predicate weaker than its
   *  reducer makes the unchecked fields visibly revert the moment the op
   *  is dropped. `create` is exempt: its row yields to the base row. */
  confirms: (base: T[]) => boolean
  /** Server-only read for this op's query key, bypassing any local cache.
   *  Per-op rather than per-controller because one controller spans every
   *  trip and uid the entity has ops for, and because an op must be able
   *  to confirm itself after its component unmounted. */
  authoritativeFetch: () => Promise<T[]>
  /** What to do once the authoritative read has failed too many times.
   *  `keep` (default) holds the optimistic view. `drop` reverts to server
   *  truth — the right choice when showing a stale row is safer than
   *  hiding a real one, as with a settlement the user might otherwise
   *  re-record. */
  whenUnconfirmable?: 'keep' | 'drop'
}

export type OverlayOp<T> =
  | (OverlayOpBase<T> & { kind: 'create'; row: T })
  | (OverlayOpBase<T> & { kind: 'patch';  id: string; apply: (row: T) => T })
  | (OverlayOpBase<T> & { kind: 'remove'; id: string })

export type OverlayOpInput<T> =
  | Omit<Extract<OverlayOp<T>, { kind: 'create' }>, 'opId' | 'seq' | 'status'>
  | Omit<Extract<OverlayOp<T>, { kind: 'patch'  }>, 'opId' | 'seq' | 'status'>
  | Omit<Extract<OverlayOp<T>, { kind: 'remove' }>, 'opId' | 'seq' | 'status'>

/** Identifies one op for the whole of its life, including after the
 *  component that created it unmounted or the user switched trips. */
export interface OverlayHandle {
  opId:         string
  queryKeyHash: string
}

export const OVERLAY_GRACE_MS = 8_000

/** An ambiguous write may still be committing, so server truth is read
 *  only after this settle window. Judging immediately would drop the row
 *  and let the realtime push bring it straight back — visible as a row
 *  that vanishes and returns. Matches AMBIGUOUS_RECONCILE_DELAY_MS. */
export const OVERLAY_AMBIGUOUS_SETTLE_MS = 3_000

const MAX_CONFIRM_ATTEMPTS = 3

let seqCounter = 0

/**
 * Replay ops over a base list. Pure.
 *
 * `create` is an upsert, not an insert: ids are minted client-side, so
 * Firestore echoes the local write back as a snapshot while the mutation
 * is still pending. Since presence alone must not confirm an op, a plain
 * insert would render the row twice for that window — indefinitely while
 * offline. The base row wins, so the real row takes over as soon as it
 * exists and dropping the op later is invisible.
 *
 * `patch` maps against the accumulator rather than the original base, so
 * `create → patch` composes; a patch whose row is absent is skipped, so
 * it can never resurrect a deleted row.
 */
export function applyOverlays<T extends { id: string }>(
  base:   T[],
  ops:    readonly OverlayOp<T>[],
  insert: 'head' | 'tail',
): T[] {
  if (ops.length === 0) return base

  let acc = base
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    switch (op.kind) {
      case 'create': {
        if (acc.some(row => row.id === op.row.id)) break
        acc = insert === 'head' ? [op.row, ...acc] : [...acc, op.row]
        break
      }
      case 'patch': {
        let hit = false
        const next = acc.map(row => {
          if (row.id !== op.id) return row
          hit = true
          return op.apply(row)
        })
        if (hit) acc = next
        break
      }
      case 'remove': {
        const next = acc.filter(row => row.id !== op.id)
        if (next.length !== acc.length) acc = next
        break
      }
    }
  }
  return acc
}

interface Entry<T> {
  ops:      readonly OverlayOp<T>[]
  /** Coalesces concurrent confirmations so N ops on a key cost one read. */
  inFlight?: Promise<T[]>
  attempts:  Map<string, number>
  timers:    Map<string, ReturnType<typeof setTimeout>>
}

export interface ListOverlayController<T extends { id: string }> {
  add:          (queryKey: QueryKey, op: OverlayOpInput<T>) => OverlayHandle
  markSucceeded:(handle: OverlayHandle) => void
  markAmbiguous:(handle: OverlayHandle) => void
  drop:         (handle: OverlayHandle) => void
  reconcile:    (queryKeyHash: string, base: T[]) => void
  merge:        (base: T[], ops: readonly OverlayOp<T>[]) => T[]
  subscribe:    (queryKeyHash: string, cb: () => void) => () => void
  getSnapshot:  (queryKeyHash: string) => readonly OverlayOp<T>[]
  retryUnconfirmed: (queryKeyHash?: string) => void
  clearAll:     () => void
  __resetForTest: () => void
}

/** Shared so every controller — and `useSyncExternalStore`'s server
 *  snapshot — hands back the same reference for "no ops". */
const EMPTY_OPS: readonly never[] = Object.freeze([])
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Ids whose write is still in flight, for rows that must not be tapped,
 *  swiped or edited yet.
 *
 *  `succeeded` is deliberately excluded: that write is done and only its
 *  confirmation is outstanding, so keeping the row locked would be a
 *  needless freeze. `ambiguous` stays locked — we genuinely don't know. */
export function useOverlayPendingRowIds<T extends { id: string }>(
  controller: ListOverlayController<T>,
  queryKey:   QueryKey,
): ReadonlySet<string> {
  const hash = hashKey(queryKey)
  const ops  = useSyncExternalStore(
    cb => controller.subscribe(hash, cb),
    () => controller.getSnapshot(hash),
    () => EMPTY_OPS,
  )
  if (ops.length === 0) return EMPTY_IDS
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.status === 'succeeded') continue
    ids.add(op.kind === 'create' ? op.row.id : op.id)
  }
  return ids
}

const controllers: { clearAll: () => void }[] = []

/** Clear every overlay. Called from the sign-out / account-switch path so
 *  one user's in-flight optimism can't leak into the next session. */
export function clearAllListOverlays(): void {
  for (const c of controllers) c.clearAll()
}

export function createListOverlay<T extends { id: string }>(
  config: { insert: 'head' | 'tail'; source: string },
): ListOverlayController<T> {
  const entries   = new Map<string, Entry<T>>()
  const listeners = new Map<string, Set<() => void>>()
  const EMPTY: readonly OverlayOp<T>[] = EMPTY_OPS

  let onlineBound     = false
  let visibilityBound = false

  function notify(hash: string): void {
    listeners.get(hash)?.forEach(cb => cb())
  }

  function clearTimers(entry: Entry<T>): void {
    for (const t of entry.timers.values()) clearTimeout(t)
    entry.timers.clear()
  }

  /** Entry rows are dropped as a unit once empty so a long session doesn't
   *  accumulate one permanent entry per trip visited. */
  function setOps(hash: string, entry: Entry<T>, ops: readonly OverlayOp<T>[]): void {
    if (ops.length === 0) {
      clearTimers(entry)
      entries.delete(hash)
    } else {
      entry.ops = ops
    }
    releaseGlobalListeners()
    notify(hash)
  }

  function anyUnconfirmed(): boolean {
    for (const entry of entries.values()) {
      if (entry.ops.some(op => op.status !== 'pending')) return true
    }
    return false
  }

  function bindGlobalListeners(): void {
    if (typeof window === 'undefined') return
    if (!onlineBound) {
      window.addEventListener('online', onOnline)
      onlineBound = true
    }
    if (!visibilityBound) {
      document.addEventListener('visibilitychange', onVisible)
      visibilityBound = true
    }
  }

  function releaseGlobalListeners(): void {
    if (typeof window === 'undefined' || anyUnconfirmed()) return
    if (onlineBound) {
      window.removeEventListener('online', onOnline)
      onlineBound = false
    }
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', onVisible)
      visibilityBound = false
    }
  }

  function onOnline(): void { retryUnconfirmed() }
  function onVisible(): void {
    if (document.visibilityState === 'visible') retryUnconfirmed()
  }

  function findOp(hash: string, opId: string): OverlayOp<T> | undefined {
    return entries.get(hash)?.ops.find(op => op.opId === opId)
  }

  function replaceOp(hash: string, opId: string, next: OverlayOp<T>): void {
    const entry = entries.get(hash)
    if (!entry) return
    setOps(hash, entry, entry.ops.map(op => (op.opId === opId ? next : op)))
  }

  function add(queryKey: QueryKey, input: OverlayOpInput<T>): OverlayHandle {
    const hash = hashKey(queryKey)
    const op = { ...input, opId: `op-${++seqCounter}`, seq: seqCounter, status: 'pending' } as OverlayOp<T>
    const entry = entries.get(hash) ?? { ops: EMPTY, attempts: new Map(), timers: new Map() }
    entries.set(hash, entry)
    entry.ops = [...entry.ops, op]
    notify(hash)
    return { opId: op.opId, queryKeyHash: hash }
  }

  function drop(handle: OverlayHandle): void {
    const entry = entries.get(handle.queryKeyHash)
    if (!entry) return
    const timer = entry.timers.get(handle.opId)
    if (timer) {
      clearTimeout(timer)
      entry.timers.delete(handle.opId)
    }
    entry.attempts.delete(handle.opId)
    setOps(handle.queryKeyHash, entry, entry.ops.filter(op => op.opId !== handle.opId))
  }

  function markSucceeded(handle: OverlayHandle): void {
    const op = findOp(handle.queryKeyHash, handle.opId)
    if (!op || op.status === 'succeeded') return
    replaceOp(handle.queryKeyHash, handle.opId, { ...op, status: 'succeeded' })
    armConfirmTimer(handle, OVERLAY_GRACE_MS)
  }

  function markAmbiguous(handle: OverlayHandle): void {
    const op = findOp(handle.queryKeyHash, handle.opId)
    if (!op) return
    replaceOp(handle.queryKeyHash, handle.opId, { ...op, status: 'ambiguous' })
    bindGlobalListeners()
    // Deliberately not read now — see OVERLAY_AMBIGUOUS_SETTLE_MS.
    armConfirmTimer(handle, OVERLAY_AMBIGUOUS_SETTLE_MS)
  }

  /** Schedules the server-truth read that retires an op.
   *
   *  A `succeeded` op normally clears on the next snapshot that agrees
   *  with it; this only covers the case where that snapshot never comes —
   *  a write the server silently no-opped. An `ambiguous` op uses it to
   *  wait out the settle window before judging.
   *
   *  Re-armed when the read itself fails, so a quiet tab with a flaky
   *  backend still converges instead of showing the optimistic value
   *  until something external happens to fire a retry. */
  function armConfirmTimer(handle: OverlayHandle, delayMs: number): void {
    const entry = entries.get(handle.queryKeyHash)
    if (!entry || entry.timers.has(handle.opId)) return
    bindGlobalListeners()
    const timer = setTimeout(() => {
      entry.timers.delete(handle.opId)
      void confirm(handle, { final: true })
    }, delayMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    entry.timers.set(handle.opId, timer)
  }

  async function confirm(handle: OverlayHandle, opts: { final?: boolean } = {}): Promise<void> {
    const { queryKeyHash: hash, opId } = handle
    const entry = entries.get(hash)
    const op    = entry?.ops.find(o => o.opId === opId)
    if (!entry || !op) return

    const attempts = (entry.attempts.get(opId) ?? 0) + 1
    entry.attempts.set(opId, attempts)

    let base: T[]
    try {
      entry.inFlight ??= op.authoritativeFetch().finally(() => {
        const live = entries.get(hash)
        if (live === entry) live.inFlight = undefined
      })
      base = await entry.inFlight
    } catch (e) {
      // Identity gate: a clear or eviction while the read was in flight
      // must not let this resolution touch whatever now holds the key.
      if (entries.get(hash) !== entry || !entry.ops.some(o => o.opId === opId)) return
      const err = e instanceof Error ? e : new Error(String(e))
      // `drop` degrades on the first failure: its fallback is server truth,
      // so retrying only prolongs the unsafe state it exists to escape.
      if (op.whenUnconfirmable === 'drop') {
        captureError(err, { source: `${config.source}/overlay-unconfirmable`, opId })
        drop(handle)
        return
      }
      if (attempts >= MAX_CONFIRM_ATTEMPTS) {
        captureError(err, { source: `${config.source}/overlay-confirm`, opId, attempts })
      } else {
        // Keep trying on our own clock. Without this the op would sit on
        // the optimistic value until the user happened to reconnect,
        // background the tab, or remount the list.
        armConfirmTimer(handle, OVERLAY_GRACE_MS)
      }
      bindGlobalListeners()
      return
    }

    if (entries.get(hash) !== entry || !entry.ops.some(o => o.opId === opId)) return

    const current = entry.ops.find(o => o.opId === opId)!
    if (current.status === 'ambiguous') {
      // Server truth settles it either way: confirmed means the write
      // landed, unconfirmed means it never did and the row must go.
      drop(handle)
      return
    }
    if (current.confirms(base) || opts.final) {
      if (opts.final && !current.confirms(base)) {
        captureError(new Error('overlay op expired unconfirmed'), {
          source: `${config.source}/overlay-grace`, opId,
        })
      }
      drop(handle)
    }
  }

  function reconcile(hash: string, base: T[]): void {
    const entry = entries.get(hash)
    if (!entry) return
    const survivors = entry.ops.filter(op => !(op.status === 'succeeded' && op.confirms(base)))
    if (survivors.length === entry.ops.length) return
    for (const op of entry.ops) {
      if (survivors.includes(op)) continue
      const timer = entry.timers.get(op.opId)
      if (timer) clearTimeout(timer)
      entry.timers.delete(op.opId)
      entry.attempts.delete(op.opId)
    }
    setOps(hash, entry, survivors)
  }

  function retryUnconfirmed(hash?: string): void {
    for (const [key, entry] of entries) {
      if (hash && key !== hash) continue
      for (const op of entry.ops) {
        if (op.status === 'pending') continue
        // A live timer means this op is still inside its settle or grace
        // window. Reading now would judge a write that may still be
        // committing — the flicker those windows exist to prevent.
        if (entry.timers.has(op.opId)) continue
        // Reaching here means the timers are spent, so this read is the
        // last word for a succeeded op: expire it if truth disagrees.
        void confirm(
          { opId: op.opId, queryKeyHash: key },
          { final: op.status === 'succeeded' },
        )
      }
    }
  }

  function clearAll(): void {
    for (const [hash, entry] of entries) {
      clearTimers(entry)
      entries.delete(hash)
      notify(hash)
    }
    releaseGlobalListeners()
  }

  const controller: ListOverlayController<T> = {
    add,
    markSucceeded,
    markAmbiguous,
    drop,
    reconcile,
    merge: (base, ops) => applyOverlays(base, ops, config.insert),
    subscribe(hash, cb) {
      let set = listeners.get(hash)
      if (!set) {
        set = new Set()
        listeners.set(hash, set)
      }
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) listeners.delete(hash)
      }
    },
    // Stable identity is required by useSyncExternalStore: a fresh array
    // per call would loop, and mutating in place would never notify.
    getSnapshot: hash => entries.get(hash)?.ops ?? EMPTY,
    retryUnconfirmed,
    clearAll,
    __resetForTest() {
      clearAll()
      listeners.clear()
    },
  }

  controllers.push(controller)
  return controller
}
