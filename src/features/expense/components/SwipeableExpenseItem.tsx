// src/features/expense/components/SwipeableExpenseItem.tsx
// 費用列表 row — 左滑露出刪除。drag 期間以 ref 直接寫 DOM transform（不走 React state），
// 避免每一 pointermove 都重新渲染整個 row。
import { useState, useRef, useEffect, memo } from 'react'
import { Trash2 } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import {
  SWIPE_WIDTH, OPEN_THRESHOLD, MOVE_THRESHOLD,
  FG_TRANSITION, BG_TRANSITION,
} from '@/components/ui/swipeConstants'

export interface SwipeableExpenseItemProps {
  expense:      Expense
  payer:        TripMember | undefined
  summary:      string
  categoryEmoji: string
  isOpen:       boolean
  onSelect:     () => void
  onOpen:       () => void
  onClose:      () => void
  onDelete:     () => void
}

function SwipeableExpenseItem({
  expense, payer, summary, categoryEmoji,
  isOpen, onSelect, onOpen, onClose, onDelete,
}: SwipeableExpenseItemProps) {
  const [confirming, setConfirming] = useState(false)
  const fgRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const drag  = useRef({
    startX: 0, startY: 0,
    currentX: 0,
    dragging: false,
    mode: null as 'swipe' | null,
    didDrag: false,
  })

  function writeTransform(x: number) {
    drag.current.currentX = x
    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transform = `translate3d(${x}px,0,0)`
    if (bg) {
      bg.style.transform = `translate3d(${SWIPE_WIDTH + x}px,0,0)`
      bg.style.pointerEvents = x < 0 ? 'auto' : 'none'
    }
  }

  // Clear the "confirming delete" sub-state when the swipe panel closes. The
  // parent only toggles isOpen; this component owns the confirming flag, so
  // a sync-in-effect here is the natural place. setState-in-effect is flagged
  // by the purity lint but this is an edge-triggered reset, not a render
  // cascade, and the next render is the one we want.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirming(false)
    }
  }, [isOpen])

  function onPointerDown(e: React.PointerEvent) {
    drag.current.startX   = e.clientX
    drag.current.startY   = e.clientY
    drag.current.mode     = null
    drag.current.didDrag  = false
    drag.current.dragging = true
    const fg = fgRef.current, bg = bgRef.current
    if (fg) { fg.style.transition = 'none'; fg.style.willChange = 'transform' }
    if (bg) { bg.style.transition = 'background 0.15s'; bg.style.willChange = 'transform' }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
    catch { /* 某些瀏覽器對 pointer capture 會拋錯 — 可忽略 */ }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.dragging) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY

    if (drag.current.mode === 'swipe') {
      drag.current.didDrag = true
      const base = isOpen ? -SWIPE_WIDTH : 0
      const next = Math.min(0, Math.max(-SWIPE_WIDTH, base + dx))
      writeTransform(next)
      return
    }

    if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return

    if (Math.abs(dx) > Math.abs(dy)) {
      drag.current.mode = 'swipe'
      drag.current.didDrag = true
    } else {
      drag.current.dragging = false
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
      catch { /* no-op */ }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag.current.dragging) return
    drag.current.dragging = false
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
    catch { /* no-op */ }

    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transition = FG_TRANSITION
    if (bg) bg.style.transition = BG_TRANSITION

    if (drag.current.mode === 'swipe') {
      const x = drag.current.currentX
      if (x <= -OPEN_THRESHOLD) {
        writeTransform(-SWIPE_WIDTH)
        if (!isOpen) onOpen()
      } else {
        writeTransform(0)
        if (isOpen) onClose()
      }
    }

    // 動畫結束後釋放合成器層（避免長期佔用 GPU 記憶體）
    window.setTimeout(() => {
      if (fg) fg.style.willChange = ''
      if (bg) bg.style.willChange = ''
    }, 280)
  }

  function handleClick() {
    if (drag.current.didDrag) { drag.current.didDrag = false; return }
    if (isOpen) { onClose(); return }
    onSelect()
  }

  function handleDeleteTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirming) { setConfirming(true); return }
    onDelete()
  }

  const openX = isOpen ? -SWIPE_WIDTH : 0

  return (
    <div className="relative rounded-xl overflow-hidden bg-surface border border-border">
      {/* 刪除背景按鈕 */}
      <div
        ref={bgRef}
        onClick={handleDeleteTap}
        className={[
          'absolute top-0 right-0 bottom-0 flex items-center justify-center cursor-pointer',
          confirming ? 'bg-[#A83A3A]' : 'bg-[#D85A5A]',
        ].join(' ')}
        style={{
          width: SWIPE_WIDTH,
          transform: `translate3d(${SWIPE_WIDTH + openX}px,0,0)`,
          transition: BG_TRANSITION,
          pointerEvents: openX < 0 ? 'auto' : 'none',
        }}
      >
        {confirming ? (
          <div className="text-white text-[11px] font-bold tracking-[0.04em] text-center leading-[1.3]">
            確認<br/>削除
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <Trash2 size={18} color="white" strokeWidth={2.2} />
            <span className="text-white text-[10px] font-bold tracking-[0.04em]">
              削除
            </span>
          </div>
        )}
      </div>

      {/* 前景內容層 */}
      <div
        ref={fgRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={handleClick}
        onContextMenu={e => e.preventDefault()}
        className="relative select-none cursor-pointer bg-surface"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-9 h-9 rounded-input bg-tile shrink-0 flex items-center justify-center text-[17px] pointer-events-none">
            {categoryEmoji}
          </div>
          <div className="flex-1 min-w-0 pointer-events-none">
            <div className="text-[13px] font-semibold text-ink -tracking-[0.1px] overflow-hidden text-ellipsis whitespace-nowrap">
              {expense.title}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-muted">
              {payer && (
                <>
                  <span
                    className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full text-[8px] font-bold shrink-0"
                    style={{ background: payer.bg, color: payer.color }}
                  >
                    {payer.label}
                  </span>
                  <span>立替</span>
                  <span className="text-border">·</span>
                </>
              )}
              <span>{summary}</span>
            </div>
          </div>
          <div className="text-[14px] font-bold text-ink tabular-nums shrink-0 pointer-events-none">
            ¥{expense.amount.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
}

// callback props 在 parent render 時每次都是新 ref — 自訂 compare 忽略它們，
// 只看會影響渲染結果的 primitive / stable-ref props。
export default memo(SwipeableExpenseItem, (prev, next) => (
  prev.expense === next.expense &&
  prev.payer === next.payer &&
  prev.summary === next.summary &&
  prev.categoryEmoji === next.categoryEmoji &&
  prev.isOpen === next.isOpen
))
