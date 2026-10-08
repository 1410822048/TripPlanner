// @vitest-environment jsdom
// useAwaitedSave: the form instance owns a waited write. Its outcome is
// routed when it settles — to this form while it is still mounted, otherwise
// to the global handler (stillOpen() → false) and nothing here is touched.
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

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useAwaitedSave', () => {
  it('busy while pending, closes on success', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise, () => 'x') })
    expect(result.current.saving).toBe(true)
    await act(async () => { d.resolve() })
    await flush()
    expect(onClose).toHaveBeenCalledOnce()
    expect(result.current.saving).toBe(false)
  })

  it('a definitive failure becomes this form’s banner and keeps it open', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise, e => `refused: ${(e as Error).message}`) })
    await act(async () => { d.reject(new WorkerRejected(409, 'rate changed', 'FX_RATE_CHANGED')) })
    await flush()
    expect(result.current.error).toBe('refused: rate changed')
    expect(result.current.saving).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a later attempt clears the old banner even when the page refuses it without writing', async () => {
    // Otherwise a stale 「儲存失敗」 would cover the page's newer reason
    // (e.g. the trip was switched — close and reopen the form).
    const { result } = renderHook(() => useAwaitedSave(vi.fn()))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise, () => '儲存失敗') })
    await act(async () => { d.reject(new Error('net')) })
    await flush()
    expect(result.current.error).toBe('儲存失敗')

    const run = vi.fn(() => undefined)   // the page refused synchronously
    act(() => { result.current.submit(run, () => 'unused') })
    expect(run).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
  })

  it('ignores a second write (e.g. a delete) while one is in flight, even in the same tick', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const save = deferred()
    const del = vi.fn(() => Promise.resolve())
    act(() => {
      result.current.submit(() => save.promise, () => 'x')
      result.current.submit(del)                       // same tick, before any re-render
    })
    act(() => { result.current.submit(del) })          // after re-render, still in flight
    expect(del).not.toHaveBeenCalled()

    await act(async () => { save.resolve() })
    await flush()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('an ambiguous outcome closes the form (the global toast reports it)', async () => {
    const onClose = vi.fn()
    const describeFailure = vi.fn(() => 'x')
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise, describeFailure) })
    await act(async () => { d.reject(new WorkerAmbiguous('lost', undefined)) })
    await flush()
    expect(onClose).toHaveBeenCalledOnce()
    expect(describeFailure).not.toHaveBeenCalled()
  })

  it('without describe, a failure is left to the global toast: no banner, no close', async () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise) })
    await act(async () => { d.reject(new Error('delete failed')) })
    await flush()
    expect(result.current.error).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(result.current.saving).toBe(false)
  })

  it('after unmount: stillOpen() is false and a late outcome touches nothing', async () => {
    const onClose = vi.fn()
    const describeFailure = vi.fn(() => 'x')
    const { result, unmount } = renderHook(() => useAwaitedSave(onClose))
    const d = deferred()
    act(() => { result.current.submit(() => d.promise, describeFailure) })
    const stillOpen = result.current.stillOpen
    expect(stillOpen()).toBe(true)
    unmount()
    expect(stillOpen()).toBe(false)
    await act(async () => { d.reject(new WorkerRejected(409, 'x', 'FX_RATE_CHANGED')) })
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(describeFailure).not.toHaveBeenCalled()
  })
})
