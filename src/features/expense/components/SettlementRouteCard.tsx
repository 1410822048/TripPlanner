// src/features/expense/components/SettlementRouteCard.tsx
// One simplified payment suggestion: a transfer ("A → C ¥X，經 B") or a
// debt-cycle offset ("A、B、C 互相抵銷"). Expands to the legs it clears and,
// per leg, the expenses behind it (previewed with the Worker's lineage code),
// so every suggested payment is traceable to concrete expenses.
//
// Who gets the action button mirrors the Worker's authorization:
//   transfer — the receiver; the trip owner when the receiver has left
//   offset   — any participant still on the trip; the owner when all left
// Everyone else sees a status, and an intermediate sees why they don't pay.
import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, Clock, Repeat } from 'lucide-react'
import MemberAvatar from '@/components/ui/MemberAvatar'
import type { TripMember } from '@/features/trips/types'
import { formatMinorAmount } from '@/utils/money'
import { routeRole, type RouteSuggestion } from '../services/settlementRoutes'

interface Props {
  suggestion: RouteSuggestion
  memberById: Map<string, TripMember>
  currency:   string
  uid:        string | null
  /** Owner capability (identity folded with epoch by the page). */
  canRecordForDeparted: boolean
  onRecord:   (suggestion: RouteSuggestion) => void
}

export default function SettlementRouteCard({ suggestion, memberById, currency, uid, canRecordForDeparted, onRecord }: Props) {
  const [open, setOpen] = useState(false)
  const nameOf = (id: string) => memberById.get(id)?.displayName ?? id
  const role = routeRole(suggestion, uid)

  let canRecord: boolean
  let onBehalf: boolean
  if (suggestion.kind === 'TRANSFER') {
    const receiver = memberById.get(suggestion.receiverUid)
    // A signed-in user whose own member doc is gone is their own ghost:
    // `uid === receiver` alone would offer an action the Worker refuses.
    // Even when the owner is the payer: once the receiver has left, the
    // owner is the only one the Worker lets record it (or it stays open).
    onBehalf = canRecordForDeparted && receiver?.isGhost === true
    canRecord = (uid != null && uid === suggestion.receiverUid && receiver?.isGhost !== true) || onBehalf
  } else {
    const people = suggestion.participantUids.map(id => memberById.get(id))
    const allGone = people.every(m => m?.isGhost === true)
    onBehalf = canRecordForDeparted && allGone && !(uid != null && suggestion.participantUids.includes(uid))
    canRecord = (uid != null && suggestion.participantUids.includes(uid) && memberById.get(uid)?.isGhost !== true) || onBehalf
  }

  const viaUids = suggestion.kind === 'TRANSFER'
    ? [...new Set(suggestion.legs.flatMap(l => [l.fromUid, l.toUid]))]
        .filter(id => id !== suggestion.payerUid && id !== suggestion.receiverUid)
    : []

  return (
    <div className="px-2.5 py-2 bg-app rounded-input border border-border">
      <div className="flex items-center gap-2">
        {suggestion.kind === 'TRANSFER' ? (
          <>
            <MemberAvatar member={memberById.get(suggestion.payerUid)!} size={28} />
            <ArrowRight size={12} strokeWidth={2.5} className="text-muted shrink-0" />
            <MemberAvatar member={memberById.get(suggestion.receiverUid)!} size={28} />
          </>
        ) : (
          <div className="w-[28px] h-[28px] rounded-full bg-teal-pale text-teal flex items-center justify-center shrink-0">
            <Repeat size={14} strokeWidth={2.4} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          {suggestion.kind === 'TRANSFER' ? (
            <>
              <div className="text-[14.5px] font-extrabold text-ink tabular-nums -tracking-[0.2px]">
                {formatMinorAmount(suggestion.amountMinor, currency)}
              </div>
              {viaUids.length > 0 && (
                <div className="text-[10px] text-muted font-medium truncate">經 {viaUids.map(nameOf).join('、')}</div>
              )}
            </>
          ) : (
            <>
              <div className="text-[12.5px] font-bold text-ink truncate">{suggestion.participantUids.map(nameOf).join('、')}</div>
              <div className="text-[10px] text-muted font-medium">互相抵銷 · 不需付款</div>
            </>
          )}
        </div>
        {canRecord ? (
          <button
            type="button"
            onClick={() => onRecord(suggestion)}
            aria-label={suggestion.kind === 'TRANSFER'
              ? `${onBehalf ? `代 ${nameOf(suggestion.receiverUid)}（已退出）` : ''}記錄已收到 ${nameOf(suggestion.payerUid)} 支付的 ${formatMinorAmount(suggestion.amountMinor, currency)}`
              : `${onBehalf ? '代已退出成員' : ''}記錄 ${suggestion.participantUids.map(nameOf).join('、')} 互相抵銷`}
            className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full border-none bg-teal text-white text-[10.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
          >
            <Check size={11} strokeWidth={2.8} />
            {suggestion.kind === 'OFFSET'
              ? (onBehalf ? '代記抵銷' : '記錄抵銷')
              : (onBehalf ? '代記已收款' : '已收款')}
          </button>
        ) : (
          <div
            role="status"
            aria-label={suggestion.kind === 'TRANSFER'
              ? (role?.kind === 'payer'
                  ? `等待收款人（${nameOf(suggestion.receiverUid)}）確認`
                  : `尚未確認 ${nameOf(suggestion.payerUid)} 支付給 ${nameOf(suggestion.receiverUid)} 的清算`)
              : '等待參與者確認抵銷'}
            className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full bg-app text-muted text-[10.5px] font-medium tracking-[0.04em] opacity-75"
          >
            <Clock size={11} strokeWidth={2.4} />
            {suggestion.kind === 'TRANSFER' ? '等待收款' : '等待確認'}
          </div>
        )}
      </div>

      {role?.kind === 'intermediate' && (
        <div className="mt-1.5 text-[10.5px] text-muted leading-[1.5]">
          你不用付款：這筆會同時清掉 {role.fromUids.map(nameOf).join('、')} 欠你的與你欠 {role.toUids.map(nameOf).join('、')} 的各 {formatMinorAmount(role.amountMinor, currency)}，你的淨額不變。
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="mt-1 flex items-center gap-0.5 bg-transparent border-none p-0 cursor-pointer text-[10.5px] font-semibold text-muted hover:text-ink"
      >
        <ChevronDown size={11} strokeWidth={2.5} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? '收起明細' : `明細（${suggestion.legs.length} 段）`}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1.5">
          {suggestion.legs.map(leg => (
            <li key={`${leg.fromUid}-${leg.toUid}`} className="text-[11px] text-ink">
              <div className="flex items-center gap-1 tabular-nums">
                <span className="truncate">{nameOf(leg.fromUid)}</span>
                <ArrowRight size={9} strokeWidth={2.5} className="text-muted shrink-0" />
                <span className="truncate">{nameOf(leg.toUid)}</span>
                <span className="ml-auto font-semibold">{formatMinorAmount(leg.amountMinor, currency)}</span>
              </div>
              {leg.sources.length > 0 && (
                <div className="text-[10px] text-muted leading-[1.45]">
                  來源：{leg.sources.map(src =>
                    `${src.itemName ? `${src.expenseTitle} / ${src.itemName}` : src.expenseTitle} ${formatMinorAmount(src.amountMinor, currency)}`,
                  ).join('、')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
