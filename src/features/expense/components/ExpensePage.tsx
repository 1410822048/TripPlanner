// src/features/expense/components/ExpensePage.tsx
import { Plus, Receipt } from 'lucide-react'
import {
  useExpenses, useCreateExpense, useUpdateExpense, useDeleteExpense,
  expenseUpdateMutationKey,
} from '../hooks/useExpenses'
import { usePendingMutationIds } from '@/hooks/usePendingMutationIds'
import { useSettlements, useCreateSettlement, useDeleteSettlement } from '../hooks/useSettlements'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useIsTripOwner } from '@/features/trips/hooks/useTripRole'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { MOCK_EXPENSES } from '../mocks'
import { toast } from '@/shared/toast'
import type { Expense, ExpenseCategory } from '@/types'
import ExpenseFormModal, { type ExpenseFormResult } from './ExpenseFormModal'
import ExpenseReadonlyModal from './ExpenseReadonlyModal'
import SettlementSummary from './SettlementSummary'
import SettlementRecordSheet, { type SettlementRecordSubmit } from './SettlementRecordSheet'
import { useState } from 'react'
import ExpenseListSkeleton from './ExpenseListSkeleton'
import ExpensePageSkeleton from './ExpensePageSkeleton'
import ExpenseListEmpty from './ExpenseListEmpty'
import ExpenseDateGroups from './ExpenseDateGroups'
import { CATEGORY_ICON } from '@/shared/categoryMeta'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { currencySymbol } from '@/utils/currency'
import { formatMinorAmount, formatMinorNumber } from '@/utils/money'

