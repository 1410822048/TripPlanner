// src/features/expense/components/SettlementRecordSheet.tsx
// 記錄清算 — one sheet for every routed settlement the user can record:
//
//   - TRANSFER / 'suggestion': the receiver confirms a planned payment
//     ("A 付給你 ¥X，經 B"). Amount fixed.
//   - TRANSFER / 'payment' (「記錄收款」): the receiver records what someone
//     actually paid them — pick the payer, enter the amount (capped at what
//     the debt graph can explain, maxPayable).
//   - OFFSET: a participant confirms a debt cycle cleared with no payment.
//
// The route sent is computed from the LIVE ledger at render time
// (paymentRoute): the planned legs while they still match, else a fresh
// route for the same payment. A stale suggestion is therefore replanned,
// never forced through — and the Worker still CAS-checks every leg. An
// offset can't be "re-routed" (it is not a payment), so a changed one is
// refused with a prompt to reopen.
//
// Foreign currency (TRANSFER only): the receiver picks the currency they
// actually got; the ledger amount stays in trip currency and the source
// amount is derived at-most from it (display + audit), exactly as the
// Worker derives it. The FX CAS rate is the one the derivation used.
//
// routeId is minted by the caller (ExpensePage) — see
// CreateSettlementRouteVariables.
import { useRef, useState } from 'react'
import { SETTLEMENT_LIMITS } from '@tripmate/entity-contracts'
import { ArrowRight, Loader2, Repeat } from 'lucide-react'
import { estimateSourceMinorAtMostTargetHalfEven } from '@tripmate/fx-core'
import {
  isRouteCurrent,
  routeParticipants,
  type OffsetRoute,
  type SettlementRoute,
  type TransferRoute,
} from '@tripmate/settlement-core'

import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import CurrencyPicker from '@/components/ui/CurrencyPicker'
import CurrencyInput from '@/components/ui/CurrencyInput'
import DatePicker from '@/components/ui/pickers/DatePicker'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { useFxPreview, type FxRateQuote } from '@/hooks/useFxPreview'
import { fxRateChanged } from '@/services/workerBase'
import { useAwaitedSave, describeSaveFailure } from '@/hooks/useAwaitedSave'
import { fxRateChangedMessage } from '../utils'
import { toLocalDateString } from '@/utils/dates'
import { currencySymbol } from '@/utils/currency'
import {
  formatMinorAmount,
  formatMinorForInput,
  currencyFractionDigits,
  parseMoneyToMinorResult,
} from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import { maxPayable, payersFor, paymentRoute } from '../services/settlementRoutes'

type Pairwise = Record<string, Record<string, number>>

/** What the user is recording. */
export type RecordIntent =
  | {
      kind:        'TRANSFER'
      mode:        'suggestion' | 'payment'
      receiverUid: string
      /** Required for 'suggestion'; the preselected payer for 'payment'. */
      payerUid?:   string
      /** Required for 'suggestion'; the prefilled amount for 'payment'. */
      amountMinor?: number
      /** The planned legs, used while they still match the ledger. */
      planned?:    TransferRoute
    }
  | { kind: 'OFFSET'; route: OffsetRoute }

/** Payload handed to ExpensePage — CreateSettlementRouteVariables minus the
 *  id and the page-derived optimistic fields. */
export interface RouteRecordSubmit {
  route:    SettlementRoute
  note?:    string
  foreign?: {
    sourceCurrency: string
    settledOn:      string
    expectedFxRate: FxRateQuote
  }
  /** FOREIGN only, for the optimistic row. */
  sourceAmountMinor?: number
  /** Present when the FX rate shown is still provisional: the page returns
   *  the mutation promise and the sheet waits on it (useAwaitedSave). */
  reportInForm?: () => boolean
}

interface Props {
  isOpen:       boolean
  onClose:      () => void
  /** Returns the mutation promise when the payload carries `reportInForm`;
   *  `false` when the page refused synchronously (sheet stays open, latch
   *  released). */
  onSave:       (payload: RouteRecordSubmit) => false | void | Promise<unknown>
  intent:       RecordIntent
  /** The live normalized ledger (computeBalancesFull().pairwise). */
  pairwise:     Pairwise
  tripCurrency: string
  /** Cloud trip id — FX preview comes from the Worker's write-path rate. */
  tripId?:      string | null
  /** Ghost-expanded roster: any party may have left the trip. */
  members:      TripMember[]
  isSaving:     boolean
}

/** Today where the user is: `settledOn` is the calendar day they received
 *  the money, bounded by their day (useFxPreview agrees). */
function todayLocal(): string {
  return toLocalDateString(new Date())
}

