import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashKey } from '@tanstack/react-query'

const captureError = vi.fn()
vi.mock('@/services/sentry', () => ({ captureError: (...a: unknown[]) => captureError(...a) }))

import {
  applyOverlays,
  createListOverlay,
  OVERLAY_AMBIGUOUS_SETTLE_MS,
  OVERLAY_GRACE_MS,
  type OverlayOp,
} from './listOverlay'

interface Row { id: string; title: string; done?: boolean; note?: string }

const KEY_A = ['planning', 'trip-a', 'uid-1'] as const
const KEY_B = ['planning', 'trip-b', 'uid-1'] as const

/** What the list would render for this server truth. */
const view = (c: ReturnType<typeof createListOverlay<Row>>, base: Row[]) =>
  c.merge(base, c.getSnapshot(hashKey(KEY_A)))

const row = (id: string, title = id): Row => ({ id, title })

/** Ops built by hand for the pure-function tests. */
function op(partial: Partial<OverlayOp<Row>> & Pick<OverlayOp<Row>, 'kind'>): OverlayOp<Row> {
  return {
    opId:   'x',
    seq:    1,
    status: 'pending',
    confirms: () => false,
    authoritativeFetch: async () => [],
    ...partial,
  } as OverlayOp<Row>
}

describe('applyOverlays', () => {
  it('returns the identical array when there is nothing to apply', () => {
    const base = [row('a')]
    expect(applyOverlays(base, [], 'head')).toBe(base)
  })

  it('upserts a create so a locally echoed row is not rendered twice', () => {
    const base = [row('a', 'from server')]
    const out = applyOverlays(base, [op({ kind: 'create', row: row('a', 'optimistic') })], 'head')

    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('from server')
  })

  it('inserts a create at the configured end when the id is new', () => {
    const base = [row('a')]
    expect(applyOverlays(base, [op({ kind: 'create', row: row('b') })], 'head').map(r => r.id))
      .toEqual(['b', 'a'])
    expect(applyOverlays(base, [op({ kind: 'create', row: row('b') })], 'tail').map(r => r.id))
      .toEqual(['a', 'b'])
  })

  it('replays in seq order so a patch composes over an earlier create', () => {
    const out = applyOverlays([], [
      op({ kind: 'patch', id: 'a', seq: 2, apply: r => ({ ...r, title: `${r.title}!` }) }),
      op({ kind: 'create', seq: 1, row: row('a', 'new') }),
    ], 'head')

    expect(out).toEqual([{ id: 'a', title: 'new!' }])
  })

  it('skips a patch whose row is absent rather than resurrecting it', () => {
    const out = applyOverlays([row('b')], [
      op({ kind: 'patch', id: 'a', apply: r => ({ ...r, title: 'ghost' }) }),
    ], 'head')

    expect(out.map(r => r.id)).toEqual(['b'])
  })

  it('drops a removed row', () => {
    expect(applyOverlays([row('a'), row('b')], [op({ kind: 'remove', id: 'a' })], 'head')
      .map(r => r.id)).toEqual(['b'])
  })

  // P1: the defect the cache-patch design could not express.
  it('leaves only the surviving edit when one of two edits to a row is dropped', () => {
    const base: Row[] = [{ id: 'a', title: 'server', done: false }]
    const first  = op({ kind: 'patch', id: 'a', seq: 1, apply: r => ({ ...r, title: 'from A' }) })
    const second = op({ kind: 'patch', id: 'a', seq: 2, apply: r => ({ ...r, done: true }) })

    // A fails → its op is gone; B is untouched and still applies to truth.
    const out = applyOverlays(base, [second], 'head')
    expect(out[0]).toEqual({ id: 'a', title: 'server', done: true })
    expect(applyOverlays(base, [first, second], 'head')[0]?.title).toBe('from A')
  })
})

