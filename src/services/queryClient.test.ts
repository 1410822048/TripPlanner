// Global MutationCache.onError: the rules the FX rate confirmation relies on.
// `reportInForm` is a predicate asked when the save settles: a form still
// open reports a definitive failure itself (no toast); one dismissed while
// waiting returns false and the failure is toasted here like any optimistic
// save. Ambiguous outcomes always use the global "still confirming" toast.
// A FX_RATE_CHANGED refusal is the CAS doing its job, not a fault (no Sentry).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toastMocks = vi.hoisted(() => ({ mutationError: vi.fn(), info: vi.fn() }))
const captureError = vi.hoisted(() => vi.fn())
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))
vi.mock('@/services/sentry', () => ({ captureError }))
vi.mock('@/services/clientCompatibility', () => ({
  assertClientWriteCompatible: () => {},
  isUpdateRequiredError: () => false,
}))

import { queryClient } from './queryClient'
import { WorkerRejected } from './workerBase'

type OnError = (err: unknown, vars: unknown, ctx: unknown, mutation: unknown) => void
const onError = queryClient.getMutationCache().config.onError as OnError
const mutation = { meta: { action: '新增費用' } }
const fxChanged = () => new WorkerRejected(409, 'rate changed', 'FX_RATE_CHANGED', undefined, {
  rateDecimal: '150', rateDate: '2026-10-07',
})

beforeEach(() => {
  toastMocks.mutationError.mockReset()
  toastMocks.info.mockReset()
  captureError.mockReset()
})

describe('MutationCache.onError', () => {
  it('a form still open suppresses the toast but a real failure is still reported', () => {
    onError(new Error('boom'), { reportInForm: () => true }, undefined, mutation)
    expect(toastMocks.mutationError).not.toHaveBeenCalled()
    expect(captureError).toHaveBeenCalledOnce()
  })

  it('a form dismissed while waiting gets the normal toast', () => {
    onError(fxChanged(), { reportInForm: () => false }, undefined, mutation)
    expect(toastMocks.mutationError).toHaveBeenCalledOnce()
  })

  it('an ambiguous outcome is never reported by the form', () => {
    const ambiguous = Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
    onError(ambiguous, { reportInForm: () => true }, undefined, mutation)
    expect(toastMocks.info).toHaveBeenCalledOnce()
  })

  it('a non-function reportInForm is ignored', () => {
    onError(new Error('boom'), { reportInForm: true }, undefined, mutation)
    expect(toastMocks.mutationError).toHaveBeenCalledOnce()
  })

  it('FX_RATE_CHANGED is not sent to Sentry', () => {
    onError(fxChanged(), { reportInForm: () => true }, undefined, mutation)
    expect(captureError).not.toHaveBeenCalled()
    expect(toastMocks.mutationError).not.toHaveBeenCalled()
  })

  it('FX_RATE_CHANGED after an optimistic close still toasts', () => {
    onError(fxChanged(), {}, undefined, mutation)
    expect(captureError).not.toHaveBeenCalled()
    expect(toastMocks.mutationError).toHaveBeenCalledOnce()
  })

  it('other failures keep the existing behaviour', () => {
    onError(new Error('boom'), {}, undefined, mutation)
    expect(captureError).toHaveBeenCalledOnce()
    expect(toastMocks.mutationError).toHaveBeenCalledOnce()
  })
})
