// src/features/expense/components/ExpenseDateGroups.tsx
// Renders expenses grouped by date with daily subtotals. Pure render —
// no derivations leaked back to caller, no internal mutation. Swipe
// state comes from caller's useSwipeOpen so the page-level "close all
// on outside tap" stays in sync.
//
// Each date section is collapsible. Default: the most recent 3 days are
// expanded and older days collapsed — long trips would otherwise stack
// 14+ days into one infinite scroll. User overrides via per-date taps;
// overrides persist across re-renders (eg. when a new expense is added)
// so taps never get undone by data updates.
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import type { useSwipeOpen } from '@/hooks/useSwipeOpen'
import SwipeableExpenseItem from './SwipeableExpenseItem'
import { CATEGORY_EMOJI } from '@/shared/categoryMeta'
import { splitSummary } from '../utils'
import { fromLocalDateString } from '@/utils/dates'
import { formatAmount } from '@/utils/currency'
import { groupBy } from '@/utils/groupBy'

/** 預設展開最近 N 天 — "today + yesterday"。一天 receipts 很容易破 10 筆,
 *  3 天就會推離首屏。 */
const DEFAULT_EXPANDED_DAYS = 2

function formatDateHeading(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
}

interface Props {
  expenses:      Expense[]
  members:       TripMember[]
  currency:      string
  canWrite:      boolean
  swipe:         ReturnType<typeof useSwipeOpen>
  /** Tap on an expense row. Optional — viewers omit it (the page gates
   *  on canWrite) so SwipeableExpenseItem renders read-only. */
  onSelect?:     (e: Expense) => void
  onSwipeDelete: (e: Expense) => void
}

export default function ExpenseDateGroups({
  expenses, members, currency, canWrite, swipe, onSelect, onSwipeDelete,
}: Props) {
  const grouped = groupBy(expenses, e => e.date)
  const dates = Object.keys(grouped).sort((a, b) => (a < b ? 1 : -1))
  // O(1) per-row lookup. `members.find` inside `.map` was O(N×M) on every
  // SettlementSummary / swipe / modal cascade re-render.
  const memberById = new Map(members.map(m => [m.id, m]))

  // User overrides per-date. Anything NOT in this map falls back to the
  // idx-based default (top N expanded). A map means we can store both
  // "explicitly opened" and "explicitly closed" without conflating them
  // with the default, so user choices survive data updates that re-rank
  // dates (e.g. adding an expense on a new day shifts indices but the
  // user's earlier "open day-5" decision stays).
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())

  function isOpen(date: string, idx: number): boolean {
    const ovr = overrides.get(date)
    return ovr ?? idx < DEFAULT_EXPANDED_DAYS
  }

  function toggle(date: string, idx: number) {
    setOverrides(prev => {
      const next = new Map(prev)
      const currentlyOpen = prev.get(date) ?? idx < DEFAULT_EXPANDED_DAYS
      next.set(date, !currentlyOpen)
      return next
    })
  }

  return (
    <>
      {dates.map((date, idx) => {
        const items = grouped[date] ?? []
        const subtotal = items.reduce((s, e) => s + e.amount, 0)
        const open = isOpen(date, idx)
        return (
          <div key={date} className="mb-4">
            <button
              type="button"
              onClick={() => toggle(date, idx)}
              aria-expanded={open}
              className="w-full flex items-center justify-between px-1 mb-2 py-1 bg-transparent border-none cursor-pointer text-left"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <ChevronDown
                  size={13}
                  strokeWidth={2.5}
                  className={`text-muted shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                />
                <span className="text-[12px] font-bold text-ink tracking-[0.02em]">
                  {formatDateHeading(date)}
                </span>
                <span className="text-[10.5px] text-muted tabular-nums">
                  · {items.length}件
                </span>
              </div>
              <span className="text-[11px] text-muted font-medium tabular-nums shrink-0">
                {formatAmount(subtotal, currency)}
              </span>
            </button>

            {open && (
              <div className="flex flex-col gap-1.5">
                {items.map(e => {
                  // Viewer mode skips swipe affordance + delete callback so
                  // SwipeableExpenseItem renders a plain tap-to-edit row.
                  const swipeProps = canWrite ? swipe.bindRow(e.id) : {}
                  return (
                    <SwipeableExpenseItem
                      key={e.id}
                      expense={e}
                      payer={memberById.get(e.paidBy)}
                      summary={splitSummary(e, members.length)}
                      categoryEmoji={CATEGORY_EMOJI[e.category]}
                      currency={currency}
                      {...swipeProps}
                      onSelect={onSelect ? () => { swipe.closeAll(); onSelect(e) } : undefined}
                      onDelete={canWrite ? () => onSwipeDelete(e) : undefined}
                    />
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
