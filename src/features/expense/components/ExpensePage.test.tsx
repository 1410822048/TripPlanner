import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Timestamp } from 'firebase/firestore'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

const harness = vi.hoisted(() => ({
  expenses: [] as Expense[],
  members: [] as TripMember[],
  settlements: [] as unknown[],
  uid: 'u1',
  canWrite: true,
  isOwner: false,
  currency: 'JPY',
  openAdd: vi.fn(),
  openEdit: vi.fn(),
  closeModal: vi.fn(),
  openSignIn: vi.fn(),
  closeSignIn: vi.fn(),
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteExpense: vi.fn(),
  createSettlement: vi.fn(),
  deleteSettlement: vi.fn(),
  modalIsOpen: false,
  modalEditTarget: null as Expense | null,
}))

vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({
    isOpen,
    title,
    children,
    footer,
  }: {
    isOpen: boolean
    title: string
    children: ReactNode
    footer?: ReactNode
  }) => (
    isOpen
      ? <div role="dialog" aria-label={title}><h2>{title}</h2>{children}{footer}</div>
      : null
  ),
}))

vi.mock('@/features/attachments/components/AttachmentPreviewModal', () => ({
  default: ({ fileName, onClose }: { fileName: string; onClose: () => void }) => (
    <div role="dialog" aria-label="attachment-preview">
      preview:{fileName}
      <button type="button" onClick={onClose}>preview close</button>
    </div>
  ),
}))

vi.mock('@/hooks/useFeatureListPage', () => ({
  useFeatureListPage: () => ({
    ctx: {
      status: 'cloud',
      trip: { id: 'trip-1', title: 'Tokyo', ownerId: 'owner-1' },
    },
    uid: harness.uid,
    cloudTripId: 'trip-1',
    mutationTripId: 'trip-1',
    isDemo: false,
    canWrite: harness.canWrite,
    isOwner: harness.isOwner,
    modal: {
      isOpen: harness.modalIsOpen,
      key: 'closed',
      editTarget: harness.modalEditTarget,
      openAdd: harness.openAdd,
      openEdit: harness.openEdit,
      close: harness.closeModal,
    },
    signIn: {
      isOpen: false,
      open: harness.openSignIn,
      close: harness.closeSignIn,
    },
  }),
}))

vi.mock('../hooks/useExpenses', () => ({
  expenseUpdateMutationKey: ['expenses', 'update'],
  useExpenses: () => ({ data: harness.expenses, isLoading: false }),
  useCreateExpense: () => ({ mutate: harness.createExpense }),
  useUpdateExpense: () => ({ mutate: harness.updateExpense }),
  useDeleteExpense: () => ({ mutateAsync: harness.deleteExpense }),
}))

vi.mock('../hooks/useSettlements', () => ({
  useSettlements: () => ({ data: harness.settlements }),
  useCreateSettlement: () => ({ mutate: harness.createSettlement }),
  useDeleteSettlement: () => ({ mutate: harness.deleteSettlement }),
}))

vi.mock('@/features/members/hooks/useMembers', () => ({
  useMembers: () => ({ data: harness.members }),
}))

vi.mock('@/features/members/utils', () => ({
  membersToTripMembers: (members: TripMember[]) => members,
}))

vi.mock('@/features/trips/hooks/useTripRole', () => ({
  useIsTripOwner: () => harness.isOwner,
}))

vi.mock('@/hooks/usePendingMutationIds', () => ({
  usePendingMutationIds: () => new Set<string>(),
}))

vi.mock('@/hooks/useTripCurrency', () => ({
  useTripCurrency: () => harness.currency,
}))

vi.mock('@/hooks/useAttachmentUrl', () => ({
  useAttachmentUrl: (path: string | null | undefined, opts: { kind: 'thumb' | 'full' }) =>
    path ? `blob:${opts.kind}:${path}` : null,
}))

vi.mock('./SettlementSummary', () => ({ default: () => null }))
vi.mock('./SettlementRecordSheet', () => ({ default: () => null }))
vi.mock('./ExpenseFormModal', () => ({
  default: ({ editTarget }: { editTarget: Expense | null }) => (
    <div role="dialog" aria-label={editTarget ? 'expense-edit' : 'expense-create'} />
  ),
}))
vi.mock('@/features/auth/components/SignInPromptModal', () => ({ default: () => null }))
vi.mock('@/components/ui/DemoBanner', () => ({ default: () => null }))
vi.mock('@/components/ui/NoTripEmptyState', () => ({ default: () => null }))

import ExpensePage from './ExpensePage'

const TS = {} as unknown as Timestamp

const MEMBERS: TripMember[] = [
  { id: 'u1', label: 'A', color: '#111', bg: '#fff' },
  { id: 'u2', label: 'B', color: '#111', bg: '#fff' },
]

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    tripId: 'trip-1',
    title: 'Cafe receipt',
    amountMinor: 1200,
    currency: 'JPY',
    category: 'food',
    paidBy: 'u1',
    splits: [
      { memberId: 'u1', amountMinor: 600 },
      { memberId: 'u2', amountMinor: 600 },
    ],
    date: '2026-06-17',
    adjustments: [],
    createdBy: 'u1',
    updatedBy: 'u1',
    memberIds: ['u1', 'u2'],
    createdAt: TS,
    updatedAt: TS,
    deletedAt: null,
    receiptPurgedAt: null,
    ...overrides,
  }
}

