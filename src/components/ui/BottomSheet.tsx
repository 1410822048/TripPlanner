// src/components/ui/BottomSheet.tsx
import { useEffect, useId, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBottomSheet } from '@/hooks/useBottomSheet'
import { useModalFocus } from '@/hooks/useModalFocus'

interface Props {
  isOpen:   boolean
  title:    ReactNode
  onClose:  () => void
  /** Temporarily false while a commit result is unresolved. */
  dismissible?: boolean
  footer?:  ReactNode
  children: ReactNode
}

export default function BottomSheet({ isOpen, title, onClose, dismissible = true, footer, children }: Props) {
  const { sheetRef, sheetTransform, backdropOpacity, pointerActive, dragHandlers } =
    useBottomSheet({ isOpen, onClose, dismissible })

  const titleId    = useId()
  useModalFocus(sheetRef, isOpen, onClose, 201, dismissible)

  // 開啟時鎖住 <main> scroll（app 的實際滾動容器）
  // iOS Safari: overflow:hidden 單獨不足以阻止 rubberband，需搭配 touch-action:none
  // 並保留/還原 scrollTop 避免位置跳回頂端
  useEffect(() => {
    if (!isOpen) return
    const main = document.querySelector<HTMLElement>('main')
    if (!main) return
    const prevOverflow   = main.style.overflow
    const prevTouchAction = main.style.touchAction
    const scrollTop = main.scrollTop
    main.style.overflow   = 'hidden'
    main.style.touchAction = 'none'
    return () => {
      main.style.overflow   = prevOverflow
      main.style.touchAction = prevTouchAction
      main.scrollTop = scrollTop
    }
  }, [isOpen])

  // 防止 iOS Safari 在 backdrop 上的 touchmove 冒泡觸發 viewport bounce
  useEffect(() => {
    if (!isOpen) return
    const prevent = (e: TouchEvent) => {
      // 只阻擋 sheet 外（backdrop）的 touchmove；sheet 內部允許正常滾動
      const sheet = sheetRef.current
      if (sheet && e.target instanceof Node && sheet.contains(e.target)) return
      // 允許 Portal 渲染到 body 的 dialog（DatePicker / TimePicker）內部滾動
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      e.preventDefault()
    }
    document.addEventListener('touchmove', prevent, { passive: false })
    return () => document.removeEventListener('touchmove', prevent)
  }, [isOpen, sheetRef])

  if (!isOpen) return null

  return (
    <>
      <div
        onClick={dismissible ? onClose : undefined}
        className="fixed inset-0 z-[200]"
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
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed bottom-0 inset-x-0 max-w-[430px] mx-auto bg-surface rounded-t-[20px] z-[201] max-h-[92dvh] flex flex-col touch-pan-y will-change-transform overflow-hidden outline-none"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 12px)',
          transform: sheetTransform,
          transition: pointerActive ? 'none' : 'transform 0.28s cubic-bezier(0.32,0.72,0,1)',
        }}
      >

        <div
          {...dragHandlers}
          aria-disabled={!dismissible}
          className={[
            'shrink-0 select-none',
            !dismissible ? 'cursor-default' : pointerActive ? 'cursor-grabbing' : 'cursor-grab',
          ].join(' ')}
          style={{ touchAction: 'none' }}
        >
          <div className="flex justify-center pt-2.5 pb-1">
            <div className={[
              'w-10 h-1 rounded-sm transition-colors',
              pointerActive ? 'bg-muted' : 'bg-border',
            ].join(' ')} />
          </div>

          <div className="flex items-center justify-between px-5 pt-1.5 pb-3 border-b border-border">
            <h3 id={titleId} className="m-0 text-[16px] font-bold text-ink tracking-[0.02em] font-serif-ja">
              {title}
            </h3>
            <button
              type="button"
              disabled={!dismissible}
              onClick={onClose}
              onPointerDown={e => e.stopPropagation()}
              aria-label="關閉"
              className="w-[30px] h-[30px] rounded-full border-none bg-app text-muted flex items-center justify-center cursor-pointer touch-auto hover:bg-border transition-colors disabled:cursor-not-allowed disabled:opacity-45"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto overflow-x-hidden overscroll-contain flex-1 px-5 py-4 flex flex-col gap-3.5">
          {children}
        </div>

        {footer && (
          <div className="px-5 py-3 shrink-0 border-t border-border">
            {footer}
          </div>
        )}
      </div>
    </>
  )
}
