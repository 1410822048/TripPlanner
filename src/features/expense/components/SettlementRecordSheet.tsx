// src/features/expense/components/SettlementRecordSheet.tsx
// Phase 4.1 rearchitecture (2026-06-02) — 「済み」 is NOT an amount-entry
// form. The whole sheet is "confirm clear this suggestion":
//   - The amount shown is the suggestion's remaining (read-only). The
//     ledger amountMinor is always this value, for BOTH modes — the
//     Worker writes `amountMinor = pair-remaining` regardless of which
//     currency the receiver was actually paid in.
//   - For foreign currency the user picks WHICH currency they actually
//     received in; the sheet shows "約 TWD 110" derived from
//     `useFxPreview` (inverse via atMost from remaining). This source
//     amount is display + audit data only — it does NOT participate
//     in the ledger.
//   - Worker re-derives source authoritatively at tx time and writes
//     fxSnapshot.convertedAmountMinor = forward(source), which may be
//     ≤ amountMinor by 1-2 minor units due to half-even rounding
//     plateaus — intentional, ledger is decoupled from FX math.
//
// Foreign-mode trust gating mirrors the Worker:
//   - Submit gates on a confirmed `useFxPreview` rate so the
//     optimistic source-side display lands within fx-core rounding of
//     what the Worker will write. Optimistic amountMinor is always
//     `suggested.amountMinor` (= remaining), so it never jumps on
//     listener swap regardless of FX freshness.
//   - Future settledOn dates short-circuit the hook AND the submit gate —
//     Worker FX router would reject FX_FUTURE_DATE_UNSUPPORTED anyway.
//
// settlementId is intentionally NOT minted here. The caller (ExpensePage)
// mints via crypto.randomUUID so the optimistic patch / Worker request /
// Firestore doc all share one id — see CreateSettlementVariables docstring.
import { useMemo, useRef, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { estimateSourceMinorAtMostTargetHalfEven } from '@tripmate/fx-core'

import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import CurrencyPicker from '@/components/ui/CurrencyPicker'
import DatePicker from '@/components/ui/pickers/DatePicker'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { useFxPreview } from '@/hooks/useFxPreview'
import {
  formatMinorAmount,
  currencyFractionDigits,
} from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type {
  CreateTripSettlementVariables,
  CreateForeignSettlementVariables,
} from '../services/settlementService'

interface Suggestion {
  fromUid:     string
  toUid:       string
  /** Suggested amount in trip currency (integer minor units). Comes from
   *  the balance engine's `computeSettlements` output. */
  amountMinor: number
}

/** Payload handed up to ExpensePage — the full `CreateSettlementVariables`
 *  minus `settlementId` (caller mints via crypto.randomUUID). Discriminated
 *  by `mode` at the top level so the optimistic shape stays correlated:
 *  TRIP_CURRENCY MUST NOT carry `sourceAmountMinor`, FOREIGN_CURRENCY MUST.
 *  ExpensePage just spreads + adds settlementId; no nested narrowing needed. */
export type SettlementRecordSubmit =
  | Omit<CreateTripSettlementVariables,    'settlementId'>
  | Omit<CreateForeignSettlementVariables, 'settlementId'>

interface Props {
  isOpen:       boolean
  onClose:      () => void
  onSave:       (payload: SettlementRecordSubmit) => void
  /** The pairwise suggestion the receiver tapped 「済み」on. Drives the
   *  read-only amount display + the from/to avatar row. */
  suggested:    Suggestion
  /** Trip currency — the currency picker defaults to this; the FX preview
   *  triggers only when the picked currency differs. */
  tripCurrency: string
  members:      TripMember[]
  /** Threaded through to FormModalShell for the shared save-button
   *  contract. Always `false` from ExpensePage: this is an optimistic-
   *  close sheet (the parent nulls recordTarget the instant onSave
   *  fires), so there's no in-place saving state to render — double-
   *  submit is guarded by the synchronous `submittedRef` latch instead.
   *  Kept (rather than hardcoded internally) for symmetry with the sibling
   *  optimistic-close modal ExpenseFormModal, which also takes it; the
   *  pair should lose it together if/when the FormModalShell save-state
   *  contract is revisited (see [[expense-form-modal-extract]]). */
  isSaving:     boolean
}

/** Today in UTC, YYYY-MM-DD. Matches the Worker fx-rate.ts and
 *  useFxPreview's todayUtc semantics so the future-date guard agrees
 *  across surfaces. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function SettlementRecordSheet({
  isOpen, onClose, onSave, suggested, tripCurrency, members, isSaving,
}: Props) {
  // Inline state — sheet is unmounted on close (parent gates with isOpen)
  // and remounts via key when the suggestion identity changes, so every
  // open initializes from fresh props.
  const [currency,  setCurrency]  = useState<string>(tripCurrency)
  const [settledOn, setSettledOn] = useState<string>(todayUtc())
  const [note,      setNote]      = useState<string>('')
  const [errors,    setErrors]    = useState<Record<string, string>>({})

  // One-submit-per-open latch. The sheet closes optimistically (ExpensePage
  // nulls recordTarget right after onSave), but a fast double-tap / Enter-
  // repeat can fire handleSubmit twice BEFORE that unmount re-render lands —
  // each call mints a fresh settlementId (caller-side crypto.randomUUID), so
  // the 2nd write hits the Worker as a different id and 409s as stale once
  // the 1st clears the debt → phantom optimistic row + confusing toast. A
  // synchronous ref (NOT state — a setState is async and a same-tick 2nd
  // click would still read the stale `false`) blocks the 2nd call. Resets
  // per open via remount (parent keys the sheet on the suggestion identity).
  const submittedRef = useRef(false)

  const fromMember = members.find(m => m.id === suggested.fromUid)
  const toMember   = members.find(m => m.id === suggested.toUid)

  const isForeignMode = currency !== tripCurrency

  // FX preview only used when foreign. The hook gates internally on
  // degenerate/invalid/future inputs, so we can call it unconditionally
  // and read disabledReason for the user-facing message.
  const fxPreview = useFxPreview({
    requestedDate:  settledOn,
    sourceCurrency: currency,
    tripCurrency,
  })

  // Foreign-mode derivation: from the suggested trip-currency remaining,
  // inverse-derive the largest source amount whose forward conversion
  // does NOT exceed remaining (at-most policy — exactly what the Worker
  // does authoritatively). This source amount is display + audit data
  // only; the ledger amountMinor stays = remaining (Phase 4.1). We do
  // NOT forward-convert it back here — the Worker owns the canonical
  // `fxSnapshot.convertedAmountMinor`, so recomputing it client-side
  // would be dead weight.
  const foreignDerived = useMemo(() => {
    if (!isForeignMode) return null
    if (!fxPreview.rateDecimal) return null
    const sourceMinor = estimateSourceMinorAtMostTargetHalfEven({
      targetMinor:          suggested.amountMinor,
      rateDecimal:          fxPreview.rateDecimal,
      sourceFractionDigits: currencyFractionDigits(currency),
      targetFractionDigits: currencyFractionDigits(tripCurrency),
    })
    return { sourceMinor }
  }, [currency, fxPreview.rateDecimal, isForeignMode, suggested.amountMinor, tripCurrency])

  function handleCurrencyChange(next: string) {
    setCurrency(next)
    setErrors({})
  }

  // Changing the date re-derives the FX rate (different cache key), so any
  // prior settledOn / fx validation error is stale — clear it, same as
  // handleCurrencyChange. Otherwise a fixed future-date / rate error banner
  // lingers until the next submit (false-error UI).
  function handleSettledOnChange(next: string) {
    setSettledOn(next)
    setErrors({})
  }

  function handleSubmit() {
    if (submittedRef.current) return   // already submitted this open — no-op the 2nd tap
    const next: Record<string, string> = {}

    if (isForeignMode) {
      if (settledOn > todayUtc()) {
        next.settledOn = '未来日付は換算できません'
      }
      if (fxPreview.disabledReason === 'invalid-input') {
        next.settledOn = '通貨または日付を確認してください'
      }
      if (fxPreview.isError) {
        next.fx = '換算レートを取得できません。再試行してください'
      }
      if (fxPreview.isLoading) {
        next.fx = '換算レートを取得中です'
      }
      if (!fxPreview.rateDecimal) {
        next.fx = next.fx ?? '換算レートを確定してから保存してください'
      }
      // Tiny remaining + weak rate can inverse to 0 source minor (no
      // source ≥ 1 fits at-most-remaining). Worker rejects this exact
      // shape with SettlementValidationError('sourceCurrency') via the
      // `foreign.sourceAmountMinor <= 0` guard; mirror it here on the
      // SAME field so the user sees "金額が小さすぎます" instead of a
      // round-trip 400. Note: Phase 4.1 amountMinor=remaining is
      // perfectly writeable when sourceMinor=0 (1 JPY for instance),
      // but a 0 source is meaningless for the receipt — reject so the
      // user picks a different source currency or uses TRIP_CURRENCY
      // mode for the tiny remainder.
      if (foreignDerived && foreignDerived.sourceMinor <= 0) {
        next.fx = '換算後の金額が小さすぎます。別の通貨を選んでください'
      }
    }

    if (Object.keys(next).length > 0) {
      setErrors(next)
      return                            // validation fail does NOT latch — user fixes + retries
    }

    submittedRef.current = true         // latch BEFORE onSave so a same-tick 2nd tap no-ops

    if (isForeignMode) {
      // FOREIGN: wire payload is intent only (mode + uids + sourceCurrency
      // + settledOn + note). Optimistic patch mirrors what the Worker
      // will write under Phase 4.1 ledger semantics:
      //   amountMinor = suggested.amountMinor (== remaining, full clear)
      // even though the Worker's FX forward (fxSnapshot.convertedAmountMinor)
      // may be ≤ that by a few minor units. Using the suggestion's amount
      // matches the authoritative server write and avoids a visible
      // jump when the listener swap lands.
      onSave({
        mode:                   'FOREIGN_CURRENCY',
        fromUid:                suggested.fromUid,
        toUid:                  suggested.toUid,
        expectedRemainingMinor: suggested.amountMinor,
        sourceCurrency:         currency,
        settledOn,
        ...(note.trim() ? { note: note.trim() } : {}),
        optimistic: {
          amountMinor:       suggested.amountMinor,
          currency:          tripCurrency,
          sourceAmountMinor: foreignDerived!.sourceMinor,
        },
      })
    } else {
      // TRIP: wire payload is intent only. Optimistic patch uses the
      // suggestion's amount directly — Worker will compute the exact
      // remaining at tx time (typically the same modulo any concurrent
      // expense edit).
      onSave({
        mode:                   'TRIP_CURRENCY',
        fromUid:                suggested.fromUid,
        toUid:                  suggested.toUid,
        expectedRemainingMinor: suggested.amountMinor,
        ...(note.trim() ? { note: note.trim() } : {}),
        optimistic: {
          amountMinor: suggested.amountMinor,
          currency:    tripCurrency,
        },
      })
    }
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title="清算を記録"
      saveLabel="記録する"
      onClose={onClose}
      onSave={handleSubmit}
    >
      <div className="flex flex-col gap-4">
        {/* Pairwise summary — visually anchors the sheet to the
            suggestion the user tapped. Read-only; the receiver can't
            switch payer here (would be a different debt edge). */}
        {fromMember && toMember && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 bg-app rounded-input border border-border">
            <MemberAvatar member={fromMember} size={32} />
            <ArrowRight size={14} strokeWidth={2.5} className="text-muted shrink-0" />
            <MemberAvatar member={toMember} size={32} />
            <div className="flex-1 min-w-0 text-[13px] text-muted leading-tight">
              <span className="font-semibold text-ink">{fromMember.label}</span>
              <span> から </span>
              <span className="font-semibold text-ink">{toMember.label}</span>
              <span> への清算</span>
            </div>
          </div>
        )}

        {/* Amount display — READ ONLY. 「済み」 clears the entire
            remaining debt; Worker writes amountMinor = remaining
            regardless of mode (Phase 4.1 ledger truth). Trip mode
            shows ¥550 directly. Foreign mode shows "¥550 (≈ TWD 119)" —
            the ¥550 is the actual debt cleared; the TWD value is the
            inverse-derived source amount the receiver tells the system
            they received in (recorded for audit / future review). */}
        <FormField label="清算金額">
          <div className="w-full min-h-12 px-3 py-2.5 bg-app rounded-input border border-border text-[16px] leading-6 text-ink tabular-nums flex items-baseline gap-1 flex-wrap">
            <span className="font-semibold">
              {formatMinorAmount(suggested.amountMinor, tripCurrency)}
            </span>
            {isForeignMode && (
              !fxPreview.rateDecimal ? (
                <span className="text-muted text-[14px]">
                  （{fxPreview.isLoading ? '換算レート取得中…' : '受取通貨と日付を選んでください'}）
                </span>
              ) : foreignDerived ? (
                <span className="text-muted text-[14px]">
                  （≈ {formatMinorAmount(foreignDerived.sourceMinor, currency)}）
                </span>
              ) : null
            )}
          </div>
        </FormField>

        <FormField label="受取通貨">
          {/* Picking the trip currency keeps the sheet in TRIP_CURRENCY
              mode (degenerate path, no FX). Picking a different code
              flips to FOREIGN_CURRENCY. */}
          <CurrencyPicker value={currency} onChange={handleCurrencyChange} />
        </FormField>

        {isForeignMode && (
          <FormField label="受取日" error={errors.settledOn} required>
            {/* Settled-on bounds the FX rate lookup. maxDate caps the
                picker at today so the user can't pick a future date
                (Worker would reject with FX_FUTURE_DATE_UNSUPPORTED).
                No minDate — historic settlements are valid. */}
            <DatePicker
              value={settledOn}
              onChange={handleSettledOnChange}
              maxDate={todayUtc()}
              error={!!errors.settledOn}
            />
          </FormField>
        )}

        {/* Inline FX preview — mirrors ExpenseFormModal's foreign-mode
            banner so the visual language is consistent. Four render
            states: blocked (disabledReason) / loading / error / success. */}
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
              <span>未来日付は換算できません。受取日を変更してください。</span>
            ) : fxPreview.disabledReason === 'invalid-input' ? (
              <span>通貨または受取日を確認してください。</span>
            ) : fxPreview.isLoading ? (
              <>
                <Loader2 size={14} strokeWidth={2.2} className="animate-spin shrink-0" />
                <span>換算レートを取得中…</span>
              </>
            ) : fxPreview.isError || !fxPreview.rateDecimal ? (
              <span>換算レートを取得できません。再試行してください。</span>
            ) : (
              <span className="tabular-nums opacity-90">
                レート {fxPreview.rateDecimal}（{fxPreview.rateDate}）
              </span>
            )}
          </div>
        )}

        <FormField label="メモ（任意）">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="例)焼肉の精算"
            maxLength={200}
            className="w-full min-h-12 px-3 py-2.5 bg-app rounded-input border-[1.5px] border-border text-[16px] leading-6 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors"
          />
        </FormField>
      </div>
    </FormModalShell>
  )
}
