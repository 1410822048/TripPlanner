// src/components/ui/pickers/PickerDialog.tsx
// 共用的置中彈出容器（供 DatePicker / TimePicker 使用）
// 透過 Portal 渲染到 document.body，避開父層 overflow-hidden 與 BottomSheet 的裁切
import { useEffect, useRef, type ReactNode, type PointerEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useBottomSheet } from '@/hooks/useBottomSheet'

interface Props {
  isOpen:    boolean
  onClose:   () => void
  title?:    string
  placement?: 'center' | 'bottom'
  children:  ReactNode
}

function BottomPickerDialog({
  isOpen, onClose, title, children,
}: Omit<Props, 'placement'>) {
  const { sheetRef, sheetTransform, backdropOpacity, pointerActive, dragHandlers } =
    useBottomSheet({ isOpen, onClose, dismissRatio: 0.25 })
  const dragStartYRef = useRef(0)
  const draggedRef = useRef(false)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragStartYRef.current = e.clientY
    draggedRef.current = false
    dragHandlers.onPointerDown(e)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (Math.abs(e.clientY - dragStartYRef.current) > 8) draggedRef.current = true
    dragHandlers.onPointerMove(e)
  }
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!draggedRef.current) return
    e.preventDefault()
    e.stopPropagation()
    draggedRef.current = false
  }

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end justify-center">
      <div
        onClick={onClose}
        className="absolute inset-0"
        style={{
          background: `rgba(0,0,0,${backdropOpacity})`,
          transition: pointerActive ? 'none' : 'background 0.24s ease',
          touchAction: 'none',
        }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[430px] overflow-hidden rounded-t-[22px] border border-border bg-surface outline-none"
        style={{
          boxShadow: '0 -10px 34px rgba(0,0,0,0.18)',
          paddingBottom: 'env(safe-area-inset-bottom, 12px)',
          transform: sheetTransform,
          transition: pointerActive ? 'none' : 'transform 0.28s cubic-bezier(0.32,0.72,0,1)',
          touchAction: 'none',
        }}
        onClick={e => e.stopPropagation()}
        onClickCapture={onClickCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={dragHandlers.onPointerUp}
        onPointerCancel={dragHandlers.onPointerCancel}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export default function PickerDialog({ isOpen, onClose, title, placement = 'center', children }: Props) {
  // Esc 關閉（桌面）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null
  if (placement === 'bottom') {
    return <BottomPickerDialog isOpen={isOpen} onClose={onClose} title={title}>{children}</BottomPickerDialog>
  }

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