export default function ExpensePage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, canWrite, modal, signIn } =
    useFeatureListPage<Expense>()
  const swipe    = useSwipeOpen()
  const currency = useTripCurrency()
  const symbol   = currencySymbol(currency)

  const { data: fbExpenses, isLoading } = useExpenses(cloudTripId)
  const { data: fbMembers } = useMembers(cloudTripId)
  const { data: fbSettlements } = useSettlements(cloudTripId)
  const settlements = ctx.status === 'cloud' ? (fbSettlements ?? []) : []
  const isOwner = useIsTripOwner(cloudTripId, isDemo)
  const createSettlementMut = useCreateSettlement(mutationTripId)
  const deleteSettlementMut = useDeleteSettlement(mutationTripId)
  // Settlement record sheet state. Non-null when the receiver tapped
  // 「済み」on a suggestion row — drives the sheet open + seeds it with
  // the balance-engine's suggested (fromUid, toUid, amountMinor). Sheet
  // closes by setting back to null; the parent owns the mutation.
  const [recordTarget, setRecordTarget] = useState<
    { fromUid: string; toUid: string; amountMinor: number } | null
  >(null)

  // Plain derivations — React Compiler auto-memoises based on inferred
  // deps. The aggregation chain (expenses → total / categoryStats /
  // grouped) is now compiler-driven; downstream memos stay stable for
  // the same upstream data without manual useMemo plumbing.
  const members =
    ctx.status === 'demo'  ? ctx.trip.members :
    ctx.status === 'cloud' ? membersToTripMembers(fbMembers ?? []) :
    []

  // `allExpenses` keeps soft-deleted rows (settlement chronological
  // replay needs them). `expenses` below is the active subset used by
  // the list / totals / count / aggregation — the default-named one is
  // the safe one to pass to new aggregators; only SettlementSummary
  // takes `allExpenses`.
  const allExpenses =
    ctx.status === 'demo'
      ? (ctx.trip.id === 'demo' ? MOCK_EXPENSES : [])
      : (fbExpenses ?? [])

  const createMut = useCreateExpense(mutationTripId)
  const updateMut = useUpdateExpense(mutationTripId)
  const deleteMut = useDeleteExpense(mutationTripId)
  // Set of expense ids whose UPDATE is in-flight — drives the 保存中… pill
  // on edited rows. CREATE pending is handled inside SwipeableExpenseItem
  // via the temp- id prefix; UPDATE preserves the real id so we need this.
  const pendingUpdateIds = usePendingMutationIds<{ expenseId: string }>(
    expenseUpdateMutationKey,
    'expenseId',
  )
  // isSaving stays `false` for the modal — handleSave closes the modal
  // synchronously before the mutation fires (optimistic close), so the
  // save button never enters a busy state. Without forcing this to false
  // an in-flight previous mutation would leak its `isPending` into a
  // newly-opened modal, showing "保存中" before the user even taps save.

  // Single pass: active list + total + category bucket together.
  // Compiler memoises; collapses what used to be filter → reduce → for-of.
  const expenses: Expense[] = []
  const categoryStatsRaw: Partial<Record<ExpenseCategory, number>> = {}
  let totalMinor = 0
  for (const e of allExpenses) {
    if (e.deletedAt) continue
    expenses.push(e)
    totalMinor += e.amountMinor
    categoryStatsRaw[e.category] = (categoryStatsRaw[e.category] ?? 0) + e.amountMinor
  }
  const categoryStats = (Object.entries(categoryStatsRaw) as [ExpenseCategory, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  // Expenses a non-owner may not edit / soft-delete. PRIMARY source is the
  // server-enforced `expense.settlementLockIds` (exactly what the Worker +
  // rules gate on). Settlement lineage (appliedExpenseIds / appliedSources)
  // is UNIONED in only to cover the optimistic windows where the two can
  // briefly disagree: on optimistic CREATE the settlement row lands before
  // the expense's lock field propagates; on optimistic DELETE the settlement
  // row is gone but the lock field lingers until the Worker clears it and
  // the listener updates. Union keeps the row readonly across both, matching
  // the server (no false "editable" flash that then 403s).
  const lockedExpenseIds = new Set<string>()
  for (const e of expenses) {
    if ((e.settlementLockIds?.length ?? 0) > 0) lockedExpenseIds.add(e.id)
  }
  for (const settlement of settlements) {
    for (const id of settlement.appliedExpenseIds ?? []) lockedExpenseIds.add(id)
    for (const source of settlement.appliedSources ?? []) lockedExpenseIds.add(source.expenseId)
  }

  if (ctx.status === 'loading') return <ExpensePageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Receipt} reason="費用を記録" />

  const title = ctx.trip.title
  const perPersonMinor = members.length > 0 ? Math.round(totalMinor / members.length) : 0
  const readonlyEditTarget =
    modal.editTarget && !isOwner && lockedExpenseIds.has(modal.editTarget.id)
      ? modal.editTarget
      : null

  function handleSave({ input, attachment }: ExpenseFormResult) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }

    // Optimistic close: the modal goes away IMMEDIATELY, the optimistic
    // patchListCache in onMutate makes the new row appear in the list
    // before Firestore + Storage have done anything. The real writes
    // happen in the background — if they fail, the hook's onError fires
    // rollbackListCache + a toast, restoring the list to its pre-save
    // state. This is the same pattern Splitwise uses for "instant" saves.
    //
    // Snapshot editTarget before modal.close() in case the close handler
    // clears it synchronously (closures can stale if we read after close).
    const editing = modal.editTarget
    if (editing && !isOwner && lockedExpenseIds.has(editing.id)) {
      toast.error('清算済みの費用はオーナーのみ編集できます')
      return
    }
    modal.close()
    if (editing) {
      updateMut.mutate({
        expenseId: editing.id,
        updates:   input,
        uid,
        attachment,
        existing:  {
          path:      editing.receipt?.path,
          thumbPath: editing.receipt?.thumbPath,
        },
      })
    } else {
      createMut.mutate({
        input,
        createdBy:  uid,
        attachment: attachment instanceof File ? attachment : null,
      })
    }
  }
  function handleRecordSettlement(submit: SettlementRecordSubmit) {
    if (isDemo) { setRecordTarget(null); signIn.open(); return }
    if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    // Mint settlementId here (not inside the service) so the optimistic
    // cache row, the Worker request, and the Firestore doc all share
    // one id. Memory: [[settlement-id-hoist-load-bearing]] — any future
    // refactor that moves id-minting back into the service breaks the
    // realtime listener's atomic row replacement.
    //
    // `submit` is already a discriminated `CreateSettlementVariables`
    // minus settlementId, so a single spread preserves the mode → shape
    // correlation (FOREIGN keeps sourceAmountMinor on optimistic, TRIP
    // doesn't carry it). No nested narrowing needed.
    //
    // Conservative pending lock lineage: every active expense that creates
    // debt either direction within this pair. The Worker computes the exact
    // lock set (forward sources ∪ reverse offset), but until its commit +
    // the expense listener land, this is what ExpensePage's readonly union
    // uses so a non-owner can't briefly edit a source expense post-済み.
    // Over-approximation is safe — the listener swaps in the exact set.
    const pendingAppliedExpenseIds = expenses
      .filter(e =>
        (e.paidBy === submit.toUid   && e.splits.some(s => s.memberId === submit.fromUid)) ||
        (e.paidBy === submit.fromUid && e.splits.some(s => s.memberId === submit.toUid)))
      .map(e => e.id)
    // `pendingAppliedExpenseIds` is a top-level variables field (NOT nested
    // in the discriminated `optimistic`), so this is a pure spread — no
    // mutation of `submit`, no per-mode narrowing needed.
    createSettlementMut.mutate({ ...submit, settlementId: crypto.randomUUID(), pendingAppliedExpenseIds })
    // Close the sheet optimistically — the optimistic patch already
    // inserts the row; the realtime listener will replace it once the
    // Worker commits. Errors surface through the global
    // MutationCache.onError toast (no banner inside the sheet) since
    // the sheet is gone by the time the rejection lands.
    setRecordTarget(null)
  }

  async function handleSwipeDelete(e: Expense) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    if (!isOwner && lockedExpenseIds.has(e.id)) {
      toast.error('清算済みの費用はオーナーのみ編集できます')
      return
    }
    // Hook onError rolls back the optimistic remove and shows the toast.
    await deleteMut.mutateAsync({ expenseId: e.id }).catch(() => {})
  }

  return (
    // Click anywhere on the page wrapper closes any open swipe — the row's
    // inner buttons stopPropagation, so this only fires for taps in the
    // gaps between rows / headers / non-row areas.
    <div className="bg-app min-h-full pb-8" onClick={swipe.closeAll}>

      {isDemo && <DemoBanner reason="費用を保存" onSignIn={signIn.open} />}

      {/* ── HEADER ─────────────────────────────────────────── */}
      <div className="px-5 pt-4 pb-2">
        <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
          費用記録
        </p>
        <h1 className="m-0 text-[22px] font-black text-ink -tracking-[0.5px]">
          {title}
        </h1>
      </div>

      {/* ── SUMMARY CARD ───────────────────────────────────── */}
      <div className="px-4 mt-2">
        <div className="bg-surface border border-border rounded-2xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
          <div className="text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
            旅行総支出
          </div>
          <div className="mt-1 flex items-baseline gap-0.5">
            <span className="text-[18px] font-bold text-muted leading-none">{symbol}</span>
            <span className="text-[32px] font-black text-ink -tracking-[1px] leading-none tabular-nums">
              {formatMinorNumber(totalMinor, currency)}
            </span>
          </div>

          {totalMinor > 0 && categoryStats.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted tabular-nums">
              {categoryStats.slice(0, 5).map(([cat, amt], i) => {
                const CatIcon = CATEGORY_ICON[cat]
                return (
                <span key={cat} className="flex items-center">
                  {i > 0 && <span className="mr-2 text-border">·</span>}
                  <CatIcon size={12} strokeWidth={2} className="mr-1 text-muted" />
                  <span className="text-ink font-semibold">{Math.round((amt / totalMinor) * 100)}</span>
                  <span className="ml-px text-muted">%</span>
                </span>
                )
              })}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-border grid grid-cols-3 gap-2">
            {[
              { value: String(expenses.length), unit: '件', label: '費用筆數' },
              { value: String(members.length),  unit: '人', label: '参加' },
              { value: formatMinorAmount(perPersonMinor, currency), unit: '', label: '1人あたり' },
            ].map(({ value, unit, label }) => (
              <div key={label} className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-px">
                  <span className="text-[18px] font-extrabold text-ink -tracking-[0.3px] tabular-nums">
                    {value}
                  </span>
                  {unit && <span className="text-[11px] font-semibold text-muted ml-0.5">{unit}</span>}
                </div>
                <span className="text-[10.5px] text-muted tracking-[0.06em]">{label}</span>
              </div>
            ))}
          </div>

          {canWrite && (
            <button
              onClick={modal.openAdd}
              className="mt-4 w-full h-11 rounded-chip border-none bg-teal text-white text-[13px] font-bold tracking-[0.04em] flex items-center justify-center gap-1.5 cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              費用を追加
            </button>
          )}
        </div>
      </div>

      {/* ── SETTLEMENT ─────────────────────────────────────── */}
      <SettlementSummary
        expenses={allExpenses}
        members={members}
        settlements={settlements}
        currency={currency}
        uid={uid ?? null}
        isOwner={isOwner}
        onRecordSettlement={suggestion => {
          if (isDemo) { signIn.open(); return }
          if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
          // Open the sheet preseeded with the suggestion. The mutate
          // happens inside handleRecordSettlement below; this just opens
          // the UI. Settlement FX Commit 3/4 + Phase 4.1: previously this
          // branch mutated directly with the trip-currency suggestion —
          // now we hand over to the sheet so the receiver can pick the
          // currency they actually received in (for display + audit). The
          // cleared amount itself is fixed at pair-remaining (full clear);
          // the sheet only exposes currency + date + note.
          setRecordTarget(suggestion)
        }}
        onDeleteSettlement={id => {
          if (isDemo) { signIn.open(); return }
          if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
          deleteSettlementMut.mutate({ settlementId: id })
        }}
      />

      {/* ── EXPENSE LIST ───────────────────────────────────── */}
      <div className="mt-4 px-4">
        {isLoading && !isDemo ? (
          <ExpenseListSkeleton />
        ) : expenses.length === 0 ? (
          <ExpenseListEmpty canWrite={canWrite} onAdd={modal.openAdd} />
        ) : (
          <ExpenseDateGroups
            expenses={expenses}
            members={members}
            currency={currency}
            canWrite={canWrite}
            swipe={swipe}
            pendingUpdateIds={pendingUpdateIds}
            readonlyExpenseIds={isOwner ? undefined : lockedExpenseIds}
            onSelect={canWrite ? modal.openEdit : undefined}
            onSwipeDelete={handleSwipeDelete}
          />
        )}
      </div>

      {/* Conditionally render so the modal unmounts when closed. Combined
          with the per-target `key`, this gives us fresh-state-on-open
          semantics: every open gets a clean useState init from props. A
          previous version kept the modal mounted and drove state resets
          from useEffect; migrating to the key+unmount pattern removed the
          last setState-in-effect smell here. */}
      {modal.isOpen && (
        readonlyEditTarget ? (
          <ExpenseReadonlyModal
            key={modal.key}
            isOpen
            expense={readonlyEditTarget}
            members={members}
            currency={currency}
            onClose={modal.close}
          />
        ) : (
          <ExpenseFormModal
            key={modal.key}
            isOpen
            editTarget={modal.editTarget}
            defaultDate={new Date().toISOString().slice(0, 10)}
            members={members}
            isSaving={false}
            onClose={modal.close}
            onSave={handleSave}
          />
        )
      )}

      {/* Settlement record sheet — opens when the receiver taps「済み」
          on a suggestion row. Conditionally rendered + keyed so each
          open resets internal state from fresh props (same pattern as
          ExpenseFormModal above). */}
      {recordTarget && (
        <SettlementRecordSheet
          key={`${recordTarget.fromUid}-${recordTarget.toUid}-${recordTarget.amountMinor}`}
          isOpen
          onClose={() => setRecordTarget(null)}
          onSave={handleRecordSettlement}
          suggested={recordTarget}
          tripCurrency={currency}
          members={members}
          isSaving={false}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="費用を保存するには、"
      />
    </div>
  )
}
