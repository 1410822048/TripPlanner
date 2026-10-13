// Render + fireEvent tests for SettlementHistory — the「已清算紀錄」section
// extracted from SettlementSummary. Covers the logic this component owns:
// one row per route however many legs it has, the recent-N fold/unfold, the
// aggregate orphan banner + reason copy, the recorder-or-owner delete gate,
// the per-leg orphan classification it threads down, and that cancelling
// names every leg of the route. Pure presentation — no mocks;
// SettlementRouteRow is exercised as the real child.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettlementHistory from './SettlementHistory'
import { ORPHAN_REASON_COPY } from './settlementOrphanCopy'
import type { TripMember } from '@/features/trips/types'
import type { SettlementRecord } from '@/types/settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

const A: TripMember = { id: 'u1', displayName: 'Alice', avatarLabel: 'A', color: '#000', bg: '#fff' }
const B: TripMember = { id: 'u2', displayName: 'Bob', avatarLabel: 'B', color: '#000', bg: '#fff' }
const C: TripMember = { id: 'u3', displayName: 'Carol', avatarLabel: 'C', color: '#000', bg: '#fff' }
const memberById = new Map([[A.id, A], [B.id, B], [C.id, C]])

/** A one-leg route u1 → u2 recorded by u2. */
function rec(routeId: string, over: Partial<SettlementRecord> = {}): SettlementRecord {
  const amountMinor = over.amountMinor ?? 5000
  return {
    id: `${routeId}-00`, tripId: 't1', fromUid: 'u1', toUid: 'u2',
    amountMinor, currency: 'JPY', settledBy: 'u2', createdAt: TS, deletedAt: null,
    route: { id: routeId, legIndex: 0, legCount: 1, kind: 'TRANSFER', participantUids: ['u1', 'u2'], payerUid: 'u1', receiverUid: 'u2', amountMinor },
    ...over,
  }
}

/** u1 → u3 via u2, two legs. */
function viaB(routeId: string): SettlementRecord[] {
  const header = { id: routeId, legCount: 2, kind: 'TRANSFER' as const, participantUids: ['u1', 'u2', 'u3'], payerUid: 'u1', receiverUid: 'u3', amountMinor: 700 }
  return [
    { ...rec(routeId), id: `${routeId}-00`, fromUid: 'u1', toUid: 'u2', amountMinor: 700, settledBy: 'u3', route: { ...header, legIndex: 0 } },
    { ...rec(routeId), id: `${routeId}-01`, fromUid: 'u2', toUid: 'u3', amountMinor: 700, settledBy: 'u3', route: { ...header, legIndex: 1 } },
  ]
}

type HistoryProps = Parameters<typeof SettlementHistory>[0]
function renderHistory(over: Partial<HistoryProps> = {}) {
  const onDelete = over.onDelete ?? vi.fn()
  render(
    <SettlementHistory
      settlements={[rec('s1')]} memberById={memberById}
      currency="JPY" uid={null} canDeleteAnySettlement={false}
      totalOrphanMinor={0} orphanByReason={{}} orphanById={new Map()}
      onDelete={onDelete}
      {...over}
    />,
  )
  return onDelete
}

const DELETE = { name: '刪除清算紀錄' }

describe('SettlementHistory — one row per route', () => {
  it('a two-leg route is one entry, showing who it went through', () => {
    renderHistory({ settlements: viaB('r1') })
    expect(screen.getByText(/已清算紀錄（1 筆）/)).toBeTruthy()
    expect(screen.getByText('經 Bob')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /明細（2 段）/ }))
    expect(screen.getAllByText(/Alice|Bob|Carol/).length).toBeGreaterThan(2)
  })
})

describe('SettlementHistory — fold', () => {
  it('shows only the most recent 3 routes, expanding to all on tap', () => {
    const settlements = [1, 2, 3, 4, 5].map(n => rec(`s${n}`, { amountMinor: n * 1000 }))
    renderHistory({ settlements, canDeleteAnySettlement: true, uid: 'x' })
    expect(screen.getAllByRole('button', DELETE)).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: /顯示其他 2 筆/ }))
    expect(screen.getAllByRole('button', DELETE)).toHaveLength(5)
    expect(screen.getByRole('button', { name: /收起/ })).toBeTruthy()
  })

  it('counts routes, not legs, toward the fold threshold', () => {
    renderHistory({ settlements: [...viaB('r1'), ...viaB('r2'), ...viaB('r3')], canDeleteAnySettlement: true, uid: 'x' })
    expect(screen.queryByRole('button', { name: /顯示其他/ })).toBeNull()
    expect(screen.getAllByRole('button', DELETE)).toHaveLength(3)
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
    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u9', canDeleteAnySettlement: false })
    expect(screen.queryByRole('button', DELETE)).toBeNull()
  })

  it('shows delete for the recorder, and for the owner of any record', () => {
    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u2', canDeleteAnySettlement: false })
    expect(screen.getByRole('button', DELETE)).toBeTruthy()

    renderHistory({ settlements: [rec('s1', { settledBy: 'u2' })], uid: 'u9', canDeleteAnySettlement: true })
    expect(screen.getAllByRole('button', DELETE).length).toBeGreaterThan(0)
  })

  it('threads the per-leg orphan classification and cancels every leg of the route', () => {
    const onDelete = vi.fn()
    const legs = viaB('r1')
    renderHistory({
      settlements: legs, uid: 'u3', canDeleteAnySettlement: false, onDelete,
      orphanById: new Map([['r1-01', { fromUserId: 'u2', toUserId: 'u3', amountMinor: 700, settlementId: 'r1-01', reason: 'OVERPAYMENT' }]]),
    })
    expect(screen.getByLabelText(/未對應/)).toBeTruthy()
    // Opened by default when something is unmatched, with the reason copy.
    expect(screen.getByTitle(ORPHAN_REASON_COPY.OVERPAYMENT)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', DELETE))
    fireEvent.click(screen.getByRole('button', { name: /確認刪除整筆清算紀錄/ }))
    expect(onDelete).toHaveBeenCalledWith('r1-00', ['r1-00', 'r1-01'])
  })
})
