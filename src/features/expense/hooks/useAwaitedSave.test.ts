// @vitest-environment jsdom
// useAwaitedSave: the form instance owns a waited save. Its outcome is routed
// when it settles — to this form while it is still mounted, otherwise to the
// global handler (stillOpen() → false) and nothing here is touched.
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAwaitedSave } from './useAwaitedSave'
import { WorkerAmbiguous, WorkerRejected } from '@/services/workerBase'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useAwaitedSave', () => {
  it('busy while pending, closes on success', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    let tracked!: Promise<void>
    act(() => { tracked = result.current.track(d.promise, () => 'x') })
    expect(result.current.saving).toBe(true)
    await act(async () => { d.resolve(); await tracked })
    expect(onClose).toHaveBeenCalledOnce()
    expect(result.current.saving).toBe(false)
  })

  it('a definitive failure becomes this form’s banner and keeps it open', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    let tracked!: Promise<void>
    act(() => { tracked = result.current.track(d.promise, e => `refused: ${(e as Error).message}`) })
    await act(async () => { d.reject(new WorkerRejected(409, 'rate changed', 'FX_RATE_CHANGED')); await tracked })
    expect(result.current.error).toBe('refused: rate changed')
    expect(result.current.saving).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an ambiguous outcome closes the form (the global toast reports it)', async () => {
    const onClose = vi.fn()
    const describe = vi.fn(() => 'x')
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    let tracked!: Promise<void>
    act(() => { tracked = result.current.track(d.promise, describe) })
    await act(async () => { d.reject(new WorkerAmbiguous('lost', undefined)); await tracked })
    expect(onClose).toHaveBeenCalledOnce()
    expect(describe).not.toHaveBeenCalled()
  })

  it('after unmount: stillOpen() is false and a late outcome touches nothing', async () => {
    const onClose = vi.fn()
    const describe = vi.fn(() => 'x')
    const { result, unmount } = renderHook(() => useAwaitedSave(onClose))
    const ok = deferred()
    const bad = deferred()
    let t1!: Promise<void>
    let t2!: Promise<void>
    act(() => {
      t1 = result.current.track(ok.promise, describe)
      t2 = result.current.track(bad.promise, describe)
    })
    const stillOpen = result.current.stillOpen
    expect(stillOpen()).toBe(true)
    unmount()
    expect(stillOpen()).toBe(false)
    await act(async () => {
      ok.resolve()
      bad.reject(new WorkerRejected(409, 'x', 'FX_RATE_CHANGED'))
      await Promise.all([t1, t2])
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
  })
})
