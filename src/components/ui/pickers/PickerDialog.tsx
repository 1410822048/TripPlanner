// src/components/ui/pickers/PickerDialog.tsx
// 共用的置中彈出容器（供 DatePicker / TimePicker 使用）
// 透過 Portal 渲染到 document.body，避開父層 overflow-hidden 與 BottomSheet 的裁切
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  isOpen:   boolean
  onClose:  () => void
  title?:   string
  children: ReactNode
}

export default function PickerDialog({ isOpen, onClose, title, children }: Props) {
  // Esc 關閉（桌面）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="absolute inset-0"
        style={{
          background: 'rgba(0,0,0,0.42)',
          animation: 'backdropIn 0.18s ease both',
          touchAction: 'none',
        }}
      />
      {/* Dialog */}
      <div
        className="relative bg-surface rounded-2xl border border-border w-full max-w-[320px] overflow-hidden"
        style={{
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          animation: 'calPop 0.22s cubic-bezier(0.32,0.72,0,1) both',
        }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
