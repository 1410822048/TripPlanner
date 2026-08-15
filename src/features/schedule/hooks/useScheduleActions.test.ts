import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { CreateScheduleInput, Schedule } from '@/types'
import type { UseFormModalResult } from '@/hooks/useFormModal'

const mutationMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('./useSchedules', async () => {
  const actual = await vi.importActual<typeof import('./useSchedules')>('./useSchedules')
  return {
    nextScheduleOrder: actual.nextScheduleOrder,
    useCreateSchedule: () => ({ mutateAsync: mutationMocks.create, isPending: false }),
    useUpdateSchedule: () => ({ mutateAsync: mutationMocks.update, isPending: false }),
    useDeleteSchedule: () => ({ mutateAsync: mutationMocks.remove, isPending: false }),
  }
})

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('@/shared/toast', () => ({ toast: toastMocks }))
vi.mock('@/utils/devFailures', () => ({ simulateFailureMaybe: async () => {} }))

const compatibility = vi.hoisted(() => ({ writeBlockReason: null as string | null }))
vi.mock('@/services/clientCompatibility', () => ({
  getClientWriteBlockReason: () => compatibility.writeBlockReason,
}))

import { useScheduleActions } from './useScheduleActions'

const input = (over: Partial<CreateScheduleInput> = {}): CreateScheduleInput => ({
  title: 'Museum', date: '2026-09-18', timeMode: 'flexible', durationMinutes: 60,
  category: 'activity', ...over,
})

const schedule = (over: Partial<Schedule> & { id: string }): Schedule =>
  ({ tripId: 't1', order: 0, ...input(), ...over }) as Schedule

function makeModal(editTarget: Schedule | null = null) {
  return {
    isOpen: true, key: 'k', editTarget, saveError: null,
    openAdd: vi.fn(), openEdit: vi.fn(), close: vi.fn(),
    setError: vi.fn(), clearError: vi.fn(),
  } as unknown as UseFormModalResult<Schedule> & { close: ReturnType<typeof vi.fn>; setError: ReturnType<typeof vi.fn> }
}

function render(opts: {
  isDemo?: boolean
  uid?: string | undefined
  schedules?: Schedule[]
  modal?: ReturnType<typeof makeModal>
  openSignIn?: () => void
} = {}) {
  const modal = opts.modal ?? makeModal()
  const openSignIn = opts.openSignIn ?? vi.fn()
  const hook = renderHook(() => useScheduleActions({
    isDemo:    opts.isDemo ?? false,
    uid:       'uid' in opts ? opts.uid : 'uid-1',
    tripId:    'trip-1',
    schedules: opts.schedules ?? [],
    scheduleModal: modal,
    openSignIn,
  }))
  return { hook, modal, openSignIn }
}

beforeEach(() => {
  vi.clearAllMocks()
  compatibility.writeBlockReason = null
})

describe('useScheduleActions save', () => {
  it('creates with an id and a per-day order derived from the visible list', async () => {
    const { hook } = render({ schedules: [schedule({ id: 'a', date: '2026-09-18', order: 3 })] })

    await act(async () => { await hook.result.current.onScheduleSave(input()) })

    expect(mutationMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'uid-1',
      order:     4,
    }))
    expect(mutationMocks.create.mock.calls[0]?.[0].scheduleId).toEqual(expect.any(String))
  })

  it('skips the write entirely when an edit changed nothing', async () => {
    const target = schedule({ id: 'a' })
    const { hook, modal } = render({ modal: makeModal(target) })

    await act(async () => { await hook.result.current.onScheduleSave(input()) })

    expect(mutationMocks.update).not.toHaveBeenCalled()
    expect(modal.close).toHaveBeenCalled()
  })

  it('sends only the changed fields on an edit', async () => {
    const target = schedule({ id: 'a', title: 'Old' })
    const { hook } = render({ modal: makeModal(target) })

    await act(async () => { await hook.result.current.onScheduleSave(input({ title: 'New' })) })

    expect(mutationMocks.update).toHaveBeenCalledWith({
      scheduleId: 'a', uid: 'uid-1', updates: { title: 'New' },
    })
  })

  it('surfaces a failure in the modal banner rather than closing it', async () => {
    mutationMocks.create.mockRejectedValueOnce(new Error('boom'))
    const { hook, modal } = render()

    await act(async () => { await hook.result.current.onScheduleSave(input()) })

    expect(modal.setError).toHaveBeenCalledWith('boom')
    expect(modal.close).not.toHaveBeenCalled()
  })

  it('prompts sign-in instead of writing in demo mode', async () => {
    const { hook, modal, openSignIn } = render({ isDemo: true })

    await act(async () => { await hook.result.current.onScheduleSave(input()) })

    expect(openSignIn).toHaveBeenCalled()
    expect(modal.close).toHaveBeenCalled()
    expect(mutationMocks.create).not.toHaveBeenCalled()
  })

  it('refuses to write while the uid is still resolving', async () => {
    const { hook } = render({ uid: undefined })

    await act(async () => { await hook.result.current.onScheduleSave(input()) })

    expect(mutationMocks.create).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalled()
  })
})

describe('useScheduleActions delete', () => {
  it('deletes the edit target and closes', async () => {
    const { hook, modal } = render({ modal: makeModal(schedule({ id: 'a' })) })

    await act(async () => { await hook.result.current.onScheduleDelete() })

    expect(mutationMocks.remove).toHaveBeenCalledWith('a')
    expect(modal.close).toHaveBeenCalled()
  })

  it('keeps the modal open state consistent when the delete fails', async () => {
    mutationMocks.remove.mockRejectedValueOnce(new Error('nope'))
    const { hook, modal } = render({ modal: makeModal(schedule({ id: 'a' })) })

    await act(async () => { await hook.result.current.onScheduleDelete() })

    // The hook's onError already toasted; the modal must not be closed as
    // if the delete had worked.
    expect(modal.close).not.toHaveBeenCalled()
  })

  it('just closes when there is nothing to delete', async () => {
    const { hook, modal } = render()

    await act(async () => { await hook.result.current.onScheduleDelete() })

    expect(mutationMocks.remove).not.toHaveBeenCalled()
    expect(modal.close).toHaveBeenCalled()
  })

  it('surfaces the stale-bundle reason in the modal banner instead of deleting', async () => {
    // A sheet open when the epoch flips still fires this handler, and the
    // global toast deliberately skips UpdateRequiredError — the banner is
    // the only feedback the user gets.
    compatibility.writeBlockReason = '請先更新 App 才能儲存'
    const { hook, modal } = render({ modal: makeModal(schedule({ id: 'a' })) })

    await act(async () => { await hook.result.current.onScheduleDelete() })

    expect(mutationMocks.remove).not.toHaveBeenCalled()
    expect(modal.setError).toHaveBeenCalledWith('請先更新 App 才能儲存')
    expect(modal.close).not.toHaveBeenCalled()
  })
})
