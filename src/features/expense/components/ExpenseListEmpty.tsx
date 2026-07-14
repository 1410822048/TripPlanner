// src/features/expense/components/ExpenseListEmpty.tsx
// Empty state for ExpensePage. CTA highlights OCR auto-capture so first-
// time users see the differentiating capability instead of a neutral
// "+ button above" hint.
import { Receipt, Camera } from 'lucide-react'

interface Props {
  canWrite: boolean
  onAdd:    () => void
}

export default function ExpenseListEmpty({ canWrite, onAdd }: Props) {
  return (
    <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
      <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
        <Receipt size={24} strokeWidth={1.6} />
      </div>
      <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
        尚未記錄費用
      </p>
      {canWrite ? (
        <>
          <p className="m-0 mb-4 text-[11.5px] text-muted tracking-[0.04em] leading-[1.5]">
            只要拍攝收據，品項、金額與分類都會<br />
            由 AI 自動記錄
          </p>
          <button
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
      ) : (
        <p className="m-0 text-[11.5px] text-muted tracking-[0.04em]">
          你目前以檢視者身分加入。只有擁有者和編輯者可以新增費用。
        </p>
      )}
    </div>
  )
}
