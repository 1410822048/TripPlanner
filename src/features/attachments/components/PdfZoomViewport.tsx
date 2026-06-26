import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'

const MIN_SCALE = 1
const MAX_SCALE = 3
const ZOOM_STEP = 0.5
const ZOOMED_EPSILON = 0.01

interface ZoomFocus {
  x: number
  y: number
}

interface PinchState {
  startDistance: number
  startScale: number
  lastScale: number
  originX: number
  originY: number
  focus: ZoomFocus
}

type ZoomAnchor =
  | {
      kind: 'page'
      page: string
      xRatio: number
      yRatio: number
      focus: ZoomFocus
    }
  | {
      kind: 'content'
      xRatio: number
      yRatio: number
      focus: ZoomFocus
    }

export interface PdfZoomState {
  pageWidth?: number
  scale: number
}

interface Props {
  children: (state: PdfZoomState) => ReactNode
}

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function touchDistance(touches: TouchList) {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return 0
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function touchCenter(touches: TouchList) {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return null
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  }
}

function ratioWithin(clientPosition: number, start: number, size: number) {
  if (size <= 0) return 0
  return (clientPosition - start) / size
}

function captureZoomAnchor(
  scrollEl: HTMLDivElement,
  contentEl: HTMLDivElement,
  focus: ZoomFocus,
): ZoomAnchor | undefined {
  const scrollRect = scrollEl.getBoundingClientRect()
  const clientX = scrollRect.left + focus.x
  const clientY = scrollRect.top + focus.y
  const pageFrame = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('[data-pdf-page-frame]')

  if (pageFrame && contentEl.contains(pageFrame) && pageFrame.dataset.pdfPageFrame) {
    const pageRect = pageFrame.getBoundingClientRect()
    return {
      kind: 'page',
      page: pageFrame.dataset.pdfPageFrame,
      xRatio: ratioWithin(clientX, pageRect.left, pageRect.width),
      yRatio: ratioWithin(clientY, pageRect.top, pageRect.height),
      focus,
    }
  }

  const contentRect = contentEl.getBoundingClientRect()
  return {
    kind: 'content',
    xRatio: ratioWithin(clientX, contentRect.left, contentRect.width),
    yRatio: ratioWithin(clientY, contentRect.top, contentRect.height),
    focus,
  }
}

function restoreZoomAnchor(
  scrollEl: HTMLDivElement,
  contentEl: HTMLDivElement,
  anchor: ZoomAnchor,
) {
  requestAnimationFrame(() => {
    const scrollRect = scrollEl.getBoundingClientRect()
    const frame = anchor.kind === 'page'
      ? contentEl.querySelector<HTMLElement>(`[data-pdf-page-frame="${anchor.page}"]`)
      : contentEl
    if (!frame) return

    const frameRect = frame.getBoundingClientRect()
    const anchorClientX = frameRect.left + frameRect.width * anchor.xRatio
    const anchorClientY = frameRect.top + frameRect.height * anchor.yRatio
    const focusClientX = scrollRect.left + anchor.focus.x
    const focusClientY = scrollRect.top + anchor.focus.y

    scrollEl.scrollLeft += anchorClientX - focusClientX
    scrollEl.scrollTop += anchorClientY - focusClientY
  })
}

function commitScaleValue(
  scaleRef: { current: number },
  setScale: (scale: number) => void,
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
  nextScale: number,
  focus?: ZoomFocus,
) {
  const clamped = clampScale(nextScale)
  const prevScale = scaleRef.current
  if (Math.abs(clamped - prevScale) <= ZOOMED_EPSILON) return

  const anchor = scrollEl && contentEl && focus
    ? captureZoomAnchor(scrollEl, contentEl, focus)
    : undefined

  scaleRef.current = clamped
  flushSync(() => setScale(clamped))

  if (!scrollEl || !contentEl || !anchor) return
  restoreZoomAnchor(scrollEl, contentEl, anchor)
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-sm backdrop-blur transition-colors hover:bg-black/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-default disabled:opacity-35"
    >
      {children}
    </button>
  )
}

