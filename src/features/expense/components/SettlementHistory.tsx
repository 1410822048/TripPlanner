// src/features/expense/components/SettlementHistory.tsx
// The「清算済み記録」section of the settlement card: an optional aggregate
// orphan warning banner, the most-recent-N settlement rows (fold/unfold for
// the rest), each delegated to SettlementRow. The orphan classification +
// balances are computed by the parent (SettlementSummary) and passed in;
// this component only owns the fold state.
import { useState } from 'react'
import { AlertCircle, ChevronDown } from 'lucide-react'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'
import type { OrphanReason, OrphanSettlement } from '../services/settlement'
import { formatMinorAmount } from '@/utils/money'
import { orphanReasonExplain } from './settlementOrphanCopy'
import SettlementRow from './SettlementRow'

interface HistoryProps {
  expenses:    Expense[]
  settlements: SettlementRecord[]
  memberById:  Map<string, TripMember>
  currency:    string
  uid:         string | null
  isOwner:     boolean
  /** Aggregate orphan amount across all pairs, in integer minor units.
   *  Triggers the warning banner above the list when > 0 — explains
   *  why some settlements may look detached from the balance view. */
  totalOrphanMinor: number
  /** Orphan amount split by reason -- drives reason-specific banner
   *  copy. Missing keys mean 0 for that reason. */
  orphanByReason: Partial<Record<OrphanReason, number>>
  /** Per-settlement orphan lookup. Each history row uses this to
   *  render its own reason chip; rows whose id is absent are matched
   *  (no chip). */
  orphanById:  Map<string, OrphanSettlement>
  onDelete:    (id: string) => void
}

/**
 * 預設只展開最近 N 筆,超過的折疊起來 — 長行程結算筆數會累積,完全攤開
 * 會把整張卡片拉很長。N=3 跟 ExpenseDateGroups 同樣的「最新優先」啟發
 * 式:絕大多數人想看的就是最近一次的金額確認,更舊的當作審計用,折起來
 * 不擋路。settlements 來自 service 端已 orderBy('createdAt', 'desc'),
 * 所以 slice(0, N) 就是「最新 N 筆」。
 */
const DEFAULT_VISIBLE = 3

export default function SettlementHistory({
  expenses, settlements, memberById, currency, uid, isOwner, totalOrphanMinor, orphanByReason, orphanById, onDelete,
}: HistoryProps) {
  const [expanded, setExpanded] = useState(false)
  const visible    = expanded ? settlements : settlements.slice(0, DEFAULT_VISIBLE)
  const hiddenCount = settlements.length - visible.length
  const canFold    = settlements.length > DEFAULT_VISIBLE

  return (
    <>
      <div className="my-3 border-t border-dashed border-border" />
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10.5px] font-semibold text-muted tracking-[0.08em] uppercase">
          已清算紀錄（{settlements.length} 筆）
        </div>
      </div>

      {totalOrphanMinor > 0 && (
        <div
          className="flex items-start gap-1.5 px-2.5 py-1.5 mb-2 rounded-input"
          style={{
            background: '#FFF4E0',
            border: '1px solid #F0D49B',
          }}
        >
          <AlertCircle size={12} className="shrink-0 mt-px" style={{ color: '#B5651D' }} />
          <div className="text-[10.5px] leading-[1.5]" style={{ color: '#7A4A12' }}>
            <span className="font-semibold">未對應的清算 {formatMinorAmount(totalOrphanMinor, currency)}</span>
            <span className="opacity-80">{' · '}{orphanReasonExplain(orphanByReason)}</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {visible.map(s => {
          const from = memberById.get(s.fromUid)
          const to   = memberById.get(s.toUid)
          if (!from || !to) return null
          // Worker (settlement-delete) allows the recorder OR the trip
          // owner. Mirror BOTH client-side so the owner's correction path
          // (deleting a settlement another member mis-recorded) is reachable
          // from the UI — not just the recorder deleting their own.
          const canDelete = isOwner || (uid != null && uid === s.settledBy)
          return (
            <SettlementRow
              key={s.id}
              record={s}
              from={from}
              to={to}
              currency={currency}
              expenses={expenses}
              canDelete={canDelete}
              orphan={orphanById.get(s.id)}
              onDelete={() => onDelete(s.id)}
            />
          )
        })}
      </div>

      {canFold && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className="mt-1.5 w-full flex items-center justify-center gap-1 py-1.5 bg-transparent border-none cursor-pointer text-[10.5px] font-semibold text-muted hover:text-ink tracking-[0.04em] transition-colors"
        >
          <ChevronDown
            size={12}
            strokeWidth={2.5}
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          {expanded ? '收起' : `顯示其他 ${hiddenCount} 筆`}
        </button>
      )}
    </>
  )
}
