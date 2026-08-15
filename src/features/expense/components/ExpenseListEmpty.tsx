// src/features/expense/components/ExpenseListEmpty.tsx
// Empty state for ExpensePage. CTA highlights OCR auto-capture so first-
// time users see the differentiating capability instead of a neutral
// "+ button above" hint.
import { Receipt, Camera } from 'lucide-react'
import ListEmptyCard from '@/components/ui/ListEmptyCard'
import { UPDATE_REQUIRED_EMPTY_STATE } from '@/services/clientCompatibility'

interface Props {
  canWrite: boolean
  /** Role-only half of `canWrite`. Checked FIRST when blocked: a viewer
   *  stays a viewer after updating the app, so promising "update and you
   *  can add" would be a lie for them. */
  roleCanWrite: boolean
  onAdd:    () => void
}

export default function ExpenseListEmpty({ canWrite, roleCanWrite, onAdd }: Props) {
  return (
    <ListEmptyCard
      icon={(
        <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
          <Receipt size={24} strokeWidth={1.6} />
        </div>
      )}
      title="尚未記錄費用"
      description={canWrite ? (
        <span className="leading-[1.5]">
          只要拍攝收據，品項、金額與分類都會<br />
          由 AI 自動記錄
        </span>
      ) : roleCanWrite
        ? UPDATE_REQUIRED_EMPTY_STATE
        : '你目前以檢視者身分加入。只有擁有者和編輯者可以新增費用。'}
      actions={canWrite ? (
        <>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
            style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
          >
            <Camera size={14} strokeWidth={2.5} />
            從收據開始
          </button>
          <div className="mt-2.5 text-[10.5px] text-muted">
            也可以手動新增
          </div>
        </>
      ) : undefined}
    />
  )
}
