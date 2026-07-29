import { Pencil } from 'lucide-react'

interface ReadonlyEditFooterProps {
  onEdit: () => void
}

export default function ReadonlyEditFooter({ onEdit }: ReadonlyEditFooterProps) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full h-12 rounded-chip border-none bg-teal text-white text-[14px] font-bold tracking-[0.04em] flex items-center justify-center gap-2 cursor-pointer transition-transform active:scale-[0.99]"
      style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
    >
      <Pencil size={15} strokeWidth={2.3} />
      編輯
    </button>
  )
}
