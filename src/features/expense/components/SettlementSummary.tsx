// src/features/expense/components/SettlementSummary.tsx
import { useState } from 'react'
import { ArrowRight, Check, AlertCircle, Trash2, ChevronDown, Clock } from 'lucide-react'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { computeBalancesFull, computeSettlements } from '../services/settlement'
import { formatAmount } from '@/utils/currency'

interface Props {
  expenses:    Expense[]
  members:     TripMember[]
  settlements: SettlementRecord[]
  /** ISO currency code of the trip — used to format amounts inline. */
  currency: string
  /** Current user uid — must equal `toUid` for the「済み」button to
   *  enable. Receiver-only mirrors firestore.rules. */
  uid: string | null
  onMarkSettled: (fromId: string, toId: string, amount: number) => void
  /** Removes a previously recorded settlement. Used to clean up
   *  orphans whose expense was deleted, or to undo a premature「済み」. */
  onDeleteSettlement: (id: string) => void
}

export default function SettlementSummary({
  expenses, members, settlements, currency, uid,
  onMarkSettled, onDeleteSettlement,
}: Props) {
  // computeBalancesFull also returns `participants` (members + ghosts
  // for kicked-out uids still in expenses/settlements). Reusing that
  // list avoids walking expenses/splits/settlements a second time.
  const { balances, orphans, participants } = computeBalancesFull(expenses, members, settlements)
  const suggestions = computeSettlements(balances)
  const memberById  = new Map(participants.map(m => [m.id, m]))

  // Don't render if nothing to show. Even without expenses we still
  // surface the section when settlement records exist (e.g. user deleted
  // every expense after settling — the orphan records need a delete entry).
  if (expenses.length === 0 && settlements.length === 0) return null

  const allSettled = suggestions.length === 0
  const totalOrphan = orphans.reduce((s, o) => s + o.amount, 0)

  return (
    <div className="px-4 mt-4">
      <div className="bg-surface border border-border rounded-[22px] px-5 pt-4 pb-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-muted tracking-[0.1em] uppercase">
            精算
          </div>
          {allSettled && expenses.length > 0 && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-card bg-teal-pale text-teal text-[10px] font-bold tracking-[0.04em]">
              <Check size={10} strokeWidth={3} />
              清算済み
            </div>
          )}
        </div>

        {/* ── 每位成員的淨額 ────────────────────────────── */}
        {expenses.length > 0 && (
          <div className="flex flex-col gap-[3px]">
            {balances.map(b => {
              const m = memberById.get(b.memberId)!
              const isCredit = b.net > 0.5
              const isDebit  = b.net < -0.5
              const rounded  = Math.round(Math.abs(b.net))
              return (
                <div key={b.memberId} className={[
                  'flex items-center gap-2.5 py-[3px]',
                  m.isGhost ? 'opacity-70' : '',
                ].join(' ')}>
                  <MemberAvatar member={m} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-ink font-semibold leading-tight">
                      {m.label}
                    </div>
                    <div className="text-[10px] text-muted tabular-nums mt-px">
                      {m.isGhost && <span className="text-danger font-semibold">退出済み · </span>}
                      立替 {formatAmount(b.paid, currency)} · 分担 {formatAmount(b.owed, currency)}
                    </div>
                  </div>
                  <span
                    className={[
                      'text-[13.5px] font-extrabold tabular-nums -tracking-[0.2px]',
                      isCredit ? 'text-teal'
                        : isDebit ? 'text-danger'
                        : 'text-muted',
                    ].join(' ')}
                  >
                    {isCredit ? '+' : isDebit ? '-' : '±'}{formatAmount(rounded, currency)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* ── 提案 ──────────────────────────────────────── */}
        {expenses.length > 0 && (allSettled ? (
          <div className="mt-3 pt-3 border-t border-dashed border-border text-center">
            <div className="text-[11.5px] text-muted leading-[1.5]">
              全員の支払いがバランスしています 🎉
            </div>
          </div>
        ) : (
          <>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="text-[10.5px] font-semibold text-muted tracking-[0.08em] uppercase mb-2">
              支払い提案（{suggestions.length}件）
            </div>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s, i) => {
                const from = memberById.get(s.fromId)!
                const to   = memberById.get(s.toId)!
                // Receiver-only: only the payee (toId) can mark settled.
                // Payer / third-party see a status pill, not a button.
                const canRecord = uid != null && uid === s.toId
                const isPayer   = uid != null && uid === s.fromId
                return (
                  <div
                    key={`${s.fromId}-${s.toId}-${i}`}
                    className="flex items-center gap-2 px-2.5 py-2 bg-app rounded-input border border-border"
                  >
                    <MemberAvatar member={from} size={28} />
                    <ArrowRight size={12} strokeWidth={2.5} className="text-muted shrink-0" />
                    <MemberAvatar member={to}   size={28} />
                    <div className="flex-1 min-w-0 text-[14.5px] font-extrabold text-ink tabular-nums -tracking-[0.2px]">
                      {formatAmount(s.amount, currency)}
                    </div>
                    {canRecord ? (
                      <button
                        type="button"
                        onClick={() => onMarkSettled(s.fromId, s.toId, s.amount)}
                        aria-label={`${from.label}から ${formatAmount(s.amount, currency)} の受取を清算済みとして記録`}
                        className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full border-none bg-teal text-white text-[10.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
                      >
                        <Check size={11} strokeWidth={2.8} />
                        済み
                      </button>
                    ) : (
                      <div
                        role="status"
                        aria-label={isPayer
                          ? `受取人(${to.label})の確認待ち`
                          : `${from.label}から${to.label}への清算は未確認`}
                        title={isPayer ? '受取人(あなたではない側)が確認します' : undefined}
                        className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full bg-app text-muted text-[10.5px] font-medium tracking-[0.04em] opacity-75"
                      >
                        <Clock size={11} strokeWidth={2.4} />
                        受取待ち
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        ))}

        {/* ── 清算済み記録 + orphan 警告 ────────────────── */}
        {settlements.length > 0 && (
          <SettlementHistory
            settlements={settlements}
            memberById={memberById}
            currency={currency}
            uid={uid}
            totalOrphan={totalOrphan}
            onDelete={onDeleteSettlement}
          />
        )}
      </div>
    </div>
  )
}

// ─── Settlement history sub-component ──────────────────────────────

interface HistoryProps {
  settlements: SettlementRecord[]
  memberById:  Map<string, TripMember>
  currency:    string
  uid:         string | null
  /** Aggregate orphan amount across all pairs. Triggers the warning
   *  banner above the list when > 0 — explains why some settlements
   *  may look detached from the balance view. */
  totalOrphan: number
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

function SettlementHistory({
  settlements, memberById, currency, uid, totalOrphan, onDelete,
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
          清算済み記録（{settlements.length}件）
        </div>
      </div>

      {totalOrphan > 0 && (
        <div
          className="flex items-start gap-1.5 px-2.5 py-1.5 mb-2 rounded-input"
          style={{
            background: '#FFF4E0',
            border: '1px solid #F0D49B',
          }}
        >
          <AlertCircle size={12} className="shrink-0 mt-px" style={{ color: '#B5651D' }} />
          <div className="text-[10.5px] leading-[1.5]" style={{ color: '#7A4A12' }}>
            <span className="font-semibold">未對應的清算 {formatAmount(totalOrphan, currency)}</span>
            <span className="opacity-80"> · 對應費用已被刪除,或屬於過度支付。如不需要可從下方刪除。</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {visible.map(s => {
          const from = memberById.get(s.fromUid)
          const to   = memberById.get(s.toUid)
          if (!from || !to) return null
          // firestore.rules: delete allowed for settledBy uid or trip owner.
          // We check the obvious one client-side (recorder); owner case
          // would need useIsTripOwner — kept off for now to avoid widening
          // props, since recorders covering their own records is the
          // dominant use case.
          const canDelete = uid != null && uid === s.settledBy
          return (
            <SettlementRow
              key={s.id}
              record={s}
              from={from}
              to={to}
              currency={currency}
              canDelete={canDelete}
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
          {expanded ? '折りたたむ' : `他 ${hiddenCount} 件を表示`}
        </button>
      )}
    </>
  )
}

// ─── Single settlement record row ──────────────────────────────────

interface RowProps {
  record:    SettlementRecord
  from:      TripMember
  to:        TripMember
  currency:  string
  canDelete: boolean
  onDelete:  () => void
}

function SettlementRow({ record, from, to, currency, canDelete, onDelete }: RowProps) {
  // Two-tap confirm: matches the swipe-to-delete pattern elsewhere in
  // the app — first tap arms the action with a red label, second tap
  // commits. Keeps a single accidental tap from wiping a settlement.
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-app rounded-input">
      <MemberAvatar member={from} size={20} />
      <ArrowRight size={10} strokeWidth={2.5} className="text-muted shrink-0" />
      <MemberAvatar member={to} size={20} />
      <div className="flex-1 min-w-0 text-[11.5px] font-semibold text-ink tabular-nums -tracking-[0.2px]">
        {formatAmount(record.amount, currency)}
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={() => {
            if (confirming) onDelete()
            else setConfirming(true)
          }}
          onBlur={() => setConfirming(false)}
          aria-label={confirming
            ? '清算記録の削除を確認'
            : '清算記録を削除'}
          className={[
            'shrink-0 flex items-center gap-0.5 px-2 h-6 rounded-full border-none text-[10px] font-bold tracking-[0.04em] cursor-pointer transition-colors',
            confirming
              ? 'bg-danger text-white'
              : 'bg-transparent text-muted hover:bg-border',
          ].join(' ')}
        >
          {confirming ? '確認' : <Trash2 size={11} strokeWidth={2} />}
        </button>
      )}
    </div>
  )
}

