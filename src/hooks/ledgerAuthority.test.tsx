import { createElement, useState, type ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Query, QuerySnapshot } from 'firebase/firestore'

const sdk = vi.hoisted(() => ({ onSnapshot: vi.fn() }))
vi.mock('@/services/firebase', () => ({ getFirebase: async () => sdk }))
vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'test-user' }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))
import { subscribeToCollection } from '@/services/realtimeQuery'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import BottomSheet from '@/components/ui/BottomSheet'
import AttachmentPreviewModal from '@/features/attachments/components/AttachmentPreviewModal'

afterEach(() => vi.useRealTimers())

describe('server-confirmed ledger authority', () => {
  it('previews cached rows without cancelling the server read, and tracks metadata-only changes', async () => {
    let snapshot!: (value: QuerySnapshot) => void
    sdk.onSnapshot.mockImplementation((_query, _options, onData) => { snapshot = onData; return vi.fn() })
    let resolveServer!: (rows: { id: string }[]) => void
    const initialFetch = vi.fn(() => new Promise<{ id: string }[]>(resolve => { resolveServer = resolve }))
    const useLedger = createRealtimeListHook<{ id: string }>({
      queryKeyFactory: key => ['test-ledger', key], source: 'test', initialFetch,
      requireServerConfirmation: true,
      subscribe: async (_key, _uid, onData, onError) => subscribeToCollection({
        buildQuery: () => ({} as Query), fromDoc: doc => ({ id: doc.id }),
        source: 'test-ledger', requireComplete: true, limit: 500,
      }, onData, onError),
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const view = renderHook(() => useLedger('trip-1'), { wrapper })
    await waitFor(() => expect(snapshot).toBeTypeOf('function'))
    const emit = (fromCache: boolean, hasPendingWrites = false) => snapshot({
      docs: [], size: 0, metadata: { fromCache, hasPendingWrites },
    } as unknown as QuerySnapshot)
    act(() => emit(true))
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
    expect(view.result.current.dataUpdatedAt).toBe(0)
    await act(async () => resolveServer([{ id: 'server-expense' }]))
    await waitFor(() => expect(view.result.current.data).toEqual([{ id: 'server-expense' }]))
    expect(view.result.current.dataUpdatedAt).toBeGreaterThan(0)
    act(() => emit(false, true))
    await waitFor(() => expect(view.result.current.dataUpdatedAt).toBe(0))
    act(() => emit(false))
    await waitFor(() => expect(view.result.current.dataUpdatedAt).toBeGreaterThan(0))
    act(() => emit(true))
    await waitFor(() => expect(view.result.current.dataUpdatedAt).toBe(0))
    view.unmount()
    qc.clear()
  })
})

describe('attachment over a form', () => {
  it('routes Escape and Tab to the preview, preserving the draft and restoring focus', () => {
    vi.useFakeTimers()
    const parentClose = vi.fn(), previewClose = vi.fn()
    function Example() {
      const [preview, setPreview] = useState(false)
      return <BottomSheet isOpen title="費用表單" onClose={parentClose}>
        <input aria-label="費用標題" defaultValue="保留草稿" />
        <button type="button" onClick={() => setPreview(true)}>預覽收據</button>
        {preview && <AttachmentPreviewModal url="blob:test" fileType="image/webp" fileName="收據" onClose={() => {
          previewClose()
          setPreview(false)
        }} />}
      </BottomSheet>
    }
    render(<Example />)
    act(() => vi.advanceTimersByTime(50))
    const trigger = screen.getByRole('button', { name: '預覽收據' })
    trigger.focus()
    fireEvent.click(trigger)
    act(() => vi.advanceTimersByTime(50))
    const dialog = screen.getByRole('dialog', { name: '收據' })
    expect(dialog.parentElement).toBe(document.body)
    const closeButton = dialog.querySelector<HTMLButtonElement>('button')!
    closeButton.focus()
    fireEvent.keyDown(closeButton, { key: 'Tab' })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('在新分頁開啟')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(parentClose).not.toHaveBeenCalled()
    expect(previewClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: '費用標題' })).toHaveProperty('value', '保留草稿')
    expect(document.activeElement).toBe(trigger)
  })
})