export default function SettlementRecordSheet({
  isOpen, onClose, onSave, intent, pairwise, tripCurrency, tripId, members, isSaving,
}: Props) {
  const isTransfer = intent.kind === 'TRANSFER'
  const isPayment  = intent.kind === 'TRANSFER' && intent.mode === 'payment'
  const receiverUid = intent.kind === 'TRANSFER' ? intent.receiverUid : null
  const payers = isPayment && receiverUid ? payersFor(pairwise, receiverUid, members.map(m => m.id)) : []

  const [payerChoice, setPayerChoice] = useState<string | undefined>(() =>
    intent.kind === 'TRANSFER' ? (intent.payerUid ?? payers[0]?.uid) : undefined)
  const [amountText, setAmountText] = useState<string>(() => {
    if (intent.kind !== 'TRANSFER' || intent.mode !== 'payment') return ''
    const initial = intent.amountMinor
      ?? (payerChoice && receiverUid ? maxPayable(pairwise, payerChoice, receiverUid) : 0)
    return initial > 0 ? formatMinorForInput(initial, tripCurrency) : ''
  })
  const [currency,  setCurrency]  = useState<string>(tripCurrency)
  const [settledOn, setSettledOn] = useState<string>(todayLocal())
  const [note,      setNote]      = useState<string>('')
  const [errors,    setErrors]    = useState<Record<string, string>>({})

  // One-submit-per-open latch (sync ref: a same-tick double tap must not
  // mint two route ids — the second would 409 as stale once the first lands).
  const submittedRef = useRef(false)
  const memberById = new Map(members.map(m => [m.id, m]))

  const payerUid = intent.kind === 'TRANSFER'
    ? (intent.mode === 'suggestion' ? intent.payerUid : payerChoice)
    : undefined
  const amountParse = isPayment ? parseMoneyToMinorResult(amountText, tripCurrency) : null
  const amountMinor = intent.kind === 'TRANSFER'
    ? (intent.mode === 'suggestion' ? intent.amountMinor : (amountParse?.ok ? amountParse.value : undefined))
    : undefined
  const maxMinor = payerUid && receiverUid ? maxPayable(pairwise, payerUid, receiverUid) : 0

  // The route this save would send, on the live ledger.
  const route: SettlementRoute | null = intent.kind === 'OFFSET'
    ? intent.route
    : payerUid && receiverUid && amountMinor !== undefined && amountMinor > 0
      ? paymentRoute(pairwise, payerUid, receiverUid, amountMinor, intent.planned)
      : null
  const offsetCurrent = intent.kind === 'OFFSET' ? isRouteCurrent(intent.route, pairwise) : true
  const routeAmount = route?.kind === 'TRANSFER' ? route.amountMinor : 0

  const isForeignMode = isTransfer && currency !== tripCurrency
  const fxPreview = useFxPreview({
    requestedDate:  settledOn,
    sourceCurrency: currency,
    tripCurrency,
    tripId,
  })
  const awaited = useAwaitedSave(onClose)

  // Display + audit only: the largest source amount whose forward
  // conversion does not exceed the cleared amount (the Worker's policy).
  const foreignSourceMinor = isForeignMode && fxPreview.rateDecimal && routeAmount > 0
    ? estimateSourceMinorAtMostTargetHalfEven({
        targetMinor:          routeAmount,
        rateDecimal:          fxPreview.rateDecimal,
        sourceFractionDigits: currencyFractionDigits(currency),
        targetFractionDigits: currencyFractionDigits(tripCurrency),
      })
    : null

  function clearErrors() { setErrors({}) }

  function handleSubmit() {
    if (submittedRef.current) return
    const next: Record<string, string> = {}
    let foreign: { expectedFxRate: FxRateQuote; sourceMinor: number } | null = null

    if (intent.kind === 'OFFSET') {
      if (!offsetCurrent) next.route = '這筆抵銷已因其他清算而改變，請關閉後重新確認。'
    } else {
      if (!payerUid) next.payer = '請選擇付款人'
      if (isPayment && (!amountParse?.ok || amountParse.value <= 0)) next.amount = '請輸入金額'
      else if (!route) {
        next.amount = maxMinor > 0
          ? `帳上目前最多只能記錄 ${formatMinorAmount(maxMinor, tripCurrency)}`
          : '帳務已變動，目前沒有可記錄的金額'
      }
      if (isForeignMode) {
        if (settledOn > todayLocal()) next.settledOn = '無法換算未來日期'
        if (fxPreview.disabledReason === 'invalid-input') next.settledOn = '請確認幣別或日期'
        if (fxPreview.isError) next.fx = '無法取得匯率，請再試一次'
        if (fxPreview.isLoading) next.fx = '正在取得匯率'
        if (!fxPreview.rateQuote || foreignSourceMinor === null) {
          next.fx = next.fx ?? '請確認匯率後再儲存'
        } else if (foreignSourceMinor <= 0) {
          next.fx = '換算後的金額過小，請選擇其他幣別'
        } else {
          foreign = { expectedFxRate: fxPreview.rateQuote, sourceMinor: foreignSourceMinor }
        }
      }
    }

    if (Object.keys(next).length > 0 || !route) {
      setErrors(next)
      return
    }
    submittedRef.current = true
    const trimmedNote = note.trim()
    const base = { route, ...(trimmedNote ? { note: trimmedNote } : {}) }

    if (isForeignMode && foreign) {
      const { expectedFxRate, sourceMinor } = foreign
      awaited.submit(() => refusedUnlatch(onSave({
        ...base,
        foreign: { sourceCurrency: currency, settledOn, expectedFxRate },
        sourceAmountMinor: sourceMinor,
        ...(!fxPreview.isFinal ? { reportInForm: awaited.stillOpen } : {}),
      })), err => {
        submittedRef.current = false
        const current = fxRateChanged(err)
        if (!current) return describeSaveFailure(err)
        fxPreview.adoptRate(current)
        return fxRateChangedMessage(expectedFxRate, current)
      })
      return
    }
    refusedUnlatch(onSave(base))
  }

  // The page can refuse synchronously (scope change, ledger not ready,
  // update required, cap) without closing the sheet: release the latch.
  function refusedUnlatch(outcome: false | void | Promise<unknown>): void | Promise<unknown> {
    if (outcome === false) {
      submittedRef.current = false
      return
    }
    return outcome
  }

  const payer    = payerUid ? memberById.get(payerUid) : undefined
  const receiver = receiverUid ? memberById.get(receiverUid) : undefined
  const viaUids  = route ? routeParticipants(route.legs).filter(uid => uid !== payerUid && uid !== receiverUid) : []
  const nameOf   = (uid: string) => memberById.get(uid)?.displayName ?? uid

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving || awaited.saving}
      title={intent.kind === 'OFFSET' ? '記錄互相抵銷' : isPayment ? '記錄收款' : '記錄清算'}
      saveLabel="儲存紀錄"
      saveError={awaited.error}
      onClose={onClose}
      onSave={handleSubmit}
    >
      <div className="flex flex-col gap-4">
        {intent.kind === 'OFFSET' ? (
          <div className="flex items-start gap-2.5 px-3 py-2.5 bg-app rounded-input border border-border">
            <Repeat size={16} strokeWidth={2.2} className="text-teal shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 text-[13px] text-muted leading-[1.5]">
              <span className="font-semibold text-ink">{intent.route.participantUids.map(nameOf).join('、')}</span>
              <span> 之間的欠款剛好繞成一圈，可以互相抵銷，不需要任何人付款。每個人的應收與應付都減少相同金額，淨額不變。</span>
            </div>
          </div>
        ) : (
          <>
            {isPayment ? (
              <FormField label="付款人" error={errors.payer} required>
                {payers.length === 0 ? (
                  <div className="text-[13px] text-muted">目前帳上沒有人欠你錢。</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="付款人">
                    {payers.map(p => {
                      const m = memberById.get(p.uid)
                      const selected = p.uid === payerUid
                      return (
                        <button
                          key={p.uid}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => {
                            setPayerChoice(p.uid)
                            setAmountText(formatMinorForInput(p.maxMinor, tripCurrency))
                            clearErrors()
                          }}
                          className={[
                            'flex items-center gap-1.5 pl-1 pr-2.5 h-9 rounded-full border text-[12.5px] font-semibold cursor-pointer',
                            selected ? 'border-teal bg-teal-pale text-teal' : 'border-border bg-surface text-ink',
                          ].join(' ')}
                        >
                          {m && <MemberAvatar member={m} size={26} />}
                          {m?.displayName ?? p.uid}
                        </button>
                      )
                    })}
                  </div>
                )}
              </FormField>
            ) : payer && receiver && (
              <div className="flex items-center gap-2.5 px-3 py-2.5 bg-app rounded-input border border-border">
                <MemberAvatar member={payer} size={32} />
                <ArrowRight size={14} strokeWidth={2.5} className="text-muted shrink-0" />
                <MemberAvatar member={receiver} size={32} />
                <div className="flex-1 min-w-0 text-[13px] text-muted leading-tight">
                  <span className="font-semibold text-ink">{payer.displayName}</span>
                  <span> 支付給 </span>
                  <span className="font-semibold text-ink">{receiver.displayName}</span>
                </div>
              </div>
            )}

            <FormField label="清算金額" error={errors.amount} required={isPayment}>
              {isPayment ? (
                <CurrencyInput
                  symbol={currencySymbol(tripCurrency)}
                  inputMode="decimal"
                  value={amountText}
                  onChange={e => { setAmountText(e.target.value); clearErrors() }}
                  error={!!errors.amount}
                  aria-label="清算金額"
                />
              ) : (
                <div className="w-full min-h-12 px-3 py-2.5 bg-app rounded-input border border-border text-[16px] leading-6 text-ink tabular-nums flex items-baseline gap-1 flex-wrap">
                  <span className="font-semibold">{formatMinorAmount(amountMinor ?? 0, tripCurrency)}</span>
                  {isForeignMode && foreignSourceMinor !== null && (
                    <span className="text-muted text-[14px]">（≈ {formatMinorAmount(foreignSourceMinor, currency)}）</span>
                  )}
                </div>
              )}
              {isPayment && payerUid && (
                <div className="mt-1 text-[11px] text-muted tabular-nums">
                  帳上最多可記錄 {formatMinorAmount(maxMinor, tripCurrency)}
                  {isForeignMode && foreignSourceMinor !== null && ` · ≈ ${formatMinorAmount(foreignSourceMinor, currency)}`}
                </div>
              )}
            </FormField>
          </>
        )}

        {errors.route && (
          <div role="alert" className="px-3 py-2 rounded-input text-[12px] font-medium bg-warn-bg text-warn border border-warn">
            {errors.route}
          </div>
        )}

        {/* The legs this record will clear — every one on a real debt. */}
        {route && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-semibold text-muted">
              {route.kind === 'OFFSET'
                ? '將抵銷的欠款'
                : viaUids.length > 0
                  ? `經 ${viaUids.map(nameOf).join('、')} 轉交，將清掉以下欠款`
                  : '將清掉以下欠款'}
            </div>
            {route.legs.map(leg => (
              <div key={`${leg.fromUid}-${leg.toUid}`} className="flex items-center gap-1.5 text-[12px] text-ink tabular-nums">
                <span className="truncate">{nameOf(leg.fromUid)}</span>
                <ArrowRight size={10} strokeWidth={2.5} className="text-muted shrink-0" />
                <span className="truncate">{nameOf(leg.toUid)}</span>
                <span className="ml-auto font-semibold">{formatMinorAmount(leg.amountMinor, tripCurrency)}</span>
              </div>
            ))}
          </div>
        )}

        {isTransfer && (
          <FormField label="收款幣別">
            <CurrencyPicker value={currency} onChange={next => { setCurrency(next); clearErrors() }} />
          </FormField>
        )}

        {isForeignMode && (
          <FormField label="收款日期" error={errors.settledOn} required>
            <DatePicker
              value={settledOn}
              onChange={next => { setSettledOn(next); clearErrors() }}
              maxDate={todayLocal()}
              error={!!errors.settledOn}
            />
          </FormField>
        )}

        {isForeignMode && (
          <div
            role="status"
            aria-live="polite"
            className={[
              'flex items-center gap-2 px-3 py-2 rounded-input text-[12px] font-medium',
              fxPreview.disabledReason || fxPreview.isError || errors.fx
                ? 'bg-warn-bg text-warn border border-warn'
                : 'bg-teal-pale text-teal',
            ].join(' ')}
          >
            {errors.fx ? (
              <span>{errors.fx}</span>
            ) : fxPreview.disabledReason === 'future-date' ? (
              <span>無法換算未來日期，請變更收款日期。</span>
            ) : fxPreview.disabledReason === 'invalid-input' ? (
              <span>請確認幣別或收款日期。</span>
            ) : fxPreview.isLoading ? (
              <>
                <Loader2 size={14} strokeWidth={2.2} className="animate-spin shrink-0" />
                <span>正在取得匯率…</span>
              </>
            ) : fxPreview.isError || !fxPreview.rateDecimal ? (
              <span>無法取得匯率，請再試一次。</span>
            ) : (
              <span className="tabular-nums opacity-90">
                匯率 {fxPreview.rateDecimal}（{fxPreview.rateDate}）
              </span>
            )}
          </div>
        )}

        <FormField label="備註（選填）">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="例如：燒肉費用清算"
            maxLength={SETTLEMENT_LIMITS.note}
            className="w-full min-h-12 px-3 py-2.5 bg-app rounded-input border-[1.5px] border-border text-[16px] leading-6 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors"
          />
        </FormField>
      </div>
    </FormModalShell>
  )
}