export default function PdfZoomViewport({ children }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(MIN_SCALE)
  const pinchRef = useRef<PinchState | null>(null)
  const rafRef = useRef<number | null>(null)
  const [scale, setScale] = useState(MIN_SCALE)
  const [pageWidth, setPageWidth] = useState<number>()
  const isZoomed = scale > MIN_SCALE + ZOOMED_EPSILON

  const viewportCenter = () => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return undefined
    return {
      x: scrollEl.clientWidth / 2,
      y: scrollEl.clientHeight / 2,
    }
  }

  const commitScale = (nextScale: number, focus = viewportCenter()) => {
    commitScaleValue(scaleRef, setScale, scrollRef.current, contentRef.current, nextScale, focus)
  }

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return

    const measure = () => {
      setPageWidth(current => {
        const next = Math.min(Math.max(scrollEl.clientWidth - 24, 1), 900)
        return current === next ? current : next
      })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const content = contentRef.current
    if (!root || !content) return

    const applyPreviewScale = (nextScale: number) => {
      const pinch = pinchRef.current
      if (!pinch) return
      const ratio = nextScale / pinch.startScale
      content.style.transformOrigin = `${pinch.originX}px ${pinch.originY}px`
      content.style.transform = `scale(${ratio})`
    }

    const clearPreviewScale = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      content.style.transform = ''
      content.style.transformOrigin = ''
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      const distance = touchDistance(event.touches)
      const center = touchCenter(event.touches)
      const scrollEl = scrollRef.current
      if (distance <= 0 || !center || !scrollEl) return

      event.preventDefault()
      const contentRect = content.getBoundingClientRect()
      const scrollRect = scrollEl.getBoundingClientRect()
      pinchRef.current = {
        startDistance: distance,
        startScale: scaleRef.current,
        lastScale: scaleRef.current,
        originX: center.x - contentRect.left,
        originY: center.y - contentRect.top,
        focus: {
          x: center.x - scrollRect.left,
          y: center.y - scrollRect.top,
        },
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault()
      event.stopPropagation()

      const nextScale = clampScale(pinch.startScale * (touchDistance(event.touches) / pinch.startDistance))
      pinch.lastScale = nextScale
      if (rafRef.current !== null) return

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        applyPreviewScale(pinch.lastScale)
      })
    }

    const finishPinch = (event: TouchEvent) => {
      const pinch = pinchRef.current
      if (!pinch || event.touches.length >= 2) return
      event.preventDefault()
      commitScaleValue(scaleRef, setScale, scrollRef.current, contentRef.current, pinch.lastScale, pinch.focus)
      clearPreviewScale()
      pinchRef.current = null
    }

    root.addEventListener('touchstart', onTouchStart, { passive: false })
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    root.addEventListener('touchend', finishPinch, { passive: false })
    root.addEventListener('touchcancel', finishPinch, { passive: false })

    return () => {
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchend', finishPinch)
      root.removeEventListener('touchcancel', finishPinch)
      clearPreviewScale()
    }
  }, [])

  return (
    <div className="relative flex-1 min-h-0">
      <div className="pointer-events-none absolute left-0 right-0 top-2 z-20 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 p-1 text-white shadow-lg backdrop-blur">
          <ZoomButton
            label="縮小"
            disabled={!isZoomed}
            onClick={() => commitScale(scaleRef.current - ZOOM_STEP)}
          >
            <ZoomOut size={15} strokeWidth={2.2} />
          </ZoomButton>
          <div className="min-w-12 text-center text-[11px] font-bold tabular-nums text-white/90">
            {Math.round(scale * 100)}%
          </div>
          <ZoomButton
            label="拡大"
            disabled={scale >= MAX_SCALE - ZOOMED_EPSILON}
            onClick={() => commitScale(scaleRef.current + ZOOM_STEP)}
          >
            <ZoomIn size={15} strokeWidth={2.2} />
          </ZoomButton>
          <ZoomButton
            label="リセット"
            disabled={!isZoomed}
            onClick={() => commitScale(MIN_SCALE)}
          >
            <RotateCcw size={14} strokeWidth={2.2} />
          </ZoomButton>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="h-full overflow-auto overscroll-contain pb-3 pt-12"
        style={{ touchAction: 'auto' }}
      >
        <div ref={rootRef} className="relative min-h-full min-w-full" style={{ touchAction: 'pan-x pan-y' }}>
          <div ref={contentRef} className="mx-auto flex w-max min-w-full transform-gpu flex-col items-center gap-3">
            {children({ pageWidth, scale })}
          </div>
        </div>
      </div>
    </div>
  )
}
