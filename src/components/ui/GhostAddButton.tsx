import { Plus } from 'lucide-react'

interface GhostAddButtonProps {
  label: string
  onClick: () => void
}

export default function GhostAddButton({ label, onClick }: GhostAddButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
    >
      <Plus size={14} strokeWidth={2} />
      {label}
    </button>
  )
}
