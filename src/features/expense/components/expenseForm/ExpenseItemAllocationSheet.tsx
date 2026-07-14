// src/features/expense/components/expenseForm/ExpenseItemAllocationSheet.tsx
// Item-level allocation editor. ExpenseFormModal is already a BottomSheet, so
// this sheet portals to <body> and owns its keyboard handling to avoid nested
// modal focus/escape conflicts with the parent form sheet.
import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Minus, Plus } from 'lucide-react'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'

interface Props {
  isOpen:                boolean
  item:                  FormItem
  index:                 number
  members:               TripMember[]
  currency:              string
  onClose:               () => void
  onToggleAllocation:    (index: number, memberId: string) => void
  onSetAllocationShares: (index: number, memberId: string, shares: number) => void
}

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function stopNativePropagation(e: KeyboardEvent) {
  e.stopPropagation()
  e.nativeEvent.stopImmediatePropagation?.()
}

export default function ExpenseItemAllocationSheet({
  isOpen, item, index, members, currency,
  onClose, onToggleAllocation, onSetAllocationShares,
}: Props) {
  const titleId = useId()
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const returnRef = useRef<HTMLElement | null>(null)

  const allocationByMember = new Map(item.allocations.map(a => [a.memberId, a]))
  const rows = members.map(member => ({
    member,
    allocation: allocationByMember.get(member.id),
  }))
  const selectedRows = rows.filter(row => row.allocation)
  const unselectedRows = rows.filter(row => !row.allocation)
  const totalShares = item.allocations.reduce((sum, allocation) => sum + allocation.shares, 0)
  const allOneShareActive = members.length > 0
    && selectedRows.length === members.length
    && selectedRows.every(row => row.allocation?.shares === 1)
  const clearActive = item.allocations.length === 0

  useEffect(() => {
    if (!isOpen) return
    returnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => sheetRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      const target = returnRef.current
      if (target && document.contains(target)) target.focus()
      returnRef.current = null
    }
  }, [isOpen])

  if (!isOpen) return null

  function closeSheet() {
    onClose()
  }

  function setEveryoneOneShare() {
    for (const member of members) {
      const allocation = allocationByMember.get(member.id)
      if (allocation) onSetAllocationShares(index, member.id, 1)
      else onToggleAllocation(index, member.id)
    }
  }

  function clearAllocations() {
    for (const allocation of item.allocations) {
      onToggleAllocation(index, allocation.memberId)
    }
  }

  function handleKeyDownCapture(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      stopNativePropagation(e)
      closeSheet()
      return
    }
    if (e.key !== 'Tab') return
    stopNativePropagation(e)

    const sheet = sheetRef.current
    if (!sheet) return
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) {
      e.preventDefault()
      sheet.focus()
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || active === sheet)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[360]"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <button
        type="button"
        aria-label="關閉"
        onClick={closeSheet}
        className="absolute inset-0 h-full w-full border-0 bg-black/35 p-0"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[86dvh] max-w-[430px] flex-col overflow-hidden rounded-t-[22px] bg-surface shadow-[0_-10px_34px_rgba(0,0,0,0.18)] outline-none"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 12px)' }}
      >
        <div className="shrink-0 border-b border-border px-5 pb-3 pt-3">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 mb-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-muted">
                分攤
              </p>
              <h3 id={titleId} className="m-0 truncate text-[16px] font-black text-ink">
                {item.name.trim() || `第 ${index + 1} 行`}
              </h3>
              <p className="m-0 mt-1 text-[11.5px] font-semibold tabular-nums text-muted">
                {formatMinorAmount(item.amountMinor, currency)}
              </p>
            </div>
            <div className="shrink-0 rounded-full bg-teal-pale px-3 py-1.5 text-[11.5px] font-bold tabular-nums text-teal">
              {selectedRows.length} 人 / {totalShares} 份
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={setEveryoneOneShare}
              aria-pressed={allOneShareActive}
              disabled={members.length === 0}
              className={[
                'h-9 rounded-full border text-[12px] font-bold transition-all active:scale-[0.97] disabled:opacity-45',
                allOneShareActive
                  ? 'border-teal/20 bg-teal-pale text-teal shadow-[0_0_0_2px_rgba(61,139,122,0.08)]'
                  : 'border-border bg-app text-muted hover:border-teal/20 hover:text-teal',
              ].join(' ')}
            >
              全員 1 份
            </button>
            <button
              type="button"
              onClick={clearAllocations}
              aria-pressed={clearActive}
              className={[
                'h-9 rounded-full border text-[12px] font-bold transition-all active:scale-[0.97] disabled:opacity-45',
                clearActive
                  ? 'border-warn bg-warn text-white shadow-[0_5px_14px_rgba(184,135,74,0.26),inset_0_1px_0_rgba(255,255,255,0.28)]'
                  : 'border-border bg-app text-muted hover:border-warn/25 hover:text-warn',
              ].join(' ')}
            >
              清除
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {selectedRows.map(({ member, allocation }) => {
              const shares = allocation!.shares
              return (
                <div
                  key={member.id}
                  className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[14px] border border-accent/20 bg-teal-pale px-2.5 py-2"
                >
                  <MemberAvatar member={member} size={30} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold text-ink">{member.label}</div>
                    <div className="text-[10.5px] font-semibold text-teal">分攤中</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (shares <= 1) onToggleAllocation(index, member.id)
                        else onSetAllocationShares(index, member.id, shares - 1)
                      }}
                      aria-label={`減少 ${member.label} 的分攤數`}
                      className="grid h-9 w-9 place-items-center rounded-full border border-teal/20 bg-surface text-teal"
                    >
                      <Minus size={15} strokeWidth={2.4} />
                    </button>
                    <span className="min-w-10 text-center text-[13px] font-black tabular-nums text-teal">
                      x{shares}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onSetAllocationShares(index, member.id, shares + 1)
                      }}
                      aria-label={`增加 ${member.label} 的分攤數`}
                      className="grid h-9 w-9 place-items-center rounded-full border border-teal/20 bg-surface text-teal"
                    >
                      <Plus size={15} strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              )
            })}

            {unselectedRows.length > 0 && selectedRows.length > 0 && (
              <div className="px-1 pt-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted">
                未選取
              </div>
            )}

            {unselectedRows.map(({ member }) => (
              <div
                key={member.id}
                className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[14px] border border-border bg-app px-2.5 py-2"
              >
                <MemberAvatar member={member} size={30} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-ink">{member.label}</div>
                  <div className="text-[10.5px] font-medium text-muted">未分攤</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onToggleAllocation(index, member.id)
                  }}
                  className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-surface px-3 text-[12px] font-bold text-teal"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  新增
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={closeSheet}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-full border-0 bg-teal text-[14px] font-bold text-white shadow-[0_4px_14px_rgba(61,139,122,0.25)]"
          >
            <Check size={16} strokeWidth={2.5} />
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
