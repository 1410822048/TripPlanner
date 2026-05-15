// src/features/expense/components/ExpensePage.tsx
import { Plus, Receipt } from 'lucide-react'
import {
  useExpenses, useCreateExpense, useUpdateExpense, useDeleteExpense,
} from '../hooks/useExpenses'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { MOCK_EXPENSES } from '../mocks'
import { splitSummary } from '../utils'
import { toast } from '@/shared/toast'
import type { Expense, ExpenseCategory } from '@/types'
import ExpenseFormModal, { type ExpenseFormResult } from './ExpenseFormModal'
import SwipeableExpenseItem from './SwipeableExpenseItem'
import SettlementSummary from './SettlementSummary'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import LoadingText from '@/components/ui/LoadingText'
import TripLoading from '@/components/ui/TripLoading'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import { fromLocalDateString } from '@/utils/dates'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { formatAmount, currencySymbol } from '@/utils/currency'

function formatDateHeading(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
}

export default function ExpensePage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, canWrite, modal, signIn } =
    useFeatureListPage<Expense>()
  const swipe    = useSwipeOpen()
  const currency = useTripCurrency()
  const symbol   = currencySymbol(currency)

  const { data: fbExpenses, isLoading } = useExpenses(cloudTripId)
  const { data: fbMembers } = useMembers(cloudTripId)

  // Plain derivations — React Compiler auto-memoises based on inferred
  // deps. The aggregation chain (expenses → total / categoryStats /
  // grouped) is now compiler-driven; downstream memos stay stable for
  // the same upstream data without manual useMemo plumbing.
  const members =
    ctx.status === 'demo'  ? ctx.trip.members :
    ctx.status === 'cloud' ? membersToTripMembers(fbMembers ?? []) :
    []

  // Demo 僅對應 'demo' trip(東京五日間);其他 demo trip 顯示空狀態。
  const expenses =
    ctx.status === 'demo'
      ? (ctx.trip.id === 'demo' ? MOCK_EXPENSES : [])
      : (fbExpenses ?? [])

  const createMut = useCreateExpense(mutationTripId)
  const updateMut = useUpdateExpense(mutationTripId)
  const deleteMut = useDeleteExpense(mutationTripId)
  // isSaving stays `false` for the modal — handleSave closes the modal
  // synchronously before the mutation fires (optimistic close), so the
  // save button never enters a busy state. Without forcing this to false
  // an in-flight previous mutation would leak its `isPending` into a
  // newly-opened modal, showing "保存中" before the user even taps save.

  // Aggregations on `expenses` — compiler memoises so swipe toggles /
  // modal open-close don't trigger O(N×categories) re-bucketing.
  const total = expenses.reduce((s, e) => s + e.amount, 0)

  const categoryStatsRaw: Partial<Record<ExpenseCategory, number>> = {}
  for (const e of expenses) categoryStatsRaw[e.category] = (categoryStatsRaw[e.category] ?? 0) + e.amount
  const categoryStats = (Object.entries(categoryStatsRaw) as [ExpenseCategory, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])

  const grouped: Record<string, Expense[]> = {}
  for (const e of expenses) (grouped[e.date] ??= []).push(e)
  const dates = Object.keys(grouped).sort().reverse()

  if (ctx.status === 'loading') return <TripLoading />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Receipt} reason="費用を記録" />

  const title = ctx.trip.title
  const perPerson = members.length > 0 ? Math.round(total / members.length) : 0

  function handleSave({ input, attachment }: ExpenseFormResult) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!modal.editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }

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
        attachment,
        existing:  {
          path:      editing.receipt?.path,
          thumbPath: editing.receipt?.thumbPath,
        },
      })
    } else {
      createMut.mutate({
        input,
        userId:     uid!,
        attachment: attachment instanceof File ? attachment : null,
      })
    }
  }
  async function handleSwipeDelete(e: Expense) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    // Hook onError rolls back the optimistic remove and shows the toast.
    await deleteMut.mutateAsync({
      expenseId: e.id,
      paths:     { path: e.receipt?.path, thumbPath: e.receipt?.thumbPath },
    }).catch(() => {})
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
              {total.toLocaleString()}
            </span>
          </div>

          {total > 0 && categoryStats.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted tabular-nums">
              {categoryStats.slice(0, 5).map(([cat, amt], i) => (
                <span key={cat} className="flex items-center">
                  {i > 0 && <span className="mr-2 text-border">·</span>}
                  <span className="text-[13px] mr-1 leading-none">{CATEGORY_EMOJI[cat]}</span>
                  <span className="text-ink font-semibold">{Math.round((amt / total) * 100)}</span>
                  <span className="ml-px text-muted">%</span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-border grid grid-cols-3 gap-2">
            {[
              { value: String(expenses.length), unit: '件', label: '費用筆數' },
              { value: String(members.length),  unit: '人', label: '参加' },
              { value: formatAmount(perPerson, currency), unit: '', label: '1人あたり' },
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
      <SettlementSummary expenses={expenses} members={members} currency={currency} />

      {/* ── EXPENSE LIST ───────────────────────────────────── */}
      <div className="mt-4 px-4">
        {isLoading && !isDemo ? (
          <div className="text-center py-12 text-dot text-[13px]">
            <LoadingText />
          </div>
        ) : expenses.length === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <Receipt size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              まだ費用が記録されていません
            </p>
            <p className="m-0 text-[11.5px] text-muted tracking-[0.04em]">
              {canWrite
                ? '上のボタンから最初の費用を追加しましょう'
                : '閲覧者として参加中です。費用の追加はオーナー / 編集者のみ行えます。'}
            </p>
          </div>
        ) : (
          dates.map(date => {
            const items = grouped[date] ?? []
            const subtotal = items.reduce((s, e) => s + e.amount, 0)
            return (
              <div key={date} className="mb-4">
                <div className="flex items-center justify-between px-1 mb-2">
                  <span className="text-[12px] font-bold text-ink tracking-[0.02em]">
                    {formatDateHeading(date)}
                  </span>
                  <span className="text-[11px] text-muted font-medium tabular-nums">
                    {formatAmount(subtotal, currency)}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  {items.map(e => {
                    // Viewer mode: swipe affordance + delete callback omitted so
                    // SwipeableExpenseItem renders a plain non-swipeable row
                    // (tap still routes to the read-only edit modal view).
                    const swipeProps = canWrite ? swipe.bindRow(e.id) : {}
                    return (
                      <SwipeableExpenseItem
                        key={e.id}
                        expense={e}
                        payer={members.find(m => m.id === e.paidBy)}
                        summary={splitSummary(e, members.length)}
                        categoryEmoji={CATEGORY_EMOJI[e.category]}
                        currency={currency}
                        {...swipeProps}
                        onSelect={() => { swipe.closeAll(); modal.openEdit(e) }}
                        onDelete={canWrite ? () => handleSwipeDelete(e) : undefined}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })
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
