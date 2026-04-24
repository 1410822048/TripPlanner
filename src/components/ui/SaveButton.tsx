// src/components/ui/SaveButton.tsx
// Modal 底部的儲存按鈕（含 loading 狀態）
import { Loader } from 'lucide-react'

interface Props {
  onClick:   () => void
  isSaving?: boolean
  /** 正常狀態文字，例：「変更を保存」 */
  label:     string
  /** isSaving 時文字，預設「保存中…」 */
  loadingLabel?: string
  disabled?: boolean
}

export default function SaveButton({
  onClick, isSaving = false, label, loadingLabel = '保存中…', disabled,
}: Props) {
  const busy = isSaving || disabled
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={[
        'w-full h-12 rounded-chip border-none text-white text-[15px] font-bold',
        'flex items-center justify-center gap-2 tracking-wide transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        busy
          ? 'bg-[#8AABB0] cursor-not-allowed'
          : 'bg-accent cursor-pointer hover:bg-accent/90 active:bg-accent/80',
      ].join(' ')}
    >
      {isSaving
        ? <><Loader size={16} className="animate-spin" /> {loadingLabel}</>
        : label}
    </button>
  )
}
