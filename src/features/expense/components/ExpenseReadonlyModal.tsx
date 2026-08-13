import { FileText, Image as ImageIcon, Lock } from 'lucide-react'
import type { Expense, ExpenseAdjustment, ExpenseItem } from '@/types'
import type { TripMember } from '@/features/trips/types'
import BottomSheet from '@/components/ui/BottomSheet'
import FormField from '@/components/ui/FormField'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { CATEGORY_ICON } from '@/shared/categoryMeta'
import { adjustmentSign } from '@tripmate/expense-materialize'
import { fromLocalDateString } from '@/utils/dates'
import { formatMinorAmount } from '@/utils/money'
import { splitSummary } from '../utils'
import { ghostMember } from '../services/settlement'
import ReadonlyEditFooter from '@/components/ui/ReadonlyEditFooter'

/** 「影響」列最多列幾個人,其餘收成「+N」。一筆調整可能牽涉整團,全部攤開
 *  會把這個 compact row 撐成一段清單。 */
const AFFECTED_MEMBERS_SHOWN = 3

/**
 * 一筆調整的適用範圍描述,供唯讀檢視稽核用。
 *
 * 兩種 scope 會產生不同的應付金額,但在畫面上長得一樣,所以這裡必須說清楚
 * 套用的是哪一條規則。EXPENSE 範圍刻意不寫「全體」——materialize 是按各項目
 * 「調整後」金額的比例分攤,再依該項目的 allocations 拆給成員,因此沒有分到
 * 任何項目的旅程成員並不受影響,而已被折抵到 0 的項目也不參與加權。
 */
function describeAdjustmentScope(
  adjustment: ExpenseAdjustment,
  itemById:   Map<string, ExpenseItem>,
  memberById: Map<string, TripMember>,
): { target: string; rule?: string; members?: TripMember[] } {
  if (adjustment.scope !== 'ITEM') {
    return { target: '整筆費用', rule: '依各項目調整後金額比例分攤' }
  }
  const item = adjustment.targetItemId ? itemById.get(adjustment.targetItemId) : undefined
  if (!item) return { target: '未知項目' }
  // 從 allocations 出發,而不是 members.filter():唯讀檢視只收到現役成員
  // (ExpensePage 沒有對它做 expandWithGhosts),反向過濾會讓已退出成員的
  // 分攤靜默消失,稽核時看到的名單就會少人。
  const affected = item.allocations.map(
    allocation => memberById.get(allocation.memberId) ?? ghostMember(allocation.memberId),
  )
  return { target: item.name, ...(affected.length > 0 ? { members: affected } : {}) }
}

interface Props {
  isOpen:   boolean
  expense:  Expense
  members:  TripMember[]
  currency: string
  isLocked?: boolean
  onClose:  () => void
  onEdit?:   () => void
  onPreviewReceipt?: (expense: Expense) => void
}

function formatExpenseDate(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export default function ExpenseReadonlyModal({
  isOpen, expense, members, currency, isLocked = false, onClose, onEdit, onPreviewReceipt,
}: Props) {
  const CategoryIcon = CATEGORY_ICON[expense.category]
  const memberById = new Map(members.map(member => [member.id, member]))
  const itemById = new Map((expense.items ?? []).map(item => [item.id, item]))
  const payer = memberById.get(expense.paidBy)
  const receipt = expense.receipt
  // path-only: row thumbnail reads ONLY thumbPath (no full-path fallback —
  // a PDF / thumb-less receipt shows the icon, never pulls the full blob
  // into the thumb LRU). Full-size preview is owned by ExpensePage so row
  // thumbnails and this detail surface share one overlay state machine.
  const receiptPreviewUrl = useAttachmentUrl(receipt?.thumbPath, { kind: 'thumb' })

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="費用詳情"
      footer={onEdit ? <ReadonlyEditFooter onEdit={onEdit} /> : undefined}
    >
      {isLocked && (
        <div className="flex items-center gap-2 rounded-input border border-border bg-app px-3 py-2 text-[12px] font-semibold text-muted">
          <Lock size={13} strokeWidth={2.2} className="shrink-0" />
          <span>已清算</span>
        </div>
      )}

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

      <FormField label="付款人">
        <div className="flex items-center gap-2 rounded-input border border-border bg-app px-3 py-2">
          {payer && <MemberAvatar member={payer} size={28} />}
          <span
            title={payer?.displayName ?? expense.paidBy}
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink"
          >
            {payer?.displayName ?? expense.paidBy}
          </span>
        </div>
      </FormField>

      <FormField label={`分攤 - ${splitSummary(expense, members.length)}`}>
        <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
          {expense.splits
            .filter(split => split.amountMinor > 0)
            .map(split => {
              const member = memberById.get(split.memberId)
              return (
                <div key={split.memberId} className="flex items-center gap-2 px-3 py-2">
                  {member && <MemberAvatar member={member} size={26} />}
                  <span className="flex-1 min-w-0 text-[13px] font-medium text-ink truncate">
                    {member?.displayName ?? split.memberId}
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
                  {item.allocations.map(allocation => {
                    const member = memberById.get(allocation.memberId)
                    return (
                      <span key={allocation.memberId} className="text-[10.5px] font-semibold text-muted">
                        {member?.displayName ?? allocation.memberId}
                        {allocation.shares > 1 ? ` x${allocation.shares}` : ''}
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
              const sign  = adjustmentSign(adjustment.kind)
              const scope = describeAdjustmentScope(adjustment, itemById, memberById)
              return (
                <div key={adjustment.id} className="flex items-start gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">
                      {adjustment.label}
                    </div>
                    <div className="mt-0.5 text-[10.5px] font-semibold text-muted truncate">
                      適用範圍：{scope.target}
                    </div>
                    {scope.rule && (
                      <div className="text-[10.5px] text-muted truncate">{scope.rule}</div>
                    )}
                    {scope.members && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="shrink-0 text-[10.5px] text-muted">影響</span>
                        {scope.members.slice(0, AFFECTED_MEMBERS_SHOWN).map(member => (
                          <span key={member.id} className="flex min-w-0 items-center gap-1">
                            <MemberAvatar member={member} size={16} />
                            {/* MemberAvatar 的 <img> 是 alt=""(裝飾性),稽核資訊
                                必須另外給看得見、讀得到的文字。截斷是視覺上的,
                                `title` 保留完整姓名。 */}
                            <span
                              title={member.displayName}
                              className={[
                                'max-w-24 truncate text-[10.5px]',
                                member.isGhost ? 'font-semibold text-danger' : 'text-ink',
                              ].join(' ')}
                            >
                              {member.displayName}
                            </span>
                          </span>
                        ))}
                        {scope.members.length > AFFECTED_MEMBERS_SHOWN && (
                          <span
                            className="shrink-0 text-[10.5px] font-semibold text-muted"
                            title={scope.members.slice(AFFECTED_MEMBERS_SHOWN)
                              .map(m => m.displayName).join('、')}
                          >
                            +{scope.members.length - AFFECTED_MEMBERS_SHOWN}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
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
        <FormField label="收據">
          <button
            type="button"
            onClick={() => receipt.path && onPreviewReceipt?.(expense)}
            disabled={!receipt.path || !onPreviewReceipt}
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
        <FormField label="備註">
          <div className="rounded-input border border-border bg-app px-3 py-2 text-[13px] leading-6 text-ink whitespace-pre-wrap break-words">
            {expense.note}
          </div>
        </FormField>
      )}

    </BottomSheet>
  )
}
