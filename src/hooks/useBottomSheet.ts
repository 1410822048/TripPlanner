// src/hooks/useBottomSheet.ts
// Bottom sheet 開關動畫 + 拖曳收合邏輯，供所有 modal sheet 共用
import { useEffect, useRef, useState } from 'react'

// ─── 收合參數 ────────────────────────────────────────────────────
/** 下滑超過 sheet 高度的此比例即關閉（0.45 ≈「拖一半」直覺） */
const DISMISS_RATIO    = 0.45
/** px/ms；快速下滑也會關閉（避免誤觸，門檻取高） */
const DISMISS_VELOCITY = 0.9
/** 關閉動畫長度（ms）— 讓父層排程 onClose */
const CLOSE_ANIM_MS    = 220

export interface UseBottomSheetOpts {
  isOpen: boolean
  onClose: () => void
}

export interface UseBottomSheetResult {
  /** sheet 根 div 的 ref（用來量測高度） */
  sheetRef: React.RefObject<HTMLDivElement | null>
  /** 目前 transform 值（組合開啟動畫 + 拖曳位移） */
  sheetTransform: string
  /** 目前 backdrop 透明度（隨拖曳距離淡出） */
  backdropOpacity: number
  /** 拖曳中為 true — 用來關閉 CSS transition（拖曳需跟手） */
  pointerActive: boolean
  /** 拖曳把手/header 套上這組 handler 即可 */
  dragHandlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp:   (e: React.PointerEvent) => void
    onPointerCancel:(e: React.PointerEvent) => void
  }
}

export function useBottomSheet({ isOpen, onClose }: UseBottomSheetOpts): UseBottomSheetResult {
  const [dragY, setDragY] = useState(0)
  const [mounted, setMounted] = useState(false)         // 控制開啟動畫
  const [pointerActive, setPointerActive] = useState(false) // 鏡射 dragging 供 render 使用
  const [sheetHeight, setSheetHeight] = useState(450)   // 拖曳開始時重新量測

  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef({ startY: 0, startTime: 0, dragging: false })
  // Live drag position — read by pointerUp's velocity calc so it sees the
  // current frame's value, not whatever React state had committed.
  const dragYRef = useRef(0)
  // Pending close timer — cancelled if sheet reopens before it fires.
  const closeTimerRef = useRef<number | undefined>(undefined)

  // ─── Animation lifecycle tied to `isOpen` ──────────────────────
  // These two effects orchestrate the enter / exit animation. Both contain
  // `setState-in-effect` calls, flagged by the React purity lint as cascade-
  // render smells. Here the cascade IS the intent: `isOpen` toggling is the
  // edge-trigger that drives the animation phase, and the next render is
  // the phase we want. A key-remount refactor can't replace this because it
  // would break the 220ms close transition — the component must stay mounted
  // through the exit animation.

  // 關閉 modal 時重置 dragY + mounted；開啟時取消任何未 fire 的 close timer
  useEffect(() => {
    if (!isOpen) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setDragY(0)
      setMounted(false)
      /* eslint-enable react-hooks/set-state-in-effect */
      dragYRef.current = 0
    } else if (closeTimerRef.current !== undefined) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
  }, [isOpen])

  // 開啟時：先渲染在畫面外（translateY 100%），一 frame 後切 mounted=true
  // → transition 自動把 sheet 從 100% 滑到 0，與拖曳用同一套動畫系統
  // (setState happens inside a nested rAF callback rather than the effect
  // body, which lets the purity lint see this as "effect body is empty"
  // and pass cleanly.)
  useEffect(() => {
    if (!isOpen) return
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setMounted(true))
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen])

  // ─── 手勢 ────────────────────────────────────────────────────
  function setDragActive(active: boolean) {
    drag.current.dragging = active
    setPointerActive(active)
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current.startY    = e.clientY
    drag.current.startTime = Date.now()
    setDragActive(true)
    // 拖曳開始時量測 sheet 實際高度（動態依內容變化）
    if (sheetRef.current) {
      setSheetHeight(sheetRef.current.getBoundingClientRect().height)
    }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
    catch { /* pointer capture 於部分瀏覽器可能拋錯 — 可忽略 */ }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.dragging) return
    const dy = e.clientY - drag.current.startY
    // 向上拖帶阻尼（rubber band），避免 sheet 被拉出上邊界
    const translated = dy < 0 ? dy / 5 : dy
    dragYRef.current = translated
    setDragY(translated)
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag.current.dragging) return
    setDragActive(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
    catch { /* release 於已釋放或瀏覽器不支援時會拋錯 — 可忽略 */ }

    // Read live position from ref — React state from the last render may lag
    // by 1 frame, making fast-flick velocity checks unreliable.
    const currentY  = dragYRef.current
    const elapsed   = Math.max(1, Date.now() - drag.current.startTime)
    const velocity  = currentY / elapsed                    // px/ms
    const threshold = sheetHeight * DISMISS_RATIO
    const shouldClose = currentY > threshold || velocity > DISMISS_VELOCITY
    if (shouldClose) {
      setDragY(window.innerHeight)
      dragYRef.current = window.innerHeight
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = undefined
        onClose()
      }, CLOSE_ANIM_MS)
    } else {
      setDragY(0)
      dragYRef.current = 0
    }
  }

  // ─── 衍生值 ───────────────────────────────────────────────────
  // Sheet transform：組合開啟動畫(mounted) + 拖曳位移(dragY)
  const sheetTransform = !mounted
    ? 'translateY(100%)'
    : dragY !== 0 ? `translateY(${dragY}px)` : 'translateY(0)'
  // Backdrop 透明度：未 mounted=0、mounted 後隨拖曳距離遞減
  const dismissPx = sheetHeight * DISMISS_RATIO
  const backdropOpacity = !mounted
    ? 0
    : Math.max(0.05, 0.35 - Math.max(0, dragY) / (dismissPx * 2))

  return {
    sheetRef,
    sheetTransform,
    backdropOpacity,
    pointerActive,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  }
}