function receiptExpense(overrides: Partial<Expense> = {}): Expense {
  return expense({
    receipt: {
      path: 'trips/trip-1/expenses/e1/receipt.webp',
      thumbPath: 'trips/trip-1/expenses/e1/thumb.webp',
      type: 'image/webp',
    },
    ...overrides,
  })
}

beforeEach(() => {
  harness.expenses = [receiptExpense()]
  harness.members = MEMBERS
  harness.settlements = []
  harness.uid = 'u1'
  harness.canWrite = true
  harness.isOwner = false
  harness.currency = 'JPY'
  harness.openAdd.mockReset()
  harness.openEdit.mockReset()
  harness.closeModal.mockReset()
  harness.openSignIn.mockReset()
  harness.closeSignIn.mockReset()
  harness.createExpense.mockReset()
  harness.updateExpense.mockReset()
  harness.deleteExpense.mockReset()
  harness.deleteExpense.mockResolvedValue(undefined)
  harness.createSettlement.mockReset()
  harness.deleteSettlement.mockReset()
  harness.modalIsOpen = false
  harness.modalEditTarget = null
})

describe('ExpensePage read-first expense flow', () => {
  it('opens the read-only detail sheet before editing an expense', () => {
    render(<ExpensePage />)

    const detailButton = screen.getByRole('button', { name: '顯示 Cafe receipt 的詳細資料' })
    expect(detailButton.tagName).toBe('BUTTON')
    fireEvent.click(detailButton)

    expect(screen.getByRole('dialog', { name: '費用詳情' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '編輯' })).toBeTruthy()
    expect(harness.openEdit).not.toHaveBeenCalled()
  })

  it('opens the receipt preview from the thumbnail without opening detail', () => {
    render(<ExpensePage />)

    fireEvent.click(screen.getByRole('button', { name: '顯示收據' }))

    expect(screen.getByRole('dialog', { name: 'attachment-preview' })).toBeTruthy()
    expect(screen.getByText('preview:receipt.webp')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '費用詳情' })).toBeNull()
  })

  it('opens receipt preview from detail through the page overlay and returns to detail on close', () => {
    render(<ExpensePage />)

    fireEvent.click(screen.getByText('Cafe receipt'))

    const detail = screen.getByRole('dialog', { name: '費用詳情' })
    fireEvent.click(within(detail).getByRole('button', { name: /receipt\.webp/ }))

    expect(screen.getByRole('dialog', { name: 'attachment-preview' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '費用詳情' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'preview close' }))

    expect(screen.getByRole('dialog', { name: '費用詳情' })).toBeTruthy()
  })

  it('does not offer edit from detail for a locked expense when the viewer is not owner', () => {
    harness.expenses = [receiptExpense({ settlementLockIds: ['settlement-1'] })]
    harness.canWrite = true
    harness.isOwner = false

    render(<ExpensePage />)

    fireEvent.click(screen.getByText('Cafe receipt'))

    const detail = screen.getByRole('dialog', { name: '費用詳情' })
    expect(detail).toBeTruthy()
    expect(within(detail).getByText('已清算')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '編輯' })).toBeNull()
  })

  it('downgrades an open edit form to read-only detail when the expense becomes settlement-locked', async () => {
    const locked = receiptExpense({ settlementLockIds: ['settlement-1'] })
    harness.expenses = [locked]
    harness.modalIsOpen = true
    harness.modalEditTarget = locked
    harness.canWrite = true
    harness.isOwner = false

    render(<ExpensePage />)

    expect(screen.queryByRole('dialog', { name: 'expense-edit' })).toBeNull()

    const detail = screen.getByRole('dialog', { name: '費用詳情' })
    expect(within(detail).getByText('已清算')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '編輯' })).toBeNull()
    expect(harness.closeModal).not.toHaveBeenCalled()
  })

  it('does not strand the modal when a settlement-locked edit target has been soft-deleted', async () => {
    // X 被 owner soft-delete(deletedAt 已設 → 從 active 列表濾掉),但仍被
    // settlement lineage 鎖定,所以 expenseById 查不到 X、readonly detail 無法
    // 渲染。guard 讓 redirect 退回 null,form modal 正常顯示(可關閉),而非
    // form 與 detail 兩者皆空、modal.isOpen 卻卡在 true。
    const deleted = receiptExpense({ id: 'e-del', deletedAt: TS })
    harness.expenses = [deleted]
    harness.settlements = [{ id: 's1', appliedExpenseIds: ['e-del'] }]
    harness.modalIsOpen = true
    harness.modalEditTarget = deleted
    harness.canWrite = true
    harness.isOwner = false

    render(<ExpensePage />)

    expect(screen.queryByRole('dialog', { name: 'expense-edit' })).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: '費用詳情' })).toBeNull()
  })
})
