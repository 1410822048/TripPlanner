import { useState } from 'react'
import { FileText, Image as ImageIcon, Lock } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import BottomSheet from '@/components/ui/BottomSheet'
import FormField from '@/components/ui/FormField'
import MemberAvatar from '@/components/ui/MemberAvatar'
import AttachmentPreviewModal from '@/features/bookings/components/AttachmentPreviewModal'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { CATEGORY_ICON } from '@/shared/categoryMeta'
import { adjustmentSign } from '@tripmate/expense-materialize'
import { fromLocalDateString } from '@/utils/dates'
import { formatMinorAmount } from '@/utils/money'
import { splitSummary } from '../utils'

interface Props {
  isOpen:   boolean
  expense:  Expense
  members:  TripMember[]
  currency: string
  onClose:  () => void
}

function formatExpenseDate(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export default function ExpenseReadonlyModal({
  isOpen, expense, members, currency, onClose,
}: Props) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const CategoryIcon = CATEGORY_ICON[expense.category]
  const memberById = new Map(members.map(member => [member.id, member]))
  const payer = memberById.get(expense.paidBy)
  const receipt = expense.receipt
  // path-only: row thumbnail reads ONLY thumbPath (no full-path fallback —
  // a PDF / thumb-less receipt shows the icon, never pulls the full blob
  // into the thumb LRU). The full path resolves only while the preview
  // modal is open, via kind:'full'.
  const receiptPreviewUrl = useAttachmentUrl(receipt?.thumbPath, { kind: 'thumb' })
  const receiptFullUrl    = useAttachmentUrl(previewOpen ? receipt?.path : undefined, { kind: 'full' })

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="費用詳細">
      <div className="flex items-center gap-2 rounded-input border border-border bg-app px-3 py-2 text-[12px] font-semibold text-muted">
        <Lock size={13} strokeWidth={2.2} className="shrink-0" />
        <span>清算済み</span>
      </div>

      <div className="rounded-input border border-border bg-surface px-3 py-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-input bg-tile shrink-0 flex items-center justify-center text-muted">
            <CategoryIcon size={19} strokeWidth={1.8} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-bold text-ink leading-6 break-words">
              {expense.title}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {formatExpenseDate(expense.date)}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[16px] font-black text-ink tabular-nums">
              {formatMinorAmount(expense.amountMinor, currency)}
            </div>
            {expense.sourceCurrency && expense.sourceCurrency !== currency && (
              <div className="mt-0.5 text-[11px] font-semibold text-muted tabular-nums">
                {formatMinorAmount(expense.sourceAmountMinor!, expense.sourceCurrency)}
              </div>
            )}
          </div>
        </div>
      </div>

      <FormField label="支払者">
        <div className="flex items-center gap-2 rounded-input border border-border bg-app px-3 py-2">
          {payer && <MemberAvatar member={payer} size={28} />}
          <span className="text-[13px] font-semibold text-ink">{payer?.label ?? expense.paidBy}</span>
        </div>
      </FormField>

      <FormField label={`分担 - ${splitSummary(expense, members.length)}`}>
        <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
          {expense.splits
            .filter(split => split.amountMinor > 0)
            .map(split => {
              const member = memberById.get(split.memberId)
              return (
                <div key={split.memberId} className="flex items-center gap-2 px-3 py-2">
                  {member && <MemberAvatar member={member} size={26} />}
                  <span className="flex-1 min-w-0 text-[13px] font-medium text-ink truncate">
                    {member?.label ?? split.memberId}
                  </span>
                  <span className="text-[13px] font-bold text-ink tabular-nums">
                    {formatMinorAmount(split.amountMinor, currency)}
                  </span>
                </div>
              )
            })}
        </div>
      </FormField>

      {expense.items && expense.items.length > 0 && (
        <FormField label="明細">
          <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
            {expense.items.map(item => (
              <div key={item.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink truncate">
                    {item.name}
                  </span>
                  <span className="text-[13px] font-bold text-ink tabular-nums">
                    {formatMinorAmount(item.amountMinor, currency)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.assignees.map(uid => {
                    const member = memberById.get(uid)
                    return (
                      <span key={uid} className="text-[10.5px] font-semibold text-muted">
                        {member?.label ?? uid}
                      </span>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </FormField>
      )}

      {expense.adjustments.length > 0 && (
        <FormField label="調整">
          <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
            {expense.adjustments.map(adjustment => {
              const sign = adjustmentSign(adjustment.kind)
              return (
                <div key={adjustment.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1 min-w-0 text-[13px] font-medium text-ink truncate">
                    {adjustment.label}
                  </span>
                  <span className="text-[13px] font-bold text-ink tabular-nums">
                    {sign < 0 ? '-' : '+'}{formatMinorAmount(adjustment.amountMinor, currency)}
                  </span>
                </div>
              )
            })}
          </div>
        </FormField>
      )}

      {receipt && (
        <FormField label="レシート">
          <button
            type="button"
            onClick={() => receipt.path && setPreviewOpen(true)}
            disabled={!receipt.path}
            className="w-full flex items-center gap-3 rounded-input border border-border bg-app px-3 py-2 text-left cursor-pointer disabled:cursor-default disabled:opacity-70 hover:border-muted transition-colors"
          >
            <div className="w-10 h-10 rounded-md bg-tile shrink-0 overflow-hidden flex items-center justify-center">
              {receiptPreviewUrl && receipt.type.startsWith('image/') ? (
                <img src={receiptPreviewUrl} alt="" className="w-full h-full object-cover" draggable={false} />
              ) : receipt.type.startsWith('image/') ? (
                <ImageIcon size={18} strokeWidth={1.8} className="text-muted" />
              ) : (
                <FileText size={18} strokeWidth={1.8} className="text-muted" />
              )}
            </div>
            <span className="flex-1 min-w-0 text-[12px] font-semibold text-ink truncate">
              {receipt.path.split('/').pop() ?? 'receipt'}
            </span>
          </button>
        </FormField>
      )}

      {expense.note && (
        <FormField label="メモ">
          <div className="rounded-input border border-border bg-app px-3 py-2 text-[13px] leading-6 text-ink whitespace-pre-wrap break-words">
            {expense.note}
          </div>
        </FormField>
      )}

      {previewOpen && receipt?.path && (
        <AttachmentPreviewModal
          url={receiptFullUrl}
          fileType={receipt.type}
          fileName={receipt.path.split('/').pop() ?? 'receipt'}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </BottomSheet>
  )
}
