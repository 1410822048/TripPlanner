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
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { MOCK_EXPENSES } from '../mocks'
import { toast } from '@/shared/toast'
import type { Expense, ExpenseCategory } from '@/types'
import ExpenseFormModal, { type ExpenseFormResult } from './ExpenseFormModal'
import SettlementSummary from './SettlementSummary'
import ExpenseListSkeleton from './ExpenseListSkeleton'
import ExpensePageSkeleton from './ExpensePageSkeleton'
import ExpenseListEmpty from './ExpenseListEmpty'
import ExpenseDateGroups from './ExpenseDateGroups'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
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
  const createSettlementMut = useCreateSettlement(mutationTripId)
  const deleteSettlementMut = useDeleteSettlement(mutationTripId)

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

  if (ctx.status === 'loading') return <ExpensePageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Receipt} reason="費用を記録" />

  const title = ctx.trip.title
  const perPersonMinor = members.length > 0 ? Math.round(totalMinor / members.length) : 0

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
  async function handleSwipeDelete(e: Expense) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
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
              {categoryStats.slice(0, 5).map(([cat, amt], i) => (
                <span key={cat} className="flex items-center">
                  {i > 0 && <span className="mr-2 text-border">·</span>}
                  <span className="text-[13px] mr-1 leading-none">{CATEGORY_EMOJI[cat]}</span>
                  <span className="text-ink font-semibold">{Math.round((amt / totalMinor) * 100)}</span>
                  <span className="ml-px text-muted">%</span>
                </span>
              ))}
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
        onMarkSettled={(fromUid, toUid, amountMinor) => {
          if (isDemo) { signIn.open(); return }
          if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
          // Mint id here(not inside the service)so the optimistic row,
          // the Worker request, and the Firestore doc share one id —
          // realtime listener replaces the optimistic row atomically.
          createSettlementMut.mutate({
            settlementId: crypto.randomUUID(),
            fromUid, toUid, amountMinor, currency,
          })
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
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="費用を保存するには、"
      />
    </div>
  )
}
