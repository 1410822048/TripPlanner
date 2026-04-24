// src/features/expense/components/ExpensePage.tsx
import { useMemo, useState } from 'react'
import { Plus, Receipt } from 'lucide-react'
import { useTripStore } from '@/store/tripStore'
import { useSelectedDemoTrip } from '@/store/demoTripStore'
import {
  useExpenses, useCreateExpense, useUpdateExpense, useDeleteExpense,
} from '../hooks/useExpenses'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useUid } from '@/hooks/useAuth'
import { MOCK_EXPENSES } from '../mocks'
import { splitSummary } from '../utils'
import { toast } from '@/shared/toast'
import type { Expense, ExpenseCategory, CreateExpenseInput } from '@/types'
import ExpenseFormModal from './ExpenseFormModal'
import SwipeableExpenseItem from './SwipeableExpenseItem'
import SettlementSummary from './SettlementSummary'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import LoadingText from '@/components/ui/LoadingText'
import { fromLocalDateString } from '@/utils/dates'

function formatDateHeading(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
}

export default function ExpensePage() {
  const uid = useUid()
  const isDemo = !uid
  const currentTrip = useTripStore(s => s.currentTrip)
  const demoTrip = useSelectedDemoTrip()
  const tripId = isDemo ? demoTrip.id : currentTrip?.id

  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Expense | null>(null)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const { data: fbExpenses, isLoading } = useExpenses(isDemo ? undefined : tripId)
  const { data: fbMembers } = useMembers(isDemo ? undefined : tripId)
  const members = useMemo(
    () => isDemo ? demoTrip.members : membersToTripMembers(fbMembers ?? []),
    [isDemo, demoTrip.members, fbMembers],
  )
  // Demo 僅對應 'demo' trip（東京五日間）；其他 demo trip 顯示空狀態
  const demoExpenses = demoTrip.id === 'demo' ? MOCK_EXPENSES : []
  const expenses = isDemo ? demoExpenses : (fbExpenses ?? [])
  const createMut = useCreateExpense(tripId ?? '')
  const updateMut = useUpdateExpense(tripId ?? '')
  const deleteMut = useDeleteExpense(tripId ?? '')
  const isSaving  = createMut.isPending || updateMut.isPending

  const title = isDemo ? demoTrip.title : currentTrip?.title

  // Signed-in but no trip selected → mirror Schedule's empty messaging.
  if (!isDemo && !currentTrip) {
    return (
      <div className="bg-app min-h-full flex flex-col items-center justify-center px-6 py-10">
        <div className="w-14 h-14 rounded-full bg-surface border border-border flex items-center justify-center mb-4 text-muted">
          <Receipt size={22} strokeWidth={1.6} />
        </div>
        <h2 className="m-0 mb-1.5 text-[17px] font-bold text-ink -tracking-[0.3px]">
          旅程を選択してください
        </h2>
        <p className="m-0 text-[12px] text-muted text-center max-w-[260px] leading-[1.7] tracking-[0.02em]">
          「行程」タブで旅程を作成・選択すると、<br />
          費用を記録できるようになります。
        </p>
      </div>
    )
  }

  const total = expenses.reduce((s, e) => s + e.amount, 0)
  const perPerson = members.length > 0 ? Math.round(total / members.length) : 0

  const catSums: Partial<Record<ExpenseCategory, number>> = {}
  for (const e of expenses) catSums[e.category] = (catSums[e.category] ?? 0) + e.amount
  const categoryStats = (Object.entries(catSums) as [ExpenseCategory, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])

  const grouped: Record<string, Expense[]> = {}
  for (const e of expenses) (grouped[e.date] ??= []).push(e)
  const dates = Object.keys(grouped).sort().reverse()

  function openAdd()             { setEditTarget(null);  setModalOpen(true) }
  function openEdit(e: Expense)  { setEditTarget(e);     setModalOpen(true) }
  function closeModal()          { setModalOpen(false);  setEditTarget(null) }

  async function handleSave(data: CreateExpenseInput) {
    if (isDemo) { setModalOpen(false); setSignInOpen(true); return }
    if (!editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    try {
      if (editTarget) {
        await updateMut.mutateAsync({ expenseId: editTarget.id, updates: data })
      } else {
        await createMut.mutateAsync({ input: data, userId: uid! })
      }
      closeModal()
    } catch { /* hook onError already surfaced the toast */ }
  }
  async function handleSwipeDelete(expenseId: string) {
    setSwipedId(null)
    if (isDemo) { setSignInOpen(true); return }
    // Hook onError rolls back the optimistic remove and shows the toast.
    await deleteMut.mutateAsync(expenseId).catch(() => {})
  }

  return (
    <div className="bg-app min-h-full pb-8">

      {/* ── DEMO BANNER ────────────────────────────────────── */}
      {isDemo && (
        <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-accent-pale border border-accent/15 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-[10.5px] text-accent leading-[1.5] tracking-[0.02em]">
            <span className="font-bold">プレビューモード</span>
            <span className="opacity-75"> · サインインで費用を保存</span>
          </div>
          <button
            onClick={() => setSignInOpen(true)}
            className="shrink-0 h-7 px-3 rounded-full bg-accent text-white text-[10.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.97]"
            style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
          >
            サインイン
          </button>
        </div>
      )}

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
            <span className="text-[18px] font-bold text-muted leading-none">¥</span>
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
              { value: `¥${perPerson.toLocaleString()}`, unit: '', label: '1人あたり' },
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

          <button
            onClick={openAdd}
            className="mt-4 w-full h-11 rounded-chip border-none bg-teal text-white text-[13px] font-bold tracking-[0.04em] flex items-center justify-center gap-1.5 cursor-pointer transition-all hover:-translate-y-px"
            style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
          >
            <Plus size={14} strokeWidth={2.5} />
            費用を追加
          </button>
        </div>
      </div>

      {/* ── SETTLEMENT ─────────────────────────────────────── */}
      <SettlementSummary expenses={expenses} members={members} />

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
              上のボタンから最初の費用を追加しましょう
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
                    ¥{subtotal.toLocaleString()}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  {items.map(e => (
                    <SwipeableExpenseItem
                      key={e.id}
                      expense={e}
                      payer={members.find(m => m.id === e.paidBy)}
                      summary={splitSummary(e, members.length)}
                      categoryEmoji={CATEGORY_EMOJI[e.category]}
                      isOpen={swipedId === e.id}
                      onSelect={() => openEdit(e)}
                      onOpen={() => setSwipedId(e.id)}
                      onClose={() => { if (swipedId === e.id) setSwipedId(null) }}
                      onDelete={() => handleSwipeDelete(e.id)}
                    />
                  ))}
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
      {modalOpen && (
        <ExpenseFormModal
          key={editTarget?.id ?? 'new'}
          isOpen
          editTarget={editTarget}
          defaultDate={new Date().toISOString().slice(0, 10)}
          members={members}
          isSaving={isSaving}
          onClose={closeModal}
          onSave={handleSave}
        />
      )}

      <SignInPromptModal
        isOpen={signInOpen}
        onClose={() => setSignInOpen(false)}
        reason="費用を保存するには、"
      />
    </div>
  )
}
