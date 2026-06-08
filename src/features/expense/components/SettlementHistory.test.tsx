// Render + fireEvent tests for SettlementHistory — the「清算済み記録」section
// extracted from SettlementSummary. Covers the logic this component owns:
// the recent-N fold/unfold, the aggregate orphan banner + reason copy, the
// recorder-or-owner delete gate it derives per row, the per-row orphan
// classification it threads down, and skipping rows whose member is gone.
// Pure presentation — no mocks; SettlementRow is exercised as the real child.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettlementHistory from './SettlementHistory'
import { ORPHAN_REASON_COPY } from './settlementOrphanCopy'
import type { TripMember } from '@/features/trips/types'
import type { SettlementRecord } from '@/types/settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

const A: TripMember = { id: 'u1', label: 'A', color: '#000', bg: '#fff' }
const B: TripMember = { id: 'u2', label: 'B', color: '#000', bg: '#fff' }
const memberById = new Map([[A.id, A], [B.id, B]])

function rec(id: string, over: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id, tripId: 't1', fromUid: 'u1', toUid: 'u2',
    amountMinor: 5000, currency: 'JPY', settledBy: 'u2', createdAt: TS,
    ...over,
  }
}

type HistoryProps = Parameters<typeof SettlementHistory>[0]
function renderHistory(over: Partial<HistoryProps> = {}) {
  const onDelete = over.onDelete ?? vi.fn()
  render(
    <SettlementHistory
      expenses={[]} settlements={[rec('s1')]} memberById={memberById}
      currency="JPY" uid={null} isOwner={false}
      totalOrphanMinor={0} orphanByReason={{}} orphanById={new Map()}
      onDelete={onDelete}
      {...over}
    />,
  )
  return onDelete
}

const DELETE = { name: '清算記録を削除' }

describe('SettlementHistory — fold', () => {
  it('shows only the most recent 3 rows, expanding to all on tap', () => {
    const settlements = [1, 2, 3, 4, 5].map(n => rec(`s${n}`, { amountMinor: n * 1000 }))
    renderHistory({ settlements, isOwner: true, uid: 'x' })
    expect(screen.getAllByRole('button', DELETE)).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: /他 2 件を表示/ }))
    expect(screen.getAllByRole('button', DELETE)).toHaveLength(5)
    expect(screen.getByRole('button', { name: /折りたたむ/ })).toBeTruthy()
  })

  it('shows no fold control at or below the visible threshold', () => {
    renderHistory({ settlements: [rec('s1'), rec('s2'), rec('s3')], isOwner: true, uid: 'x' })
    expect(screen.queryByRole('button', { name: /件を表示/ })).toBeNull()
  })
})

describe('SettlementHistory — orphan banner', () => {
  it('renders the warning banner with the single-reason copy', () => {
    renderHistory({ totalOrphanMinor: 5000, orphanByReason: { EXPENSE_DELETED: 5000 } })
    expect(screen.getByText(/未對應的清算/)).toBeTruthy()
    expect(screen.getByText(/對應的費用已被刪除/)).toBeTruthy()
  })

  it('omits the banner when there are no orphans', () => {
    renderHistory({ totalOrphanMinor: 0, orphanByReason: {} })
    expect(screen.queryByText(/未對應的清算/)).toBeNull()
  })
})

describe('SettlementHistory — delete gate + wiring', () => {
  it('hides delete for a viewer who is neither recorder nor owner', () => {
    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u9', isOwner: false })
    expect(screen.queryByRole('button', DELETE)).toBeNull()
  })

  it('shows delete for the recorder, and for the owner of any record', () => {
    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u2', isOwner: false })
    expect(screen.getByRole('button', DELETE)).toBeTruthy()

    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u9', isOwner: true })
    expect(screen.getAllByRole('button', DELETE).length).toBeGreaterThan(0)
  })

  it('threads the per-row orphan classification and bubbles the record id on delete', () => {
    const onDelete = vi.fn()
    renderHistory({
      settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u2', isOwner: false, onDelete,
      orphanById: new Map([['s1', { fromUserId: 'u1', toUserId: 'u2', amountMinor: 5000, settlementId: 's1', reason: 'OVERPAYMENT' }]]),
    })
    expect(screen.getByTitle(ORPHAN_REASON_COPY.OVERPAYMENT).getAttribute('aria-label')).toContain('多付')

    fireEvent.click(screen.getByRole('button', DELETE))
    fireEvent.click(screen.getByRole('button', { name: '清算記録の削除を確認' }))
    expect(onDelete).toHaveBeenCalledWith('s1')
  })

  it('skips a row whose member is missing from memberById', () => {
    renderHistory({ settlements: [rec('s1', { fromUid: 'ghost' })], isOwner: true, uid: 'x' })
    expect(screen.queryByRole('button', DELETE)).toBeNull()
  })
})