describe('ListOverlayController', () => {
  let controller: ReturnType<typeof createListOverlay<Row>>

  beforeEach(() => {
    captureError.mockClear()
    controller = createListOverlay<Row>({ insert: 'head', source: 'test' })
  })
  afterEach(() => {
    controller.__resetForTest()
    vi.useRealTimers()
  })

  const addRemove = (key: typeof KEY_A | typeof KEY_B, id: string, fetchImpl?: () => Promise<Row[]>) =>
    controller.add(key, {
      kind: 'remove',
      id,
      confirms: base => !base.some(r => r.id === id),
      authoritativeFetch: fetchImpl ?? (async () => []),
    })

  // An op may only retire once every earlier op on the same row has.
  // Retiring a later one while an earlier survives replays a state the user
  // already moved past — the cancelled row comes back.
  describe('stacked operations on one row', () => {
    const addCreate = (id: string, fetchImpl?: () => Promise<Row[]>) =>
      controller.add(KEY_A, {
        kind: 'create', row: row(id),
        confirms: base => base.some(r => r.id === id),
        authoritativeFetch: fetchImpl ?? (async () => []),
      })
    const addPatch = (id: string, field: 'title' | 'note', value: string) =>
      controller.add(KEY_A, {
        kind: 'patch', id,
        apply: r => ({ ...r, [field]: value }),
        confirms: base => base.find(r => r.id === id)?.[field] === value,
        authoritativeFetch: async () => [],
      })

    it('create then remove: the cancelled row does not come back', () => {
      const create = addCreate('a')
      const remove = addRemove(KEY_A, 'a')
      controller.markSucceeded(create)
      controller.markSucceeded(remove)

      controller.reconcile(create.queryKeyHash, [])

      expect(controller.getSnapshot(create.queryKeyHash)).toHaveLength(0)
      expect(view(controller, [])).toEqual([])
    })

    it('remove then create: the re-added row survives', () => {
      const remove = addRemove(KEY_A, 'a')
      const create = addCreate('a')
      controller.markSucceeded(remove)
      controller.markSucceeded(create)

      const base = [row('a')]
      controller.reconcile(create.queryKeyHash, base)

      expect(view(controller, base).map(r => r.id)).toEqual(['a'])
    })

    it('create then patch then remove retires as one group', () => {
      const create = addCreate('a')
      const patch  = addPatch('a', 'title', 'edited')
      const remove = addRemove(KEY_A, 'a')
      for (const h of [create, patch, remove]) controller.markSucceeded(h)

      controller.reconcile(create.queryKeyHash, [])

      expect(controller.getSnapshot(create.queryKeyHash)).toHaveLength(0)
    })

    it('retires only the confirmed prefix when two patches touch different fields', () => {
      const first  = addPatch('a', 'title', 'new title')
      const second = addPatch('a', 'note', 'new note')
      controller.markSucceeded(first)
      controller.markSucceeded(second)

      // Only the first edit has landed.
      const base = [{ id: 'a', title: 'new title' }]
      controller.reconcile(first.queryKeyHash, base)

      const left = controller.getSnapshot(first.queryKeyHash)
      expect(left).toHaveLength(1)
      expect(view(controller, base)[0]).toMatchObject({ title: 'new title', note: 'new note' })
    })

    it('never retires a later op while an earlier one is unconfirmed', () => {
      const first  = addPatch('a', 'title', 'first')
      const second = addPatch('a', 'title', 'second')
      controller.markSucceeded(first)
      controller.markSucceeded(second)

      // Truth reflects the LAST write only — the classic inversion setup.
      const base = [{ id: 'a', title: 'second' }]
      controller.reconcile(first.queryKeyHash, base)

      // Retiring `second` alone would replay `first` and show 'first'.
      expect(view(controller, base)[0]?.title).toBe('second')
    })

    it('survives a triple toggle settling out of order', () => {
      const a = addPatch('a', 'title', 'on')
      const b = addPatch('a', 'title', 'off')
      const c = addPatch('a', 'title', 'on')
      controller.markSucceeded(c)
      controller.markSucceeded(a)
      controller.markSucceeded(b)

      const base = [{ id: 'a', title: 'on' }]
      controller.reconcile(a.queryKeyHash, base)

      expect(view(controller, base)[0]?.title).toBe('on')
    })

    it('holds a confirmed remove back while an earlier write is still in flight', () => {
      addCreate('a')                       // left pending
      const remove = addRemove(KEY_A, 'a')
      controller.markSucceeded(remove)

      controller.reconcile(remove.queryKeyHash, [])

      // Dropping the remove would resurrect the pending create's row.
      expect(controller.getSnapshot(remove.queryKeyHash)).toHaveLength(2)
      expect(view(controller, [])).toEqual([])
    })

    it('holds a confirmed remove back while an earlier write is ambiguous', () => {
      const create = addCreate('a')
      const remove = addRemove(KEY_A, 'a')
      controller.markAmbiguous(create)   // may or may not have committed
      controller.markSucceeded(remove)

      controller.reconcile(remove.queryKeyHash, [])

      // Retiring both would leave nothing to hide the row if the create
      // lands after all.
      expect(controller.getSnapshot(remove.queryKeyHash)).toHaveLength(2)
      expect(view(controller, [])).toEqual([])
    })

    it('will not force-retire across an earlier ambiguous write', async () => {
      vi.useFakeTimers()
      // The create's own read FAILS, so it stays ambiguous and re-arms.
      // (A hung read would be worse than useless here: the per-key
      // in-flight coalescing would stall the remove's confirmation too,
      // and the test would pass without exercising anything.)
      const create = addCreate('a', async () => { throw new Error('unreachable') })
      // The remove's read DISAGREES (row still there), so its grace expiry
      // reaches forceRetire rather than settling through reconcile — that
      // is the branch under test.
      const remove = addRemove(KEY_A, 'a', async () => [row('a')])
      controller.markAmbiguous(create)
      controller.markSucceeded(remove)

      // The remove's grace expiry must defer rather than take the
      // still-unresolved create with it.
      await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)

      expect(controller.getSnapshot(remove.queryKeyHash)).toHaveLength(2)
      expect(controller.getSnapshot(remove.queryKeyHash).some(o => o.kind === 'create')).toBe(true)
      expect(view(controller, [])).toEqual([])
    })

    it('resolves an ambiguous op through the same rule as reconcile', async () => {
      vi.useFakeTimers()
      const create = addCreate('a')
      const remove = addRemove(KEY_A, 'a', async () => [])
      controller.markSucceeded(create)
      controller.markAmbiguous(remove)

      await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)

      // The ambiguous remove settles, and takes the create with it rather
      // than leaving it to replay alone.
      expect(controller.getSnapshot(create.queryKeyHash)).toHaveLength(0)
    })

    it('expires a stuck op without inverting the row', async () => {
      vi.useFakeTimers()
      const create = addCreate('a', async () => [])
      const remove = addRemove(KEY_A, 'a', async () => [])
      controller.markSucceeded(create)
      controller.markSucceeded(remove)

      await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)

      expect(view(controller, [])).toEqual([])
    })
  })

  it('hands out one stable empty snapshot, and a new identity only on real change', () => {
    // useSyncExternalStore loops if getSnapshot allocates per call.
    expect(controller.getSnapshot('nothing-here')).toBe(controller.getSnapshot('other-key'))

    const handle = addRemove(KEY_A, 'a')
    const first = controller.getSnapshot(handle.queryKeyHash)
    expect(controller.getSnapshot(handle.queryKeyHash)).toBe(first)

    controller.markSucceeded(handle)
    expect(controller.getSnapshot(handle.queryKeyHash)).not.toBe(first)
  })

  it('notifies subscribers on add, status change and drop', () => {
    const handle = addRemove(KEY_A, 'a')
    const cb = vi.fn()
    controller.subscribe(handle.queryKeyHash, cb)

    controller.markSucceeded(handle)
    expect(cb).toHaveBeenCalledTimes(1)

    controller.drop(handle)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
  })

  it('reconcile drops a succeeded op only once server truth agrees', () => {
    const handle = addRemove(KEY_A, 'a')
    const hash = handle.queryKeyHash

    // Still pending: even agreeing truth must not drop it.
    controller.reconcile(hash, [row('b')])
    expect(controller.getSnapshot(hash)).toHaveLength(1)

    controller.markSucceeded(handle)
    // Disagreeing truth (row still present) keeps it.
    controller.reconcile(hash, [row('a'), row('b')])
    expect(controller.getSnapshot(hash)).toHaveLength(1)

    controller.reconcile(hash, [row('b')])
    expect(controller.getSnapshot(hash)).toHaveLength(0)
  })

  it('prunes on the status flip when truth already agreed beforehand', () => {
    const handle = addRemove(KEY_A, 'a')
    const hash = handle.queryKeyHash
    const cb = vi.fn()
    controller.subscribe(hash, cb)

    // Local echo already removed the row while the mutation was in flight.
    controller.reconcile(hash, [])
    expect(controller.getSnapshot(hash)).toHaveLength(1)

    controller.markSucceeded(handle)   // the only thing that changed
    expect(cb).toHaveBeenCalled()      // so the reconcile effect re-runs
    controller.reconcile(hash, [])
    expect(controller.getSnapshot(hash)).toHaveLength(0)
  })

  it('evicts the key entry once its last op drops', () => {
    const handle = addRemove(KEY_A, 'a')
    const before = controller.getSnapshot(handle.queryKeyHash)
    expect(before).toHaveLength(1)

    controller.drop(handle)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
    expect(controller.getSnapshot(handle.queryKeyHash)).toBe(controller.getSnapshot('anything-else'))
  })

  it('keeps trips isolated', () => {
    const a = addRemove(KEY_A, 'a')
    const b = addRemove(KEY_B, 'b')

    controller.markSucceeded(a)
    controller.reconcile(a.queryKeyHash, [])

    expect(controller.getSnapshot(a.queryKeyHash)).toHaveLength(0)
    expect(controller.getSnapshot(b.queryKeyHash)).toHaveLength(1)
  })

  it('resolves an ambiguous op against server truth, either way', async () => {
    vi.useFakeTimers()
    const landed = addRemove(KEY_A, 'a', async () => [row('b')])          // row gone → write landed
    controller.markAmbiguous(landed)
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    expect(controller.getSnapshot(landed.queryKeyHash)).toHaveLength(0)

    const phantom = addRemove(KEY_B, 'b', async () => [row('b')])         // row still there → never landed
    controller.markAmbiguous(phantom)
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    expect(controller.getSnapshot(phantom.queryKeyHash)).toHaveLength(0)
  })

  it('waits out the settle window before judging an ambiguous write', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(async () => [] as Row[])
    const handle = addRemove(KEY_A, 'a', fetchSpy)

    controller.markAmbiguous(handle)
    // Reading now would drop the op while the write may still be
    // committing, so the row would vanish and the later snapshot would
    // bring it back.
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS - 1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not let an external retry cut the settle window short', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(async () => [] as Row[])
    const handle = addRemove(KEY_A, 'a', fetchSpy)
    controller.markAmbiguous(handle)

    // Reconnecting or foregrounding the tab must not bring the judgement
    // forward — the write may still be committing.
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS - 1)
    controller.retryUnconfirmed()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('expires a succeeded op on the external retry that follows an exhausted budget', async () => {
    vi.useFakeTimers()
    let fail = true
    const fetchSpy = vi.fn(async () => {
      if (fail) throw new Error('backend flaky')
      return [row('a')]            // the row never left: truth disagrees
    })
    const handle = addRemove(KEY_A, 'a', fetchSpy)
    controller.markSucceeded(handle)

    // Three self-scheduled attempts, all failing, exhaust the budget.
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(1)

    fail = false
    controller.retryUnconfirmed()
    await vi.advanceTimersByTimeAsync(0)

    // No timer left to expire it later, so this read has to be the last
    // word rather than leaving the optimistic value on screen.
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
    expect(captureError).toHaveBeenCalled()
  })

  it('keeps retrying on its own clock after a failed confirmation', async () => {
    vi.useFakeTimers()
    let fail = true
    const fetchSpy = vi.fn(async () => {
      if (fail) throw new Error('backend flaky')
      return [] as Row[]
    })
    const handle = addRemove(KEY_A, 'a', fetchSpy)
    controller.markSucceeded(handle)

    await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(1)

    // No reconnect, no tab switch, no remount — the op has to converge by
    // itself rather than sit on the optimistic value indefinitely.
    fail = false
    await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
  })

  it('keeps an op whose authoritative read fails, and confirms it once the read recovers', async () => {
    vi.useFakeTimers()
    let fail = true
    const handle = addRemove(KEY_A, 'a', async () => {
      if (fail) throw new Error('offline')
      return []
    })

    controller.markAmbiguous(handle)
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    expect(captureError).not.toHaveBeenCalled()
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(1)

    fail = false
    await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)
    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
  })

  it('coalesces concurrent confirmations on one key into a single read', async () => {
    vi.useFakeTimers()
    let release!: (rows: Row[]) => void
    const pending = new Promise<Row[]>(res => { release = res })
    const fetchSpy = vi.fn(() => pending)
    const a = addRemove(KEY_A, 'a', fetchSpy)
    const b = addRemove(KEY_A, 'b', fetchSpy)

    controller.markAmbiguous(a)
    controller.markAmbiguous(b)
    // Both settle timers fire in the same window, so the second op finds
    // the first read still in flight and rides along.
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    release([])
    await vi.advanceTimersByTimeAsync(0)

    expect(controller.getSnapshot(a.queryKeyHash)).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores a read that resolves after everything was cleared', async () => {
    vi.useFakeTimers()
    let release!: (rows: Row[]) => void
    const handle = addRemove(KEY_A, 'a', () => new Promise<Row[]>(res => { release = res }))
    const cb = vi.fn()
    controller.subscribe(handle.queryKeyHash, cb)

    controller.markAmbiguous(handle)
    await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    controller.clearAll()
    cb.mockClear()

    release([])
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0)
    expect(cb).not.toHaveBeenCalled()
  })

  it('reports a succeeded op that server truth never confirms, then drops it', async () => {
    vi.useFakeTimers()
    const handle = addRemove(KEY_A, 'a', async () => [row('a')])   // the row never left
    controller.markSucceeded(handle)

    await vi.advanceTimersByTimeAsync(OVERLAY_GRACE_MS)
    await vi.waitFor(() => expect(controller.getSnapshot(handle.queryKeyHash)).toHaveLength(0))
    expect(captureError).toHaveBeenCalled()
  })
})
