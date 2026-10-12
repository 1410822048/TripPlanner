// src/features/expense/components/SettlementRouteRow.tsx
// One logical routed settlement in the「已清算紀錄」list: every leg of the
// route merged into a single row (payer → receiver, or an offset), with the
// legs, their expense sources and any orphan explanation behind a toggle.
// Cancelling is all-or-nothing — the Worker cancels the whole route from any
// one leg — so the confirm copy says so.
import { useState } from 'react'
import { AlertCircle, ArrowRight, ChevronDown, Repeat, Trash2 } from 'lucide-react'
import MemberAvatar from '@/components/ui/MemberAvatar'
import type { TripMember } from '@/features/trips/types'
import type { SettlementRecord, SettlementRouteHeader } from '@/types/settlement'
import type { OrphanSettlement } from '../services/settlement'
import { formatMinorAmount } from '@/utils/money'
import { ORPHAN_REASON_COPY, ORPHAN_REASON_LABEL } from './settlementOrphanCopy'

interface Props {
  header:     SettlementRouteHeader
  legs:       SettlementRecord[]
  memberById: Map<string, TripMember>
  currency:   string
  canDelete:  boolean
  /** Orphan entries for this route's legs (empty when fully backed). */
  orphans:    OrphanSettlement[]
  onDelete:   () => void
}

export default function SettlementRouteRow({ header, legs, memberById, currency, canDelete, orphans, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(orphans.length > 0)
  const nameOf = (id: string) => memberById.get(id)?.displayName ?? id
  const member = (id: string) => memberById.get(id)
  const isTransfer = header.kind === 'TRANSFER'
  const viaUids = isTransfer
    ? header.participantUids.filter(id => id !== header.payerUid && id !== header.receiverUid)
    : []
  const orphanTotal = orphans.reduce((s, o) => s + o.amountMinor, 0)
  const orphanByLeg = new Map(orphans.map(o => [o.settlementId, o]))
  const payer = isTransfer ? member(header.payerUid!) : undefined
  const receiver = isTransfer ? member(header.receiverUid!) : undefined

  return (
    <div className="px-2.5 py-1.5 bg-app rounded-input">
      <div className="flex items-center gap-2">
        {isTransfer && payer && receiver ? (
          <>
            <MemberAvatar member={payer} size={20} />
            <ArrowRight size={10} strokeWidth={2.5} className="text-muted shrink-0" />
            <MemberAvatar member={receiver} size={20} />
          </>
        ) : (
          <div className="w-5 h-5 rounded-full bg-teal-pale text-teal flex items-center justify-center shrink-0">
            <Repeat size={11} strokeWidth={2.4} />
          </div>
        )}
        <div className="flex-1 min-w-0 tabular-nums -tracking-[0.2px] leading-tight">
          {isTransfer ? (
            header.sourceCurrency !== undefined && header.sourceAmountMinor !== undefined ? (
              <>
                <div className="text-[11.5px] font-semibold text-ink">{formatMinorAmount(header.sourceAmountMinor, header.sourceCurrency)}</div>
                <div className="text-[10px] text-muted font-medium mt-px">{formatMinorAmount(header.amountMinor ?? 0, currency)}</div>
              </>
            ) : (
              <div className="text-[11.5px] font-semibold text-ink">{formatMinorAmount(header.amountMinor ?? 0, currency)}</div>
            )
          ) : (
            <div className="text-[11.5px] font-semibold text-ink truncate">
              {header.participantUids.map(nameOf).join('、')} 互相抵銷
            </div>
          )}
          {viaUids.length > 0 && (
            <div className="text-[10px] text-muted font-medium mt-px truncate">經 {viaUids.map(nameOf).join('、')}</div>
          )}
          {header.ownerRecorded && (
            <div className="text-[10px] text-muted font-medium mt-px">由旅程擁有者代為記錄</div>
          )}
          {header.note && (
            <div className="text-[10px] text-muted font-medium mt-px truncate" title={header.note}>{header.note}</div>
          )}
        </div>
        {orphanTotal > 0 && (
          <span
            aria-label={`未對應 ${formatMinorAmount(orphanTotal, currency)}`}
            className="shrink-0 inline-flex items-center gap-0.5 px-1.5 h-5 rounded-full text-[9.5px] font-bold tracking-[0.02em]"
            style={{ background: '#FFF4E0', color: '#7A4A12', border: '1px solid #F0D49B' }}
          >
            <AlertCircle size={9} strokeWidth={2.5} />
            未對應 {formatMinorAmount(orphanTotal, currency)}
          </span>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => {
              if (confirming) onDelete()
              else setConfirming(true)
            }}
            onBlur={() => setConfirming(false)}
            aria-label={confirming ? '確認刪除整筆清算紀錄（含所有轉交段）' : '刪除清算紀錄'}
            className={[
              'shrink-0 flex items-center gap-0.5 px-2 h-6 rounded-full border-none text-[10px] font-bold tracking-[0.04em] cursor-pointer transition-colors',
              confirming ? 'bg-danger text-white' : 'bg-transparent text-muted hover:bg-border',
            ].join(' ')}
          >
            {confirming ? (legs.length > 1 ? '整筆刪除' : '確認') : <Trash2 size={11} strokeWidth={2} />}
          </button>
        )}
      </div>

      <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="mt-0.5 flex items-center gap-0.5 bg-transparent border-none p-0 cursor-pointer text-[10px] font-semibold text-muted hover:text-ink"
          >
            <ChevronDown size={10} strokeWidth={2.5} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            {open ? '收起' : `明細（${legs.length} 段）`}
          </button>
          {open && (
            <ul className="mt-1 flex flex-col gap-1">
              {legs.map(leg => {
                const orphan = orphanByLeg.get(leg.id)
                return (
                  <li key={leg.id} className="text-[10.5px] text-ink">
                    <div className="flex items-center gap-1 tabular-nums">
                      <span className="truncate">{nameOf(leg.fromUid)}</span>
                      <ArrowRight size={9} strokeWidth={2.5} className="text-muted shrink-0" />
                      <span className="truncate">{nameOf(leg.toUid)}</span>
                      <span className="ml-auto font-semibold">{formatMinorAmount(leg.amountMinor, currency)}</span>
                    </div>
                    {(leg.appliedSources?.length ?? 0) > 0 && (
                      <div className="text-[10px] text-muted leading-[1.45]">
                        來源：{leg.appliedSources!.map(src =>
                          `${src.itemName ? `${src.expenseTitle} / ${src.itemName}` : src.expenseTitle} ${formatMinorAmount(src.amountMinor, currency)}`,
                        ).join('、')}
                      </div>
                    )}
                    {orphan && (
                      <div className="text-[10px] leading-[1.45]" style={{ color: '#7A4A12' }} title={ORPHAN_REASON_COPY[orphan.reason]}>
                        {ORPHAN_REASON_LABEL[orphan.reason]} {formatMinorAmount(orphan.amountMinor, currency)}：{ORPHAN_REASON_COPY[orphan.reason]}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </>
    </div>
  )
}
