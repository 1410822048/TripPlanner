import { useEffect, useEffectEvent, type RefObject } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const layers = new Map<HTMLElement, { priority: number; order: number }>()
let order = 0

function topLayer(includeDetached = false): HTMLElement | undefined {
  return [...layers].filter(([node]) => includeDetached || node.isConnected)
    .sort((a, b) => b[1].priority - a[1].priority || b[1].order - a[1].order)[0]?.[0]
}

/** Portal 與父表單共用焦點管理；Escape / Tab 僅交給最上層視窗。 */
export function useModalFocus(
  ref: RefObject<HTMLDivElement | null>,
  isOpen: boolean,
  onClose: () => void,
  priority: number,
  dismissible = true,
): void {
  const close = useEffectEvent(() => { if (dismissible) onClose() })
  useEffect(() => {
    const node = ref.current
    if (!isOpen || !node) return
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    layers.set(node, { priority, order: ++order })
    const raf = requestAnimationFrame(() => {
      if (topLayer() === node && !node.contains(document.activeElement)) node.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topLayer() !== node) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const list = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter(element => !element.closest('[hidden],[inert],[aria-hidden="true"]'))
      const first = list[0]
      const last = list.at(-1)
      const active = document.activeElement
      if (!first || !last) { event.preventDefault(); node.focus(); return }
      if (!node.contains(active) || active === node || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      // React 在 passive cleanup 前已拆除 DOM，仍須辨識原本的最上層。
      const wasTop = topLayer(true) === node
      layers.delete(node)
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      const remaining = topLayer()
      if (wasTop && invoker?.isConnected && (!remaining || remaining.contains(invoker))) invoker.focus()
    }
  }, [ref, isOpen, priority])
}
